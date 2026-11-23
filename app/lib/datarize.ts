// 데이터라이즈(공식몰 CRM 발송 도구) 리포팅 API — 읽기 전용(2026-11-24 대표: "API 키를 받았다 — CRM 맵에 접목"). 서버 전용.
//  문서 https://developer.datarize.ai/reporting/ · 기본 주소 https://api.datarize.ai/v1/reporting · 모두 GET.
//  인증: Authorization: Datarize-Api-Key <키>(Bearer 아님). 키 = env DATARIZE_API_KEY('dtr_api_' 로 시작하는 리포팅 키 — 이벤트 키로는 조회가 안 된다).
//  한도: 초 30 · 분 600 · 일 10,000건. 성과는 최근 180일. 데이터는 약 1시간마다 갱신.
//  이 API 로는 발송·캠페인 수정·오디언스 올리기를 할 수 없다(문서에 없음) — 여기서는 읽기만 한다.
//
//  ■ CRM 맵과 잇는 법 — 소재(creative)의 버튼·이미지 링크에 든 utm_campaign 을 맵 메시지의 utm_campaign(+별칭)과 맞춘다.
//    캠페인 하나에 소재가 여럿이고 소재마다 utm_campaign 이 다를 수 있어(옛 이름·새 이름, 메시지 두 개가 한 캠페인) 성과는 '소재 단위'로 가져온다.
//    같은 utm_campaign 을 여러 캠페인이 쓰기도 한다(장바구니 캠페인이 고객 등급별로 6개) — 그때는 모두 그 메시지의 발송으로 더한다.
//  ■ 쓰는 곳
//    ① 주간 성과: syncDatarize 가 일별×소재의 발송·클릭·비용을 crm_send_stats 에 넣는다(batch 'datarize-sync', utm_campaign 칸에 쉼표로).
//    ② 맵과의 차이 점검·드로어의 실제 소재: loadCatalog(캠페인·소재 목록, b2b_settings 에 1시간 보관).
import { supabaseAdmin } from "./supabase";
import { getKv, setKv } from "./b2b-settings";
import { upsertCrmStats, DATARIZE_BATCH, type CrmStatUpsert } from "./crm-stats";
import { campaignKeys, type CrmMessage } from "./crm";

const BASE = "https://api.datarize.ai/v1/reporting";
const TIMEOUT_MS = 20_000;
export const isDatarizeConfigured = (): boolean => !!(process.env.DATARIZE_API_KEY || "").trim();
export class DatarizeError extends Error {}

