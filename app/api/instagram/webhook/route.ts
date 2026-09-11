import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/app/lib/supabase";
import { sendPrivateReply } from "@/app/lib/instagram";
import { getIgAccounts } from "@/app/lib/ig-dm";
import { isRuleLive, matchesKeyword, renderDm } from "@/app/lib/ig-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 인스타 댓글 웹훅 — 미들웨어 공개 예외(메타가 호출). 보안은 로그인 대신 서명으로:
//  POST 본문의 X-Hub-Signature-256 을 앱 시크릿(IG_APP_SECRET)으로 검증 — 불일치는 무시.
//  env: IG_WEBHOOK_VERIFY_TOKEN(구독 검증 GET), IG_APP_SECRET(서명 검증).

// GET — 메타 대시보드의 웹훅 구독 검증(hub.challenge 에코)
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const mode = sp.get("hub.mode");
  const token = sp.get("hub.verify_token");
  const challenge = sp.get("hub.challenge") || "";
  const expected = (process.env.IG_WEBHOOK_VERIFY_TOKEN || "").trim();
  if (mode === "subscribe" && expected && token === expected) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ ok: false, error: "verify token 불일치" }, { status: 403 });
}

type CommentValue = {
  id?: string;                       // comment_id
  text?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
  parent_id?: string;
};
type WebhookBody = {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: CommentValue }[] }[];
};

function validSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex")); } catch { return false; }
}

// POST — 댓글 이벤트. 항상 200(메타 재시도 폭주 방지), 처리 결과는 로그 테이블로.
export async function POST(req: NextRequest) {
  const secret = (process.env.IG_APP_SECRET || "").trim();
  if (!secret) return NextResponse.json({ ok: false, error: "IG_APP_SECRET 미설정" }, { status: 503 });

  const raw = await req.text();
  if (!validSignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ ok: false, error: "서명 불일치" }, { status: 401 });
  }

  let body: WebhookBody;
  try { body = JSON.parse(raw) as WebhookBody; } catch { return NextResponse.json({ ok: true }); }

  try {
    const accounts = await getIgAccounts();
    const db = supabaseAdmin();
    const now = Date.now();

    for (const entry of body.entry || []) {
      const igUserId = String(entry.id || "");
      const account = accounts.find((a) => a.igUserId === igUserId);
      if (!account) continue; // 등록 안 된 계정의 이벤트

      for (const ch of entry.changes || []) {
        if (ch.field !== "comments") continue;
        const v = ch.value || {};
        const commentId = String(v.id || "");
        const commenterId = String(v.from?.id || "");
        const mediaId = String(v.media?.id || "");
        if (!commentId || !mediaId) continue;
        if (commenterId === igUserId) continue; // 우리 계정이 단 댓글/답글엔 DM 금지(루프 방지)

        // 이 게시물의 켜져 있는 규칙 중 키워드가 맞는 첫 번째(댓글당 DM 은 어차피 1회)
        const { data: rules } = await db.from("ig_dm_rules").select("*")
          .eq("ig_user_id", igUserId).eq("media_id", mediaId).order("created_at", { ascending: true });
        const rule = (rules || []).find((r) => isRuleLive(r, now) && matchesKeyword(r.keyword, v.text || ""));
        if (!rule) continue;

        // 멱등 — comment_id UNIQUE 선점. 선점은 'pending' 으로 넣고 발송 성공 후에만 'sent' 확정 —
        //  종전엔 sent 로 선점해 발송 실패·타임아웃이 '보낸 것'으로 남고, 재배달이 와도 unique 에
        //  막혀 그 고객은 DM 을 영영 못 받았다(감사 확정). failed 행은 재배달 때 재시도한다.
        const { error: insErr } = await db.from("ig_dm_logs").insert({
          rule_id: rule.id, ig_user_id: igUserId, comment_id: commentId,
          commenter_id: commenterId, commenter_username: v.from?.username || "",
          comment_text: (v.text || "").slice(0, 500), status: "pending",
        });
        if (insErr) {
          // unique 충돌 = 이미 본 댓글. sent 면 끝, failed(또는 10분 넘게 방치된 pending — 함수 중단 잔재)면 재시도.
          const { data: prev } = await db.from("ig_dm_logs").select("status, created_at").eq("comment_id", commentId).maybeSingle();
          const stalePending = prev?.status === "pending" && prev.created_at &&
            Date.now() - new Date(prev.created_at as string).getTime() > 10 * 60_000;
          if (prev?.status !== "failed" && !stalePending) continue;
          // error 컬럼은 not null(094) — null 을 넣으면 갱신 자체가 실패해 재시도가 무동작이 된다(검증 확정)
          const { data: claimed, error: updErr } = await db.from("ig_dm_logs")
            .update({ status: "pending", error: "" }).eq("comment_id", commentId).eq("status", prev!.status).select("comment_id");
          if (updErr) { console.error("[instagram/webhook] 재시도 선점 실패:", updErr.message); continue; }
          if (!claimed || claimed.length === 0) continue; // 다른 배달이 먼저 선점
        }

        try {
          await sendPrivateReply(account.token, igUserId, commentId, renderDm(rule.message, v.from?.username || ""));
          await db.from("ig_dm_logs").update({ status: "sent" }).eq("comment_id", commentId);
        } catch (e) {
          await db.from("ig_dm_logs").update({ status: "failed", error: String(e instanceof Error ? e.message : e).slice(0, 300) })
            .eq("comment_id", commentId);
        }
        // 댓글 폭주(이벤트 게시물) 시 인스타 API 레이트리밋 완화 — 발송 간 짧은 간격
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } catch (e) {
    console.error("[instagram/webhook]", e);
  }
  return NextResponse.json({ ok: true });
}
