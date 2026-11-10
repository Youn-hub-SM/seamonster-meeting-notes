import { NextRequest, NextResponse } from "next/server";
import { resolveIgToken, refreshIgToken, subscribeWebhook, IgNeedAccountId } from "@/app/lib/instagram";
import { getIgAccounts, saveIgAccounts, removeIgAccount } from "@/app/lib/ig-dm";

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
      if (a.kind === "fb") continue; // 통합 로그인 토큰은 만료가 없다
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
      configured: { appSecret: !!process.env.IG_APP_SECRET, metaSecret: !!process.env.META_APP_SECRET, verifyToken: !!process.env.IG_WEBHOOK_VERIFY_TOKEN },
      webhookUrl: `${origin}/api/instagram/webhook`,
      accounts: accounts.map((a) => ({ igUserId: a.igUserId, username: a.username, kind: a.kind === "fb" ? "fb" : "ig", tokenMasked: mask(a.token), updatedAt: a.updatedAt })),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "조회 실패" }, { status: 500 });
  }
}

// POST { token } — 토큰 붙여넣기로 계정 등록/갱신(토큰 종류 판별 → igUserId·username 자동 채움. 통합 로그인 토큰은 배정된 계정 전부)
//      { subscribe: igUserId } — 그 계정을 앱 웹훅 수신자로 구독(comments)
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { token?: string; subscribe?: string; igUserId?: string };
    if (body.subscribe) {
      const acc = (await getIgAccounts()).find((a) => a.igUserId === body.subscribe);
      if (!acc) return NextResponse.json({ ok: false, error: "등록되지 않은 계정입니다." }, { status: 404 });
      await subscribeWebhook(acc);
      return NextResponse.json({ ok: true, subscribed: acc.username });
    }
    const token = (body.token || "").trim();
    if (!token) return NextResponse.json({ ok: false, error: "토큰을 붙여넣으세요." }, { status: 400 });
    const wantId = (body.igUserId || "").replace(/\D/g, "");
    const { kind, profiles } = await resolveIgToken(token, wantId || undefined);
    const now = new Date().toISOString();
    const current = await getIgAccounts();
    // 통합 로그인 토큰은 배정된 계정을 전부 돌려준다 — 이미 Instagram 로그인(ig)으로 연결돼 잘 돌고 있는 계정은 건드리지 않는다.
    //  (그 계정도 새 방식으로 옮기려면 먼저 연결을 해제하고 다시 넣는다)
    const keepIg = new Set(kind === "fb" ? current.filter((a) => a.kind !== "fb").map((a) => a.igUserId) : []);
    const fresh = profiles.filter((p) => !keepIg.has(p.user_id));
    const skipped = profiles.filter((p) => keepIg.has(p.user_id)).map((p) => p.username);
    if (!fresh.length) return NextResponse.json({ ok: false, error: `이 토큰의 계정(@${skipped.join(", @")})은 이미 연결되어 있습니다. 새 계정을 메타 개발자 화면에서 추가한 뒤 토큰을 다시 만드세요.` }, { status: 409 });
    const ids = new Set(fresh.map((p) => p.user_id));
    const accounts = [
      ...current.filter((a) => !ids.has(a.igUserId)),
      ...fresh.map((p) => ({ igUserId: p.user_id, username: p.username, token, kind, updatedAt: now })),
    ];
    await saveIgAccounts(accounts);
    return NextResponse.json({ ok: true, added: fresh.map((p) => p.username).join(", @"), skipped, kind, count: accounts.length });
  } catch (err) {
    if (err instanceof IgNeedAccountId) return NextResponse.json({ ok: false, needAccountId: true, error: err.message }, { status: 422 });
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
