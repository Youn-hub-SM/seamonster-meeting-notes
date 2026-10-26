import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { syncSolapi, kstToday, shiftDays, getSolapiTemplateMap, refreshSolapiTemplates } from "@/app/lib/crm-stats";
import { isSolapiConfigured } from "@/app/lib/solapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — 템플릿 ID → 이름(표(편집)의 솔라피 템플릿 선택지). ?refresh=1 이면 API 에서 다시 받는다.
export async function GET(req: NextRequest) {
  try {
    if (!isSolapiConfigured()) return NextResponse.json({ ok: true, configured: false, templates: [] });
    let map = await getSolapiTemplateMap();
    if (req.nextUrl.searchParams.get("refresh") === "1" || !Object.keys(map).length) { await refreshSolapiTemplates(); map = await getSolapiTemplateMap(); }
    return NextResponse.json({ ok: true, configured: true, templates: Object.entries(map).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ko")) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "템플릿 조회 실패") }, { status: 500 });
  }
}

// POST { since?, until? } — 솔라피 발송 내역을 가져와 일별×종류×템플릿으로 저장. 기본 최근 14일(다시 가져오면 덮어쓴다).
export async function POST(req: NextRequest) {
  try {
    if (!isSolapiConfigured()) return NextResponse.json({ ok: false, error: "솔라피 API 키가 없습니다(Vercel 환경 변수 SOLAPI_API_KEY·SOLAPI_API_SECRET)." }, { status: 400 });
    const b = (await req.json().catch(() => ({}))) as { since?: string; until?: string };
    const until = /^\d{4}-\d{2}-\d{2}$/.test(b.until || "") ? String(b.until) : kstToday();
    const since = /^\d{4}-\d{2}-\d{2}$/.test(b.since || "") ? String(b.since) : shiftDays(until, -13);
    if (since > until) return NextResponse.json({ ok: false, error: "기간이 올바르지 않습니다." }, { status: 400 });
    const r = await syncSolapi({ since, until });
    return NextResponse.json({ ok: true, since, until, ...r });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "솔라피 가져오기 실패") }, { status: 500 });
  }
}
