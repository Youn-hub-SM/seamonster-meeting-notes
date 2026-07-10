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
  const token = (process.env.META_ACCESS_TOKEN || "").trim();
  const rawAcct = (process.env.META_AD_ACCOUNT_ID || "").trim().replace(/\s+/g, ""); // 공백/개행 제거(붙여넣기 시 흔함)
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

// 자격 확인용 가벼운 핑(광고 계정 이름·상태·통화).
export async function pingMetaAd(): Promise<{ ok: boolean; name?: string; accountStatus?: number; currency?: string }> {
  const { accountId } = creds();
  const j = await metaGet<{ name?: string; account_status?: number; currency?: string }>(`/${accountId}`, { fields: "name,account_status,currency" });
  return { ok: true, name: j.name, accountStatus: j.account_status, currency: j.currency };
}

// ── 목록 조회(페이지네이션) ──
async function metaList<T>(path: string, params: Record<string, string | number | undefined>): Promise<T[]> {
  const first = await metaGet<{ data?: T[]; paging?: { next?: string } }>(path, { ...params, limit: 500 });
  const out: T[] = [...(first.data || [])];
  let next = first.paging?.next;
  for (let i = 0; i < 10 && next; i++) {
    const res = await fetch(next, { cache: "no-store" });
    const j = (await res.json().catch(() => ({}))) as { data?: T[]; paging?: { next?: string } };
    out.push(...(j.data || [])); next = j.paging?.next;
  }
  return out;
}

// ── 타입 ──
export type MetaCampaign = { id: string; name: string; status: string; effective_status: string; objective?: string; daily_budget?: string; lifetime_budget?: string; bid_strategy?: string };
export type MetaAdset = { id: string; name: string; status: string; effective_status: string; campaign_id: string; daily_budget?: string; lifetime_budget?: string; optimization_goal?: string };
export type MetaAd = { id: string; name: string; status: string; effective_status: string; adset_id: string; campaign_id?: string; creative?: { id?: string; thumbnail_url?: string } };
export type MetaInsight = { spend: number; impressions: number; clicks: number; ctr: number; cpc: number; purchases: number; purchaseValue: number; roas: number; cpa: number };
export type StatRange = { datePreset?: string; since?: string; until?: string };

export function listCampaigns() {
  const { accountId } = creds();
  return metaList<MetaCampaign>(`/${accountId}/campaigns`, { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy" });
}
export function listAdsets() {
  const { accountId } = creds();
  return metaList<MetaAdset>(`/${accountId}/adsets`, { fields: "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal" });
}
export function listAds() {
  const { accountId } = creds();
  return metaList<MetaAd>(`/${accountId}/ads`, { fields: "id,name,status,effective_status,adset_id,campaign_id,creative{id,thumbnail_url}" });
}

// ── 성과(인사이트) ── level별 엔티티id 키로 병합. purchase 계열 액션에서 구매수/매출/ROAS/CPA 추출.
type InsightRow = Record<string, unknown> & { campaign_id?: string; adset_id?: string; ad_id?: string };
const PURCHASE_KEYS = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];
function pickAction(arr: unknown, keys: string[]): number {
  if (!Array.isArray(arr)) return 0;
  const list = arr as { action_type?: string; value?: string }[];
  for (const k of keys) { const f = list.find((a) => a.action_type === k); if (f) return Number(f.value) || 0; }
  const g = list.find((a) => String(a.action_type || "").includes("purchase")); // 폴백: purchase 포함 키
  return g ? Number(g.value) || 0 : 0;
}
function parseInsight(r: InsightRow): MetaInsight {
  const spend = Number(r.spend) || 0;
  const purchases = pickAction(r.actions, PURCHASE_KEYS);
  const purchaseValue = pickAction(r.action_values, PURCHASE_KEYS);
  let roas = pickAction(r.purchase_roas, PURCHASE_KEYS);
  if (!roas && spend) roas = purchaseValue / spend;
  const cpa = pickAction(r.cost_per_action_type, PURCHASE_KEYS);
  return { spend, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, ctr: Number(r.ctr) || 0, cpc: Number(r.cpc) || 0, purchases, purchaseValue, roas, cpa };
}
export async function getInsights(level: "campaign" | "adset" | "ad", range: StatRange = {}, debug = false): Promise<{ byId: Record<string, MetaInsight>; rawSample?: InsightRow }> {
  const { accountId } = creds();
  const key = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
  // level만으로는 breakdown id 가 안 붙는 경우가 있어 fields 에 명시.
  const params: Record<string, string> = { level, fields: `${key},spend,impressions,clicks,ctr,cpc,actions,action_values,purchase_roas,cost_per_action_type` };
  if (range.since && range.until) params.time_range = JSON.stringify({ since: range.since, until: range.until });
  else params.date_preset = range.datePreset || "last_7d";
  const rows = await metaList<InsightRow>(`/${accountId}/insights`, params);
  const byId: Record<string, MetaInsight> = {};
  for (const r of rows) { const id = r[key] as string | undefined; if (id) byId[id] = parseInsight(r); }
  return { byId, ...(debug ? { rawSample: rows[0] } : {}) };
}

// ── 광고 켜기/끄기 ── campaign/adset/ad 공통(엔티티 id 로 status 변경).
export async function setEntityStatus(id: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
  const { token } = creds();
  const res = await fetch(`${BASE}/${id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ status, access_token: token }) });
  const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new Error(`메타 API ${res.status}: ${j?.error?.message || "상태 변경 실패"}`);
}

// ── 단계 분류 ── 예산이 캠페인에 있으면 CBO, 광고세트에 있으면 ABO.
export const isCBO = (c: MetaCampaign) => !!(Number(c.daily_budget) || Number(c.lifetime_budget));
export const isABO = (a: MetaAdset) => !!(Number(a.daily_budget) || Number(a.lifetime_budget));

// ── 진단 ── 토큰 스코프 + 접근 가능한 광고계정 + 대상 계정 접근 여부. 권한 문제 원인 파악용.
export async function metaDiagnostics(): Promise<Record<string, unknown>> {
  const { token, accountId } = creds();
  const out: Record<string, unknown> = { targetAccountId: accountId };
  try { out.me = await metaGet<{ id?: string; name?: string }>("/me", { fields: "id,name" }); } catch (e) { out.meErr = String((e as Error)?.message || e); }
  try {
    const dt = await metaGet<{ data?: { scopes?: string[]; type?: string; app_id?: string; is_valid?: boolean; expires_at?: number; data_access_expires_at?: number } }>("/debug_token", { input_token: token });
    out.scopes = dt?.data?.scopes; out.tokenType = dt?.data?.type; out.appId = dt?.data?.app_id; out.tokenValid = dt?.data?.is_valid;
    out.expiresAt = dt?.data?.expires_at; // 0 = 만료 없음
    out.dataAccessExpiresAt = dt?.data?.data_access_expires_at;
  } catch (e) { out.debugTokenErr = String((e as Error)?.message || e); }
  try {
    const aa = await metaGet<{ data?: { id?: string; name?: string; account_status?: number }[] }>("/me/adaccounts", { fields: "id,name,account_status", limit: 200 });
    const list = (aa?.data || []).map((a) => ({ id: a.id, name: a.name }));
    out.adAccounts = list;
    out.targetInList = list.some((a) => a.id === accountId);
  } catch (e) { out.adAccountsErr = String((e as Error)?.message || e); }
  return out;
}
