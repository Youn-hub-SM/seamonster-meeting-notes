// CRM 발송 수치(crm_send_stats, migration 149) — 주간 성과표의 계산·수집 (2026-10-26, docs/crm-dashboard-plan.md)
//  수단별 발송·클릭은 crm_send_stats 에서, 랜딩 성과(세션·구매·매출)는 GA4 의 utm medium(소스/매체 'kakao / …')에서.
import { supabaseAdmin } from "./supabase";
import { isGaConfigured, runGaReport } from "./ga";
import { fetchSolapiMessages, aggregateSolapi, isSolapiConfigured, fetchSolapiTemplates, type SolapiTemplate } from "./solapi";
import { getKv, setKv } from "./b2b-settings";
import { estimateAudience, estimateAudienceWeekly } from "./crm-audience";
import { isTracked, triggerText, campaignKeys, campaignAliases, CRM_CUSTOMER_LABEL, type CrmMessage } from "./crm";

export const CRM_SOURCES = [
  { key: "datarize_brand", label: "데이터라이즈 브랜드메시지", how: "csv" },
  { key: "datarize_alimtalk", label: "데이터라이즈 알림톡", how: "csv" },
  { key: "blumn", label: "블룸 AI 알림톡", how: "csv" },
  { key: "solapi", label: "솔라피(스마트스토어)", how: "api" },
  { key: "naver_talk", label: "네이버 톡톡", how: "manual" },
  { key: "talkstore", label: "톡스토어 마케팅메시지", how: "manual" },
  { key: "sms", label: "알리고 문자", how: "manual" },
  { key: "other", label: "기타", how: "manual" },
] as const;
export type CrmSourceKey = (typeof CRM_SOURCES)[number]["key"];
export const CRM_SOURCE_LABEL: Record<string, string> = Object.fromEntries(CRM_SOURCES.map((s) => [s.key, s.label]));
export const isCrmSource = (s: unknown): s is CrmSourceKey => CRM_SOURCES.some((x) => x.key === s);

export type CrmStatRow = { id: string; source: string; grain: "day" | "week"; date: string; template: string; sent: number; delivered: number | null; clicked: number | null; cost: number | null; utm_campaign: string | null; note: string; batch: string; created_by: string | null };
export type CrmStatUpsert = Omit<CrmStatRow, "id" | "created_by"> & { created_by?: string | null };

// ── 주(월요일 시작) 도우미 ──
export const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
export function weekStartOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 월=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
export const shiftDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

export async function upsertCrmStats(rows: CrmStatUpsert[]): Promise<number> {
  if (!rows.length) return 0;
  const sb = supabaseAdmin();
  const payload = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await sb.from("crm_send_stats").upsert(payload.slice(i, i + 500), { onConflict: "source,grain,date,template" });
    if (error) throw error;
  }
  return rows.length;
}

// ── 솔라피 동기화: 기간의 발송을 일별×종류×템플릿으로 upsert ──
const KV_TPL = "solapi_templates"; // 템플릿 ID → 이름(동기화 때 갱신, 화면·표에서 이름 표시)
export async function getSolapiTemplateMap(): Promise<Record<string, string>> {
  try { const raw = await getKv(KV_TPL); return raw ? (JSON.parse(raw) as Record<string, string>) : {}; } catch { return {}; }
}
export async function refreshSolapiTemplates(): Promise<SolapiTemplate[]> {
  const list = await fetchSolapiTemplates();
  const map: Record<string, string> = {};
  for (const t of list) map[t.templateId] = t.name || t.templateId;
  try { await setKv(KV_TPL, JSON.stringify(map)); } catch { /* 저장 실패해도 동기화는 계속 */ }
  return list;
}
// 표시용 템플릿 라벨: 'ATA:KA01TP…' → '알림톡 · <템플릿 이름>'
const TYPE_KO: Record<string, string> = { ATA: "알림톡", CTA: "친구톡", CTI: "친구톡(이미지)", BMS: "브랜드메시지", SMS: "문자", LMS: "문자(장문)", MMS: "문자(사진)", RCS_SMS: "RCS", RCS_LMS: "RCS", RCS_MMS: "RCS" };
export function solapiTemplateLabel(template: string, map: Record<string, string>): string {
  const [type, id] = template.split(":");
  const ko = TYPE_KO[type] || type;
  return id ? `${ko} · ${map[id] || id}` : ko;
}
export async function syncSolapi(p: { since: string; until: string }): Promise<{ rows: number; messages: number; templates: number }> {
  if (!isSolapiConfigured()) throw new Error("솔라피 자격(SOLAPI_API_KEY·SOLAPI_API_SECRET)이 없습니다.");
  const [msgs, tpls] = await Promise.all([fetchSolapiMessages(p), refreshSolapiTemplates().catch(() => [] as SolapiTemplate[])]);
  const names: Record<string, string> = {}; for (const t of tpls) names[t.templateId] = t.name;
  const agg = aggregateSolapi(msgs);
  const rows: CrmStatUpsert[] = agg.map((a) => ({ source: "solapi", grain: "day", date: a.date, template: `${a.type}${a.templateId ? `:${a.templateId}` : ""}`, sent: a.sent, delivered: null, clicked: null, cost: null, utm_campaign: null, note: [names[a.templateId] || "", a.failed ? `실패 ${a.failed}` : ""].filter(Boolean).join(" · "), batch: "solapi-sync" }));
  const n = await upsertCrmStats(rows);
  return { rows: n, messages: msgs.length, templates: tpls.length };
}

