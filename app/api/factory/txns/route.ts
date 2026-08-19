import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryActor } from "@/app/lib/factory-db";
import { TXN_TYPES, SITE_DEST, lotLabel, type TxnType } from "@/app/lib/factory";
import { notifyFactory, factoryMsg } from "@/app/lib/factory-notify";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET ?from= &to= &lot_id= — 거래 내역(로트 정보 포함, 최신순)
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let q = factoryDb().from("lot_txns").select("*, lots(item_name, spec, tape_color, origin, warehouse_id)");
    const lotId = sp.get("lot_id");
    if (lotId) q = q.eq("lot_id", lotId);
    const from = sp.get("from");
    const to = sp.get("to");
    if (from && DATE_RE.test(from)) q = q.gte("txn_date", from);
    if (to && DATE_RE.test(to)) q = q.lte("txn_date", to);

    const { data, error } = await q
      .order("txn_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;

    // 창고명은 별도 조회로 붙인다(중첩 조인 2단은 PostgREST 에서 부담이 크다)
    const whs = await factoryDb().from("warehouses").select("id,name");
    const nameOf = new Map((whs.data || []).map((w) => [String((w as { id: string }).id), String((w as { name: string }).name)]));
    const rows = ((data || []) as Record<string, unknown>[]).map((t) => {
      const lot = (t.lots || {}) as Record<string, unknown>;
      return {
        ...t,
        lots: undefined,
        item_name: lot.item_name ?? null,
        spec: lot.spec ?? null,
        tape_color: lot.tape_color ?? null,
        origin: lot.origin ?? null,
        warehouse: nameOf.get(String(lot.warehouse_id ?? "")) ?? "",
      };
    });
    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error("[factory/txns GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "이력 조회 실패") }, { status: 500 });
  }
}

// POST { lot_id, type, qty, txn_date?, dest?, memo? } — 출고·생산투입·조정·추가입고
//  qty 는 양수로 받고 서버가 유형에 따라 부호를 붙인다. 조정만 음수를 그대로 받는다.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const lot_id = String(b.lot_id || "").trim();
    const type = String(b.type || "") as TxnType;
    const raw = Number(b.qty);
    if (!lot_id) return NextResponse.json({ ok: false, error: "로트를 고르세요." }, { status: 400 });
    if (!TXN_TYPES.includes(type)) return NextResponse.json({ ok: false, error: "거래 유형이 올바르지 않습니다." }, { status: 400 });
    if (type === "이동") return NextResponse.json({ ok: false, error: "창고 이동은 이동 화면에서 처리합니다." }, { status: 400 });
    if (!Number.isFinite(raw) || raw === 0) return NextResponse.json({ ok: false, error: "수량을 입력하세요." }, { status: 400 });

    const qty = type === "입고" ? Math.abs(raw) : type === "조정" ? raw : -Math.abs(raw);

    const db = factoryDb();
    const { data: cur, error: ce } = await db.from("lot_stock").select("*").eq("id", lot_id).single();
    if (ce) throw ce;
    const lot = cur as { qty: number; unit: string; warehouse: string; item_name: string; spec: string | null; tape_color: string | null; origin: string | null };
    const have = Number(lot.qty) || 0;
    // 재고보다 많이 빼는 건 오타일 가능성이 높다 — 막고 현재수량을 알려준다.
    // 실물이 정말 안 맞으면 '조정'으로 맞춘다(그게 실사 보정의 정상 경로다).
    if (qty < 0 && type !== "조정" && have + qty < 0) {
      return NextResponse.json(
        { ok: false, error: `현재수량(${have})보다 많이 뺄 수 없습니다. 실물이 다르면 '조정'으로 맞추세요.` },
        { status: 400 },
      );
    }

    const dest = type === "생산투입" ? SITE_DEST : String(b.dest || "").trim() || null;
    const who = await factoryActor(req);
    const memo = String(b.memo || "").trim() || null;
    const { data, error } = await db.from("lot_txns").insert({
      lot_id,
      txn_date: DATE_RE.test(String(b.txn_date || "")) ? String(b.txn_date) : undefined,
      type,
      qty,
      dest,
      memo,
      created_by: who,
    }).select("*").single();
    if (error) throw error;
    await notifyFactory(factoryMsg({ event: type, label: lotLabel(lot), warehouse: lot.warehouse, qty, unit: lot.unit, dest, who, memo }));
    return NextResponse.json({ ok: true, row: data });
  } catch (err) {
    console.error("[factory/txns POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "거래 등록 실패") }, { status: 500 });
  }
}
