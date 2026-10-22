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

// ── 범용 리포트(2026-10-22 AI 비서·종합 리포트 ga_report 도구) ── 차원·측정항목은 허용 목록의 키만 받는다(API 이름 노출·오타 방지).
//  구매 전환율은 API 측정항목이 아니라 코드가 구매÷세션으로 계산해 붙인다(GA 의 keyEventRate 는 설정에 따라 뜻이 달라진다).
export const GA_DIMENSIONS = {
  date: { api: "date", label: "날짜" },
  channel: { api: "sessionDefaultChannelGroup", label: "채널 그룹" },          // Organic Search·Paid Social·Direct …
  source_medium: { api: "sessionSourceMedium", label: "소스/매체" },
  campaign: { api: "sessionCampaignName", label: "캠페인" },
  landing_page: { api: "landingPage", label: "랜딩 페이지" },
  device: { api: "deviceCategory", label: "기기" },
  new_vs_returning: { api: "newVsReturning", label: "신규/재방문" },
  page_path: { api: "pagePath", label: "페이지 경로" },                       // 2026-10-22 페이지 단위(/, /buy …)
  page_title: { api: "pageTitle", label: "페이지 제목" },
  event_name: { api: "eventName", label: "이벤트" },
  item_name: { api: "itemName", label: "상품명" },                             // 상품 측정항목(item_*)과만 짝
} as const;
export const GA_METRICS = {
  sessions: { api: "sessions", label: "세션" },
  users: { api: "totalUsers", label: "사용자" },
  new_users: { api: "newUsers", label: "신규 사용자" },
  engaged_sessions: { api: "engagedSessions", label: "참여 세션" },
  add_to_carts: { api: "addToCarts", label: "장바구니 담기" },
  checkouts: { api: "checkouts", label: "결제 시작" },
  purchases: { api: "transactions", label: "구매" },
  revenue: { api: "purchaseRevenue", label: "구매액(원)" },
  page_views: { api: "screenPageViews", label: "페이지 조회" },                 // 2026-10-22 페이지·참여 지표
  bounce_rate: { api: "bounceRate", label: "이탈률(%)" },                       // API 는 0~1 비율 → %
  engagement_rate: { api: "engagementRate", label: "참여율(%)" },
  event_count: { api: "eventCount", label: "이벤트 수" },
  avg_session_sec: { api: "averageSessionDuration", label: "평균 세션 시간(초)" },
  views_per_session: { api: "screenPageViewsPerSession", label: "세션당 페이지 조회" },
  key_events: { api: "keyEvents", label: "주요 이벤트" },                      // GA 에서 '주요 이벤트(전환)'로 표시한 이벤트 수
  item_views: { api: "itemsViewed", label: "상품 조회" },
  items_purchased: { api: "itemsPurchased", label: "상품 구매 수량" },
  item_revenue: { api: "itemRevenue", label: "상품 구매액(원)" },
} as const;
export type GaDimensionKey = keyof typeof GA_DIMENSIONS;
export type GaMetricKey = keyof typeof GA_METRICS;
export const GA_MAX_DAYS = 400;

export type GaReportResult = { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; note: string };
export type GaMatch = "exact" | "contains" | "begins_with";
export type GaFilter = { dimension: GaDimensionKey; match: GaMatch; value: string };
const MATCH_API: Record<GaMatch, string> = { exact: "EXACT", contains: "CONTAINS", begins_with: "BEGINS_WITH" };
const RATE_METRICS = new Set<GaMetricKey>(["bounce_rate", "engagement_rate"]); // API 비율(0~1) → %

