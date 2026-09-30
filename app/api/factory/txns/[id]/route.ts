import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005 } from "@/app/lib/factory-db";
import { boxStr, lotLabel } from "@/app/lib/factory";
import { notifyFactory, factoryMsg } from "@/app/lib/factory-notify";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

// DELETE — 기록 취소(모든 계정). 지우지 않고 취소 표시만 — 합계에서 빠지고 히스토리에 누가·언제가 남는다.
//  이미 출고된 입고분은 취소하면 재고가 마이너스라 DB 함수가 막는다.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const u = await factoryWho(req);
    const db = factoryDb();
    const { data, error } = await db.rpc("cancel_stock_txn", { p_id: id, p_actor: u.name });
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "P0001") return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
      if (code === "22P02") return NextResponse.json({ ok: false, error: "기록을 찾을 수 없습니다." }, { status: 404 });
      throw error;
    }
    const t = data as { product_id: string; type: string; mfg_date: string | null; box_kg: number | string; boxes: number; memo: string | null };
    const { data: p } = await db.from("products").select("name").eq("id", t.product_id).maybeSingle();
    await Promise.race([notifyFactory(factoryMsg({
      event: `취소(${t.type})`,
      label: `${(p as { name?: string } | null)?.name ?? "품목"}(${lotLabel({ mfg_date: t.mfg_date, box_kg: Number(t.box_kg) })}) ${t.boxes > 0 && t.type !== "입고" ? "+" : ""}${boxStr(t.boxes)}`,
      who: u.name,
    })), new Promise<void>((r) => setTimeout(r, 4000))]); // 알림이 느려도 취소 응답을 붙잡지 않는다
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    console.error("[factory/txns DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
