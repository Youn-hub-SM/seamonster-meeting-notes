// GA4 Data API 클라이언트 (서버 전용) — CRM 메시지맵의 UTM 캠페인 성과 조회.
//  인증: 구글 서비스 계정(JWT 서명 → OAuth2 토큰). 외부 SDK 없이 node:crypto RS256 서명.
//  전제: 서비스 계정 이메일을 GA4 속성에 '뷰어'로 추가해야 데이터가 나온다(403 아님, 빈 결과).
//  자격 = env: GA4_PROPERTY_ID · GA_SA_EMAIL · GA_SA_PRIVATE_KEY(개행은 \n 이스케이프 허용)

import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export function isGaConfigured(): boolean {
  return !!(process.env.GA4_PROPERTY_ID && process.env.GA_SA_EMAIL && process.env.GA_SA_PRIVATE_KEY);
}

function creds() {
  const propertyId = (process.env.GA4_PROPERTY_ID || "").trim().replace(/^properties\//, "");
  const email = (process.env.GA_SA_EMAIL || "").trim();
  // Vercel env 는 개행을 \n 문자열로 저장하는 경우가 흔함 → 실제 개행으로 복원.
  const key = (process.env.GA_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if (!propertyId || !email || !key) throw new Error("GA 자격(GA4_PROPERTY_ID·GA_SA_EMAIL·GA_SA_PRIVATE_KEY)이 설정되지 않았습니다.");
  return { propertyId, email, key };
}

// ── 서비스 계정 액세스 토큰(1시간) — 모듈 캐시로 재사용, 만료 5분 전 갱신 ──
let tokenCache: { token: string; exp: number } | null = null;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

async function accessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp - 300_000) return tokenCache.token;
  const { email, key } = creds();
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }))}`;
  let signature: Buffer;
  try { signature = createSign("RSA-SHA256").update(input).sign(key); }
  catch { throw new Error("GA_SA_PRIVATE_KEY 형식이 올바르지 않습니다 (PEM 전체를 넣었는지, 개행이 \\n 으로 들어갔는지 확인)."); }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64url(signature)}` }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(`GA 토큰 발급 실패: ${j.error_description || res.status}`);
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

// ── 캠페인별 성과 ── utm_campaign(세션 귀속) 기준: 세션·사용자·구매(거래)·구매액.
export type GaCampaignStat = { sessions: number; users: number; purchases: number; revenue: number };

export async function getCampaignStats(campaigns: string[], sinceDays = 90): Promise<Record<string, GaCampaignStat>> {
  const list = [...new Set(campaigns.map((c) => c.trim()).filter(Boolean))];
  if (list.length === 0) return {};
  const { propertyId } = creds();
  const token = await accessToken();
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${Math.max(1, sinceDays)}daysAgo`, endDate: "yesterday" }],
      dimensions: [{ name: "sessionCampaignName" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "transactions" }, { name: "purchaseRevenue" }],
      dimensionFilter: { filter: { fieldName: "sessionCampaignName", inListFilter: { values: list, caseSensitive: false } } },
      limit: String(Math.max(list.length, 50)),
    }),
    cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as {
    rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`GA API ${res.status}: ${j.error?.message || "조회 실패"}`);
  const out: Record<string, GaCampaignStat> = {};
  for (const r of j.rows || []) {
    const name = r.dimensionValues?.[0]?.value || "";
    const m = (i: number) => Number(r.metricValues?.[i]?.value) || 0;
    if (name) out[name] = { sessions: m(0), users: m(1), purchases: m(2), revenue: Math.round(m(3)) };
  }
  return out;
}

// ── 캠페인 일자별 성과 ── 추이용. 행 = 날짜 × 캠페인 (날짜 오름차순).
export type GaDailyRow = { date: string; campaign: string; sessions: number; purchases: number; revenue: number };

export async function getCampaignDaily(campaigns: string[], sinceDays = 30): Promise<GaDailyRow[]> {
  const list = [...new Set(campaigns.map((c) => c.trim()).filter(Boolean))];
  if (list.length === 0) return [];
  const { propertyId } = creds();
  const token = await accessToken();
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${Math.max(1, sinceDays)}daysAgo`, endDate: "yesterday" }],
      dimensions: [{ name: "date" }, { name: "sessionCampaignName" }],
      metrics: [{ name: "sessions" }, { name: "transactions" }, { name: "purchaseRevenue" }],
      dimensionFilter: { filter: { fieldName: "sessionCampaignName", inListFilter: { values: list, caseSensitive: false } } },
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: "10000", // 365일 × 캠페인 수십 개도 충분
    }),
    cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as {
    rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`GA API ${res.status}: ${j.error?.message || "조회 실패"}`);
  const out: GaDailyRow[] = [];
  for (const r of j.rows || []) {
    const raw = r.dimensionValues?.[0]?.value || ""; // YYYYMMDD
    const campaign = r.dimensionValues?.[1]?.value || "";
    const m = (i: number) => Number(r.metricValues?.[i]?.value) || 0;
    if (raw.length === 8 && campaign) {
      out.push({ date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, campaign, sessions: m(0), purchases: m(1), revenue: Math.round(m(2)) });
    }
  }
  return out;
}
