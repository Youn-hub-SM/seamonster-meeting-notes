import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb } from "@/app/lib/factory-db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_FIELDS = ["item_name", "spec", "tape_color", "origin", "note", "supplier", "unit", "memo"] as const;

// GET — 로트 1건 + 거래 내역
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const db = factoryDb();
    const { data: lot, error } = await db.from("lot_stock").select("*").eq("id", id).single();
    if (error) throw error;
    const { data: txns } = await db.from("lot_txns").select("*").eq("lot_id", id)
      .order("txn_date", { ascending: false }).order("created_at", { ascending: false });
    return NextResponse.json({ ok: true, lot, txns: txns || [] });
  } catch (err) {
    console.error("[factory/lots/:id GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "로트 조회 실패") }, { status: 500 });
  }
}

// PATCH — 로트 속성 수정. 수량은 여기서 바꾸지 않는다(거래로만 움직인다).
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const b = (await req.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    for (const k of TEXT_FIELDS) {
      if (k in b) {
        const v = String(b[k] ?? "").trim();
        if (k === "item_name" && !v) return NextResponse.json({ ok: false, error: "품명은 비울 수 없습니다." }, { status: 400 });
        patch[k] = v || (k === "unit" ? "B" : null);
      }
    }
    if ("warehouse_id" in b && String(b.warehouse_id || "").trim()) patch.warehouse_id = String(b.warehouse_id);
    if ("box_kg" in b) {
      const n = Number(b.box_kg);
      patch.box_kg = b.box_kg === "" || b.box_kg === null || !Number.isFinite(n) ? null : n;
    }
    for (const k of ["first_in_date", "prod_date"] as const) {
      if (k in b) patch[k] = DATE_RE.test(String(b[k] || "")) ? String(b[k]) : null;
    }

    const { error } = await factoryDb().from("lots").update(patch).eq("id", id);
    if (error) throw error;
    const { data } = await factoryDb().from("lot_stock").select("*").eq("id", id).single();
    return NextResponse.json({ ok: true, row: data });
  } catch (err) {
    console.error("[factory/lots/:id PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "로트 수정 실패") }, { status: 500 });
  }
}

// DELETE — 로트 삭제. 거래도 함께 사라진다(on delete cascade).
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const { error } = await factoryDb().from("lots").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[factory/lots/:id DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "로트 삭제 실패") }, { status: 500 });
  }
}