// since·until = YYYY-MM-DD(어제까지). 행 = 차원 조합, 측정항목 순. 구매·세션이 함께 있으면 '구매 전환율(%)' 열을 덧붙인다.
//  filter = 차원 하나로 행을 거른다(예: page_path exact '/buy'). 필터 차원은 dimensions 에 없어도 된다.
//  extraDimension = 사용자 정의 측정기준 API 이름(customEvent:sm_label 등, 속성 메타데이터에 있는 것만) — 열 이름은 ':' 뒤 부분
const CUSTOM_DIM_RE = /^custom(Event|User|Item):[A-Za-z0-9_]{1,40}$/;
export async function runGaReport(p: { since: string; until: string; dimensions: GaDimensionKey[]; metrics: GaMetricKey[]; limit?: number; filter?: GaFilter | null; extraDimension?: string | null }): Promise<GaReportResult> {
  const dims = [...new Set(p.dimensions)].filter((d) => d in GA_DIMENSIONS);
  const extra = p.extraDimension && CUSTOM_DIM_RE.test(p.extraDimension) ? p.extraDimension : null;
  const extraLabel = extra ? extra.split(":")[1] : "";
  const mets = [...new Set(p.metrics)].filter((m) => m in GA_METRICS);
  if (!mets.length) throw new Error("측정항목(metrics)이 하나 이상 필요합니다.");
  const itemDim = dims.includes("item_name");
  const itemMet = mets.some((m) => m.startsWith("item"));
  if (itemMet && !itemDim) throw new Error("상품 측정항목(item_*)은 차원 item_name 과 함께 써야 합니다.");
  if (itemDim && mets.some((m) => !m.startsWith("item"))) throw new Error("차원 item_name 에는 상품 측정항목(item_views·items_purchased·item_revenue)만 함께 씁니다.");
  const limit = Math.min(5000, Math.max(1, Math.round(p.limit || 200)));
  const f = p.filter && p.filter.dimension in GA_DIMENSIONS && String(p.filter.value || "").trim() ? p.filter : null;
  const { propertyId } = creds();
  const token = await accessToken();
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: p.since, endDate: p.until }],
      dimensions: [...dims.map((d) => ({ name: GA_DIMENSIONS[d].api })), ...(extra ? [{ name: extra }] : [])],
      metrics: mets.map((m) => ({ name: GA_METRICS[m].api })),
      ...(f ? { dimensionFilter: { filter: { fieldName: GA_DIMENSIONS[f.dimension].api, stringFilter: { matchType: MATCH_API[f.match] || "EXACT", value: String(f.value).trim(), caseSensitive: false } } } } : {}),
      orderBys: dims.includes("date") ? [{ dimension: { dimensionName: "date" } }] : [{ metric: { metricName: GA_METRICS[mets[0]].api }, desc: true }],
      limit: String(limit + 1), // 한 줄 더 읽어 잘림을 안다
      keepEmptyRows: false,
    }),
    cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as {
    rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
    rowCount?: number; error?: { message?: string };
  };
  if (!res.ok) throw new Error(`GA API ${res.status}: ${j.error?.message || "조회 실패"}`);
  const si = mets.indexOf("sessions"), pi = mets.indexOf("purchases");
  const withRate = si >= 0 && pi >= 0;
  const columns = [...dims.map((d) => GA_DIMENSIONS[d].label), ...(extra ? [extraLabel] : []), ...mets.map((m) => GA_METRICS[m].label), ...(withRate ? ["구매 전환율(%)"] : [])];
  const all = j.rows || [];
  const rows = all.slice(0, limit).map((r) => {
    const row: Record<string, unknown> = {};
    dims.forEach((d, i) => {
      const v = r.dimensionValues?.[i]?.value ?? "";
      row[GA_DIMENSIONS[d].label] = d === "date" && v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
    });
    if (extra) row[extraLabel] = r.dimensionValues?.[dims.length]?.value ?? "";
    mets.forEach((m, i) => {
      const v = Number(r.metricValues?.[i]?.value) || 0;
      row[GA_METRICS[m].label] = m === "revenue" || m === "item_revenue" ? Math.round(v)
        : RATE_METRICS.has(m) ? Math.round(v * 10000) / 100
        : m === "avg_session_sec" || m === "views_per_session" ? Math.round(v * 10) / 10 : v;
    });
    if (withRate) {
      const ses = Number(r.metricValues?.[si]?.value) || 0, pur = Number(r.metricValues?.[pi]?.value) || 0;
      row["구매 전환율(%)"] = ses > 0 ? Math.round((pur / ses) * 10000) / 100 : 0;
    }
    return row;
  });
  return {
    columns, rows, rowCount: rows.length, truncated: all.length > limit,
    note: "GA4 세션 귀속 기준(마지막 클릭이 아니라 세션 시작 소스). 구매·구매액은 GA 전자상거래 이벤트 기준이라 매출 원장과 다를 수 있다. 어제까지만 확정값.",
  };
}

// ── 유입경로(단계별 이탈) — runFunnelReport(v1alpha, 구글이 '변경될 수 있음'이라 둔 API). 2026-10-22 비서 ga_funnel ──
//  단계 = 페이지 경로(unifiedPagePathScreen)·이벤트 이름(여러 개면 '그중 하나') 조건. 닫힌 유입경로(1단계부터 들어온 사용자만).
//  답 = 단계별 활성 사용자·완료율·이탈 수·이탈률. "메인 → /buy → 아무 행동 없이 나감"은 3단계(행동 이벤트들)로 두고 2단계 이탈률을 본다.
export type GaFunnelStep = { name: string; page_path?: string | null; page_match?: GaMatch | null; events?: string[] | null };
export type GaFunnelResult = { columns: string[]; rows: Record<string, unknown>[]; note: string };

