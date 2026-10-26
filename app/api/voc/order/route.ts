import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { lookupVocOrder } from "@/app/lib/voc-order";

export const dynamic = "force-dynamic";

// GET /api/voc/order?order_no= — VOC 추가 창의 주문번호 확인(채널·주문일·상품·재구매 여부). 이름·연락처는 돌려주지 않는다.
export async function GET(req: NextRequest) {
  try {
    const info = await lookupVocOrder(req.nextUrl.searchParams.get("order_no"));
    return NextResponse.json({ ok: true, ...info });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "주문 확인 실패") }, { status: 500 });
  }
}
