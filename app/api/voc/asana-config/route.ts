import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getAsanaPat, setAsanaPat, getAsanaProjectGid, setAsanaProjectGid, getAsanaDefaultAssignee, setAsanaDefaultAssignee, parseAsanaProjectGid, testAsanaConnection } from "@/app/lib/voc-asana";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 아사나 연동 상태(PAT 값은 노출 안 함)
export async function GET() {
  try {
    const [pat, project, assignee] = await Promise.all([getAsanaPat(), getAsanaProjectGid(), getAsanaDefaultAssignee()]);
    return NextResponse.json({ ok: true, hasPat: !!pat, project: project || "", assignee: assignee || "", ready: !!pat && !!project });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { pat?, project?, assignee? } — 제공된 값만 저장(빈 문자열이면 해제).
//      { test: true } — 저장된 설정으로 연결 테스트(토큰·프로젝트 접근 확인).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { pat?: string; project?: string; assignee?: string; test?: boolean };

    if (b.test === true) {
      const [pat, project] = await Promise.all([getAsanaPat(), getAsanaProjectGid()]);
      if (!pat) return NextResponse.json({ ok: false, error: "아사나 PAT를 먼저 저장하세요." }, { status: 400 });
      if (!project) return NextResponse.json({ ok: false, error: "아사나 프로젝트를 먼저 저장하세요." }, { status: 400 });
      const t = await testAsanaConnection(pat, project);
      if (!t.ok) return NextResponse.json({ ok: false, error: t.error || "연결 실패" }, { status: 502 });
      return NextResponse.json({ ok: true, detail: t.detail });
    }

    if (typeof b.pat === "string") await setAsanaPat(b.pat);
    if (typeof b.project === "string") {
      const gid = b.project.trim() ? parseAsanaProjectGid(b.project) : "";
      if (b.project.trim() && !gid) {
        return NextResponse.json({ ok: false, error: "프로젝트를 인식하지 못했습니다 — 아사나 프로젝트 URL 전체나 gid 숫자를 넣으세요." }, { status: 400 });
      }
      await setAsanaProjectGid(gid);
    }
    if (typeof b.assignee === "string") await setAsanaDefaultAssignee(b.assignee);
    const [pat, project] = await Promise.all([getAsanaPat(), getAsanaProjectGid()]);
    return NextResponse.json({ ok: true, hasPat: !!pat, project: project || "", ready: !!pat && !!project });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
