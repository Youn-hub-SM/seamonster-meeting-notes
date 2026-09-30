import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005 } from "@/app/lib/factory-db";
import { TXN_TYPES, boxStr, kgStr, lotLabel, type HistEvent, type TxnType } from "@/app/lib/factory";
import { notifyFactory, factoryMsg } from "@/app/lib/factory-notify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const kstDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const pending = () => NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 1000; // PostgREST 한도 — 이보다 크게 달라고 해도 1000행에서 잘린다
// 알림은 기다리되 오래 붙잡지 않는다 — 웹훅이 느려 함수가 시간 초과되면 저장됐는데 '실패'로 보인다
const notifySoon = (p: Promise<void>) => Promise.race([p, new Promise<void>((r) => setTimeout(r, 4000))]);

type TxnRow = {
  id: string; batch_id: string; product_id: string; txn_date: string; type: TxnType;
  mfg_date: string | null; box_kg: number | string; boxes: number; target: number | null; partner: string | null; memo: string | null;
  created_by: string | null; created_at: string; cancelled_at: string | null; cancelled_by: string | null;
};

// GET ?from=&to= — 히스토리: 기록(입고·출고·조정) + 기록 취소(취소한 날) + 품목 변경(바꾼 날). 최신순.
//  기록은 거래일이 기간 안이거나 **입력한 날**이 기간 안이면 나온다 — 지난 날짜로 넣은 기록도 입력한 날 이력에서 보인다.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const to = validDate(sp.get("to") || "") ? sp.get("to")! : kstToday();
    const from = validDate(sp.get("from") || "") ? sp.get("from")! : to;
    // KST 하루 경계 → UTC 시각
    const fromTs = new Date(Date.parse(`${from}T00:00:00Z`) - 9 * 3600e3).toISOString();
    const toTs = new Date(Date.parse(`${to}T00:00:00Z`) + 15 * 3600e3).toISOString(); // to 다음 날 00:00 KST

    const db = factoryDb();
    const cols = "id, batch_id, product_id, txn_date, type, mfg_date, box_kg, boxes, target, partner, memo, created_by, created_at, cancelled_at, cancelled_by";
    const [tx, cx, ch, pr] = await Promise.all([
      db.from("stock_txns").select(cols)
        .or(`and(txn_date.gte.${from},txn_date.lte.${to}),and(created_at.gte."${fromTs}",created_at.lt."${toTs}")`)
        .order("txn_date", { ascending: false }).order("created_at", { ascending: false }).limit(LIMIT),
      db.from("stock_txns").select(cols).gte("cancelled_at", fromTs).lt("cancelled_at", toTs)
        .order("cancelled_at", { ascending: false }).limit(LIMIT),
      db.from("product_changes").select("*").gte("changed_at", fromTs).lt("changed_at", toTs)
        .order("changed_at", { ascending: false }).limit(LIMIT),
      db.from("products").select("id, sku, name"),
    ]);
    for (const r of [tx, cx, ch, pr]) if (r.error) throw r.error;

    const prod = new Map(((pr.data || []) as { id: string; sku: string; name: string }[]).map((p) => [p.id, p]));
    const base = (t: TxnRow) => ({
      txn_id: t.id, txn_type: t.type, mfg_date: t.mfg_date, box_kg: Number(t.box_kg), boxes: t.boxes, target: t.target,
      partner: t.partner, memo: t.memo, cancelled_at: t.cancelled_at, cancelled_by: t.cancelled_by,
      sku: prod.get(t.product_id)?.sku ?? null, name: prod.get(t.product_id)?.name ?? null,
    });
    const events: HistEvent[] = [
      ...((tx.data || []) as TxnRow[]).map((t) => ({
        key: `t:${t.id}`, kind: t.type, date: t.txn_date, at: t.created_at, who: t.created_by, ...base(t),
      })),
      ...((cx.data || []) as TxnRow[]).map((t) => ({
        key: `c:${t.id}`, kind: "취소" as const, date: kstDate(t.cancelled_at!), at: t.cancelled_at!, who: t.cancelled_by, ...base(t),
      })),
      ...((ch.data || []) as { id: string; sku: string | null; name: string | null; field: string; old_value: string | null; new_value: string | null; changed_by: string | null; changed_at: string }[])
        .map((c) => ({
          key: `p:${c.id}`, kind: "변경" as const, date: kstDate(c.changed_at), at: c.changed_at, who: c.changed_by,
          sku: c.sku, name: c.name, field: c.field, old_value: c.old_value, new_value: c.new_value,
        })),
    ];
    events.sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
    const capped = [tx, cx, ch].some((r) => (r.data || []).length >= LIMIT);
    return NextResponse.json({ ok: true, events, from, to, capped });
  } catch (err) {
    if (isPending005(err)) return pending();
    console.error("[factory/txns GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "히스토리 조회 실패") }, { status: 500 });
  }
}

