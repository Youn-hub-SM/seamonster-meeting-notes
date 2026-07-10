import crypto from "crypto";

// 네이버 검색광고 API 클라이언트 (서버 전용).
//  Base: https://api.searchad.naver.com
//  인증 헤더: X-Timestamp, X-API-KEY(액세스 라이선스), X-Customer(고객 ID), X-Signature
//   서명 = base64( HMAC-SHA256( secretKey, `${timestamp}.${method}.${path}` ) )   ※ path는 쿼리 제외 순수 경로
//  자격은 env: NAVER_AD_API_KEY · NAVER_AD_SECRET · NAVER_AD_CUSTOMER_ID
//  용도: 파워링크 키워드 조회 + 입찰가(bidAmt) 조정으로 검색광고 효율화.

const BASE = "https://api.searchad.naver.com";

export function isNaverAdConfigured(): boolean {
  return !!(process.env.NAVER_AD_API_KEY && process.env.NAVER_AD_SECRET && process.env.NAVER_AD_CUSTOMER_ID);
}

function creds() {
  const apiKey = process.env.NAVER_AD_API_KEY || "";
  const secret = process.env.NAVER_AD_SECRET || "";
  const customerId = process.env.NAVER_AD_CUSTOMER_ID || "";
  if (!apiKey || !secret || !customerId) throw new Error("네이버 광고 API 자격(NAVER_AD_API_KEY·SECRET·CUSTOMER_ID)이 설정되지 않았습니다.");
  return { apiKey, secret, customerId };
}

