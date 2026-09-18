import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { publicDb } from "@/app/lib/factory-db";
import { loadRequests } from "@/app/lib/wholesale-production-db";

export const dynamic = "force-dynamic";

// GET — 씨몬스터가 파도소리에 넘긴 생산요청(읽기 전용).
//  용도(purpose) '재고 보충' = 화면 표기 '제조사' 요청(PR_PURPOSE_LABEL) — 파도소리가 이행할 건만 보여준다.
//  '도매 납품'은 이행 주체가 달라 제외. 취소 건도 제외.
//  이 라우트만 public 스키마를 본다. 쓰기는 없다 — 파도소리 화면에서 씨몬스터 데이터를 바꾸지 않는다.
export async function GET(_req: NextRequest) {
  try {
    const all = await loadRequests(publicDb());
    const rows = all
      .filter((r) => r.purpose === "재고 보충" && r.status !== "취소")
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        req_no: r.req_no,
        title: r.title,
        request_date: r.request_date,
        due_date: r.due_date,
        status: r.status,
        total_requested: r.total_requested,
        total_received: r.total_received,
        // '[요청서에 없음]' 자동 줄(요청수량 0 — 요청서에 없던 품목의 입고 기록 자리)은 제조사에게 보이는 요청서에 넣지 않는다(엑셀 요청서와 같은 기준)
        items: r.items.filter((it) => it.requested_qty > 0).map((it) => ({ name: it.name, sku: it.sku, unit: it.unit, requested_qty: it.requested_qty, received_qty: it.received_qty })),
      }));
    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error("[factory/production-requests GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "생산요청 조회 실패") }, { status: 500 });
  }
}
