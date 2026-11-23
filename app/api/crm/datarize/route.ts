import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { kstToday, shiftDays } from "@/app/lib/crm-stats";
import { isDatarizeConfigured, loadCatalog, syncDatarize, buildCheck, creativesFor, DatarizeError } from "@/app/lib/datarize";
import type { CrmMessage } from "@/app/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 데이터라이즈 연동(CRM 메시지맵, 2026-11-24) — 리포팅 API 읽기 전용(app/lib/datarize.ts).
//  GET                → 맵과 실제의 차이: 켜져 있는데 맵에 없는 캠페인, 맵에는 있는데 꺼졌거나 지워진 메시지. ?refresh=1 이면 목록을 새로 받는다(평소 1시간 보관).
//  GET ?message=<id>  → 그 메시지의 utm_campaign(+별칭)으로 나가는 실제 소재(문구·버튼)
//  POST { since?, until? } → 일별×소재 발송·클릭·비용을 crm_send_stats 에 저장. 기본 최근 12주(다시 가져오면 덮어쓴다, 180일까지).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NO_KEY = "데이터라이즈 API 키가 없습니다(Vercel 환경 변수 DATARIZE_API_KEY).";
type MsgLite = Pick<CrmMessage, "id" | "title" | "links" | "active">;

export async function GET(req: NextRequest) {
  try {
    if (!isDatarizeConfigured()) return NextResponse.json({ ok: true, configured: false });
    const sp = req.nextUrl.searchParams;
    const sb = supabaseAdmin();
    const messageId = sp.get("message");
    if (messageId) {
      const { data, error } = await sb.from("crm_messages").select("id,title,links,active").eq("id", messageId).maybeSingle();
      if (error) throw error;
      if (!data) return NextResponse.json({ ok: true, configured: true, creatives: [] });
      const catalog = await loadCatalog();
      return NextResponse.json({ ok: true, configured: true, at: catalog.at, creatives: creativesFor(catalog, data as unknown as MsgLite) });
    }
    const [catalog, msgs] = await Promise.all([loadCatalog(sp.get("refresh") === "1"), sb.from("crm_messages").select("id,title,links,active").limit(2000)]);
    if (msgs.error) throw msgs.error;
    return NextResponse.json({ ok: true, configured: true, check: buildCheck(catalog, (msgs.data || []) as unknown as MsgLite[]) });
  } catch (err) {
    if (err instanceof DatarizeError) return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "데이터라이즈 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isDatarizeConfigured()) return NextResponse.json({ ok: false, error: NO_KEY }, { status: 400 });
    const b = (await req.json().catch(() => ({}))) as { since?: string; until?: string };
    const today = kstToday();
    const until = DATE_RE.test(b.until || "") && String(b.until) < today ? String(b.until) : today;
    let since = DATE_RE.test(b.since || "") ? String(b.since) : shiftDays(until, -83);
    const floor = shiftDays(today, -179); // 성과는 최근 180일까지만 조회된다
    if (since < floor) since = floor;
    if (since > until) return NextResponse.json({ ok: false, error: "기간이 올바르지 않습니다." }, { status: 400 });
    const r = await syncDatarize({ since, until });
    return NextResponse.json({ ok: true, since, until, ...r });
  } catch (err) {
    if (err instanceof DatarizeError) return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "데이터라이즈 가져오기 실패") }, { status: 500 });
  }
}
