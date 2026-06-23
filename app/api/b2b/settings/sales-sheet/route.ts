import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getSalesSheetUrl, setSalesSheetUrl } from "@/app/lib/b2b-sheet-export";

export const dynamic = "force-dynamic";

// GET — 현재 매출 시트(Apps Script) URL
export async function GET() {
  try {
    const url = await getSalesSheetUrl();
    return NextResponse.json({ ok: true, url, connected: !!url });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { url } — 저장(빈 값이면 연동 해제)
export async function PUT(req: NextRequest) {
  try {
    const { url } = (await req.json()) as { url?: string };
    const u = (url || "").trim();
    if (u && !/^https:\/\/script\.google\.com\//.test(u)) {
      return NextResponse.json(
        { ok: false, error: "Apps Script 웹앱 URL(https://script.google.com/...) 형식이 아닙니다." },
        { status: 400 }
      );
    }
    await setSalesSheetUrl(u);
    return NextResponse.json({ ok: true, url: u, connected: !!u });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// POST — 연결 테스트(빈 rows 전송 → 시트에 아무것도 안 쌓고 도달만 확인)
export async function POST() {
  try {
    const url = await getSalesSheetUrl();
    if (!url) return NextResponse.json({ ok: false, error: "먼저 URL을 저장하세요." }, { status: 400 });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ rows: [] }),
    });
    const text = await res.text();
    if (!res.ok || /"ok"\s*:\s*false/.test(text)) {
      return NextResponse.json({ ok: false, error: `응답 이상 (HTTP ${res.status}) ${text.slice(0, 150)}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, message: "연결 정상 — 시트에 빈 전송이 도달했습니다." });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "연결 실패") }, { status: 500 });
  }
}
