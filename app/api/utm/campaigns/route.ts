import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/utm/campaigns — CRM 메시지가 쓰는 utm_campaign 목록(캠페인 자동완성 + 중복 경고용). 화면 열 때 1회.
//  utm_medium(149)·active 가 없는 DB 에서도 죽지 않게 열을 줄여 재시도.
export type UtmCampaignRow = { campaign: string; medium: string; title: string; active: boolean };

export async function GET() {
  try {
    const sb = supabaseAdmin();
    type Row = { title: string; links: { utm_campaign?: string } | null; utm_medium?: string; active?: boolean };
    let rows: Row[] = [];
    const tiers = ["title, links, utm_medium, active", "title, links, active", "title, links"];
    let lastErr: unknown = null;
    for (const cols of tiers) {
      const { data, error } = await sb.from("crm_messages").select(cols);
      if (!error) { rows = (data ?? []) as unknown as Row[]; lastErr = null; break; }
      lastErr = error;
      if (!/column|utm_medium|active/i.test(error.message || "")) throw error;
    }
    if (lastErr) throw lastErr;
    const campaigns: UtmCampaignRow[] = rows
      .map((r) => ({ campaign: String(r.links?.utm_campaign ?? "").trim(), medium: String(r.utm_medium ?? "").trim(), title: String(r.title ?? ""), active: r.active !== false }))
      .filter((r) => r.campaign);
    return NextResponse.json({ ok: true, campaigns });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
