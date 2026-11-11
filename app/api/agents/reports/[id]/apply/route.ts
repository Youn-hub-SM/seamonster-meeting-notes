import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { getReport } from "@/app/lib/agents/store";
import { applyWholesaleDraft } from "@/app/lib/agents/wholesale-apply";
import { CreateError } from "@/app/lib/production-request-create";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST — 결재. 담당자가 초안을 확인하고 누르면 초안 그대로 실제 도매 생산 요청서('도매 납품', '확정 필요' 상태)가 작성된다.
//  고칠 것이 있으면 결재가 아니라 피드백(/feedback) — 에이전트가 고친 수정본이 요청서가 된다.
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    const sb = supabaseAdmin();
    const report = await getReport(sb, id);
    if (!report) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    if (report.agent !== "wholesale-request") return NextResponse.json({ ok: false, error: "결재할 수 없는 보고서입니다." }, { status: 400 });
    if (report.status !== "done") return NextResponse.json({ ok: false, error: "작성이 끝난 초안만 결재할 수 있습니다." }, { status: 409 });
    if (report.applied) return NextResponse.json({ ok: false, error: report.request_no ? `이미 요청서 ${report.request_no} 로 작성했습니다.` : "이미 닫은 보고서입니다." }, { status: 409 });
    if (!report.draft.some((d) => d.product_id && d.qty > 0)) return NextResponse.json({ ok: false, error: "초안에 요청할 품목이 없습니다. 피드백을 보내 품목을 정하세요." }, { status: 400 });

    const token = req.cookies.get("b2b_auth")?.value;
    const who = (await verifySession(token)) || resolveUserName(token);
    const { request_no } = await applyWholesaleDraft(sb, report, who, "결재");
    return NextResponse.json({ ok: true, report: await getReport(sb, id), request_no });
  } catch (err) {
    if (err instanceof CreateError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    console.error("[agents/apply POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "요청서를 작성하지 못했습니다") }, { status: 500 });
  }
}
