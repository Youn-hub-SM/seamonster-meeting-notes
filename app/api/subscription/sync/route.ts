import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { setKv } from "@/app/lib/b2b-settings";
import { subHashKey, toSubRow, toItemRows, kstDate, isMissingTable, SYNC_KV, type SyncSubIn, type SyncPaymentIn } from "@/app/lib/subscription-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/subscription/sync — 중계 서버(scripts/cafe24-subscription-sync.mjs)가 매일 새벽 카페24 정기배송 신청 전량을 올린다(127).
//  미들웨어 예외 경로 — Bearer(업로드 공용 시크릿 또는 CRON_SECRET)로 인증.
//  body: { complete, subs: SyncSubIn[], payments?: SyncPaymentIn[] }
//   · 아이디·이름은 저장 전에 HMAC 으로 바꾼다(원문은 어디에도 남기지 않는다). 주소는 첫 낱말만.
//   · 품목은 이번 실행 시각(synced_at)으로 덮어쓰고, 이번에 온 신청의 옛 품목(옵션 삭제 등)은 지운다.
//   · complete=true(전 기간 조회 성공)일 때만 이번에 안 온 신청을 지운다 — 일부 기간 조회가 실패한 날 멀쩡한 기록이 사라지지 않게.
function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}
const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export async function POST(req: NextRequest) {
  try {
    if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const b = (await req.json()) as { complete?: boolean; subs?: SyncSubIn[]; payments?: SyncPaymentIn[] };
    const subsIn = (Array.isArray(b.subs) ? b.subs : []).filter((s) => s && typeof s.subscription_id === "string" && s.subscription_id);
    if (!subsIn.length) return NextResponse.json({ ok: false, error: "신청 데이터가 비었습니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const runAt = new Date().toISOString();
    const key = subHashKey();

    const subRows = subsIn.map((s) => toSubRow(s, runAt, key));
    const itemRows = subsIn.flatMap((s) => toItemRows(s, runAt)).filter((r) => r.subscription_item_id && r.subscription_item_id !== "undefined");
    for (const part of chunk(subRows, 500)) {
      const { error } = await sb.from("cafe24_subscriptions").upsert(part, { onConflict: "subscription_id" });
      if (error) {
        if (isMissingTable(error)) return NextResponse.json({ ok: false, error: "migration 127 미적용 — cafe24_subscriptions 테이블이 없습니다." }, { status: 500 });
        throw error;
      }
    }
    for (const part of chunk(itemRows, 500)) {
      const { error } = await sb.from("cafe24_subscription_items").upsert(part, { onConflict: "subscription_item_id" });
      if (error) throw error;
    }
    // 이번에 온 신청의 옛 품목 정리(옵션이 빠진 경우)
    for (const ids of chunk(subRows.map((s) => s.subscription_id), 100)) {
      const { error } = await sb.from("cafe24_subscription_items").delete().in("subscription_id", ids).lt("synced_at", runAt);
      if (error) throw error;
    }
    let removed = 0;
    if (b.complete === true) {
      const { data: gone, error } = await sb.from("cafe24_subscriptions").delete().lt("synced_at", runAt).select("subscription_id");
      if (error) throw error;
      removed = (gone ?? []).length;
    }

    const payRows = (Array.isArray(b.payments) ? b.payments : [])
      .filter((p) => p && p.subscription_id && p.order_id)
      .map((p) => ({
        subscription_id: String(p.subscription_id), order_id: String(p.order_id),
        status: p.status ? String(p.status).slice(0, 20) : null,
        payment_date: p.payment_date && Number.isFinite(Date.parse(String(p.payment_date))) ? new Date(Date.parse(String(p.payment_date))).toISOString() : null,
        synced_at: runAt,
      }));
    // 같은 실행 안 중복(같은 주문이 두 번) 제거 — upsert 한 묶음에 같은 키가 두 번 있으면 Postgres 가 거부한다
    const payUniq = [...new Map(payRows.map((p) => [`${p.subscription_id}|${p.order_id}`, p])).values()];
    for (const part of chunk(payUniq, 500)) {
      const { error } = await sb.from("cafe24_subscription_payments").upsert(part, { onConflict: "subscription_id,order_id" });
      if (error) throw error;
    }

    const summary = { at: runAt, asOf: kstDate(runAt), subs: subRows.length, items: itemRows.length, payments: payUniq.length, removed, complete: b.complete === true };
    try { await setKv(SYNC_KV, JSON.stringify(summary)); } catch (e) { console.warn("[subscription/sync] 요약 저장 실패", e); }
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[subscription/sync]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "정기배송 동기화 실패") }, { status: 500 });
  }
}
