import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { getReport, saveFeedback, deleteReport } from "@/app/lib/agents/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// GET — 보고서 한 장('작성 중' 확인용)
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    const report = await getReport(supabaseAdmin(), id);
    if (!report) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "보고서를 불러오지 못했습니다") }, { status: 500 });
  }
}

// PATCH { feedback } — 평가 저장(빈 글 = 평가 지우기). 다음 실행이 이 글을 읽는다.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    const b = (await req.json()) as { feedback?: string };
    const sb = supabaseAdmin();
    await saveFeedback(sb, id, String(b.feedback || ""), await actor(req));
    return NextResponse.json({ ok: true, report: await getReport(sb, id) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "평가를 저장하지 못했습니다") }, { status: 500 });
  }
}

// DELETE — 보고서 삭제. 실패한 보고서는 누구나, 완료된 보고서는 관리자만(쌓이는 기록이 비교 자료다). 요청서로 만든 보고서는 지우지 않는다.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    const sb = supabaseAdmin();
    const report = await getReport(sb, id);
    if (!report) return NextResponse.json({ ok: true });
    if (report.status === "running") return NextResponse.json({ ok: false, error: "작성 중인 보고서는 지울 수 없습니다." }, { status: 409 });
    if (report.request_id) return NextResponse.json({ ok: false, error: "요청서로 만든 보고서는 지울 수 없습니다." }, { status: 409 });
    if (report.status === "done" && !isAdminName(await actor(req))) return NextResponse.json({ ok: false, error: "완료된 보고서는 관리자만 지울 수 있습니다." }, { status: 403 });
    await deleteReport(sb, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "보고서를 지우지 못했습니다") }, { status: 500 });
  }
}
