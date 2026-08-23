import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import type { Voc } from "@/app/lib/voc";
import { getAsanaPat, getAsanaProjectGid, getAsanaDefaultAssignee, createAsanaTask, getAsanaSections, pickAsanaSection, buildTaskFromVoc } from "@/app/lib/voc-asana";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 아사나 지연 시 타임아웃(12s)+재시도가 Vercel 함수 한도 안에 들도록

// POST { id } — VOC 한 건을 아사나 프로젝트 업무로 등록 (flow-task 의 아사나판).
//  제목·본문 서식은 flow 와 동일(buildFlowTaskFromVoc 재사용 — 대표 확정 서식).
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return NextResponse.json({ ok: false, error: "id가 필요합니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const { data: voc, error } = await sb.from("voc").select("*").eq("id", body.id).maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: extractErrorMsg(error, "VOC 조회 실패") }, { status: 500 });
    if (!voc) return NextResponse.json({ ok: false, error: "VOC를 찾을 수 없습니다." }, { status: 404 });
    const v = voc as Voc;
    if (v.asana_task_at) return NextResponse.json({ ok: false, error: "이미 아사나에 등록된 VOC입니다.", already: true }, { status: 409 });

    const [pat, projectGid, assignee] = await Promise.all([getAsanaPat(), getAsanaProjectGid(), getAsanaDefaultAssignee()]);
    if (!pat) return NextResponse.json({ ok: false, error: "아사나 PAT가 설정되지 않았습니다. VOC 설정에서 등록하세요." }, { status: 400 });
    if (!projectGid) return NextResponse.json({ ok: false, error: "아사나 프로젝트가 설정되지 않았습니다. VOC 설정에서 등록하세요." }, { status: 400 });

    const { title, contents } = buildTaskFromVoc(v);
    // 항상 '개선요청' 섹션으로 — 상태 변경(진행중·완료·보류)은 아사나에서 관리한다.
    const section = pickAsanaSection(await getAsanaSections(pat, projectGid));
    const r = await createAsanaTask({
      pat, projectGid,
      name: title, notes: contents,
      assigneeEmail: assignee,
      sectionGid: section?.gid || null,
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error || "아사나 등록 실패" }, { status: 502 });

    const stamped = new Date().toISOString();
    const { error: upErr } = await sb.from("voc").update({
      asana_task_gid: r.gid, asana_task_url: r.url, asana_task_at: stamped,
    }).eq("id", v.id);
    // 마이그레이션(096) 미적용 등으로 기록 실패해도 등록 자체는 성공 — 경고만 붙인다(042/flow 패턴).
    if (upErr) return NextResponse.json({ ok: true, warning: `아사나엔 등록됐으나 상태 저장 실패: ${extractErrorMsg(upErr, "")}`, asana_task_gid: r.gid, asana_task_url: r.url });

    return NextResponse.json({ ok: true, asana_task_gid: r.gid, asana_task_url: r.url, asana_task_at: stamped, warning: r.error || undefined });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "등록 실패") }, { status: 500 });
  }
}
