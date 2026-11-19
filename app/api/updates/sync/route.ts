import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/app/lib/admin-req";
import { syncUpdateNotes } from "@/app/lib/update-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 업데이트 노트(코드 파일)를 update_notes 표(migration 171)에 지금 맞춘다. 관리자만.
//  평소에는 일정 알림 크론이 한 시간에 한 번 맞춘다 — 이 주소는 171 을 적용한 직후처럼 기다리지 않고 바로 채울 때 쓴다.
//  운영에서만 쓴다. 베타·로컬에서는 무엇이 바뀔지 세기만 한다(wrote: false) — 운영에 안 나간 소식이 표에 들어가지 않게.
export async function GET(req: NextRequest) {
  const deny = await adminOnly(req);
  if (deny) return deny;
  try {
    return NextResponse.json(await syncUpdateNotes());
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "맞추기 실패" }, { status: 500 });
  }
}
