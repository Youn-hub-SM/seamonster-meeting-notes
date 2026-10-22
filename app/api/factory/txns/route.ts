import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005, isPending007, PENDING_007 } from "@/app/lib/factory-db";
import { TXN_TYPES, kgStr, kgNum, kgBox, lotLabel, productLabel, signedKg, type HistEvent, type TxnType } from "@/app/lib/factory";
import { notifyFactory, factoryMsg } from "@/app/lib/factory-notify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const kstDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const pending = () => NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
const pending7 = () => NextResponse.json({ ok: false, error: PENDING_007, pending_migration: true }, { status: 503 });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 1000; // PostgREST 한도 — 이보다 크게 달라고 해도 1000행에서 잘린다
// 알림은 기다리되 오래 붙잡지 않는다 — 웹훅이 느려 함수가 시간 초과되면 저장됐는데 '실패'로 보인다
const notifySoon = (p: Promise<void>) => Promise.race([p, new Promise<void>((r) => setTimeout(r, 4000))]);
const num = (v: unknown) => (v == null ? null : Number(v));

// 007 부터 수량은 kg. box_kg·boxes 는 입고 때 적은 참고 정보(없을 수 있다).
type TxnRow = {
  id: string; batch_id: string; product_id: string; txn_date: string; type: TxnType;
  mfg_date: string | null; kg: number | string; target_kg: number | string | null;
  box_kg: number | string | null; boxes: number | null; partner: string | null; memo: string | null;
  created_by: string | null; created_at: string; cancelled_at: string | null; cancelled_by: string | null;
};
const COLS = "id, batch_id, product_id, txn_date, type, mfg_date, kg, target_kg, box_kg, boxes, partner, memo, created_by, created_at, cancelled_at, cancelled_by";

