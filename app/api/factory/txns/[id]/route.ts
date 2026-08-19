import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryActor } from "@/app/lib/factory-db";
import { lotLabel } from "@/app/lib/factory";
import { notifyFactory, factoryMsg } from "@/app/lib/factory-notify";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

// DELETE — 거래 취소. 이동은 짝(보낸 쪽·받은 쪽)이 함께 지워진다.
//  한쪽만 남으면 두 창고 재고가 어긋난 채로 굳는다.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const db = factoryDb();
    const { data: cur, error: ce } = await db.from("lot_txns")
      .select("id, move_id, type, qty, dest, lots(item_name, spec, tape_color, origin)")
      .eq("id", id).single();
    if (ce) throw ce;
    const t = cur as unknown as { move_id: string | null; type: string; qty: number; dest: string | null; lots: unknown };
    // 중첩 조인 결과는 타입 추론상 배열로 나온다(실제 to-one 은 객체) — 양쪽 다 수용
    const lotRow = (Array.isArray(t.lots) ? t.lots[0] : t.lots) as { item_name: string; spec: string | null; tape_color: string | null; origin: string | null } | null;
    const moveId = t.move_id;

    const { error } = moveId
      ? await db.from("lot_txns").delete().eq("move_id", moveId)
      : await db.from("lot_txns").delete().eq("id", id);
    if (error) throw error;
    await notifyFactory(factoryMsg({
      event: `취소(${t.type})`,
      label: lotRow ? lotLabel(lotRow) : "?",
      qty: -Number(t.qty), // 취소는 원거래의 반대 방향
      dest: t.dest,
      who: await factoryActor(req),
    }));
    return NextResponse.json({ ok: true, paired: !!moveId });
  } catch (err) {
    console.error("[factory/txns/:id DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "거래 취소 실패") }, { status: 500 });
  }
}