type Page<T> = { data?: T[]; meta?: { data_through?: string; data_updated_at?: string; is_stale?: boolean }; links?: { next?: string | null }; error?: { code?: string; message?: string } };
const ERR_KO: Record<string, string> = {
  unauthenticated: "데이터라이즈 API 키가 올바르지 않거나 만료됐습니다.",
  subscription_inactive: "데이터라이즈 구독이 끝나 조회할 수 없습니다.",
  insufficient_scope: "이 키로는 캠페인 성과를 볼 수 없습니다(리포팅 키인지 확인하세요).",
  rate_limited: "데이터라이즈 호출 한도에 걸렸습니다. 잠시 뒤 다시 누르세요.",
  range_too_large: "조회 기간이 너무 깁니다(최근 180일까지).",
  data_unavailable: "데이터라이즈 데이터가 아직 준비되지 않았습니다. 잠시 뒤 다시 누르세요.",
  query_timeout: "데이터라이즈 조회가 시간을 넘겼습니다. 기간을 줄여 다시 누르세요.",
};
async function getOnce<T>(url: string): Promise<{ status: number; body: Page<T>; retryAfter: number }> {
  const key = (process.env.DATARIZE_API_KEY || "").trim();
  if (!key) throw new DatarizeError("데이터라이즈 API 키가 없습니다(Vercel 환경 변수 DATARIZE_API_KEY).");
  const res = await fetch(url, { headers: { Authorization: `Datarize-Api-Key ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Page<T>;
  return { status: res.status, body, retryAfter: Number(res.headers.get("retry-after")) || 0 };
}
// 목록 끝까지 — links.next 를 그대로 따라간다. 한도(429)에 걸리면 한 번만 기다렸다 다시.
async function getAll<T>(path: string): Promise<{ rows: T[]; through: string | null; stale: boolean }> {
  const rows: T[] = []; let url: string | null = BASE + path, through: string | null = null, stale = false;
  for (let page = 0; url && page < 60; page++) {
    let r: Awaited<ReturnType<typeof getOnce<T>>> = await getOnce<T>(url);
    if (r.status === 429 && r.retryAfter > 0 && r.retryAfter <= 5) { await new Promise((ok) => setTimeout(ok, r.retryAfter * 1000)); r = await getOnce<T>(url); }
    if (r.status !== 200) {
      const code = r.body.error?.code || "";
      throw new DatarizeError(ERR_KO[code] || `데이터라이즈 ${r.status}: ${r.body.error?.message || code || "조회 실패"}`);
    }
    rows.push(...(r.body.data || []));
    through = r.body.meta?.data_through || through; stale = stale || !!r.body.meta?.is_stale;
    const next: string | null = r.body.links?.next || null;
    url = next ? (next.startsWith("http") ? next : `https://api.datarize.ai${next.startsWith("/") ? "" : "/"}${next}`) : null;
  }
  return { rows, through, stale };
}

// ── 응답 모양(쓰는 칸만) ──
type RawCampaign = { campaign_id: string; name?: string | null; channel?: string; campaign_type?: string; schedule_type?: string; status?: string; send_days?: number[] | null; send_time?: string | null; audience_name?: string | null; creative_count?: number | null; deleted_at?: string | null };
type RawLink = { url?: string | null; link_url?: string | null; label?: string | null; type?: string | null };
type RawCreative = { campaign_id: string; creative_id: string; name?: string | null; format?: string | null; status?: string | null; deleted_at?: string | null; title?: string | null; header?: string | null; message?: string | null; images?: RawLink[] | null; buttons?: RawLink[] | null; items?: { title?: string | null; message?: string | null; images?: RawLink[] | null; buttons?: RawLink[] | null }[] | null };
type RawStat = { date: string; campaign_id: string; creative_id?: string; channel?: string; sends?: number | null; clicks?: number | null; cost?: number | string | null };

export type DtrCampaign = { id: string; name: string; channel: string; type: string; schedule: string; status: string; sendDays: number[]; sendTime: string; audience: string; deleted: boolean };
export type DtrButton = { label: string; url: string };
export type DtrCreative = { campaignId: string; id: string; name: string; format: string; status: string; title: string; header: string; message: string; buttons: DtrButton[]; utms: string[] };
export type DtrCatalog = { at: string; campaigns: DtrCampaign[]; creatives: DtrCreative[] };

const UTM_RE = /[?&]utm_campaign=([^&#]*)/i;
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
// 소재의 모든 링크(버튼·이미지·항목 안의 것)에서 utm_campaign 을 뽑는다 — 소문자, 중복 없이
export function creativeUtms(c: RawCreative): string[] {
  const urls: string[] = [];
  const take = (links?: RawLink[] | null) => { for (const l of links || []) { const u = l?.url || l?.link_url; if (typeof u === "string" && u) urls.push(u); } };
  take(c.buttons); take(c.images);
  for (const it of c.items || []) { take(it.buttons); take(it.images); }
  const out: string[] = [];
  for (const u of urls) {
    const m = UTM_RE.exec(u); if (!m) continue;
    let v = m[1]; try { v = decodeURIComponent(v); } catch { /* 깨진 인코딩은 원문 그대로 */ }
    v = v.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
const toCampaign = (c: RawCampaign): DtrCampaign => ({ id: c.campaign_id, name: clip(c.name, 200) || c.campaign_id, channel: c.channel || "", type: c.campaign_type || "", schedule: c.schedule_type || "", status: c.status || "", sendDays: Array.isArray(c.send_days) ? c.send_days : [], sendTime: (c.send_time || "").slice(0, 5), audience: clip(c.audience_name, 200), deleted: !!c.deleted_at });
function toCreative(c: RawCreative): DtrCreative {
  const buttons: DtrButton[] = [];
  const add = (links?: RawLink[] | null) => { for (const b of links || []) if (b?.label || b?.url) buttons.push({ label: clip(b.label, 60), url: clip(b.url, 500) }); };
  add(c.buttons); for (const it of c.items || []) add(it.buttons);
  // 항목으로 나뉜 소재(캐러셀·와이드 리스트)는 문구가 items 안에 있다 — 줄로 이어 보여 준다
  const itemText = (c.items || []).map((it) => [it.title, it.message].filter(Boolean).join("\n")).filter(Boolean).join("\n\n");
  return { campaignId: c.campaign_id, id: c.creative_id, name: clip(c.name, 120), format: c.format || "", status: c.status || "", title: clip(c.title, 300), header: clip(c.header, 300), message: clip(c.message || itemText, 2000), buttons: buttons.slice(0, 12), utms: creativeUtms(c) };
}

// ── 캠페인·소재 목록(1시간 보관) ──
const KV = "datarize_catalog";
const CATALOG_TTL_MS = 60 * 60_000;
export async function loadCatalog(force = false): Promise<DtrCatalog> {
  if (!force) {
    try {
      const raw = await getKv(KV);
      if (raw) { const c = JSON.parse(raw) as DtrCatalog; if (c?.at && Date.now() - Date.parse(c.at) < CATALOG_TTL_MS) return c; }
    } catch { /* 보관분을 못 읽으면 새로 받는다 */ }
  }
  const [camp, cre] = await Promise.all([getAll<RawCampaign>("/message-campaigns"), getAll<RawCreative>("/message-creatives")]);
  const catalog: DtrCatalog = { at: new Date().toISOString(), campaigns: camp.rows.map(toCampaign), creatives: cre.rows.filter((c) => !c.deleted_at).map(toCreative) };
  try { await setKv(KV, JSON.stringify(catalog)); } catch (e) { console.error("[datarize] 목록 보관 실패", e instanceof Error ? e.message : e); }
  return catalog;
}

// ── 성과 가져오기 → crm_send_stats ──
const SOURCE_OF: Record<string, string> = { alimtalk: "datarize_alimtalk", brand_message: "datarize_brand" }; // 그 밖(문자·LINE)은 '기타'
export async function syncDatarize(p: { since: string; until: string }): Promise<{ rows: number; sends: number; removed: number; through: string | null }> {
  const [stats, catalog] = await Promise.all([
    getAll<RawStat>(`/message-campaign-stats?start_date=${p.since}&end_date=${p.until}&group_by=creative&page_size=5000`),
    loadCatalog(true),
  ]);
  const campName = new Map(catalog.campaigns.map((c) => [c.id, c.name]));
  const creative = new Map(catalog.creatives.map((c) => [`${c.campaignId}:${c.id}`, c]));
  const rows: CrmStatUpsert[] = []; let sends = 0;
  for (const s of stats.rows) {
    const key = `${s.campaign_id}:${s.creative_id || ""}`;
    const cr = creative.get(key);
    const sent = Number(s.sends) || 0; sends += sent;
    rows.push({
      source: SOURCE_OF[s.channel || ""] || "other", grain: "day", date: s.date, template: key, sent, delivered: null,
      clicked: s.clicks == null ? null : Number(s.clicks) || 0, cost: s.cost == null ? null : Number(s.cost) || 0,
      utm_campaign: cr?.utms.length ? cr.utms.join(",") : null,
      note: [campName.get(s.campaign_id) || s.campaign_id, cr?.name].filter(Boolean).join(" · "), batch: DATARIZE_BATCH,
    });
  }
  const n = await upsertCrmStats(rows);
  // 데이터라이즈가 값을 다시 계산해 사라진 줄(발송 0)은 지운다 — 남겨 두면 예전 숫자가 계속 더해진다
  const sb = supabaseAdmin();
  const keep = new Set(rows.map((r) => `${r.source}|${r.date}|${r.template}`));
  const old = await sb.from("crm_send_stats").select("id, source, date, template").eq("batch", DATARIZE_BATCH).gte("date", p.since).lte("date", p.until).limit(5000);
  if (old.error) throw new Error(`기존 수치 조회 오류: ${old.error.message}`);
  const gone = ((old.data || []) as { id: string; source: string; date: string; template: string }[]).filter((r) => !keep.has(`${r.source}|${r.date}|${r.template}`)).map((r) => r.id);
  for (let i = 0; i < gone.length; i += 100) { const del = await sb.from("crm_send_stats").delete().in("id", gone.slice(i, i + 100)); if (del.error) throw new Error(`사라진 줄 정리 오류: ${del.error.message}`); }
  return { rows: n, sends, removed: gone.length, through: stats.through };
}

// ── 맵과 실제의 차이 ──
export type CheckCampaign = { id: string; name: string; channel: string; status: string; audience: string; sendTime: string; sendDays: number[]; utms: string[] };
export type DatarizeCheck = {
  at: string; activeCampaigns: number; linkedMessages: number;
  unmapped: CheckCampaign[];                                                      // 데이터라이즈에서 켜져 있는데 맵에 없는 캠페인
  off: { id: string; title: string; campaign: string; campaigns: { name: string; status: string }[] }[]; // 맵에는 있는데 데이터라이즈에서 꺼졌거나 지워진 것
};
type MsgLite = Pick<CrmMessage, "id" | "title" | "links" | "active">;
// 캠페인마다 그 소재들의 utm_campaign 을 모은다
function campaignUtms(catalog: DtrCatalog): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of catalog.creatives) { const a = out.get(c.campaignId) || []; for (const u of c.utms) if (!a.includes(u)) a.push(u); out.set(c.campaignId, a); }
  return out;
}
export function buildCheck(catalog: DtrCatalog, messages: MsgLite[]): DatarizeCheck {
  const utmsOf = campaignUtms(catalog);
  const live = messages.filter((m) => m.active !== false).map((m) => ({ m, keys: campaignKeys(m) })).filter((x) => x.keys.length);
  const allKeys = new Set(live.flatMap((x) => x.keys));
  const toCheck = (c: DtrCampaign): CheckCampaign => ({ id: c.id, name: c.name, channel: c.channel, status: c.status, audience: c.audience, sendTime: c.sendTime, sendDays: c.sendDays, utms: utmsOf.get(c.id) || [] });
  const campaigns = catalog.campaigns.filter((c) => !c.deleted);
  const active = campaigns.filter((c) => c.status === "active");
  const unmapped = active.filter((c) => !(utmsOf.get(c.id) || []).some((u) => allKeys.has(u))).map(toCheck);
  const off: DatarizeCheck["off"] = []; let linkedMessages = 0;
  for (const { m, keys } of live) {
    // 지운 캠페인도 본다 — 맵에는 남아 있는데 데이터라이즈에서 지운 경우를 알리려고
    const mine = catalog.campaigns.filter((c) => (utmsOf.get(c.id) || []).some((u) => keys.includes(u)));
    if (!mine.length) continue; // 데이터라이즈로 보내는 메시지가 아니다(솔라피·수동 등)
    linkedMessages++;
    if (!mine.some((c) => !c.deleted && c.status === "active"))
      off.push({ id: m.id, title: m.title, campaign: (m.links?.utm_campaign || "").trim(), campaigns: mine.slice(0, 6).map((c) => ({ name: c.name, status: c.deleted ? "deleted" : c.status })) });
  }
  return { at: catalog.at, activeCampaigns: active.length, linkedMessages, unmapped, off };
}

// 그 메시지로 지금 나가는 소재 — utm_campaign 이 맞는 소재(꺼진 것도 상태와 함께)
export type MessageCreative = DtrCreative & { campaign: string; campaignStatus: string; channel: string; audience: string; sendTime: string };
export function creativesFor(catalog: DtrCatalog, m: MsgLite): MessageCreative[] {
  const keys = campaignKeys(m);
  if (!keys.length) return [];
  const camp = new Map(catalog.campaigns.map((c) => [c.id, c]));
  const rank = (s: string) => (s === "active" ? 0 : 1);
  return catalog.creatives.filter((c) => c.utms.some((u) => keys.includes(u))).map((c) => {
    const p = camp.get(c.campaignId);
    return { ...c, campaign: p?.name || c.campaignId, campaignStatus: p?.deleted ? "deleted" : p?.status || "", channel: p?.channel || "", audience: p?.audience || "", sendTime: p?.sendTime || "" };
  }).sort((a, b) => rank(a.campaignStatus) - rank(b.campaignStatus) || rank(a.status) - rank(b.status) || a.campaign.localeCompare(b.campaign, "ko")).slice(0, 30);
}
