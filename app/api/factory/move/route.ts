import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryActor } from "@/app/lib/factory-db";
import { lotLabel } from "@/app/lib/factory";
import { notifyFactory, factoryMsg } from "@/app/lib/factory-notify";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST { lot_id, to_warehouse_id, qty, txn_date?, memo? } — 창고 이동(외부창고 → 구평 등)
//  한 번의 입력이 move_id 로 묶인 2행을 만든다: 보내는 로트 −, 받는 로트 +.
//  받는 쪽 로트는 '이 로트에서 옮겨온 것'(origin_lot_id)으로 찾아 재사용하고, 없으면 속성을 복사해 만든다.
//  → 부분 이동을 반복해도 도착 창고에 같은 로트가 계속 쌓이지 않는다.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const lot_id = String(b.lot_id || "").trim();
    const to_warehouse_id = String(b.to_warehouse_id || "").trim();
    const qty = Math.abs(Number(b.qty));
    if (!lot_id) return NextResponse.json({ ok: false, error: "옮길 로트를 고르세요." }, { status: 400 });
    if (!to_warehouse_id) return NextResponse.json({ ok: false, error: "받을 창고를 고르세요." }, { status: 400 });
    if (!Number.isFinite(qty) || qty <= 0) return NextResponse.json({ ok: false, error: "수량을 입력하세요." }, { status: 400 });

    const db = factoryDb();
    const { data: src, error: se } = await db.from("lot_stock").select("*").eq("id", lot_id).single();
    if (se) throw se;
    const s = src as Record<string, unknown>;
    if (String(s.warehouse_id) === to_warehouse_id) {
      return NextResponse.json({ ok: false, error: "같은 창고로는 옮길 수 없습니다." }, { status: 400 });
    }
    const have = Number(s.qty) || 0;
    if (have < qty) {
      return NextResponse.json({ ok: false, error: `현재수량(${have})보다 많이 옮길 수 없습니다.` }, { status: 400 });
    }

    const { data: whs } = await db.from("warehouses").select("id,name");
    const nameOf = new Map(((whs || []) as { id: string; name: string }[]).map((w) => [String(w.id), String(w.name)]));
    const toName = nameOf.get(to_warehouse_id) || "";
    const fromName = String(s.warehouse || "");

    // 받는 로트 찾기 — 이 로트에서 이 창고로 이미 옮겨둔 것이 있으면 거기에 합친다.
    const { data: found } = await db.from("lots").select("id")
      .eq("origin_lot_id", lot_id).eq("warehouse_id", to_warehouse_id).limit(1);
    let destLotId = (found || []).length ? String((found as { id: string }[])[0].id) : "";

    const who = await factoryActor(req);
    const txn_date = DATE_RE.test(String(b.txn_date || "")) ? String(b.txn_date) : undefined;
    let createdLot = false;

    if (!destLotId) {
      const { data: newLot, error: le } = await db.from("lots").insert({
        warehouse_id: to_warehouse_id,
        item_name: s.item_name,
        spec: s.spec,
        tape_color: s.tape_color,
        origin: s.origin,
        note: s.note,
        supplier: s.supplier,
        box_kg: s.box_kg,
        unit: s.unit,
        first_in_date: txn_date || s.first_in_date,
        prod_date: s.prod_date,
        memo: s.memo,
        origin_lot_id: lot_id,
        created_by: who,
      }).select("id").single();
      if (le) throw le;
      destLotId = String((newLot as { id: string }).id);
      createdLot = true;
    }

    const move_id = crypto.randomUUID();
    const memo = String(b.memo || "").trim() || null;
    const { error: te } = await db.from("lot_txns").insert([
      { lot_id, txn_date, type: "이동", qty: -qty, dest: toName, move_id, memo, created_by: who },
      { lot_id: destLotId, txn_date, type: "이동", qty, dest: fromName, move_id, memo, created_by: who },
    ]);
    // 두 행이 한 몸이라 실패하면 방금 만든 로트까지 되돌린다(한쪽만 남으면 재고가 어긋난다).
    if (te) {
      await db.from("lot_txns").delete().eq("move_id", move_id);
      if (createdLot) await db.from("lots").delete().eq("id", destLotId);
      throw te;
    }

    await notifyFactory(factoryMsg({
      event: "창고이동",
      label: lotLabel(s as { item_name: string; spec: string | null; tape_color: string | null; origin: string | null }),
      warehouse: fromName, dest: toName, qty, unit: String(s.unit || "B"), who, memo,
    }));
    return NextResponse.json({ ok: true, move_id, dest_lot_id: destLotId });
  } catch (err) {
    console.error("[factory/move POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "창고 이동 실패") }, { status: 500 });
  }
}
