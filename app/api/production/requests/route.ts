import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { loadRequests } from "@/app/lib/wholesale-production-db";
import { toPrPurpose } from "@/app/lib/wholesale-production";
import { createProductionRequest, normalizeItems, CreateError } from "@/app/lib/production-request-create";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // 전 이력 목록(요청서·품목·입고 페이징) — 이력이 쌓여도 기본 제한에 걸리지 않게

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// GET ?status= — 도매 재고 생산 요청 목록(+품목·입고집계)
export async function GET(req: NextRequest) {
  try {
    const status = req.nextUrl.searchParams.get("status") || undefined;
    const sb = supabaseAdmin();
    const [rows, probe] = await Promise.all([
      loadRequests(sb, { status }),
      sb.from("production_request_items").select("reserved_qty").limit(1), // migration 119 적용 여부 — 미적용이면 창이 담기 경고를 띄운다
    ]);
    const reserved_supported = !(probe.error && /reserved_qty/i.test(probe.error.message));
    return NextResponse.json({ ok: true, requests: rows, reserved_supported });
  } catch (err) {
    console.error("[production/requests GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { title?, requested_by?, request_date?, due_date?, prod_start?, purpose?, memo?, items:[{product_id, requested_qty, memo?}] } — 요청서 생성
//  생성 규칙(폴백·알림 포함)은 production-request-create 에 — 주간 AI 초안도 같은 함수로 만든다.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const items = normalizeItems(b.items);
    if (!items.length) return NextResponse.json({ ok: false, error: "요청 품목과 수량을 1개 이상 입력하세요." }, { status: 400 });

    const sb = supabaseAdmin();
    const who = await actor(req);
    const purpose = toPrPurpose(b.purpose); // 용도(082·113·115) — 모르는 값은 재고 보충
    // 제조사(소매) 요청을 생산 담당자 '지인'이 직접 작성하면 확인 절차 생략 — 담당 지정 + 진행중으로 시작.
    //  (작성자 본인이 담당자라 별도 확인이 무의미. 도매 요청은 이행 주체가 달라 자동 확인 없음.)
    const autoConfirm = who === "지인" && purpose === "재고 보충";
    const full = await createProductionRequest(sb, {
      title: String(b.title || ""),
      requested_by: String(b.requested_by || ""),
      request_date: String(b.request_date || ""),
      due_date: String(b.due_date || ""),
      prod_start: b.prod_start === undefined ? undefined : String(b.prod_start || ""), // 안 보냄 = 기본 D+5, 비워서 보냄 = 요청일부터
      purpose,
      order_id: String(b.order_id || ""),
      company_id: String(b.company_id || ""),
      memo: String(b.memo || ""),
      items,
      status: autoConfirm ? "진행중" : "요청",
      assignee: autoConfirm ? who : null,
      created_by: who,
    });
    return NextResponse.json({ ok: true, request: full });
  } catch (err) {
    if (err instanceof CreateError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    console.error("[production/requests POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "요청서 생성 실패") }, { status: 500 });
  }
}
