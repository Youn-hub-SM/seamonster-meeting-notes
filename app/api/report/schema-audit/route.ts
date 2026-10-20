import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg, supabaseAdmin } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { loadLiveSchema, auditPiiColumns, liveSchemaStatus } from "@/app/lib/report-live-schema";
import { BLOCKED_RELATIONS } from "@/app/lib/report-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 관리자 — AI 데이터 비서 조회 범위 점검(2026-10-20 차단 목록 방식).
//  비서가 보는 표 수, 주석(설명) 없는 표, 차단되지 않은 표에서 개인정보·비밀로 의심되는 컬럼 이름. ?refresh=1 로 캐시 갱신.
export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get("b2b_auth")?.value;
    const user = (await verifySession(token)) || resolveUserName(token);
    if (!isAdminName(user)) return NextResponse.json({ ok: false, error: "관리자만 볼 수 있습니다." }, { status: 403 });
    const live = await loadLiveSchema(supabaseAdmin(), { force: req.nextUrl.searchParams.get("refresh") === "1" });
    const rels = [...live.relations.values()];
    const noComment = rels.filter((r) => !r.comment && !r.fallback).map((r) => r.name).sort();
    const jsonbNoComment = rels.flatMap((r) => r.columns.filter((c) => c.type === "jsonb" && !c.comment && !(r.fallback && r.fallback.includes(c.name))).map((c) => `${r.name}.${c.name}`)).sort();
    return NextResponse.json({
      ok: true, fromDb: live.fromDb, loadedAt: new Date(live.loadedAt).toISOString(), status: liveSchemaStatus(),
      visible: rels.length, blocked: BLOCKED_RELATIONS,
      noComment, jsonbNoComment, pii: auditPiiColumns(live),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "스키마 점검 실패") }, { status: 500 });
  }
}
