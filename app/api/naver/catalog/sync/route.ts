import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { getNaverToken, naverCredsStatus, fetchAllProducts, fetchOriginItems } from "@/app/lib/naver-commerce";

export const runtime = "nodejs"; // bcryptjs(naver-commerce) 사용
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CHANNEL = "스마트스토어";

// 네이버 등록 카탈로그 동기화.
//  GET  → 연결 테스트: env 상태·토큰 발급·상품 수·카탈로그 적재 현황 (동기화 안 함)
//  POST → 동기화: 상품 목록 전체 + 원상품 상세(옵션·추가상품)를 channel_catalog 에 적재.
//         상세 호출이 많으면 시간 예산(80초) 안에서 오래된 것부터 갱신하고 remaining 을 돌려준다
//         — 남으면 버튼을 다시 누르거나 다음 크론 틱이 이어서 처리.
//  인증: 로그인 사용자(화면 버튼) 또는 크론 키(Bearer CRON_SECRET/DIGEST_CRON_KEY).
//  미들웨어 예외 경로라 여기서 직접 검사한다.

async function authorized(req: NextRequest): Promise<boolean> {
  const authz = req.headers.get("authorization") || "";
  const key = new URL(req.url).searchParams.get("key");
  for (const k of [process.env.CRON_SECRET, process.env.DIGEST_CRON_KEY]) {
    if (k && (authz === `Bearer ${k}` || key === k)) return true;
  }
  const t = req.cookies.get("b2b_auth")?.value;
  return !!((await verifySession(t)) || resolveUserName(t));
}

export async function GET(req: NextRequest) {
  try {
    if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const creds = naverCredsStatus();
    if (!creds.ok) return NextResponse.json({ ok: false, step: "env", error: creds.detail });

    const tok = await getNaverToken();
    if (!tok.ok) return NextResponse.json({ ok: false, step: "token", env: creds.detail, error: tok.error });

    // 목록 1페이지만 — 연결·권한 확인용
    let totalNote = "";
    try {
      const { products } = await fetchAllProducts(tok.token);
      totalNote = `등록 원상품 ${products.length}개 확인`;
    } catch (e) {
      return NextResponse.json({ ok: false, step: "search", env: creds.detail, error: (e as Error).message });
    }

    // 카탈로그 테이블 상태 (107 미적용이어도 연결 테스트 자체는 성공으로)
    const sb = supabaseAdmin();
    const { count, error: tErr } = await sb.from("channel_catalog").select("id", { count: "exact", head: true }).eq("channel", CHANNEL);
    const table = tErr ? "마이그레이션 107(channel_catalog) 적용 필요" : `적재된 카탈로그 ${count ?? 0}행`;

    return NextResponse.json({ ok: true, env: creds.detail, connection: totalNote, table });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "연결 테스트 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  try {
    if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });

    const tok = await getNaverToken();
    if (!tok.ok) return NextResponse.json({ ok: false, error: tok.error });

    const sb = supabaseAdmin();
    // 107 미적용이면 여기서 안내
    const probe = await sb.from("channel_catalog").select("id").limit(0);
    if (probe.error) {
      return NextResponse.json({ ok: false, error: "마이그레이션 107(channel_catalog) 적용이 필요합니다." }, { status: 503 });
    }

    const { products, truncated } = await fetchAllProducts(tok.token);
    const liveOrigins = new Set(products.map((p) => String(p.originProductNo)));

    // 기존 행의 origin 별 최신 동기 시각 (서버 1000행 캡 대비 range 페이징)
    const originSynced = new Map<string, string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("channel_catalog")
        .select("origin_no, synced_at")
        .eq("channel", CHANNEL)
        .order("id")
        .range(from, from + 999);
      if (error) throw error;
      for (const r of data ?? []) {
        const prev = originSynced.get(r.origin_no as string);
        if (!prev || (r.synced_at as string) > prev) originSynced.set(r.origin_no as string, r.synced_at as string);
      }
      if (!data || data.length < 1000) break;
    }

    // 내려간(삭제된) 원상품 정리.
    //  방어: 목록이 비정상(0개인데 기존 적재 있음)이거나 페이지 캡에 걸려 절단됐으면 삭제를 건너뛴다 —
    //  API 응답 형상 변화가 '카탈로그 전체 삭제 + 성공 배너'로 둔갑하는 사고 방지.
    const staleOrigins = [...originSynced.keys()].filter((o) => !liveOrigins.has(o));
    const skipStaleDelete = truncated || (products.length === 0 && originSynced.size > 0);
    if (products.length === 0 && originSynced.size > 0) {
      return NextResponse.json({ ok: false, error: "네이버가 등록 상품 0개를 반환했습니다 — 응답 형상 변화 가능성이 있어 동기화를 중단합니다(기존 카탈로그 유지)." });
    }
    if (!skipStaleDelete && staleOrigins.length > 0) {
      // .in() 은 URL 로 인코딩되므로 청크로 나누고, 실패는 삼키지 않는다(성공 배너에 가짜 삭제 수가 남지 않게)
      for (let i = 0; i < staleOrigins.length; i += 200) {
        const { error: delErr } = await sb
          .from("channel_catalog")
          .delete()
          .eq("channel", CHANNEL)
          .in("origin_no", staleOrigins.slice(i, i + 200));
        if (delErr) throw delErr;
      }
    }

    // 미동기 → 오래된 순으로 상세 갱신 (시간 예산 80초)
    const queue = [...products].sort((a, b) => {
      const sa = originSynced.get(String(a.originProductNo)) || "";
      const sb2 = originSynced.get(String(b.originProductNo)) || "";
      return sa < sb2 ? -1 : sa > sb2 ? 1 : 0;
    });
    let updated = 0;
    let firstError: string | null = null;
    for (const p of queue) {
      if (Date.now() - started > 80_000) break;
      try {
        const items = await fetchOriginItems(tok.token, p);
        const originNo = String(p.originProductNo);
        await sb.from("channel_catalog").delete().eq("channel", CHANNEL).eq("origin_no", originNo);
        if (items.length > 0) {
          const { error: insErr } = await sb.from("channel_catalog").insert(
            items.map((it) => ({ ...it, channel: CHANNEL, synced_at: new Date().toISOString() }))
          );
          if (insErr) throw insErr;
        }
        updated++;
      } catch (e) {
        // 개별 상품 실패는 건너뛰고 계속 — 첫 에러만 보고(전형: 레이트리밋·삭제 직후 상품)
        if (!firstError) firstError = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 120)); // 레이트리밋 완화
    }

    return NextResponse.json({
      ok: true,
      products: products.length,
      updated,
      remaining: Math.max(0, products.length - updated),
      removed_origins: skipStaleDelete ? 0 : staleOrigins.length,
      truncated,
      first_error: firstError,
      took_ms: Date.now() - started,
    });
  } catch (err) {
    console.error("[naver/catalog/sync]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "카탈로그 동기화 실패") }, { status: 500 });
  }
}