// ── 주간 집계 ──
export type WeeklySource = { source: string; label: string; sent: number; clicked: number | null; cost: number | null; templates: { template: string; label: string; sent: number; clicked: number | null; days: number }[] };
export type GaMediumRow = { medium: string; sessions: number; purchases: number; revenue: number };

export async function weeklyStats(weekStart: string): Promise<{ week: string; until: string; sources: WeeklySource[]; rows: CrmStatRow[] }> {
  const until = shiftDays(weekStart, 6);
  const sb = supabaseAdmin();
  const { data, error } = await sb.from("crm_send_stats").select("*").gte("date", weekStart).lte("date", until).order("date");
  if (error) throw error;
  const rows = (data || []) as CrmStatRow[];
  const tplMap = await getSolapiTemplateMap();
  const bySrc = new Map<string, WeeklySource>();
  for (const r of rows) {
    if (r.grain === "week" && r.date !== weekStart) continue; // 주별 행은 주 시작일 것만
    const s = bySrc.get(r.source) || { source: r.source, label: CRM_SOURCE_LABEL[r.source] || r.source, sent: 0, clicked: null, cost: null, templates: [] };
    s.sent += r.sent || 0;
    if (r.clicked != null) s.clicked = (s.clicked || 0) + r.clicked;
    if (r.cost != null) s.cost = (s.cost || 0) + Number(r.cost);
    const t = s.templates.find((x) => x.template === r.template) || (s.templates.push({ template: r.template, label: r.source === "solapi" ? solapiTemplateLabel(r.template, tplMap) : r.template, sent: 0, clicked: null, days: 0 }), s.templates[s.templates.length - 1]);
    t.sent += r.sent || 0; if (r.clicked != null) t.clicked = (t.clicked || 0) + r.clicked; t.days++;
    bySrc.set(r.source, s);
  }
  const order = CRM_SOURCES.map((s) => s.key as string);
  const sources = [...bySrc.values()].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  for (const s of sources) s.templates.sort((a, b) => b.sent - a.sent);
  return { week: weekStart, until, sources, rows };
}

// GA — 소스가 kakao(utm 규칙) 또는 datarize(데이터라이즈 자동 UTM, 2026-11-09) 인 세션·구매·매출을 매체별로. 설정 없으면 null.
export async function gaByMedium(since: string, until: string): Promise<GaMediumRow[] | null> {
  if (!isGaConfigured()) return null;
  const r = await runGaReport({ since, until, dimensions: ["source_medium"], metrics: ["sessions", "purchases", "revenue"], limit: 200, filter: { dimension: "source_medium", match: "regex", value: "^(kakao|datarize)" }, scope: "all" });
  return r.rows.map((row) => ({ medium: String(row["소스/매체"] || "").replace(/^kakao\s*\/\s*/, "").replace(/^datarize\s*\/\s*/, "datarize-"), sessions: Number(row["세션"]) || 0, purchases: Number(row["구매"]) || 0, revenue: Math.round(Number(row["구매액(원)"]) || 0) })).filter((x) => x.medium).sort((a, b) => b.sessions - a.sessions);
}

