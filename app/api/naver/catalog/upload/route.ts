import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 채널 화이트리스트 — 매출원장의 판매처 표기와 반드시 일치시킨다(화면 병합·중복 제거 기준).
const CHANNELS = new Set(["스마트스토어", "쿠팡", "카페24"]);
const DEFAULT_CHANNEL = "스마트스토어"; // channel 없이 오는 기존 네이버 스크립트 하위호환

// 카탈로그 동기화 스크립트(scripts/*-catalog-*.mjs, 클라우드웨이즈 서버 크론)의 업로드 수신.
//  네이버·쿠팡은 API 가 등록 IP 만 허용해 Vercel 에서 직접 호출이 막히므로,
//  등록 IP 인 중계 서버가 채널 API 를 읽어 이 라우트로 밀어넣는다(카페24 는 IP 무관이지만 실행처 통일).
//  인증: Bearer <NAVER_COMMERCE_CLIENT_SECRET>(중계 서버와 공유하는 업로드 시크릿 — 채널 무관 공용) 또는 크론 키.
//  body: { channel?, items: CatalogItem[], live_origins?: string[] } — 마지막 청크에만 live_origins 가 와서
//  그 채널에서 내려간 origin 을 정리한다. items 는 origin 단위 delete+insert 로 멱등.

type Item = {
  item_key: string; origin_no: string; listing_name: string;
  item_kind: string; item_name: string | null; sku_code: string;
  sale_status: string | null; stock_qty: number | null;
};

function authorized(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET, process.env.DIGEST_CRON_KEY];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

export async function POST(req: NextRequest) {
  try {
    if (!authorized(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { channel?: string; items?: Item[]; live_origins?: string[]; collected_at?: string };
    const CHANNEL = body.channel || DEFAULT_CHANNEL;
    if (!CHANNELS.has(CHANNEL)) {
      return NextResponse.json({ ok: false, error: `허용되지 않은 channel: ${CHANNEL}` }, { status: 400 });
    }
    const items = Array.isArray(body.items) ? body.items : [];
    const valid = items.filter(
      (it) => it && typeof it.item_key === "string" && it.item_key && typeof it.origin_no === "string" && it.origin_no && typeof it.listing_name === "string"
    );
    if (valid.length === 0 && !Array.isArray(body.live_origins)) {
      return NextResponse.json({ ok: false, error: "items 가 비어 있습니다." }, { status: 400 });
    }

    const sb = supabaseAdmin();
    const probe = await sb.from("channel_catalog").select("id").limit(0);
    if (probe.error) {
      return NextResponse.json({ ok: false, error: "마이그레이션 107(channel_catalog) 적용이 필요합니다." }, { status: 503 });
    }

    // origin 단위 교체 적재
    const byOrigin = new Map<string, Item[]>();
    for (const it of valid) {
      const arr = byOrigin.get(it.origin_no) ?? [];
      arr.push(it);
      byOrigin.set(it.origin_no, arr);
    }
    // synced_at = 수집 시작 시각(스크립트가 동봉) — '이 재고 값이 언제 캡처됐나'의 정직한 기준.
    //  업로드 시각을 쓰면 수집(3분+) 중에 실행된 재고 명령이 '반영됨'으로 오판된다(적대 검증 확정).
    //  구 스크립트(미동봉)·미래 시각(시계 스큐)은 업로드 시각 폴백.
    const uploadedAt = new Date().toISOString();
    const collected = typeof body.collected_at === "string" && !isNaN(Date.parse(body.collected_at))
      ? new Date(body.collected_at).toISOString() : null;
    const now = collected && collected < uploadedAt ? collected : uploadedAt;
    for (const [originNo, rows] of byOrigin) {
      const { error: delErr } = await sb.from("channel_catalog").delete().eq("channel", CHANNEL).eq("origin_no", originNo);
      if (delErr) throw delErr;
      const { error: insErr } = await sb.from("channel_catalog").insert(
        rows.map((it) => ({
          channel: CHANNEL,
          item_key: it.item_key,
          origin_no: it.origin_no,
          listing_name: it.listing_name,
          item_kind: it.item_kind || "product",
          item_name: it.item_name ?? null,
          sku_code: (it.sku_code || "").trim(),
          sale_status: it.sale_status ?? null,
          stock_qty: it.stock_qty ?? null,
          synced_at: now,
        }))
      );
      if (insErr) throw insErr;
    }

    // 내려간 상품 정리 — live_origins 가 온 요청(마지막 청크)에서만.
    //  빈 배열이면 전량 삭제가 되므로 가드(스크립트도 0개면 업로드 자체를 중단한다).
    let removed = 0;
    const live = body.live_origins;
    if (Array.isArray(live) && live.length > 0) {
      const liveSet = new Set(live.map(String));
      const stale: string[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb
          .from("channel_catalog")
          .select("origin_no")
          .eq("channel", CHANNEL)
          .order("id")
          .range(from, from + 999);
        if (error) throw error;
        for (const r of data ?? []) {
          if (!liveSet.has(r.origin_no as string) && !stale.includes(r.origin_no as string)) stale.push(r.origin_no as string);
        }
        if (!data || data.length < 1000) break;
      }
      for (let i = 0; i < stale.length; i += 200) {
        const { error: delErr } = await sb.from("channel_catalog").delete().eq("channel", CHANNEL).in("origin_no", stale.slice(i, i + 200));
        if (delErr) throw delErr;
      }
      removed = stale.length;
    }

    return NextResponse.json({ ok: true, upserted_origins: byOrigin.size, rows: valid.length, removed_origins: removed });
  } catch (err) {
    console.error("[naver/catalog/upload]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "카탈로그 업로드 실패") }, { status: 500 });
  }
}
