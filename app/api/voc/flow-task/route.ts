import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import type { Voc } from "@/app/lib/voc";
import { getFlowApiKey, getFlowProjectId, getFlowBase, getFlowDefaultPriority, buildFlowTaskFromVoc, vocStatusToFlow, createFlowTask, type FlowTaskBody } from "@/app/lib/voc-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { id, projectId?, priority?, endDate?, workerId? } — VOC 한 건을 flow 프로젝트 업무로 등록.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string; projectId?: string; priority?: string; endDate?: string; workerId?: string };
    if (!body.id) return NextResponse.json({ ok: false, error: "id가 필요합니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const { data: voc, error } = await sb.from("voc").select("*").eq("id", body.id).maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: extractErrorMsg(error, "VOC 조회 실패") }, { status: 500 });
    if (!voc) return NextResponse.json({ ok: false, error: "VOC를 찾을 수 없습니다." }, { status: 404 });
    const v = voc as Voc & { flow_task_at?: string | null };
    if (v.flow_task_at) return NextResponse.json({ ok: false, error: "이미 flow에 등록된 VOC입니다.", already: true }, { status: 409 });

    const [apiKey, defaultProject, base, defaultPriority] = await Promise.all([getFlowApiKey(), getFlowProjectId(), getFlowBase(), getFlowDefaultPriority()]);
    const projectId = (body.projectId || defaultProject || "").trim();
    if (!apiKey) return NextResponse.json({ ok: false, error: "flow API 키가 설정되지 않았습니다. VOC 설정에서 등록하세요." }, { status: 400 });
    if (!projectId) return NextResponse.json({ ok: false, error: "flow 프로젝트 ID가 없습니다. VOC 설정에서 기본 projectId를 등록하세요." }, { status: 400 });

    const { title, contents } = buildFlowTaskFromVoc(v);
    const taskBody: FlowTaskBody = {
      title, contents,
      status: vocStatusToFlow(v.status),
      priority: body.priority || defaultPriority || "normal",
      startDate: v.received_at ? v.received_at.replace(/-/g, "").slice(0, 8) : undefined,
      viewPermission: "all",
    };
    if (body.endDate) taskBody.endDate = body.endDate.replace(/-/g, "").slice(0, 8);
    if (body.workerId && body.workerId.trim()) taskBody.workers = [{ workerId: body.workerId.trim() }];

    const r = await createFlowTask({ base, apiKey, projectId, body: taskBody });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error || "flow 등록 실패" }, { status: 502 });

    const { error: upErr } = await sb.from("voc").update({
      flow_task_id: r.id, flow_project_id: projectId, flow_task_at: new Date().toISOString(),
    }).eq("id", v.id);
    if (upErr) return NextResponse.json({ ok: true, warning: `flow엔 등록됐으나 상태 저장 실패: ${extractErrorMsg(upErr, "")}`, flow_task_id: r.id });

    return NextResponse.json({ ok: true, flow_task_id: r.id, flow_project_id: projectId, flow_task_at: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "등록 실패") }, { status: 500 });
  }
}