function sign(timestamp: string, method: string, path: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${method}.${path}`).digest("base64");
}

type ReqOpts = { query?: Record<string, string | number | string[] | undefined>; body?: unknown };

// 서명 요청. path 는 쿼리 제외 순수 경로(예: "/ncc/keywords"). 서명엔 path만, URL엔 쿼리 포함.
export async function naverAd<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: ReqOpts = {}): Promise<T> {
  const { apiKey, secret, customerId } = creds();
  const ts = String(Date.now());
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.append(k, String(v));
  }
  const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Timestamp": ts,
      "X-API-KEY": apiKey,
      "X-Customer": customerId,
      "X-Signature": sign(ts, method, path, secret),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = (json as { title?: string; detail?: string; message?: string } | null);
    throw new Error(`네이버 광고 API ${res.status}: ${msg?.title || msg?.detail || msg?.message || text.slice(0, 200) || ""}`);
  }
  return json as T;
}

// ── 타입(주요 필드) ──
export type NaverCampaign = { nccCampaignId: string; name: string; campaignTp: string; status?: string; statusReason?: string; dailyBudget?: number; useDailyBudget?: boolean; userLock?: boolean };
export type NaverAdgroup = { nccAdgroupId: string; nccCampaignId: string; name: string; adgroupType?: string; bidAmt?: number; useDailyBudget?: boolean; dailyBudget?: number; status?: string; userLock?: boolean };
export type NaverKeyword = { nccKeywordId: string; nccAdgroupId: string; customerId?: number; keyword: string; bidAmt: number; useGroupBidAmt: boolean; adRelevanceScore?: number; expectedClickScore?: number; status?: string; statusReason?: string; userLock?: boolean };
// salesAmt = 광고비(총비용, VAT포함). convAmt = 전환매출액. ror = 광고수익률(ROAS, %). cpConv = 전환당비용.
export type NaverStat = { id: string; impCnt?: number; clkCnt?: number; salesAmt?: number; cpc?: number; ctr?: number; avgRnk?: number; ccnt?: number; crto?: number; convAmt?: number; ror?: number; cpConv?: number };

// ── 조회 ──
export const listCampaigns = () => naverAd<NaverCampaign[]>("GET", "/ncc/campaigns");
export const listAdgroups = (nccCampaignId: string) => naverAd<NaverAdgroup[]>("GET", "/ncc/adgroups", { query: { nccCampaignId } });
export const listKeywords = (nccAdgroupId: string) => naverAd<NaverKeyword[]>("GET", "/ncc/keywords", { query: { nccAdgroupId } });

// 성과(효율 판단). ids 는 반복 파라미터(ids=a&ids=b)로 전달해야 함(JSON 배열은 400).
// fields 만 JSON 배열 문자열. 응답은 { data: [ StatObject ] } 형태 → 언랩. 90개씩 청크.
// 기간: {since,until}(YYYY-MM-DD) 있으면 timeRange, 없으면 datePreset(today/yesterday/last7days/last30days...).
export type StatRange = { datePreset?: string; since?: string; until?: string };
export async function getStats(ids: string[], range: StatRange = {}): Promise<NaverStat[]> {
  if (!ids.length) return [];
  const fields = JSON.stringify(["impCnt", "clkCnt", "salesAmt", "ctr", "cpc", "avgRnk", "ccnt", "crto", "convAmt", "ror", "cpConv"]);
  const dateQuery: Record<string, string> = range.since && range.until
    ? { timeRange: JSON.stringify({ since: range.since, until: range.until }) }
    : { datePreset: range.datePreset || "last7days" };
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 90) chunks.push(ids.slice(i, i + 90));
  const parts = await Promise.all(chunks.map(async (chunk) => {
    const res = await naverAd<NaverStat[] | { data?: NaverStat[] }>("GET", "/stats", { query: { ids: chunk, fields, ...dateQuery } });
    return Array.isArray(res) ? res : (res?.data ?? []);
  }));
  return parts.flat();
}

// ── 입찰가 조정 ── 최대 200개. useGroupBidAmt=false 여야 개별 bidAmt 적용.
export type BidUpdate = { nccKeywordId: string; bidAmt: number; useGroupBidAmt: boolean };
export function updateKeywordBids(updates: BidUpdate[]): Promise<NaverKeyword[]> {
  return naverAd<NaverKeyword[]>("PUT", "/ncc/keywords", { query: { fields: "bidAmt" }, body: updates });
}

// 광고그룹 입찰가 조정(쇼핑검색 등 그룹 단위). 벌크 API가 없어 개별 PUT /ncc/adgroups/{id}?fields=bidAmt.
export type AdgroupBidUpdate = { nccAdgroupId: string; bidAmt: number };
export async function updateAdgroupBids(updates: AdgroupBidUpdate[]): Promise<{ updated: number; failed: number; firstError?: string }> {
  const results = await Promise.allSettled(updates.map((u) =>
    naverAd<NaverAdgroup>("PUT", `/ncc/adgroups/${u.nccAdgroupId}`, { query: { fields: "bidAmt" }, body: { nccAdgroupId: u.nccAdgroupId, bidAmt: Math.max(0, Math.round(u.bidAmt)) } })
  ));
  const failedList = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  return { updated: results.length - failedList.length, failed: failedList.length, firstError: failedList[0] ? String(failedList[0].reason?.message || failedList[0].reason) : undefined };
}

// 여러 캠페인의 광고그룹 + 성과 병합(쇼핑검색 등 그룹 단위 뷰용).
export async function listAdgroupsWithStats(campaignIds: string[], range: StatRange = {}): Promise<(NaverAdgroup & { stat?: NaverStat | null })[]> {
  const groups = (await Promise.all(campaignIds.map((id) => listAdgroups(id).catch(() => [])))).flat();
  const ids = groups.map((g) => g.nccAdgroupId);
  let statById: Record<string, NaverStat> = {};
  if (ids.length) {
    try {
      const stats = await getStats(ids, range);
      statById = Object.fromEntries((stats || []).map((s) => [s.id, s]));
    } catch { /* 성과 실패해도 그룹은 반환 */ }
  }
  return groups.map((g) => ({ ...g, stat: statById[g.nccAdgroupId] || null }));
}

// 쇼핑검색광고 세부 검색어 리포트(statType=NPLA_SCH_KEYWORD). id=광고그룹(또는 캠페인) 단일.
// 최근 30일·노출순. 응답 행 = {schKeyword, impCnt, clkCnt, salesAmt(광고비), drtCrto(직접전환율%)}. 전환수/매출/ROAS 없음.
export type NplaSearchKeyword = { keyword: string; impCnt: number; clkCnt: number; salesAmt: number; drtCrto?: number };
export async function getShoppingSearchKeywords(id: string): Promise<NplaSearchKeyword[]> {
  const res = await naverAd<unknown>("GET", "/stats", { query: { id, statType: "NPLA_SCH_KEYWORD" } });
  const arr = Array.isArray(res) ? res : ((res as { data?: unknown[] })?.data ?? []);
  return (arr as Record<string, unknown>[]).map((r) => ({
    keyword: String(r.schKeyword ?? r.keyword ?? ""),
    impCnt: Number(r.impCnt ?? 0), clkCnt: Number(r.clkCnt ?? 0), salesAmt: Number(r.salesAmt ?? 0),
    drtCrto: r.drtCrto != null ? Number(r.drtCrto) : undefined,
  }));
}

// ── 구매 전환 집계(AD_CONVERSION_DETAIL 리포트) ──
// 하루 단위 비동기 리포트(생성→폴링→TSV 다운로드). TSV 15컬럼(탭):
//  0 date,1 customer,2 campaign,3 adgroup,4 keyword(nkw-.. 또는 '-'),5 adId,6 bizChannel,
//  7 hour,8 region,9 media,10 pcMobile,11 convMethod(1직접/2간접),12 convType(purchase/add_to_cart..),13 convCount,14 convSales
export type ConvRow = { adgroupId: string; keywordId: string | null; convType: string; conv: number; sales: number };
const _sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function signedHeaders(method: string, path: string): Record<string, string> {
  const { apiKey, secret, customerId } = creds();
  const ts = String(Date.now());
  return { "Content-Type": "application/json; charset=UTF-8", "X-Timestamp": ts, "X-API-KEY": apiKey, "X-Customer": customerId, "X-Signature": sign(ts, method, path, secret) };
}

function parseConvTsv(tsv: string): ConvRow[] {
  const out: ConvRow[] = [];
  for (const line of tsv.split("\n")) {
    if (!line.trim()) continue;
    const c = line.split("\t");
    if (c.length < 15) continue;
    out.push({ adgroupId: c[3], keywordId: c[4] && c[4] !== "-" ? c[4] : null, convType: c[12], conv: Number(c[13]) || 0, sales: Number(c[14]) || 0 });
  }
  return out;
}

// 하루치 전환 상세 행 조회(모든 전환유형 포함 — 필터는 호출측). statDt="YYYY-MM-DD".
export async function fetchConvReportDay(statDt: string): Promise<ConvRow[]> {
  const job = await naverAd<{ reportJobId?: number | string; id?: number | string; status?: string; downloadUrl?: string }>("POST", "/stat-reports", { body: { reportTp: "AD_CONVERSION_DETAIL", statDt } });
  const jobId = job.reportJobId ?? job.id;
  if (jobId == null) return [];
  let status = String(job.status || ""); let url = String(job.downloadUrl || "");
  for (let i = 0; i < 25 && status !== "BUILT" && status !== "DONE"; i++) {
    await _sleep(1200);
    const g = await naverAd<{ status?: string; downloadUrl?: string }>("GET", `/stat-reports/${jobId}`);
    status = String(g.status || ""); url = String(g.downloadUrl || "");
    if (status === "NONE" || status === "ERROR" || status === "REGIST_ERROR") break;
  }
  let rows: ConvRow[] = [];
  if (url) {
    try {
      const u = new URL(url);
      const dl = await fetch(url, { headers: signedHeaders("GET", u.pathname), cache: "no-store" });
      if (dl.ok) rows = parseConvTsv(await dl.text());
    } catch { /* 다운로드 실패 시 빈 배열 */ }
  }
  await naverAd("DELETE", `/stat-reports/${jobId}`).catch(() => {}); // 잡 정리(미삭제 시 자동 30일 후 삭제)
  return rows;
}

// 자격 확인용 가벼운 핑(캠페인 목록). 실패 시 에러 던짐.
export async function pingNaverAd(): Promise<{ ok: boolean; campaigns: number }> {
  const c = await listCampaigns();
  return { ok: true, campaigns: Array.isArray(c) ? c.length : 0 };
}
