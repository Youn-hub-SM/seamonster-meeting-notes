import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getB2BTeamsConfig, setB2BTeamsConfig, sendTeamsWebhook } from "@/app/lib/b2b-teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Teams 알림(Workflows 웹훅) 설정 — B2B 설정 화면의 'Teams 알림' 카드가 쓴다.
//  URL 은 채널 게시 권한 그 자체이므로 브라우저에는 유무(hasUrl)와 마스킹된 꼬리만 돌려준다.

export async function GET() {
  try {
    const cfg = await getB2BTeamsConfig();
    return NextResponse.json({
      ok: true,
      enabled: cfg.enabled,
      hasUrl: !!cfg.url,
      urlTail: cfg.url ? `…${cfg.url.slice(-12)}` : "",
      hasHelperUrl: !!cfg.helperUrl,
      helperTail: cfg.helperUrl ? `…${cfg.helperUrl.slice(-12)}` : "",
      hasClaimsUrl: !!cfg.claimsUrl,
      claimsTail: cfg.claimsUrl ? `…${cfg.claimsUrl.slice(-12)}` : "",
      hasInquiryUrl: !!cfg.inquiryUrl,
      inquiryTail: cfg.inquiryUrl ? `…${cfg.inquiryUrl.slice(-12)}` : "",
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { url?, helperUrl?, claimsUrl?, inquiryUrl?, enabled? } — 저장.
//  각 URL 은 비어있지 않을 때만 갱신(빈값이면 기존 유지) — 한 칸만 바꿔도 나머지가 지워지지 않는다.
export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as { url?: string; helperUrl?: string; claimsUrl?: string; inquiryUrl?: string; enabled?: boolean };
    const cur = await getB2BTeamsConfig();
    const nextUrl = b.url !== undefined && String(b.url).trim() ? String(b.url).trim() : cur.url;
    const nextHelper = b.helperUrl !== undefined && String(b.helperUrl).trim() ? String(b.helperUrl).trim() : cur.helperUrl;
    const nextClaims = b.claimsUrl !== undefined && String(b.claimsUrl).trim() ? String(b.claimsUrl).trim() : cur.claimsUrl;
    const nextInquiry = b.inquiryUrl !== undefined && String(b.inquiryUrl).trim() ? String(b.inquiryUrl).trim() : cur.inquiryUrl;
    for (const u of [nextUrl, nextHelper, nextClaims, nextInquiry]) {
      if (u && !/^https:\/\//.test(u)) {
        return NextResponse.json({ ok: false, error: "https:// 로 시작하는 웹훅 URL을 넣으세요." }, { status: 400 });
      }
    }
    const next = { url: nextUrl, helperUrl: nextHelper, claimsUrl: nextClaims, inquiryUrl: nextInquiry, enabled: b.enabled !== undefined ? !!b.enabled : cur.enabled };
    await setB2BTeamsConfig(next);
    return NextResponse.json({ ok: true, enabled: next.enabled, hasUrl: !!next.url, hasHelperUrl: !!next.helperUrl, hasClaimsUrl: !!next.claimsUrl, hasInquiryUrl: !!next.inquiryUrl });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// POST — 테스트 발송. 저장된 채널 모두로 한 장씩 보낸다(enabled 여부와 무관 — 켜기 전 확인용).
export async function POST() {
  try {
    const cfg = await getB2BTeamsConfig();
    if (!cfg.url && !cfg.helperUrl && !cfg.claimsUrl && !cfg.inquiryUrl) return NextResponse.json({ ok: false, error: "웹훅 URL을 먼저 저장하세요." }, { status: 400 });
    const results: string[] = [];
    if (cfg.url) {
      const r = await sendTeamsWebhook(
        cfg.url,
        "B2B 알림 채널 연결 확인.\n발주 알림(발송·입금·계산서)과 일정 브리핑이 이 채널로 들어옵니다.",
        { title: "씨몬스터 업무도우미 — 테스트 발송" }
      );
      results.push(r.ok ? "B2B 알림 채널 OK" : `B2B 알림 채널 실패(${r.error || r.status})`);
    }
    if (cfg.helperUrl) {
      const r = await sendTeamsWebhook(
        cfg.helperUrl,
        "업무도우미 변경알림 채널 연결 확인.\n생산·재고 변경 알림이 이 채널로 들어옵니다.",
        { title: "씨몬스터 업무도우미 — 테스트 발송" }
      );
      results.push(r.ok ? "변경알림 채널 OK" : `변경알림 채널 실패(${r.error || r.status})`);
    }
    if (cfg.claimsUrl) {
      const r = await sendTeamsWebhook(
        cfg.claimsUrl,
        "클레임 알림 채널 연결 확인.\n네이버·쿠팡·공식몰의 취소·반품·교환 요청(판매자 처리 필요)이 이 채널로 들어옵니다.",
        { title: "씨몬스터 업무도우미 — 테스트 발송" }
      );
      results.push(r.ok ? "클레임 채널 OK" : `클레임 채널 실패(${r.error || r.status})`);
    }
    if (cfg.inquiryUrl) {
      const r = await sendTeamsWebhook(
        cfg.inquiryUrl,
        "고객문의 알림 채널 연결 확인.\n네이버·쿠팡의 미답변 고객문의(주문문의·상품Q&A·고객센터문의)가 이 채널로 들어옵니다.",
        { title: "씨몬스터 업무도우미 — 테스트 발송" }
      );
      results.push(r.ok ? "고객문의 채널 OK" : `고객문의 채널 실패(${r.error || r.status})`);
    }
    // 한 장도 안 보냈는데 '완료'로 보이면 잘못된 URL 을 정상으로 오인한다 — 채널이 늘 때마다
    //  발송 블록 추가를 잊는 함정이 반복되므로 구조로 닫는다(2026-09-21 검증 지적).
    if (!results.length) return NextResponse.json({ ok: false, error: "발송된 채널이 없습니다 — 웹훅 URL을 먼저 저장하세요." }, { status: 400 });
    const anyFail = results.some((x) => x.includes("실패"));
    if (anyFail) return NextResponse.json({ ok: false, error: results.join(" · ") }, { status: 502 });
    return NextResponse.json({ ok: true, detail: results.join(" · ") });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "테스트 발송 실패") }, { status: 500 });
  }
}
