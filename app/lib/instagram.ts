// 인스타그램 API 클라이언트 (서버 전용) — Instagram API with Instagram Login.
//  ⚠ 호스트가 graph.facebook.com 이 아니라 **graph.instagram.com** (메타광고 meta-ad.ts 와 다른 API 패밀리).
//  페이스북 페이지 연결 불필요 — 인스타 프로페셔널 계정 토큰만으로 동작.
//  용도: 댓글 웹훅 수신(라우트) + Private Reply 발송(댓글 작성자에게 1회 DM) + 게시물 목록 + 토큰 갱신.
//  계정 토큰(3계정)은 env 가 아니라 화면에서 등록 → b2b_settings KV(app/lib/ig-dm.ts).

const VERSION = process.env.IG_API_VERSION || "v23.0";
const BASE = `https://graph.instagram.com/${VERSION}`;

type IgError = { error?: { message?: string; code?: number } };

async function igFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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
export async function getIgProfile(token: string): Promise<IgProfile> {
  const j = await igFetch<{ user_id?: string | number; id?: string; username?: string }>(`/me?fields=user_id,username`, token);
  const userId = String(j.user_id || j.id || "");
  if (!userId || !j.username) throw new Error("토큰으로 계정 정보를 읽지 못했습니다 — 인스타그램 로그인 토큰인지 확인하세요.");
  return { user_id: userId, username: j.username };
}

// 최근 게시물 — 규칙 만들 때 게시물 픽커용.
export type IgMedia = { id: string; caption?: string; permalink?: string; media_type?: string; thumbnail_url?: string; media_url?: string; timestamp?: string };
export async function listIgMedia(token: string, limit = 25): Promise<IgMedia[]> {
  const j = await igFetch<{ data?: IgMedia[] }>(`/me/media?fields=id,caption,permalink,media_type,media_url,thumbnail_url,timestamp&limit=${limit}`, token);
  return j.data || [];
}

// Private Reply — 그 댓글 작성자에게 1회 DM. (댓글당 1회·7일 이내는 메타가 강제)
export async function sendPrivateReply(token: string, igUserId: string, commentId: string, text: string): Promise<void> {
  await igFetch(`/${igUserId}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  });
}

// 앱을 이 계정의 웹훅 수신자로 구독(계정마다 1회 필요). subscribed_fields 는 댓글만.
export async function subscribeWebhook(token: string, igUserId: string): Promise<void> {
  await igFetch(`/${igUserId}/subscribed_apps?subscribed_fields=comments`, token, { method: "POST", body: "{}" });
}

// 장기 토큰 갱신 — 60일 만료, 발급 24시간 후부터 갱신 가능. 갱신 실패는 호출부에서 무시(다음 기회에).
export async function refreshIgToken(token: string): Promise<{ token: string; expiresInSec: number }> {
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`, { cache: "no-store" });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number } & IgError;
  if (!res.ok || !j.access_token) throw new Error(`토큰 갱신 실패: ${j?.error?.message || res.status}`);
  return { token: j.access_token, expiresInSec: j.expires_in || 0 };
}
