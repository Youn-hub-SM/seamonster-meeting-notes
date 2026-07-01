import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// UA → 기기/OS/브라우저(한국 인앱 브라우저 포함) 간단 파싱.
function parseUA(ua: string): { device: string; os: string; browser: string } {
  const s = (ua || "").toLowerCase();
  const device = /ipad|tablet/.test(s) ? "태블릿" : /mobile|iphone|android|ipod/.test(s) ? "모바일" : "PC";
  const os = /iphone|ipad|ios/.test(s) ? "iOS" : /android/.test(s) ? "Android" : /windows/.test(s) ? "Windows" : /mac os|macintosh/.test(s) ? "macOS" : /linux/.test(s) ? "Linux" : "기타";
  const browser = /kakaotalk/.test(s) ? "카카오톡" : /naver\(inapp|naver/.test(s) ? "네이버앱" : /whale/.test(s) ? "웨일" : /instagram/.test(s) ? "인스타그램" : /fban|fbav|fb_iab|facebook/.test(s) ? "페이스북" : /line\//.test(s) ? "라인" : /edg/.test(s) ? "Edge" : /samsungbrowser/.test(s) ? "삼성인터넷" : /crios|chrome/.test(s) ? "Chrome" : /fxios|firefox/.test(s) ? "Firefox" : /safari/.test(s) ? "Safari" : "기타";
  return { device, os, browser };
}
function sourceOf(referer: string | null): string {
  if (!referer) return "직접";
  try { return new URL(referer).hostname.replace(/^www\./, ""); } catch { return "기타"; }
}
function topN(m: Map<string, number>, n = 8): { label: string; count: number }[] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, count]) => ({ label, count }));
}

// GET /api/qr/scans?link=<id> — 그 링크의 최근 스캔(최대 2000) 파싱·집계 + 최근 목록.
export async function GET(req: NextRequest) {
  try {
    const link = req.nextUrl.searchParams.get("link");
    if (!link) return NextResponse.json({ ok: false, error: "link 가 필요합니다." }, { status: 400 });
    const { data, error } = await supabaseAdmin()
      .from("qr_scans")
      .select("scanned_at, referer, user_agent, country")
      .eq("link_id", link)
      .order("scanned_at", { ascending: false })
      .limit(2000);
    if (error) throw error;
    const scans = data ?? [];

    const byDay = new Map<string, number>(), byDevice = new Map<string, number>(), byOs = new Map<string, number>();
    const byBrowser = new Map<string, number>(), bySource = new Map<string, number>(), byCountry = new Map<string, number>();
    const byHour = new Array(24).fill(0) as number[];
    for (const s of scans) {
      const kst = new Date(new Date(s.scanned_at as string).getTime() + 9 * 3600_000);
      byDay.set(kst.toISOString().slice(0, 10), (byDay.get(kst.toISOString().slice(0, 10)) || 0) + 1);
      byHour[kst.getUTCHours()]++;
      const { device, os, browser } = parseUA(s.user_agent || "");
      byDevice.set(device, (byDevice.get(device) || 0) + 1);
      byOs.set(os, (byOs.get(os) || 0) + 1);
      byBrowser.set(browser, (byBrowser.get(browser) || 0) + 1);
      const src = sourceOf(s.referer); bySource.set(src, (bySource.get(src) || 0) + 1);
      const c = (s.country || "기타").toUpperCase(); byCountry.set(c, (byCountry.get(c) || 0) + 1);
    }
    const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));

    return NextResponse.json({
      ok: true,
      sampleSize: scans.length,
      daily,
      hourly: byHour.map((count, hour) => ({ hour, count })),
      breakdowns: { device: topN(byDevice), os: topN(byOs), browser: topN(byBrowser), source: topN(bySource), country: topN(byCountry) },
      recent: scans.slice(0, 100),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "스캔 조회 실패") }, { status: 500 });
  }
}
