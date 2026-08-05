import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb } from "@/app/lib/factory-db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

// DELETE — 거래 취소. 이동은 짝(보낸 쪽·받은 쪽)이 함께 지워진다.
//  한쪽만 남으면 두 창고 재고가 어긋난 채로 굳는다.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const db = factoryDb();
    const { data: cur, error: ce } = await db.from("lot_txns").select("id, move_id").eq("id", id).single();
    if (ce) throw ce;
    const moveId = (cur as { move_id: string | null }).move_id;

    const { error } = moveId
      ? await db.from("lot_txns").delete().eq("move_id", moveId)
      : await db.from("lot_txns").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true, paired: !!moveId });
  } catch (err) {
    console.error("[factory/txns/:id DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "거래 취소 실패") }, { status: 500 });
  }
}
