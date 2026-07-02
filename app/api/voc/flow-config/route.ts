import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getFlowApiKey, setFlowApiKey, getFlowProjectId, setFlowProjectId, getFlowBase, setFlowBase, getFlowDefaultPriority, setFlowDefaultPriority, getFlowDefaultWorker, setFlowDefaultWorker } from "@/app/lib/voc-flow";

export const dynamic = "force-dynamic";

// GET — flow 연동 상태(API 키 값은 노출 안 함)
export async function GET() {
  try {
    const [apiKey, projectId, base, priority, worker] = await Promise.all([getFlowApiKey(), getFlowProjectId(), getFlowBase(), getFlowDefaultPriority(), getFlowDefaultWorker()]);
    return NextResponse.json({ ok: true, hasApiKey: !!apiKey, projectId: projectId || "", base: base || "", priority: priority || "normal", worker: worker || "" });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { apiKey?, projectId?, base?, priority?, worker? } — 제공된 값만 저장(빈 문자열이면 해제)
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { apiKey?: string; projectId?: string; base?: string; priority?: string; worker?: string };
    if (typeof b.apiKey === "string") await setFlowApiKey(b.apiKey);
    if (typeof b.projectId === "string") await setFlowProjectId(b.projectId);
    if (typeof b.base === "string") await setFlowBase(b.base);
    if (typeof b.priority === "string") await setFlowDefaultPriority(b.priority);
    if (typeof b.worker === "string") await setFlowDefaultWorker(b.worker);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
