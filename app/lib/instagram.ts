// 인스타그램 API 클라이언트 (서버 전용). 메타의 로그인 방식 두 가지를 모두 받는다(2026-11-11):
//  · ig = Instagram API with Instagram Login — 호스트 graph.instagram.com, 인스타 사용자 토큰(IGAA…, 60일·갱신).
//         기존 계정이 쓰는 방식. 메타 개발자 화면에서 새로 발급받는 길은 닫혔다(기존 토큰은 계속 동작, 폐지 일정 미발표).
//  · fb = Instagram API with Unified Login(통합 로그인) — 호스트 graph.facebook.com, 비즈니스 통합 시스템 사용자 토큰(EAA…, 만료 없음).
//         /me 가 없고 항상 인스타 프로페셔널 계정 ID 를 경로에 쓴다. 토큰 하나에 계정이 여럿 배정될 수 있다.
//  ⚠ 두 호스트·두 토큰은 서로 호환되지 않는다(ig 토큰을 graph.facebook.com 에, fb 토큰을 graph.instagram.com 에 쓰면 거절).
//  페이스북 페이지 연결은 둘 다 불필요. (메타광고 meta-ad.ts 는 또 다른 토큰 — 섞지 말 것)
//  용도: 댓글 웹훅 수신(라우트) + Private Reply 발송(댓글 작성자에게 1회 DM) + 게시물 목록 + 토큰 갱신.
//  계정 토큰은 env 가 아니라 화면에서 등록 → b2b_settings KV(app/lib/ig-dm.ts).

const VERSION = process.env.IG_API_VERSION || "v23.0";
export type IgKind = "ig" | "fb";
const HOST: Record<IgKind, string> = { ig: "https://graph.instagram.com", fb: "https://graph.facebook.com" };
// 호출에 필요한 최소 정보 — ig-dm.ts 의 IgAccount 가 이 모양을 포함한다. kind 가 없으면 옛 기록 = ig.
export type IgAuth = { token: string; igUserId: string; kind?: IgKind };
const kindOf = (a: { kind?: IgKind }): IgKind => (a.kind === "fb" ? "fb" : "ig");

type IgError = { error?: { message?: string; code?: number } };

async function igFetch<T>(kind: IgKind, path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HOST[kind]}/${VERSION}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as T & IgError;
  if (!res.ok) throw new Error(`인스타 API ${res.status}: ${j?.error?.message || "요청 실패"}`);
  return j;
}

// 토큰 검증 겸 프로필 — user_id 는 웹훅 entry.id 와 매칭되는 프로페셔널 계정 ID.
export type IgProfile = { user_id: string; username: string };
async function getIgProfile(token: string): Promise<IgProfile> {
  const j = await igFetch<{ user_id?: string | number; id?: string; username?: string }>("ig", `/me?fields=user_id,username`, token);
  const userId = String(j.user_id || j.id || "");
  if (!userId || !j.username) throw new Error("토큰으로 계정 정보를 읽지 못했습니다 — 인스타그램 로그인 토큰인지 확인하세요.");
  return { user_id: userId, username: j.username };
}
// 통합 로그인 토큰에 배정된 인스타 계정들(메타 개발자 화면 '액세스 토큰 생성'에서 추가한 계정).
async function listAssignedIgAccounts(token: string): Promise<IgProfile[]> {
  const j = await igFetch<{ data?: { id?: string | number; username?: string }[] }>("fb", `/me/assigned_instagram_accounts?fields=id,username&limit=50`, token);
  const list = (j.data || []).filter((a) => a.id && a.username).map((a) => ({ user_id: String(a.id), username: String(a.username) }));
  if (!list.length) throw new Error("이 토큰에 배정된 인스타그램 계정이 없습니다 — 메타 개발자 화면에서 계정을 추가하고 토큰을 다시 만드세요.");
  return list;
}
// 붙여넣은 토큰이 어느 방식인지 가려 계정을 읽는다. IG… 로 시작하면 ig 먼저, 아니면(EAA…) fb 먼저 — 틀리면 다른 쪽도 해 본다.
export async function resolveIgToken(token: string): Promise<{ kind: IgKind; profiles: IgProfile[] }> {
  const order: IgKind[] = /^IG/i.test(token) ? ["ig", "fb"] : ["fb", "ig"];
  let first: Error | null = null;
  for (const kind of order) {
    try {
      return { kind, profiles: kind === "ig" ? [await getIgProfile(token)] : await listAssignedIgAccounts(token) };
    } catch (e) { first = first || (e instanceof Error ? e : new Error(String(e))); }
  }
  throw first || new Error("토큰을 확인하지 못했습니다.");
}

// 최근 게시물 — 규칙 만들 때 게시물 픽커용.
export type IgMedia = { id: string; caption?: string; permalink?: string; media_type?: string; thumbnail_url?: string; media_url?: string; timestamp?: string };
export async function listIgMedia(a: IgAuth, limit = 25): Promise<IgMedia[]> {
  const kind = kindOf(a);
  const who = kind === "fb" ? a.igUserId : "me";
  const j = await igFetch<{ data?: IgMedia[] }>(kind, `/${who}/media?fields=id,caption,permalink,media_type,media_url,thumbnail_url,timestamp&limit=${limit}`, a.token);
  return j.data || [];
}

// Private Reply — 그 댓글 작성자에게 1회 DM. (댓글당 1회·7일 이내는 메타가 강제) 경로·본문은 두 방식이 같고 호스트만 다르다.
export async function sendPrivateReply(a: IgAuth, commentId: string, text: string): Promise<void> {
  await igFetch(kindOf(a), `/${a.igUserId}/messages`, a.token, {
    method: "POST",
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  });
}

// 앱을 이 계정의 웹훅 수신자로 구독(계정마다 1회 필요). subscribed_fields 는 댓글만.
export async function subscribeWebhook(a: IgAuth): Promise<void> {
  if (kindOf(a) === "fb") {
    await igFetch("fb", `/${a.igUserId}/subscribed_apps`, a.token, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "subscribed_fields=comments",
    });
    return;
  }
  await igFetch("ig", `/${a.igUserId}/subscribed_apps?subscribed_fields=comments`, a.token, { method: "POST", body: "{}" });
}

// 장기 토큰 갱신(ig 전용) — 60일 만료, 발급 24시간 후부터 갱신 가능. 갱신 실패는 호출부에서 무시(다음 기회에).
//  fb(통합 로그인) 토큰은 만료가 없어 갱신하지 않는다.
export async function refreshIgToken(token: string): Promise<{ token: string; expiresInSec: number }> {
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`, { cache: "no-store" });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number } & IgError;
  if (!res.ok || !j.access_token) throw new Error(`토큰 갱신 실패: ${j?.error?.message || res.status}`);
  return { token: j.access_token, expiresInSec: j.expires_in || 0 };
}
