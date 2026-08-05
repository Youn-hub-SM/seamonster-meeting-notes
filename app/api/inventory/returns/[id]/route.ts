import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// DELETE /api/inventory/returns/[id] — 잘못 넣은 반품 기록 삭제. 재고와 무관하므로 되돌릴 것이 없다.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { error } = await supabaseAdmin().from("purchase_returns").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/returns DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
