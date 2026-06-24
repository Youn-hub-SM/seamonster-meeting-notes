import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getPromotions, upsertPromotion, deletePromotion, Promotion } from "@/app/lib/production-promotions";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const promotions = await getPromotions();
    return NextResponse.json({ ok: true, promotions });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<Promotion>;
    const promotions = await upsertPromotion(body);
    return NextResponse.json({ ok: true, promotions });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const promotions = await deletePromotion(id);
    return NextResponse.json({ ok: true, promotions });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
