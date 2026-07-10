// 메타(페이스북/인스타) 마케팅 API 클라이언트 (서버 전용) — 초기 스캐폴드.
//  Base: https://graph.facebook.com/{version}
//  인증: access_token (시스템 사용자 장기 토큰 권장). 광고 계정 id 는 act_{id} 형식.
//  자격 = env: META_ACCESS_TOKEN · META_AD_ACCOUNT_ID (·선택 META_API_VERSION)
//  용도(예정): 캠페인/광고세트/소재 + 성과 조회, 광고 켜기/끄기. 5단계 파이프라인 관리.

const VERSION = process.env.META_API_VERSION || "v21.0";
const BASE = `https://graph.facebook.com/${VERSION}`;

export function isMetaAdConfigured(): boolean {
  return !!(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
}

function creds() {
  const token = process.env.META_ACCESS_TOKEN || "";
  const rawAcct = process.env.META_AD_ACCOUNT_ID || "";
  if (!token || !rawAcct) throw new Error("메타 광고 API 자격(META_ACCESS_TOKEN·META_AD_ACCOUNT_ID)이 설정되지 않았습니다.");
  const accountId = rawAcct.startsWith("act_") ? rawAcct : `act_${rawAcct}`;
  return { token, accountId };
}

// Graph API GET 요청. path 는 "/act_.../campaigns" 등. access_token 자동 부착.
export async function metaGet<T = unknown>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const { token } = creds();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.append(k, String(v));
  qs.append("access_token", token);
  const res = await fetch(`${BASE}${path}?${qs}`, { cache: "no-store" });
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = (json as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`메타 API ${res.status}: ${err || text.slice(0, 200) || ""}`);
  }
  return json as T;
}

// 자격 확인용 가벼운 핑(광고 계정 이름·상태).
export async function pingMetaAd(): Promise<{ ok: boolean; name?: string; accountStatus?: number }> {
  const { accountId } = creds();
  const j = await metaGet<{ name?: string; account_status?: number }>(`/${accountId}`, { fields: "name,account_status" });
  return { ok: true, name: j.name, accountStatus: j.account_status };
}
