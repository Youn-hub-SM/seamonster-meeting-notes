import { NextRequest, NextResponse } from "next/server";
import { getIgProfile, refreshIgToken, subscribeWebhook } from "@/app/lib/instagram";
import { getIgAccounts, saveIgAccounts, upsertIgAccount, removeIgAccount } from "@/app/lib/ig-dm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mask = (t: string) => (t.length > 10 ? `${t.slice(0, 6)}…${t.slice(-4)}` : "…");
const REFRESH_AFTER_DAYS = 7; // 60일 만료 토큰 — 조회 때 7일 넘었으면 기회적으로 갱신(크론 없이 수명 유지)

// GET — 계정 목록(토큰 마스킹) + env 구성 상태 + 웹훅 URL. 오래된 토큰은 이 참에 갱신.
export async function GET(req: NextRequest) {
  try {
    const accounts = await getIgAccounts();
    let changed = false;
    for (const a of accounts) {
      const ageDays = (Date.now() - Date.parse(a.updatedAt || "")) / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays > REFRESH_AFTER_DAYS) {
        try {
          const r = await refreshIgToken(a.token);
          a.token = r.token; a.updatedAt = new Date().toISOString(); changed = true;
        } catch { /* 갱신 실패는 다음 기회에 — 아직 유효할 수 있음 */ }
      }
    }
    if (changed) await saveIgAccounts(accounts);
    const origin = new URL(req.url).origin;
    return NextResponse.json({
      ok: true,
      configured: { appSecret: !!process.env.IG_APP_SECRET, verifyToken: !!process.env.IG_WEBHOOK_VERIFY_TOKEN },
      webhookUrl: `${origin}/api/instagram/webhook`,
      accounts: accounts.map((a) => ({ igUserId: a.igUserId, username: a.username, tokenMasked: mask(a.token), updatedAt: a.updatedAt })),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "조회 실패" }, { status: 500 });
  }
}

// POST { token } — 토큰 붙여넣기로 계정 등록/갱신(프로필 검증 → igUserId·username 자동 채움)
//      { subscribe: igUserId } — 그 계정을 앱 웹훅 수신자로 구독(comments)
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { token?: string; subscribe?: string };
    if (body.subscribe) {
      const acc = (await getIgAccounts()).find((a) => a.igUserId === body.subscribe);
      if (!acc) return NextResponse.json({ ok: false, error: "등록되지 않은 계정입니다." }, { status: 404 });
      await subscribeWebhook(acc.token, acc.igUserId);
      return NextResponse.json({ ok: true, subscribed: acc.username });
    }
    const token = (body.token || "").trim();
    if (!token) return NextResponse.json({ ok: false, error: "토큰을 붙여넣으세요." }, { status: 400 });
    const p = await getIgProfile(token);
    const accounts = await upsertIgAccount({ igUserId: p.user_id, username: p.username, token, updatedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, added: p.username, count: accounts.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "저장 실패" }, { status: 500 });
  }
}

// DELETE ?id=<igUserId>
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    await removeIgAccount(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "삭제 실패" }, { status: 500 });
  }
}
