// AI 데이터 비서 — 저장 리포트 정기 발송(2026-10-19 개선안 3). 서버 전용.
//  저장 리포트(report-saved.ts)에 schedule{freq, to, lastSentOn} 이 있으면 아침 크론 틱(schedule-digest 06:00 KST)에서
//  오늘 차례인 것을 골라 SQL 을 실행하고 표를 메일로 보낸다(nodemailer, 매출 리포트와 같은 SMTP).
//  예약 변수 {{시작일}}·{{종료일}} 은 주기에 맞춰 자동으로 채운다(매일 = 어제, 매주 = 지난주 월~일, 매월 = 지난달).
//  그 밖의 {{변수}} 가 있는 리포트는 예약할 수 없다(화면이 막고, 여기서도 건너뛴다).
//  dedup = schedule.lastSentOn(KST 날짜). 한 틱에 최대 MAX_PER_TICK 건 — 나머지는 다음 날.
import { supabaseAdmin } from "./supabase";
import { validateReportSql } from "./report-ai";
import { getSavedReports, updateSavedReport, type SavedReport, type ScheduleFreq } from "./report-saved";
import { sendSalesMail, defaultRecipients } from "./sales-mailer";
import { getAppBaseUrl } from "./b2b-settings";
import { MAIL_COLORS, mailEsc } from "./sales-report-html";

export const RESERVED_VARS = ["시작일", "종료일"] as const;
const MAX_PER_TICK = 6;
const MAIL_ROWS = 100;
const BAR_ROWS = 30;

const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400e3);

export function extractVars(sql: string): string[] {
  return [...new Set([...sql.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))];
}
export const unresolvedVars = (sql: string) => extractVars(sql).filter((v) => !(RESERVED_VARS as readonly string[]).includes(v));

// 주기별 기간(KST 오늘 기준) — 라벨은 메일 제목에
export function scheduleRange(freq: ScheduleFreq, today = kstNow()): { since: string; until: string; label: string } {
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (freq === "daily") { const y = addDays(t, -1); return { since: iso(y), until: iso(y), label: iso(y) }; }
  if (freq === "weekly") {
    const dow = (t.getUTCDay() + 6) % 7;              // 월=0
    const thisMon = addDays(t, -dow);
    const since = addDays(thisMon, -7), until = addDays(thisMon, -1);
    return { since: iso(since), until: iso(until), label: `${iso(since)}~${iso(until)}` };
  }
  const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const since = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
  const until = addDays(first, -1);
  return { since: iso(since), until: iso(until), label: `${since.getUTCFullYear()}년 ${since.getUTCMonth() + 1}월` };
}
export function fillReserved(sql: string, r: { since: string; until: string }): string {
  return sql.replace(/\{\{\s*시작일\s*\}\}/g, r.since).replace(/\{\{\s*종료일\s*\}\}/g, r.until);
}
// 오늘 보낼 차례인가 — 매일 / 매주 월요일 / 매월 1일
export function isDueToday(freq: ScheduleFreq, today = kstNow()): boolean {
  if (freq === "daily") return true;
  if (freq === "weekly") return today.getUTCDay() === 1;
  return today.getUTCDate() === 1;
}

