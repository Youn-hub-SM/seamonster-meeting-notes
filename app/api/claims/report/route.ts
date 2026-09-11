import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { mirrorB2BTeams } from "@/app/lib/b2b-teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/claims/report — 중계 서버 클레임 폴러가 채널별 취소/반품/교환 요청을 밀어넣는다(112).
//  새 건(중복 아님)만 Teams 로 알림. 같은 클레임의 재전송은 (channel, claim_key) 유니크로 무시.
//  미들웨어 예외 경로 — Bearer(카탈로그 업로드와 같은 공용 시크릿)로 직접 인증.

const CHANNELS = new Set(["스마트스토어", "쿠팡", "카페24"]);
const TYPES = new Set(["취소", "반품", "교환"]);

function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET, process.env.DIGEST_CRON_KEY];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

type ClaimIn = {
  claim_type?: string; claim_key?: string; order_id?: string;
  product_name?: string; option_name?: string | null; qty?: number;
  reason?: string | null; status?: string | null; requested_at?: string | null;
};

export async function POST(req: NextRequest) {
  try {
    if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { channel?: string; claims?: ClaimIn[] };
    const channel = String(body.channel || "");
    if (!CHANNELS.has(channel)) {
      return NextResponse.json({ ok: false, error: `허용되지 않은 channel: ${channel}` }, { status: 400 });
    }
    const claims = (Array.isArray(body.claims) ? body.claims : [])
      .map((c) => ({
        claim_type: TYPES.has(String(c.claim_type)) ? String(c.claim_type) : "",
        claim_key: String(c.claim_key || "").slice(0, 200),
        order_id: String(c.order_id || "").slice(0, 100) || null,
        product_name: String(c.product_name || "").slice(0, 300) || null,
        option_name: c.option_name ? String(c.option_name).slice(0, 300) : null,
        qty: c.qty != null && Number.isFinite(Number(c.qty)) ? Number(c.qty) : null,
        reason: c.reason ? String(c.reason).slice(0, 500) : null,
        status: c.status ? String(c.status).slice(0, 100) : null,
        requested_at: c.requested_at ? String(c.requested_at).slice(0, 40) : null,
      }))
      .filter((c) => c.claim_type && c.claim_key);
    if (claims.length === 0) return NextResponse.json({ ok: true, inserted: 0, notified: 0 });

    const sb = supabaseAdmin();
    const probe = await sb.from("channel_claims").select("id").limit(0);
    if (probe.error) {
      return NextResponse.json({ ok: false, error: "마이그레이션 112(channel_claims) 적용이 필요합니다." }, { status: 503 });
    }

    // 새 건만 삽입(유니크 무시 upsert) 후, 이번에 실제로 들어간 행만 조회해 알림 —
    //  폴링 창이 겹쳐 같은 클레임이 여러 번 와도 알림은 정확히 1회.
    const inserted: typeof claims = [];
    for (const c of claims) {
      const { data, error } = await sb
        .from("channel_claims")
        .upsert({ channel, ...c }, { onConflict: "channel,claim_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      if (data && data.length > 0) inserted.push(c);
    }

    // Teams 알림 — 한 폴링분은 한 메시지로 묶는다(클레임 폭주 시 도배 방지)
    let notified = 0;
    if (inserted.length > 0) {
      const lines = inserted.slice(0, 15).map((c) =>
        `- [${c.claim_type}] ${c.product_name || "(상품명 미상)"}${c.option_name ? ` / ${c.option_name}` : ""}${c.qty ? ` x${c.qty}` : ""}` +
        `${c.order_id ? ` · 주문 ${c.order_id}` : ""}${c.reason ? ` · 사유: ${c.reason}` : ""}`);
      if (inserted.length > 15) lines.push(`- 외 ${inserted.length - 15}건`);
      const summary = `${channel} 클레임 ${inserted.length}건 접수 (취소/반품/교환)\n${lines.join("\n")}`;
      await mirrorB2BTeams(summary, null, null, { helper: true });
      notified = inserted.length;
      const keys = inserted.map((c) => c.claim_key);
      await sb.from("channel_claims").update({ notified_at: new Date().toISOString() })
        .eq("channel", channel).in("claim_key", keys);
    }

    return NextResponse.json({ ok: true, inserted: inserted.length, notified });
  } catch (err) {
    console.error("[claims/report]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "클레임 접수 실패") }, { status: 500 });
  }
}