export async function runGaFunnel(p: { since: string; until: string; steps: GaFunnelStep[]; open?: boolean; breakdown?: "device" | "channel" | null }): Promise<GaFunnelResult> {
  const steps = (p.steps || []).slice(0, 10).map((st, i) => {
    const exprs: Record<string, unknown>[] = [];
    const path = String(st.page_path || "").trim();
    if (path) exprs.push({ funnelFieldFilter: { fieldName: "unifiedPagePathScreen", stringFilter: { matchType: MATCH_API[st.page_match || "exact"] || "EXACT", value: path, caseSensitive: false } } });
    const evs = (st.events || []).map((e) => String(e).trim()).filter(Boolean).slice(0, 20);
    if (evs.length === 1) exprs.push({ funnelEventFilter: { eventName: evs[0] } });
    else if (evs.length > 1) exprs.push({ orGroup: { expressions: evs.map((e) => ({ funnelEventFilter: { eventName: e } })) } });
    if (!exprs.length) throw new Error(`${i + 1}단계(${st.name || ""})에 페이지 경로나 이벤트 조건이 없습니다.`);
    return { name: String(st.name || `${i + 1}단계`).slice(0, 40), filterExpression: exprs.length === 1 ? exprs[0] : { andGroup: { expressions: exprs } } };
  });
  if (steps.length < 2) throw new Error("유입경로는 단계가 2개 이상이어야 합니다.");
  const { propertyId } = creds();
  const token = await accessToken();
  const breakdown = p.breakdown === "device" ? "deviceCategory" : p.breakdown === "channel" ? "sessionDefaultChannelGroup" : null;
  const res = await fetch(`https://analyticsdata.googleapis.com/v1alpha/properties/${propertyId}:runFunnelReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: p.since, endDate: p.until }],
      funnel: { isOpenFunnel: !!p.open, steps },
      ...(breakdown ? { funnelBreakdown: { breakdownDimension: { name: breakdown }, limit: 5 } } : {}),
    }),
    cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as {
    funnelTable?: { dimensionHeaders?: { name?: string }[]; metricHeaders?: { name?: string }[]; rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[] };
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`GA 유입경로 API ${res.status}: ${j.error?.message || "조회 실패"}`);
  const t = j.funnelTable || {};
  const dh = (t.dimensionHeaders || []).map((h) => String(h.name || ""));
  // API 가 metricHeaders 를 두 번 반복해 보낸다(2026-10-22 실측: 머리글 8개·값 4개) — 행 값 개수만큼만 쓴다
  const mhAll = (t.metricHeaders || []).map((h) => String(h.name || ""));
  const nVal = Math.max(0, ...(t.rows || []).map((r) => (r.metricValues || []).length));
  const mh = mhAll.slice(0, nVal || mhAll.length);
  const dimLabel = (n: string) => (n === "funnelStepName" ? "단계" : n === "deviceCategory" ? "기기" : n === "sessionDefaultChannelGroup" ? "채널 그룹" : n);
  const metLabel = (n: string) => (n === "activeUsers" ? "사용자" : n === "funnelStepCompletionRate" ? "완료율(%)" : n === "funnelStepAbandonments" ? "이탈 수" : n === "funnelStepAbandonmentRate" ? "이탈률(%)" : n);
  const columns = [...dh.map(dimLabel), ...mh.map(metLabel)];
  const rows = (t.rows || []).map((r) => {
    const row: Record<string, unknown> = {};
    dh.forEach((n, i) => { const v = r.dimensionValues?.[i]?.value ?? ""; row[dimLabel(n)] = v === "RESERVED_TOTAL" ? "합계" : v; });
    mh.forEach((n, i) => { const v = Number(r.metricValues?.[i]?.value) || 0; row[metLabel(n)] = /Rate$/.test(n) ? Math.round(v * 10000) / 100 : v; });
    return row;
  });
  return { columns, rows, note: "닫힌 유입경로(1단계부터 들어온 사용자 기준, 사용자 수). 완료율 = 다음 단계로 간 비율, 이탈률 = 그 단계에서 멈춘 비율. 단계 사이 순서는 같은 세션 안의 선후만 본다(바로 다음일 필요 없음)." };
}