// GET ?from=&to= — 히스토리: 기록(입고·출고·조정) + 기록 취소(취소한 날) + 품목 변경(바꾼 날). 최신순.
//  기록은 거래일이 기간 안이거나 **입력한 날**이 기간 안이면 나온다 — 지난 날짜로 넣은 기록도 입력한 날 이력에서 보인다.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;

    // ?product_id= — 재고 목록의 품목 히스토리 창: 그 품목의 기록 전부(취소 포함), 최신순.
    //  전후 재고는 화면이 누적합으로 계산하므로 한도(LIMIT)에 닿으면 capped 로 알린다.
    const productId = sp.get("product_id") || "";
    if (productId) {
      if (!UUID_RE.test(productId)) return NextResponse.json({ ok: false, error: "품목이 올바르지 않습니다." }, { status: 400 });
      const { data, error } = await factoryDb().from("stock_txns").select(COLS).eq("product_id", productId)
        .order("txn_date", { ascending: false }).order("created_at", { ascending: false }).limit(LIMIT);
      if (error) throw error;
      const rows = ((data || []) as TxnRow[]).map((t) => ({ ...t, kg: Number(t.kg), target_kg: num(t.target_kg), box_kg: num(t.box_kg) }));
      return NextResponse.json({ ok: true, rows, capped: rows.length >= LIMIT });
    }

    const to = validDate(sp.get("to") || "") ? sp.get("to")! : kstToday();
    const from = validDate(sp.get("from") || "") ? sp.get("from")! : to;
    // KST 하루 경계 → UTC 시각
    const fromTs = new Date(Date.parse(`${from}T00:00:00Z`) - 9 * 3600e3).toISOString();
    const toTs = new Date(Date.parse(`${to}T00:00:00Z`) + 15 * 3600e3).toISOString(); // to 다음 날 00:00 KST

    const db = factoryDb();
    const [tx, cx, ch, pr] = await Promise.all([
      db.from("stock_txns").select(COLS)
        .or(`and(txn_date.gte.${from},txn_date.lte.${to}),and(created_at.gte."${fromTs}",created_at.lt."${toTs}")`)
        .order("txn_date", { ascending: false }).order("created_at", { ascending: false }).limit(LIMIT),
      db.from("stock_txns").select(COLS).gte("cancelled_at", fromTs).lt("cancelled_at", toTs)
        .order("cancelled_at", { ascending: false }).limit(LIMIT),
      db.from("product_changes").select("*").gte("changed_at", fromTs).lt("changed_at", toTs)
        .order("changed_at", { ascending: false }).limit(LIMIT),
      db.from("products").select("id, sku, name, spec"),
    ]);
    for (const r of [tx, cx, ch, pr]) if (r.error) throw r.error;

    // 화면·검색에는 "품목 규격"으로 — HistEvent.name 을 그대로 쓴다(규격 열을 따로 두지 않는다)
    const prod = new Map(((pr.data || []) as { id: string; sku: string; name: string; spec: string | null }[]).map((p) => [p.id, { ...p, name: productLabel(p) }]));
    const base = (t: TxnRow) => ({
      txn_id: t.id, txn_type: t.type, mfg_date: t.mfg_date,
      kg: Number(t.kg), target_kg: num(t.target_kg), box_kg: num(t.box_kg), boxes: t.boxes,
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
    if (isPending007(err)) return pending7();
    console.error("[factory/txns GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "히스토리 조회 실패") }, { status: 500 });
  }
}

// POST { type, txn_date?, partner?, memo?, batch_id?, lines: [{ product_id, mfg_date?, kg | target_kg, box_kg?, boxes? }] }
//  입고·출고 = kg(양수, 0.001 단위), 조정 = target_kg(실사 kg — 현재와의 차이만 기록, 오늘 날짜만).
//  box_kg·boxes 는 입고 때 적은 참고(총 kg 계산 보조) — 없어도 된다.
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
    const { data: prods, error: pe } = await db.from("products").select("id, sku, name, spec, stock_tracked").in("id", ids);
    if (pe) throw pe;
    const prod = new Map(((prods || []) as { id: string; sku: string; name: string; spec: string | null; stock_tracked: boolean }[]).map((p) => [p.id, { ...p, name: productLabel(p) }]));

    const rows: Record<string, unknown>[] = [];
    for (const [i, l] of raw.entries()) {
      const no = `${i + 1}번째 줄`;
      const p = prod.get(String(l.product_id || ""));
      if (!p) return NextResponse.json({ ok: false, error: `${no}: 품목을 찾을 수 없습니다.` }, { status: 400 });
      if (!p.stock_tracked) return NextResponse.json({ ok: false, error: `${p.name}: 재고관리 사용안함 품목입니다.` }, { status: 400 });
      const mfg = String(l.mfg_date || "");
      if (mfg && !validDate(mfg)) return NextResponse.json({ ok: false, error: `${p.name}: 제조일자가 올바르지 않습니다.` }, { status: 400 });
      const row: Record<string, unknown> = { product_id: p.id, type, txn_date, mfg_date: mfg || null, partner, memo, box_kg: null, boxes: null };
      // 참고 정보 — 적었으면 값이 맞아야 한다
      if (l.box_kg !== undefined && l.box_kg !== null && String(l.box_kg) !== "") {
        const bk = kgNum(Number(l.box_kg));
        if (!Number.isFinite(bk) || bk <= 0 || bk > 1000) return NextResponse.json({ ok: false, error: `${p.name}: 박스 중량(kg)이 올바르지 않습니다.` }, { status: 400 });
        row.box_kg = bk;
      }
      if (l.boxes !== undefined && l.boxes !== null && String(l.boxes) !== "") {
        const bx = Number(l.boxes);
        if (!Number.isInteger(bx) || bx <= 0 || bx > 1e6) return NextResponse.json({ ok: false, error: `${p.name}: 박스 수는 1 이상 정수로 입력하세요.` }, { status: 400 });
        row.boxes = bx;
      }
      if (type === "조정") {
        const t = Math.round(Number(l.target_kg) * 1000) / 1000;
        if (!Number.isFinite(t) || t < 0 || t > 1e7) return NextResponse.json({ ok: false, error: `${p.name}: 실사 kg 을 0 이상으로 입력하세요.` }, { status: 400 });
        row.target_kg = t;
      } else {
        const n = Math.round(Number(l.kg) * 1000) / 1000;
        if (!Number.isFinite(n) || n <= 0 || n > 1e7) return NextResponse.json({ ok: false, error: `${p.name}: kg 을 0보다 크게 입력하세요.` }, { status: 400 });
        row.kg = n;
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
    if (!("kg" in saved[0])) return pending7(); // 옛 함수가 돌았다(007 미적용)

    // 알림 1건(입력 1회) — 줄이 여러 개면 한 줄로 이어 붙인다
    const parts = saved.map((t) => `${prod.get(t.product_id)?.name ?? "품목"}(${lotLabel({ mfg_date: t.mfg_date })}) ${Number(t.kg) < 0 ? "−" : "+"}${kgBox(Math.abs(Number(t.kg)), num(t.box_kg))}`);
    const totalKg = saved.reduce((s, t) => s + Math.abs(Number(t.kg)), 0);
    await notifySoon(notifyFactory(factoryMsg({
      event: type,
      label: `${parts.join(" / ")}${saved.length > 1 ? ` — ${saved.length}건 ${kgStr(totalKg)}` : ""}`,
      dest: type === "출고" ? partner : null, who: u.name, memo,
    })));
    return NextResponse.json({ ok: true, count: saved.length });
  } catch (err) {
    if (isPending005(err)) return pending();
    if (isPending007(err)) return pending7();
    console.error("[factory/txns POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "기록 저장 실패") }, { status: 500 });
  }
}
