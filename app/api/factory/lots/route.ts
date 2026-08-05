import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryActor } from "@/app/lib/factory-db";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function txt(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

// GET ?warehouse_id= &own=1|0 &q= &empty=1 &from= &to= — 로트 목록(현재수량 + 기간 입출고)
//  기본은 소진 로트(현재수량 0 이하)를 숨긴다. empty=1 이면 전부 보여준다.
//  from~to 를 주면 그 범위 거래를 로트별로 합산해 period_in(+합)·period_out(−합)을 붙인다.
//  이동도 포함한다 — 그 로트 입장에서는 실제로 들어오고 나간 수량이다.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let q = factoryDb().from("lot_stock").select("*");

    const wid = sp.get("warehouse_id");
    if (wid) q = q.eq("warehouse_id", wid);
    const own = sp.get("own");
    if (own === "1") q = q.eq("is_own", true);
    if (own === "0") q = q.eq("is_own", false);
    const kw = (sp.get("q") || "").trim();
    if (kw) q = q.or(`item_name.ilike.%${kw}%,spec.ilike.%${kw}%,note.ilike.%${kw}%,supplier.ilike.%${kw}%`);
    if (sp.get("empty") !== "1") q = q.gt("qty", 0);

    const { data, error } = await q.order("item_name").order("first_in_date", { ascending: true });
    if (error) throw error;
    const rows = (data || []) as Record<string, unknown>[];

    const from = sp.get("from") || "";
    const to = sp.get("to") || "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && rows.length) {
      const { data: tx, error: te } = await factoryDb()
        .from("lot_txns").select("lot_id, qty")
        .gte("txn_date", from).lte("txn_date", to)
        .limit(20000); // supabase 기본 1000행 캡 해제 — 현재 주 66건 수준이라 수년치 여유
      if (te) throw te;
      const inMap = new Map<string, number>();
      const outMap = new Map<string, number>();
      for (const t of (tx || []) as { lot_id: string; qty: number }[]) {
        const v = Number(t.qty) || 0;
        if (v > 0) inMap.set(t.lot_id, (inMap.get(t.lot_id) || 0) + v);
        else outMap.set(t.lot_id, (outMap.get(t.lot_id) || 0) - v);
      }
      for (const r of rows) {
        r.period_in = inMap.get(String(r.id)) || 0;
        r.period_out = outMap.get(String(r.id)) || 0;
      }
    }
    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error("[factory/lots GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "재고 조회 실패") }, { status: 500 });
  }
}

// POST — 로트 신규 등록(= 최초 입고). 로트와 입고 거래 1건을 함께 만든다.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const item_name = txt(b.item_name);
    const warehouse_id = txt(b.warehouse_id);
    const qty = num(b.qty);
    if (!item_name) return NextResponse.json({ ok: false, error: "품명을 입력하세요." }, { status: 400 });
    if (!warehouse_id) return NextResponse.json({ ok: false, error: "창고를 고르세요." }, { status: 400 });
    if (qty === null || qty <= 0) return NextResponse.json({ ok: false, error: "입고 수량은 0보다 커야 합니다." }, { status: 400 });

    const who = await factoryActor(req);
    const first_in_date = DATE_RE.test(String(b.first_in_date || "")) ? String(b.first_in_date) : null;
    const lot = {
      warehouse_id,
      item_name,
      spec: txt(b.spec),
      tape_color: txt(b.tape_color),
      origin: txt(b.origin),
      note: txt(b.note),
      supplier: txt(b.supplier),
      box_kg: num(b.box_kg),
      unit: txt(b.unit) || "B",
      first_in_date,
      prod_date: DATE_RE.test(String(b.prod_date || "")) ? String(b.prod_date) : null,
      memo: txt(b.memo),
      created_by: who,
    };

    const db = factoryDb();
    const { data: lotRow, error: le } = await db.from("lots").insert(lot).select("id").single();
    if (le) throw le;
    const lotId = (lotRow as { id: string }).id;

    const { error: te } = await db.from("lot_txns").insert({
      lot_id: lotId,
      txn_date: first_in_date || undefined,
      type: "입고",
      qty,                       // 입고는 +
      memo: txt(b.memo),
      created_by: who,
    });
    // 거래가 안 들어가면 수량 0 짜리 유령 로트가 남는다 — 로트를 되돌린다.
    if (te) { await db.from("lots").delete().eq("id", lotId); throw te; }

    const { data } = await db.from("lot_stock").select("*").eq("id", lotId).single();
    return NextResponse.json({ ok: true, row: data });
  } catch (err) {
    console.error("[factory/lots POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "입고 등록 실패") }, { status: 500 });
  }
}
