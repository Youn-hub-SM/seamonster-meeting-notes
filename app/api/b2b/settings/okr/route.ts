import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { parseAsanaProjectGid } from "@/app/lib/voc-asana";
import { getOkrProjectGid, setOkrProjectGid, getOkrPersonalMap, setOkrPersonalMap, testOkrConnections } from "@/app/lib/okr";

export const maxDuration = 60; // 연동 점검이 프로젝트 수만큼 아사나를 호출한다

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OKR 연동 설정 — 공통 'OKR 관리' 프로젝트 + 사용자별 개인 소통방(비공개 프로젝트) 매핑.
//  아사나 연동 설정 페이지의 'OKR 연동' 카드가 쓴다. URL 을 넣으면 gid 만 추려 저장.

export async function GET() {
  try {
    const [project, map] = await Promise.all([getOkrProjectGid(), getOkrPersonalMap()]);
    return NextResponse.json({ ok: true, project: project || "", map });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST — 연동 점검: 공통 프로젝트와 매핑된 개인방 전부의 접근 가능 여부를 확인해 줄 단위로 답한다.
export async function POST() {
  try {
    const r = await testOkrConnections();
    return NextResponse.json({ ok: r.ok, lines: r.lines });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "점검 실패") }, { status: 500 });
  }
}

// PUT { project?, map? } — map 은 {사용자명: URL 또는 gid} 전체 교체(빈 값 항목은 제거)
export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as { project?: string; map?: Record<string, string> };
    if (typeof b.project === "string") {
      const gid = b.project.trim() ? parseAsanaProjectGid(b.project) : "";
      if (b.project.trim() && !gid) {
        return NextResponse.json({ ok: false, error: "OKR 프로젝트를 인식하지 못했습니다 — 아사나 프로젝트 URL이나 gid를 넣으세요." }, { status: 400 });
      }
      await setOkrProjectGid(gid);
    }
    if (b.map && typeof b.map === "object") {
      const next: Record<string, string> = {};
      for (const [name, raw] of Object.entries(b.map)) {
        const user = name.trim();
        const v = String(raw || "").trim();
        if (!user || !v) continue;
        const gid = parseAsanaProjectGid(v);
        if (!gid) return NextResponse.json({ ok: false, error: `'${user}'의 프로젝트를 인식하지 못했습니다 — URL이나 gid를 넣으세요.` }, { status: 400 });
        next[user] = gid;
      }
      await setOkrPersonalMap(next);
    }
    const [project, map] = await Promise.all([getOkrProjectGid(), getOkrPersonalMap()]);
    return NextResponse.json({ ok: true, project: project || "", map });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
