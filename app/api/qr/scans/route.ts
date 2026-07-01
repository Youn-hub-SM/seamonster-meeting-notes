import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/qr/scans?link=<id> — 그 링크의 최근 스캔(최대 500) + 일자별 집계.
export async function GET(req: NextRequest) {
  try {
    const link = req.nextUrl.searchParams.get("link");
    if (!link) return NextResponse.json({ ok: false, error: "link 가 필요합니다." }, { status: 400 });
    const { data, error } = await supabaseAdmin()
      .from("qr_scans")
      .select("scanned_at, referer, user_agent, country")
      .eq("link_id", link)
      .order("scanned_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    const scans = data ?? [];
    // 일자별(KST) 집계
    const byDay = new Map<string, number>();
    for (const s of scans) {
      const d = new Date(new Date(s.scanned_at as string).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
      byDay.set(d, (byDay.get(d) || 0) + 1);
    }
    const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));
    return NextResponse.json({ ok: true, scans, daily, total: scans.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "스캔 조회 실패") }, { status: 500 });
  }
}