// ── 추적 메시지(utm_campaign 있는 것)별 주간 성과 — 발송 = 실제(솔라피 템플릿) → 직접 입력(제목) → 추정(업무도우미), 클릭 = GA 세션 ──
export type TrackedRow = {
  id: string; title: string; stage: string; customer: string; medium: string; campaign: string; aliases: string[]; triggerText: string;
  sent: number | null; sentBasis: "solapi" | "manual" | "estimate" | "none"; sentNote: string;
  sessions: number | null; purchases: number | null; revenue: number | null; ctr: number | null; targetCtr: number | null;
};
export async function trackedMessages(weekStart: string, until: string, rows: CrmStatRow[]): Promise<{ tracked: TrackedRow[]; gaNote: string }> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.from("crm_messages").select("id,title,stage,customer,links,trigger,offset_days,offset_note,target_ctr,solapi_template_id,utm_medium,active").eq("active", true);
  if (error) {
    // 150 미적용 → 트리거 칸 없이 다시(추정은 못 함)
    const r2 = await sb.from("crm_messages").select("id,title,stage,customer,links,active").eq("active", true);
    if (r2.error) throw r2.error;
    return { tracked: await buildTracked(sb, (r2.data || []).map((m) => ({ ...m, trigger: "", offset_days: null, offset_note: "", target_ctr: null, solapi_template_id: "", utm_medium: "" })) as unknown as CrmMessage[], weekStart, until, rows), gaNote: "" };
  }
  return { tracked: await buildTracked(sb, (data || []) as unknown as CrmMessage[], weekStart, until, rows), gaNote: "" };
}
async function buildTracked(sb: ReturnType<typeof supabaseAdmin>, msgs: CrmMessage[], weekStart: string, until: string, rows: CrmStatRow[]): Promise<TrackedRow[]> {
  const tracked = msgs.filter((m) => isTracked(m));
  if (!tracked.length) return [];
  // GA: 캠페인 × 소스/매체(kakao·datarize) 한 번에 — 캠페인 키는 소문자, 메시지는 utm_campaign + 별칭을 합산
  const ga = new Map<string, { sessions: number; purchases: number; revenue: number }>();
  let gaOk = false;
  if (isGaConfigured()) {
    try {
      const r = await runGaReport({ since: weekStart, until, dimensions: ["campaign", "source_medium"], metrics: ["sessions", "purchases", "revenue"], limit: 500, filter: { dimension: "source_medium", match: "regex", value: "^(kakao|datarize)" }, scope: "all" });
      for (const row of r.rows) {
        const c = String(row["캠페인"] || "").trim().toLowerCase(); const cur = ga.get(c) || { sessions: 0, purchases: 0, revenue: 0 };
        cur.sessions += Number(row["세션"]) || 0; cur.purchases += Number(row["구매"]) || 0; cur.revenue += Number(row["구매액(원)"]) || 0; ga.set(c, cur);
      }
      gaOk = true;
    } catch { /* GA 실패 → 세션 null */ }
  }
  const out: TrackedRow[] = [];
  for (const m of tracked) {
    const campaign = (m.links?.utm_campaign || "").trim();
    // 발송 수: 솔라피 템플릿 ID → 직접 입력(제목 일치) → 추정
    let sent: number | null = null, sentBasis: TrackedRow["sentBasis"] = "none", sentNote = "";
    const tid = (m.solapi_template_id || "").trim();
    if (tid) { const s = rows.filter((r) => r.source === "solapi" && r.template.endsWith(`:${tid}`)).reduce((a, r) => a + r.sent, 0); if (s > 0 || rows.some((r) => r.source === "solapi")) { sent = s; sentBasis = "solapi"; sentNote = "솔라피 실제"; } }
    if (sent == null) { const manual = rows.filter((r) => r.batch === "manual" && r.template === m.title); if (manual.length) { sent = manual.reduce((a, r) => a + r.sent, 0); sentBasis = "manual"; sentNote = "직접 입력"; } }
    if (sent == null && m.trigger) { const e = await estimateAudience(sb, m, weekStart, until); if (e.count != null) { sent = e.count; sentBasis = "estimate"; sentNote = `추정 · ${e.note}`; } else sentNote = e.note; }
    const g = gaOk ? campaignKeys(m).reduce((acc, k) => { const x = ga.get(k); if (x) { acc.sessions += x.sessions; acc.purchases += x.purchases; acc.revenue += x.revenue; } return acc; }, { sessions: 0, purchases: 0, revenue: 0 }) : null;
    const ctr = g && sent ? Math.round((g.sessions / sent) * 1000) / 10 : null;
    out.push({ id: m.id, title: m.title, stage: m.stage, customer: CRM_CUSTOMER_LABEL[m.customer] || m.customer || "", medium: m.utm_medium || "", campaign, aliases: campaignAliases(m), triggerText: triggerText(m), sent, sentBasis, sentNote, sessions: g ? g.sessions : null, purchases: g ? g.purchases : null, revenue: g ? g.revenue : null, ctr, targetCtr: m.target_ctr ?? null });
  }
  return out.sort((a, b) => (b.sessions || 0) - (a.sessions || 0));
}

