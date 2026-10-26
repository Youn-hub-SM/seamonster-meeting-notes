// CRM 발송 수치(crm_send_stats, migration 149) — 주간 성과표의 계산·수집 (2026-10-26, docs/crm-dashboard-plan.md)
//  수단별 발송·클릭은 crm_send_stats 에서, 랜딩 성과(세션·구매·매출)는 GA4 의 utm medium(소스/매체 'kakao / …')에서.
import { supabaseAdmin } from "./supabase";
import { isGaConfigured, runGaReport } from "./ga";
import { fetchSolapiMessages, aggregateSolapi, isSolapiConfigured } from "./solapi";

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
export async function syncSolapi(p: { since: string; until: string }): Promise<{ rows: number; messages: number }> {
  if (!isSolapiConfigured()) throw new Error("솔라피 자격(SOLAPI_API_KEY·SOLAPI_API_SECRET)이 없습니다.");
  const msgs = await fetchSolapiMessages(p);
  const agg = aggregateSolapi(msgs);
  const rows: CrmStatUpsert[] = agg.map((a) => ({ source: "solapi", grain: "day", date: a.date, template: `${a.type}${a.templateId ? `:${a.templateId}` : ""}`, sent: a.sent, delivered: null, clicked: null, cost: null, utm_campaign: null, note: a.failed ? `실패 ${a.failed}` : "", batch: "solapi-sync" }));
  const n = await upsertCrmStats(rows);
  return { rows: n, messages: msgs.length };
}

// ── 주간 집계 ──
export type WeeklySource = { source: string; label: string; sent: number; clicked: number | null; cost: number | null; templates: { template: string; sent: number; clicked: number | null; days: number }[] };
export type GaMediumRow = { medium: string; sessions: number; purchases: number; revenue: number };

export async function weeklyStats(weekStart: string): Promise<{ week: string; until: string; sources: WeeklySource[]; rows: CrmStatRow[] }> {
  const until = shiftDays(weekStart, 6);
  const sb = supabaseAdmin();
  const { data, error } = await sb.from("crm_send_stats").select("*").gte("date", weekStart).lte("date", until).order("date");
  if (error) throw error;
  const rows = (data || []) as CrmStatRow[];
  const bySrc = new Map<string, WeeklySource>();
  for (const r of rows) {
    if (r.grain === "week" && r.date !== weekStart) continue; // 주별 행은 주 시작일 것만
    const s = bySrc.get(r.source) || { source: r.source, label: CRM_SOURCE_LABEL[r.source] || r.source, sent: 0, clicked: null, cost: null, templates: [] };
    s.sent += r.sent || 0;
    if (r.clicked != null) s.clicked = (s.clicked || 0) + r.clicked;
    if (r.cost != null) s.cost = (s.cost || 0) + Number(r.cost);
    const t = s.templates.find((x) => x.template === r.template) || (s.templates.push({ template: r.template, sent: 0, clicked: null, days: 0 }), s.templates[s.templates.length - 1]);
    t.sent += r.sent || 0; if (r.clicked != null) t.clicked = (t.clicked || 0) + r.clicked; t.days++;
    bySrc.set(r.source, s);
  }
  const order = CRM_SOURCES.map((s) => s.key as string);
  const sources = [...bySrc.values()].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  for (const s of sources) s.templates.sort((a, b) => b.sent - a.sent);
  return { week: weekStart, until, sources, rows };
}

// GA — 소스/매체가 'kakao / …'(utm 규칙 source=kakao) 인 세션·구매·매출을 매체별로. 설정 없으면 null.
export async function gaByMedium(since: string, until: string): Promise<GaMediumRow[] | null> {
  if (!isGaConfigured()) return null;
  const r = await runGaReport({ since, until, dimensions: ["source_medium"], metrics: ["sessions", "purchases", "revenue"], limit: 200, filter: { dimension: "source_medium", match: "begins_with", value: "kakao" } });
  return r.rows.map((row) => ({ medium: String(row["소스/매체"] || "").replace(/^kakao\s*\/\s*/, ""), sessions: Number(row["세션"]) || 0, purchases: Number(row["구매"]) || 0, revenue: Math.round(Number(row["구매액(원)"]) || 0) })).filter((x) => x.medium).sort((a, b) => b.sessions - a.sessions);
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
