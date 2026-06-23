import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
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

// POST — 연결 진단: (1) 마이그레이션 021(exported_at) (2) URL 저장 (3) Apps Script 도달·응답
export async function POST() {
  const diag: Record<string, unknown> = {};
  try {
    // (1) 마이그레이션 021 확인 — exported_at 컬럼 select 시도
    try {
      const sb = supabaseAdmin();
      const { error } = await sb.from("orders").select("exported_at").limit(1);
      diag.migration021 = !error;
      if (error) diag.migration021Error = error.message;
    } catch (e) {
      diag.migration021 = false;
      diag.migration021Error = e instanceof Error ? e.message : String(e);
    }

    // (2) URL
    const url = await getSalesSheetUrl();
    diag.urlSet = !!url;
    if (!url) {
      return NextResponse.json({ ok: false, error: "Apps Script URL이 저장돼 있지 않습니다.", diag }, { status: 400 });
    }

    // (3) Apps Script 도달 + 응답이 우리 JSON 인지 (빈 rows → 시트에 아무것도 안 쌓음)
    let text = "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ rows: [] }),
      });
      diag.httpStatus = res.status;
      text = await res.text();
    } catch (e) {
      diag.fetchError = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: "Apps Script URL 호출 실패 — URL을 확인하세요.", diag }, { status: 502 });
    }
    diag.responseSnippet = text.slice(0, 200);

    // 우리 Apps Script 는 {ok:true} 를 반환. HTML(권한/로그인 페이지)이면 매칭 안 됨.
    if (!/"ok"\s*:\s*true/.test(text)) {
      return NextResponse.json(
        {
          ok: false,
          error: "Apps Script가 정상 JSON을 반환하지 않습니다. 배포 시 액세스 권한이 '모든 사용자'인지, 코드가 배포 버전에 반영됐는지 확인하세요.",
          diag,
        },
        { status: 502 }
      );
    }

    if (!diag.migration021) {
      return NextResponse.json(
        { ok: false, error: "연결은 정상이나 마이그레이션 021(orders.exported_at)이 적용되지 않았습니다 — 발송완료 전송이 안 됩니다.", diag },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, message: "연결 정상 · 마이그레이션 OK — 전송 준비 완료.", diag });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "연결 실패"), diag }, { status: 500 });
  }
}