const C = MAIL_COLORS;
const won = (v: number) => v.toLocaleString("ko-KR");
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return won(v);
  return mailEsc(String(v));
}
// 표 메일 — 첫 숫자 열에 막대(≤30행), 숫자는 오른쪽 정렬. 매출 리포트 메일과 같은 팔레트.
export function buildScheduleHtml(rep: SavedReport, rangeLabel: string, columns: string[], rows: Record<string, unknown>[], baseUrl: string): string {
  const shown = rows.slice(0, MAIL_ROWS);
  const numCols = columns.filter((c) => typeof shown[0]?.[c] === "number");
  const barCol = shown.length <= BAR_ROWS ? numCols[0] : undefined;
  const maxBar = barCol ? Math.max(1, ...shown.map((r) => Math.abs(Number(r[barCol]) || 0))) : 1;
  const th = columns.map((c) => `<th style="text-align:${numCols.includes(c) ? "right" : "left"};font-size:11px;color:${C.C_MUTED};font-weight:700;padding:8px 10px;border-bottom:1px solid ${C.C_LINE};white-space:nowrap;">${mailEsc(c)}</th>`).join("");
  const trs = shown.map((r) => `<tr>${columns.map((c) => {
    const isNum = numCols.includes(c);
    const bar = barCol === c ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px;"><tr><td width="${Math.max(1, Math.round(Math.abs(Number(r[c]) || 0) / maxBar * 100))}%" bgcolor="${C.C_TIDE}" style="height:6px;font-size:0;line-height:0;border-radius:3px;">&nbsp;</td><td></td></tr></table>` : "";
    return `<td style="text-align:${isNum ? "right" : "left"};font-size:13px;color:${C.C_INK};padding:8px 10px;border-bottom:1px solid ${C.C_LINE};${isNum ? "white-space:nowrap;" : ""}">${cell(r[c])}${bar}</td>`;
  }).join("")}</tr>`).join("");
  const note = rows.length > MAIL_ROWS ? `<div style="font-size:11px;color:${C.C_MUTED};padding:8px 10px;">앞 ${MAIL_ROWS}행만 표시(전체 ${won(rows.length)}행). 전체는 AI 데이터 비서에서 [엑셀 내려받기]</div>` : "";
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7fafb;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f7fafb"><tr><td align="center" style="padding:0;">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">
  <tr><td style="background:${C.C_DEEP};padding:24px 24px;">
    <div style="font-size:11px;letter-spacing:2px;color:#9fc4d2;font-weight:600;">SEAMONSTER &#183; AI DATA ASSISTANT</div>
    <div style="font-size:20px;color:#ffffff;font-weight:800;margin-top:6px;">${mailEsc(rep.name)}</div>
    <div style="font-size:13px;color:#cfe2e9;margin-top:4px;">${mailEsc(rangeLabel)} &#183; ${won(rows.length)}행</div>
  </td></tr>
  ${rep.question ? `<tr><td style="padding:16px 24px 0;font-size:12px;color:${C.C_MUTED};">${mailEsc(rep.question)}</td></tr>` : ""}
  <tr><td style="padding:14px 24px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.C_LINE};border-radius:8px;background:#ffffff;border-collapse:separate;">
      <tr>${th}</tr>${trs || `<tr><td colspan="${columns.length || 1}" style="padding:14px 10px;font-size:13px;color:${C.C_MUTED};">조회 결과가 없습니다.</td></tr>`}
    </table>${note}
  </td></tr>
  <tr><td style="padding:20px 24px 36px;">
    <div style="font-size:11px;color:${C.C_MUTED};line-height:1.6;border-top:1px solid ${C.C_LINE};padding-top:14px;">
      저장 리포트의 정기 발송입니다. 바꾸거나 끄려면 AI 데이터 비서 › 저장된 리포트 › [정기 받기] &#183; <a href="${mailEsc(baseUrl)}/report" style="color:${C.C_TIDE};">${mailEsc(baseUrl)}/report</a><br>
      씨몬스터 AI 데이터 비서 &#183; 자동 발송
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
function buildScheduleText(rep: SavedReport, rangeLabel: string, columns: string[], rows: Record<string, unknown>[]): string {
  const L = [`[AI 데이터 비서] ${rep.name} — ${rangeLabel}`, "", columns.join(" | ")];
  for (const r of rows.slice(0, MAIL_ROWS)) L.push(columns.map((c) => cell(r[c]).replace(/&[a-z]+;/g, "")).join(" | "));
  if (rows.length > MAIL_ROWS) L.push(`… 앞 ${MAIL_ROWS}행만(전체 ${rows.length}행)`);
  return L.join("\n");
}

export type ScheduleRunResult = { id: string; name: string; ok: boolean; error?: string; rows?: number; to?: string[] };

// 한 건 실행·발송 — 화면의 [지금 보내기] 와 크론이 같은 길을 쓴다
export async function sendScheduledReport(rep: SavedReport, opts?: { force?: boolean; today?: Date }): Promise<ScheduleRunResult> {
  const sch = rep.schedule;
  if (!sch) return { id: rep.id, name: rep.name, ok: false, error: "정기 발송 설정이 없습니다." };
  const extra = unresolvedVars(rep.sql);
  if (extra.length) return { id: rep.id, name: rep.name, ok: false, error: `값을 자동으로 채울 수 없는 변수: ${extra.join(", ")}` };
  const today = opts?.today ?? kstNow();
  const range = scheduleRange(sch.freq, today);
  let safe: string;
  try { safe = validateReportSql(fillReserved(rep.sql, range)); }
  catch (e) { return { id: rep.id, name: rep.name, ok: false, error: `SQL 검증 실패: ${e instanceof Error ? e.message : String(e)}` }; }
  const { data, error } = await supabaseAdmin().rpc("run_report", { q: safe });
  if (error) return { id: rep.id, name: rep.name, ok: false, error: `쿼리 실행 오류: ${error.message}` };
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const to = (sch.to && sch.to.length ? sch.to : defaultRecipients());
  if (!to.length) return { id: rep.id, name: rep.name, ok: false, error: "수신자가 없습니다(SALES_MAIL_TO 미설정)." };
  const base = await getAppBaseUrl().catch(() => "");
  const subject = `[AI 데이터 비서] ${rep.name} — ${range.label}`;
  try {
    await sendSalesMail({ subject, text: buildScheduleText(rep, range.label, columns, rows), html: buildScheduleHtml(rep, range.label, columns, rows, base), to }, { timeoutMs: 15_000 });
  } catch (e) { return { id: rep.id, name: rep.name, ok: false, error: `메일 발송 실패: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!opts?.force) await updateSavedReport(rep.id, { schedule: { ...sch, lastSentOn: iso(today) } }).catch((e) => console.error("[report-schedule] 발송 기록 실패", e));
  return { id: rep.id, name: rep.name, ok: true, rows: rows.length, to };
}

// 크론 틱 — 오늘 차례이고 아직 안 보낸 것만, 최대 MAX_PER_TICK 건 순서대로
export async function runDueScheduledReports(today = kstNow()): Promise<ScheduleRunResult[]> {
  const todayIso = iso(today);
  const due = (await getSavedReports()).filter((r) => r.schedule && isDueToday(r.schedule.freq, today) && r.schedule.lastSentOn !== todayIso).slice(0, MAX_PER_TICK);
  const out: ScheduleRunResult[] = [];
  for (const rep of due) {
    try { out.push(await sendScheduledReport(rep, { today })); }
    catch (e) { out.push({ id: rep.id, name: rep.name, ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  if (out.length) console.log(`[report-schedule] ${todayIso} ${out.filter((r) => r.ok).length}/${out.length} 발송`, out.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`).join(" / "));
  return out;
}
