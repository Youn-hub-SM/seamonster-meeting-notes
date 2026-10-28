import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005, isPending007, PENDING_007 } from "@/app/lib/factory-db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

// DELETE — 기록 취소(모든 계정). 지우지 않고 취소 표시만 — 합계에서 빠지고 히스토리에 누가·언제가 남는다.
//  이미 출고된 입고분은 취소하면 재고가 마이너스라 DB 함수가 막는다.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const u = await factoryWho(req);
    const db = factoryDb();
    const { error } = await db.rpc("cancel_stock_txn", { p_id: id, p_actor: u.name });
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "P0001") return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
      if (code === "22P02") return NextResponse.json({ ok: false, error: "기록을 찾을 수 없습니다." }, { status: 404 });
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    if (isPending007(err)) return NextResponse.json({ ok: false, error: PENDING_007, pending_migration: true }, { status: 503 });
    console.error("[factory/txns DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
