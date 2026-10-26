import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { syncSolapi, kstToday, shiftDays } from "@/app/lib/crm-stats";
import { isSolapiConfigured } from "@/app/lib/solapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