// POST { type, txn_date?, partner?, memo?, batch_id?, lines: [{ product_id, mfg_date?, box_kg, boxes | target }] }
//  입고·출고 = boxes(양수 박스 수), 조정 = target(실사 박스 수 — 현재 수량과의 차이만 기록, 오늘 날짜만).
//  batch_id = 화면이 만든 입력 번호 — 응답을 못 받고 다시 눌러도 한 번만 기록된다.
//  잔량 확인·기록은 DB 함수(factory.post_stock_txns)가 품목 잠금 안에서 한 번에 한다 — 한 줄이라도 안 되면 전부 취소.
export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const type = String(b.type || "") as TxnType;
    if (!TXN_TYPES.includes(type)) return NextResponse.json({ ok: false, error: "유형을 고르세요." }, { status: 400 });
    const txn_date = String(b.txn_date || "") || kstToday();
    if (!validDate(txn_date)) return NextResponse.json({ ok: false, error: "날짜가 올바르지 않습니다." }, { status: 400 });
    if (txn_date > kstToday()) return NextResponse.json({ ok: false, error: "오늘 이후 날짜로는 기록할 수 없습니다." }, { status: 400 });
    // 조정은 '지금' 실사 수량과 현재 수량의 차이 — 지난 날짜로 넣으면 그 뒤 기록이 지워진 것처럼 된다
    if (type === "조정" && txn_date !== kstToday()) return NextResponse.json({ ok: false, error: "조정은 오늘 날짜로만 기록합니다." }, { status: 400 });
    const batch = UUID_RE.test(String(b.batch_id || "")) ? String(b.batch_id) : null;
    const partner = String(b.partner || "").trim() || null;
    const memo = String(b.memo || "").trim() || null;
    const raw = Array.isArray(b.lines) ? (b.lines as Record<string, unknown>[]) : [];
    if (raw.length === 0) return NextResponse.json({ ok: false, error: "품목을 추가하세요." }, { status: 400 });
    if (raw.length > 200) return NextResponse.json({ ok: false, error: "한 번에 200줄까지 저장할 수 있습니다." }, { status: 400 });

    const db = factoryDb();
    const ids = [...new Set(raw.map((l) => String(l.product_id || "")))];
    const { data: prods, error: pe } = await db.from("products").select("id, sku, name, stock_tracked").in("id", ids);
    if (pe) throw pe;
    const prod = new Map(((prods || []) as { id: string; sku: string; name: string; stock_tracked: boolean }[]).map((p) => [p.id, p]));

    const rows: Record<string, unknown>[] = [];
    for (const [i, l] of raw.entries()) {
      const no = `${i + 1}번째 줄`;
      const p = prod.get(String(l.product_id || ""));
      if (!p) return NextResponse.json({ ok: false, error: `${no}: 품목을 찾을 수 없습니다.` }, { status: 400 });
      if (!p.stock_tracked) return NextResponse.json({ ok: false, error: `${p.name}: 재고관리 사용안함 품목입니다.` }, { status: 400 });
      const mfg = String(l.mfg_date || "");
      if (mfg && !validDate(mfg)) return NextResponse.json({ ok: false, error: `${p.name}: 제조일자가 올바르지 않습니다.` }, { status: 400 });
      const kg = Math.round(Number(l.box_kg) * 100) / 100;
      if (!Number.isFinite(kg) || kg <= 0 || kg > 1000) return NextResponse.json({ ok: false, error: `${p.name}: 박스 중량(kg)을 입력하세요.` }, { status: 400 });
      const row: Record<string, unknown> = { product_id: p.id, type, txn_date, mfg_date: mfg || null, box_kg: kg, partner, memo };
      if (type === "조정") {
        const t = Number(l.target);
        if (!Number.isInteger(t) || t < 0 || t > 1e6) return NextResponse.json({ ok: false, error: `${p.name}: 실사 박스 수를 0 이상 정수로 입력하세요.` }, { status: 400 });
        row.target = t;
      } else {
        const n = Number(l.boxes);
        if (!Number.isInteger(n) || n <= 0 || n > 1e6) return NextResponse.json({ ok: false, error: `${p.name}: 박스 수를 1 이상 정수로 입력하세요.` }, { status: 400 });
        row.boxes = n;
      }
      rows.push(row);
    }

    // 이미 저장된 입력 번호면 다시 기록하지 않는다(DB 함수도 같은 확인을 잠금 안에서 한 번 더 한다)
    if (batch) {
      const { data: dup, error: de } = await db.from("stock_txns").select("id").eq("batch_id", batch).limit(1);
      if (de) throw de;
      if ((dup || []).length) return NextResponse.json({ ok: true, count: 0, duplicate: true });
    }
    const { data, error } = await db.rpc("post_stock_txns", { p_rows: rows, p_actor: u.name, p_batch: batch });
    if (error) {
      if ((error as { code?: string }).code === "P0001") return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
      throw error;
    }
    const saved = (data || []) as TxnRow[];
    if (saved.length === 0) return NextResponse.json({ ok: false, error: "현재 수량과 같아 바뀐 것이 없습니다." }, { status: 400 });

    // 알림 1건(입력 1회) — 줄이 여러 개면 한 줄로 이어 붙인다
    const parts = saved.map((t) => {
      const p = prod.get(t.product_id);
      const kgv = Number(t.box_kg);
      return `${p?.name ?? "품목"}(${lotLabel({ mfg_date: t.mfg_date, box_kg: kgv })}) ${t.boxes > 0 && type !== "입고" ? "+" : ""}${boxStr(t.boxes)}`;
    });
    const totalKg = saved.reduce((s, t) => s + Math.abs(t.boxes) * Number(t.box_kg), 0);
    await notifySoon(notifyFactory(factoryMsg({
      event: type,
      label: `${parts.join(" / ")}${saved.length > 1 ? ` — ${saved.length}건 ${kgStr(totalKg)}` : ""}`,
      dest: type === "출고" ? partner : null, who: u.name, memo,
    })));
    return NextResponse.json({ ok: true, count: saved.length });
  } catch (err) {
    if (isPending005(err)) return pending();
    console.error("[factory/txns POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "기록 저장 실패") }, { status: 500 });
  }
}