// 최근 N주 수단별 발송 추이(주간 표 아래 차트)
export async function weeklyTrend(weeks = 12, endWeek?: string): Promise<{ week: string; bySource: Record<string, number> }[]> {
  const last = endWeek || weekStartOf(kstToday());
  const first = shiftDays(last, -7 * (weeks - 1));
  const { data, error } = await supabaseAdmin().from("crm_send_stats").select("source,grain,date,sent").gte("date", first).lte("date", shiftDays(last, 6));
  if (error) throw error;
  const out = new Map<string, Record<string, number>>();
  for (let i = 0; i < weeks; i++) out.set(shiftDays(first, 7 * i), {});
  for (const r of (data || []) as { source: string; grain: string; date: string; sent: number }[]) {
    const w = r.grain === "week" ? r.date : weekStartOf(r.date);
    const b = out.get(w); if (!b) continue;
    b[r.source] = (b[r.source] || 0) + (r.sent || 0);
  }
  return [...out.entries()].map(([week, bySource]) => ({ week, bySource }));
}

// ── 메시지별 주간 클릭률 이력(2026-11-09, 대표 "매주 클릭률이 어땠는지") — 최근 N주, 끝 주 = 보고 있는 주.
//  발송 = 솔라피 템플릿 → 직접 입력(제목) → 주별 추정(한 메시지 SQL 한 번), 클릭 = GA 캠페인×날짜(kakao) 를 주로 묶음. 전체 줄 = 수단별 기록 합 ÷ kakao 세션 합.
export type HistoryRow = { id: string; title: string; customer: string; medium: string; campaign: string; aliases: string[]; targetCtr: number | null; sentBasis: TrackedRow["sentBasis"]; sent: (number | null)[]; sessions: (number | null)[]; purchases: (number | null)[]; revenue: (number | null)[]; ctr: (number | null)[] };
export type TrackedHistory = { weeks: string[]; rows: HistoryRow[]; total: { sent: number[]; sessions: (number | null)[]; ctr: (number | null)[] }; note: string };
export async function trackedHistory(endWeek: string, weeks = 12, opts: { onlyIds?: string[] } = {}): Promise<TrackedHistory> {
  const first = shiftDays(endWeek, -7 * (weeks - 1));
  const list: string[] = []; for (let i = 0; i < weeks; i++) list.push(shiftDays(first, 7 * i));
  const idx = (w: string) => list.indexOf(w);
  const sb = supabaseAdmin();
  const [msgRes, statRes] = await Promise.all([
    sb.from("crm_messages").select("id,title,customer,links,trigger,offset_days,offset_note,target_ctr,solapi_template_id,utm_medium,active").eq("active", true),
    sb.from("crm_send_stats").select("source,grain,date,template,sent,batch").gte("date", first).lte("date", shiftDays(endWeek, 6)),
  ]);
  if (msgRes.error) throw msgRes.error;
  if (statRes.error) throw statRes.error;
  const msgs = ((msgRes.data || []) as unknown as CrmMessage[]).filter((m) => isTracked(m) && (!opts.onlyIds || opts.onlyIds.includes(m.id)));
  const stats = (statRes.data || []) as { source: string; grain: string; date: string; template: string; sent: number; batch: string }[];
  const weekOf = (r: { grain: string; date: string }) => (r.grain === "week" ? r.date : weekStartOf(r.date));
  const totalSent = list.map(() => 0);
  for (const r of stats) { const i = idx(weekOf(r)); if (i >= 0) totalSent[i] += r.sent || 0; }
  // GA: 날짜 × 캠페인(kakao) 한 번 → 주별
  const ga = new Map<string, number[]>(); // 캠페인 → 주별 세션
  const gaP = new Map<string, number[]>(), gaR = new Map<string, number[]>(); // 캠페인 → 주별 구매·매출
  const gaTotal = list.map(() => 0);
  let gaOk = false, note = "";
  if (isGaConfigured()) {
    try {
      const yesterday = shiftDays(kstToday(), -1);
      const until = shiftDays(endWeek, 6) < yesterday ? shiftDays(endWeek, 6) : yesterday;
      const r = await runGaReport({ since: first, until, dimensions: ["date", "campaign"], metrics: ["sessions", "purchases", "revenue"], limit: 5000, filter: { dimension: "source_medium", match: "regex", value: "^(kakao|datarize)" }, scope: "all" });
      for (const row of r.rows) {
        const i = idx(weekStartOf(String(row["날짜"] || ""))); if (i < 0) continue;
        const c = String(row["캠페인"] || "").trim().toLowerCase(); const n = Number(row["세션"]) || 0;
        const arr = ga.get(c) || list.map(() => 0); arr[i] += n; ga.set(c, arr); gaTotal[i] += n;
        const ap = gaP.get(c) || list.map(() => 0); ap[i] += Number(row["구매"]) || 0; gaP.set(c, ap);
        const ar = gaR.get(c) || list.map(() => 0); ar[i] += Math.round(Number(row["구매액(원)"]) || 0); gaR.set(c, ar);
      }
      gaOk = true;
    } catch (e) { note = e instanceof Error ? e.message : "GA 조회 실패"; }
  } else note = "GA4 가 연결되어 있지 않습니다.";
  const solapiWeeks = new Set(stats.filter((r) => r.source === "solapi").map(weekOf));
  const rows: HistoryRow[] = [];
  const estCache = new Map<string, Record<string, number> | null>();
  for (const m of msgs) {
    const campaign = (m.links?.utm_campaign || "").trim();
    const tid = (m.solapi_template_id || "").trim();
    let sentBasis: TrackedRow["sentBasis"] = "none";
    let sent: (number | null)[] = list.map(() => null);
    if (tid && solapiWeeks.size) {
      sentBasis = "solapi";
      sent = list.map((w) => (solapiWeeks.has(w) ? stats.filter((r) => r.source === "solapi" && r.template.endsWith(`:${tid}`) && weekOf(r) === w).reduce((a, r) => a + (r.sent || 0), 0) : null));
    } else {
      const manual = stats.filter((r) => r.batch === "manual" && r.template === m.title);
      if (manual.length) { sentBasis = "manual"; sent = list.map((w) => { const xs = manual.filter((r) => weekOf(r) === w); return xs.length ? xs.reduce((a, r) => a + (r.sent || 0), 0) : null; }); }
      else if (m.trigger) {
        const key = `${m.trigger}|${m.offset_days ?? ""}|${m.customer}|${(m.offset_note || "").match(/(\d+)\s*회/)?.[1] || ""}`;
        if (!estCache.has(key)) estCache.set(key, await estimateAudienceWeekly(sb, m, first, endWeek));
        const est = estCache.get(key);
        if (est) { sentBasis = "estimate"; sent = list.map((w) => est[w] ?? null); }
      }
    }
    const keys = campaignKeys(m);
    const sumKeys = (map: Map<string, number[]>): (number | null)[] => (gaOk ? list.map((_, i) => keys.reduce((a, k) => a + (map.get(k)?.[i] || 0), 0)) : list.map(() => null));
    const sess = sumKeys(ga), purchases = sumKeys(gaP), revenue = sumKeys(gaR);
    const ctr = list.map((_, i) => { const s = sent[i], g = sess[i]; return s && g != null ? Math.round((g / s) * 1000) / 10 : null; });
    rows.push({ id: m.id, title: m.title, customer: CRM_CUSTOMER_LABEL[m.customer] || m.customer || "", medium: m.utm_medium || "", campaign, aliases: campaignAliases(m), targetCtr: m.target_ctr ?? null, sentBasis, sent, sessions: sess, purchases, revenue, ctr });
  }
  const last = weeks - 1;
  rows.sort((a, b) => (b.sessions[last] ?? -1) - (a.sessions[last] ?? -1) || (b.sent[last] ?? -1) - (a.sent[last] ?? -1));
  const total = { sent: totalSent, sessions: gaOk ? gaTotal : list.map(() => null), ctr: list.map((_, i) => (gaOk && totalSent[i] ? Math.round((gaTotal[i] / totalSent[i]) * 1000) / 10 : null)) };
  return { weeks: list, rows, total, note };
}

// ── 메시지 하나 대시보드(2026-11-09, 대표 "이 메시지 성과는 어땠는지 봅시다") — 12주 이력(그 메시지 줄 + 전체 줄) + GA 날짜×term(캠페인 exact) 1회.
//  daily = 날짜별 세션·구매·매출(요일별 합도 여기서), byTerm = utm_term(A/B)별. 캠페인은 utm_campaign + 별칭 전부(전체 일치 정규식). 추적(utm_campaign) 없는 메시지는 이력만 비어서 돌아간다.
export type MessageStats = {
  weeks: string[]; row: HistoryRow | null; total: TrackedHistory["total"]; note: string;
  daily: { date: string; sessions: number; purchases: number; revenue: number }[];
  weekday: number[]; // 월~일 세션 합
  byTerm: { term: string; sessions: number; purchases: number; revenue: number }[];
};
export async function messageStats(id: string, endWeek: string, weeks = 12): Promise<MessageStats> {
  const h = await trackedHistory(endWeek, weeks, { onlyIds: [id] });
  const row = h.rows[0] || null;
  const out: MessageStats = { weeks: h.weeks, row, total: h.total, note: h.note, daily: [], weekday: [0, 0, 0, 0, 0, 0, 0], byTerm: [] };
  if (!row || !row.campaign || !isGaConfigured()) return out;
  try {
    const first = h.weeks[0];
    const yesterday = shiftDays(kstToday(), -1);
    const until = shiftDays(endWeek, 6) < yesterday ? shiftDays(endWeek, 6) : yesterday;
    const keys = [row.campaign, ...row.aliases].map((s) => s.trim()).filter(Boolean);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const r = await runGaReport({ since: first, until, dimensions: ["date", "term"], metrics: ["sessions", "purchases", "revenue"], limit: 2000, filter: { dimension: "campaign", match: "regex_full", value: `(${keys.map(esc).join("|")})` }, scope: "all" });
    const byDate = new Map<string, { date: string; sessions: number; purchases: number; revenue: number }>();
    const byTerm = new Map<string, { term: string; sessions: number; purchases: number; revenue: number }>();
    for (const x of r.rows) {
      const date = String(x["날짜"] || ""); if (!date) continue;
      const sessions = Number(x["세션"]) || 0, purchases = Number(x["구매"]) || 0, revenue = Math.round(Number(x["구매액(원)"]) || 0);
      const d = byDate.get(date) || { date, sessions: 0, purchases: 0, revenue: 0 }; d.sessions += sessions; d.purchases += purchases; d.revenue += revenue; byDate.set(date, d);
      const termRaw = String(x["키워드(term)"] || "").trim(); const term = !termRaw || termRaw === "(not set)" ? "(없음)" : termRaw;
      const t = byTerm.get(term) || { term, sessions: 0, purchases: 0, revenue: 0 }; t.sessions += sessions; t.purchases += purchases; t.revenue += revenue; byTerm.set(term, t);
      const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; out.weekday[dow] += sessions;
    }
    out.daily = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    out.byTerm = [...byTerm.values()].sort((a, b) => b.sessions - a.sessions);
  } catch (e) { out.note = out.note || (e instanceof Error ? e.message : "GA 조회 실패"); }
  return out;
}
