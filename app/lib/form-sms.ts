// 신청자 문자 — 탈리 폼 신청자에게 정한 시각(매일 hh:mm) 또는 즉시 문자를 보낸다(2026-11-14 대표 지시). 서버 전용.
//  ■ 보내는 시각(11-14 대표: "커스텀 할 수 있게, 즉시도 포함") — rule.mode
//    daily   = 매일 rule.time(한국 시간)에 그동안의 신청을 모아서. 하루 한 번(form_sms_daily 에 보낸 날짜).
//    instant = 예약 신호가 올 때마다(5분 간격) 새 신청을 가져와 바로. 그래서 '즉시'는 신청 뒤 5분 안이다.
//    예약 신호 = pg_cron 이 5분마다 /api/form-sms/tick 을 두드린다(migration 168). 보낼지는 tickFormSms 가 정한다.
//  옛 흐름: 탈리 → 구글시트 앱스크립트 → 재피어 → 솔라피.  새 흐름: 탈리 API → survey_responses → 여기 → 솔라피.
//  "신청 직후에 바로 보내지 않기 위함"(대표) — 그래서 하루 한 번 13시에 그동안의 신청을 모아서 보낸다.
//  ■ 신청은 탈리 API 로 '가져온다'(syncTally) — 설문응답 가져오기와 같은 API 키(관리자 › 설정 › 연결 › Tally).
//    웹훅(/api/voc/tally)은 쓰지 않는다: 서명 값을 탈리 폼마다 맞춰 넣어야 하는데 그 값을 화면에서 볼 수 없어 401 이 났다(11-14 대표 화면).
//    웹훅으로 들어온 응답이 있어도 같은 표(survey_responses)라 그대로 대상이 된다(제출 ID 로 중복 방지).
//
//  ■ 대기 = survey_responses 가운데 ① 설정한 폼 ② 설정을 켠 시각(since) 뒤에 들어옴 ③ form_sms_sends(167)에 줄이 없음.
//    ② 가 안전장치다 — 켜기 전에 쌓인 옛 응답이나, 나중에 '가져오기'로 한꺼번에 들어온 옛 응답(제출 시각이 옛날)에는 보내지 않는다.
//  ■ 두 번 보내지 않기 — 보내기 전에 form_sms_sends 에 'sending' 줄을 먼저 만든다(response_id unique).
//    예약 신호와 [지금 보내기]가 겹쳐도 줄을 만든 쪽만 보낸다. 도중에 죽으면 'sending' 으로 남고 다시 보내지 않는다(화면에 '확인 필요').
//  ■ 솔라피가 요청을 거절하면(SolapiRejected — 한 통도 접수 안 됨) 줄을 지워 대기로 되돌린다. 응답을 못 받았으면(시간 초과) 접수 여부를 몰라
//    'unknown' 으로 두고 다시 보내지 않는다.
//  ■ 전화번호 원문은 survey_responses.answers 에만 있다. 기록(167)에는 가린 번호만 남긴다.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getKv, setKv } from "./b2b-settings";
import { isSolapiConfigured, sendSolapiSms, SolapiRejected } from "./solapi";
import { getTallyApiKey, tallyFetch, mapTallySubmission, type TallyQ, type TallySub } from "./voc-tally";

export const FORM_SMS_TABLE = "form_sms_sends";
export const TICK_MINUTES = 5;            // 예약 신호 간격(migration 168 의 pg_cron) — '즉시'의 최대 지연
const RETRY_WINDOW_MIN = 60;              // 매일 발송이 탈리·솔라피 문제로 못 나갔을 때 다음 신호에 다시 해 보는 시간(그 뒤엔 다음 날)
export const AUTO_CAP = 300;              // 자동 발송의 상한 — 대기가 이보다 많으면 설정 실수로 보고 멈춘다([지금 보내기]로만)
const BATCH_MAX = 1000;                   // 한 번에 다루는 신청 수
const RULE_KV = "form_sms_rule", LAST_KV = "form_sms_last", TICK_KV = "form_sms_tick", CURSOR_KV = "form_sms_cursor", DAILY_KV = "form_sms_daily";
const SYNC_PAGES = 20;                    // 한 번에 가져오는 탈리 제출 = 100건 × 20쪽

export type SendMode = "daily" | "instant";
export type FormSmsRule = { on: boolean; mode: SendMode; time: string; formId: string; formName: string; from: string; text: string; since: string | null; updatedBy?: string; updatedAt?: string };
export const EMPTY_RULE: FormSmsRule = { on: false, mode: "daily", time: "13:00", formId: "", formName: "", from: "", text: "", since: null };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// 한국 시간의 오늘 날짜와 시:분
export function kstNow(now = Date.now()): { date: string; hm: string } {
  const s = new Date(now + 9 * 3600_000).toISOString();
  return { date: s.slice(0, 10), hm: s.slice(11, 16) };
}
export type FormSmsLast = { at: string; by: string; sent: number; failed: number; skipped: number; held?: number; error?: string };
export type SendStatus = "sending" | "sent" | "failed" | "skipped" | "unknown";

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
// 휴대폰 번호로 다듬기 — '+82 10-1234-5678'·'821012345678' 도 받는다. 휴대폰이 아니면 null.
export function normalizePhone(v: unknown): string | null {
  let d = digits(v);
  if (d.startsWith("82") && d.length >= 11) d = `0${d.slice(2)}`;
  return /^01[016789]\d{7,8}$/.test(d) ? d : null;
}
export const maskPhone = (d: string) => (d.length >= 10 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : "****");
// 문자 길이(바이트, 한글 2) — 90 이하면 단문(SMS), 넘으면 장문(LMS). 솔라피의 자동 판정과 같은 기준.
export function smsBytes(text: string): number {
  let n = 0;
  for (const ch of text) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}

type Answer = { label?: string; value?: string };
// 신청 답변에서 전화번호 찾기 — 질문 이름이 전화번호 같은 칸을 먼저, 없으면 값이 휴대폰 번호인 첫 칸.
export function findPhone(answers: unknown): string | null {
  const list = (Array.isArray(answers) ? answers : []) as Answer[];
  for (const a of list) if (/연락처|전화|휴대폰|핸드폰|폰\s*번호|phone|mobile|tel/i.test(String(a?.label ?? ""))) { const p = normalizePhone(a?.value); if (p) return p; }
  for (const a of list) { const v = String(a?.value ?? "").trim(); if (/^[+\d][\d\s\-().]{8,18}$/.test(v)) { const p = normalizePhone(v); if (p) return p; } }
  return null;
}

const parse = <T,>(raw: string, fallback: T): T => { try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };
export async function getRule(): Promise<FormSmsRule> {
  const r = { ...EMPTY_RULE, ...parse<Partial<FormSmsRule>>(await getKv(RULE_KV), {}) };
  if (r.mode !== "instant") r.mode = "daily";
  if (!TIME_RE.test(r.time)) r.time = EMPTY_RULE.time;
  return r;
}
export async function getLast(): Promise<FormSmsLast | null> { return parse<FormSmsLast | null>(await getKv(LAST_KV), null); }
export async function getTickAt(): Promise<string | null> { return (await getKv(TICK_KV)) || null; }
export async function markTick(): Promise<void> { await setKv(TICK_KV, new Date().toISOString()); }

export class FormSmsError extends Error {}
// 설정 저장 — 켜는 순간(또는 켠 채로 폼을 바꾼 순간)이 '이 뒤로 들어온 신청부터'의 기준 시각이 된다.
//  매일 발송에서 오늘의 그 시각이 이미 지났으면 첫 발송은 내일이다 — 켜자마자(또는 시각을 바꾸자마자) 방금 들어온 신청에 바로 나가지 않게.
export async function saveRule(input: unknown, who: string, now = Date.now()): Promise<FormSmsRule> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const prev = await getRule();
  if (o.mode === "daily" && !TIME_RE.test(String(o.time ?? ""))) throw new FormSmsError("보내는 시각을 입력하세요.");
  const next: FormSmsRule = {
    on: o.on === true,
    mode: o.mode === "instant" ? "instant" : "daily",
    time: TIME_RE.test(String(o.time ?? "")) ? String(o.time) : prev.time,
    formId: String(o.formId ?? "").trim().slice(0, 60),
    formName: String(o.formName ?? "").trim().slice(0, 200),
    from: digits(o.from).slice(0, 12),
    text: String(o.text ?? "").replace(/\r\n/g, "\n").trim().slice(0, 1000),
    since: prev.since,
    updatedBy: who, updatedAt: new Date().toISOString(),
  };
  if (next.on) {
    if (!next.formId) throw new FormSmsError("탈리 폼을 고르세요.");
    if (next.from.length < 8) throw new FormSmsError("발신번호를 입력하세요.");
    if (!next.text) throw new FormSmsError("문구를 입력하세요.");
    if (smsBytes(next.text) > 2000) throw new FormSmsError("문구가 너무 깁니다(장문 한도 2,000바이트).");
    if (!prev.on || prev.formId !== next.formId || !prev.since) next.since = new Date(now).toISOString();
  }
  await setKv(RULE_KV, JSON.stringify(next));
  if (next.on && next.mode === "daily" && (!prev.on || prev.mode !== "daily" || prev.time !== next.time)) {
    const k = kstNow(now);
    await setKv(DAILY_KV, k.hm >= next.time ? k.date : "-"); // 지났으면 오늘은 보낸 것으로, 아니면 오늘 그 시각에 보낸다
  }
  return next;
}

// 탈리에서 새 신청 가져오기 — 켠 시각(since) 뒤의 제출만. 이미 있는 제출(submission_id)은 건너뛴다.
//  다음에는 마지막으로 본 제출 시각부터 읽는다(form_sms_cursor — 폼·켠 시각이 바뀌면 처음부터).
//  API 키가 없으면 아무것도 하지 않는다(null). 탈리 호출이 실패하면 던진다 — 부르는 쪽이 발송을 멈춘다.
export async function syncTally(sb: SupabaseClient, rule: FormSmsRule): Promise<{ scanned: number; added: number } | null> {
  if (!rule.formId || !rule.since) return null;
  const apiKey = await getTallyApiKey();
  if (!apiKey) return null;
  const cur = parse<{ formId?: string; since?: string; at?: string }>(await getKv(CURSOR_KV), {});
  // 이어 읽는 자리 = 마지막으로 본 제출 시각에서 1분 앞(경계에 걸린 제출을 놓치지 않게 — 겹친 것은 제출 ID 로 걸러진다)
  const sinceMs = Date.parse(rule.since), curMs = cur.formId === rule.formId && cur.since === rule.since && cur.at ? Date.parse(cur.at) - 60_000 : NaN;
  const start = curMs > sinceMs ? new Date(curMs).toISOString() : rule.since;
  const qmap = new Map<string, TallyQ>();
  const subs: TallySub[] = [];
  let maxAt = cur.formId === rule.formId && cur.since === rule.since && cur.at ? cur.at : rule.since;
  for (let page = 1; page <= SYNC_PAGES; page++) {
    const json = await tallyFetch(`/forms/${encodeURIComponent(rule.formId)}/submissions?filter=completed&limit=100&page=${page}&startDate=${encodeURIComponent(start)}`, apiKey);
    for (const q of (json.questions || []) as TallyQ[]) if (q.id) qmap.set(q.id, q);
    const list = (json.submissions || []) as TallySub[];
    for (const s of list) { if (!s?.id) continue; subs.push(s); if (s.submittedAt && Date.parse(s.submittedAt) > Date.parse(maxAt)) maxAt = s.submittedAt; }
    if (!json.hasMore || list.length === 0) break;
  }
  const have = new Set<string>();
  for (let i = 0; i < subs.length; i += 100) {
    const { data, error } = await sb.from("survey_responses").select("submission_id").in("submission_id", subs.slice(i, i + 100).map((s) => s.id));
    if (error) throw error;
    for (const r of (data ?? []) as { submission_id: string }[]) have.add(r.submission_id);
  }
  const rows = subs.filter((s) => !have.has(s.id)).map((s) => ({ ...mapTallySubmission(s, qmap, rule.formId), form_name: rule.formName || null }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("survey_responses").upsert(rows.slice(i, i + 200), { onConflict: "submission_id", ignoreDuplicates: true });
    if (error) throw error;
  }
  if (maxAt !== cur.at || cur.formId !== rule.formId || cur.since !== rule.since) await setKv(CURSOR_KV, JSON.stringify({ formId: rule.formId, since: rule.since, at: maxAt })).catch(() => {});
  return { scanned: subs.length, added: rows.length };
}

export type PendingRow = { id: string; at: string; phone: string | null };
type RespRow = { id: string; created_at: string; submitted_at: string | null; answers: unknown };
// 대기 중인 신청(오래된 것부터). 전화번호는 서버 안에서만 쓴다 — 화면에는 가려서 내보낸다.
export async function loadPending(sb: SupabaseClient, rule: FormSmsRule): Promise<PendingRow[]> {
  if (!rule.formId || !rule.since) return [];
  const { data, error } = await sb.from("survey_responses").select("id, created_at, submitted_at, answers")
    .eq("form_id", rule.formId).gte("created_at", rule.since).order("created_at", { ascending: true }).limit(BATCH_MAX);
  if (error) throw error;
  // 제출 시각이 켠 시각보다 앞선 응답 = 나중에 한꺼번에 가져온 옛 응답 → 대상 아님(시각 표기가 달라 숫자로 비교한다)
  const sinceMs = Date.parse(rule.since);
  const rows = ((data ?? []) as RespRow[]).filter((r) => !r.submitted_at || Date.parse(r.submitted_at) >= sinceMs);
  const done = new Set<string>();
  for (let i = 0; i < rows.length; i += 200) {
    const { data: d, error: e } = await sb.from(FORM_SMS_TABLE).select("response_id").in("response_id", rows.slice(i, i + 200).map((r) => r.id));
    if (e) throw e;
    for (const x of (d ?? []) as { response_id: string }[]) done.add(x.response_id);
  }
  return rows.filter((r) => !done.has(r.id)).map((r) => ({ id: r.id, at: r.submitted_at || r.created_at, phone: findPhone(r.answers) }));
}

export type RunResult = { ok: boolean; sent: number; failed: number; skipped: number; held?: number; error?: string; note?: string; retry?: boolean };
// 대기 중인 신청자에게 보낸다. auto = 예약 신호(상한 적용), 아니면 [지금 보내기]. retry = 한 통도 안 나갔고 다시 해 봐도 되는 실패(탈리·솔라피 거절).
export async function runFormSms(sb: SupabaseClient, by: string, auto: boolean): Promise<RunResult> {
  const rule = await getRule();
  if (!rule.on) return { ok: true, sent: 0, failed: 0, skipped: 0, note: "꺼져 있습니다" };
  if (!isSolapiConfigured()) return finish({ ok: false, sent: 0, failed: 0, skipped: 0, error: "솔라피 키(SOLAPI_API_KEY·SOLAPI_API_SECRET)가 없습니다." }, by, auto);
  // 탈리에서 새 신청을 먼저 가져온다. 못 가져오면 보내지 않는다(일부만 보내고 끝난 것처럼 보이지 않게 — 다음 실행이 이어서 가져온다)
  try { await syncTally(sb, rule); }
  catch (e) { return finish({ ok: false, sent: 0, failed: 0, skipped: 0, retry: true, error: `탈리에서 신청을 가져오지 못했습니다 — ${e instanceof Error ? e.message : "오류"}` }, by, auto); }
  const pending = await loadPending(sb, rule);
  if (!pending.length) return finish({ ok: true, sent: 0, failed: 0, skipped: 0 }, by, auto);
  if (auto && pending.length > AUTO_CAP) return finish({ ok: false, sent: 0, failed: 0, skipped: 0, held: pending.length, error: `대기 ${pending.length}명이 자동 발송 상한(${AUTO_CAP}명)을 넘어 보내지 않았습니다.` }, by, auto);

  // 줄 먼저 만들기(선점) — 번호 없음·같은 번호 중복은 바로 '건너뜀'
  const seen = new Set<string>();
  const claim = pending.map((p) => {
    const dup = !!p.phone && seen.has(p.phone);
    if (p.phone) seen.add(p.phone);
    const skip = !p.phone ? "전화번호를 찾지 못했습니다" : dup ? "같은 번호가 한 번에 두 건 — 한 통만 보냈습니다" : null;
    return { response_id: p.id, form_id: rule.formId, phone_mask: p.phone ? maskPhone(p.phone) : null, status: (skip ? "skipped" : "sending") as SendStatus, reason: skip, sent_by: by };
  });
  const { data: made, error: claimErr } = await sb.from(FORM_SMS_TABLE).upsert(claim, { onConflict: "response_id", ignoreDuplicates: true }).select("response_id, status");
  if (claimErr) throw claimErr;
  const mine = new Map(((made ?? []) as { response_id: string; status: SendStatus }[]).map((r) => [r.response_id, r.status]));
  const skipped = [...mine.values()].filter((s) => s === "skipped").length;
  const targets = pending.filter((p) => p.phone && mine.get(p.id) === "sending") as (PendingRow & { phone: string })[];
  if (!targets.length) return finish({ ok: true, sent: 0, failed: 0, skipped }, by, auto);
  const ids = targets.map((t) => t.id);
  const setAll = async (patch: Record<string, unknown>) => {
    for (let i = 0; i < ids.length; i += 200) { const { error } = await sb.from(FORM_SMS_TABLE).update(patch).in("response_id", ids.slice(i, i + 200)); if (error) throw error; }
  };

  let res;
  try {
    res = await sendSolapiSms({ from: rule.from, text: rule.text, to: targets.map((t) => t.phone) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "솔라피 호출 실패";
    if (e instanceof SolapiRejected) {
      // 한 통도 접수되지 않았다 → 줄을 지워 대기로 되돌린다(다음 13시나 [지금 보내기]에 다시)
      for (let i = 0; i < ids.length; i += 200) await sb.from(FORM_SMS_TABLE).delete().in("response_id", ids.slice(i, i + 200)).eq("status", "sending");
      return finish({ ok: false, sent: 0, failed: 0, skipped, retry: true, error: msg }, by, auto);
    }
    await setAll({ status: "unknown", reason: `솔라피 응답을 받지 못했습니다(${msg}) — 솔라피 발송 내역에서 확인하세요` }).catch(() => {});
    return finish({ ok: false, sent: 0, failed: 0, skipped, error: `솔라피 응답을 받지 못했습니다 — ${targets.length}명은 접수 여부를 확인해야 합니다.` }, by, auto);
  }

  const failedBy = new Map(res.failed.map((f) => [f.to, f]));
  const now = new Date().toISOString();
  await setAll({ status: "sent", group_id: res.groupId, sent_at: now });
  let failed = 0;
  for (const t of targets) {
    const f = failedBy.get(t.phone);
    if (!f) continue;
    failed++;
    const { error } = await sb.from(FORM_SMS_TABLE).update({ status: "failed", reason: `${f.message}${f.code ? ` (${f.code})` : ""}`, sent_at: null }).eq("response_id", t.id);
    if (error) throw error;
  }
  return finish({ ok: true, sent: targets.length - failed, failed, skipped }, by, auto);
}
// 마지막 실행 기록. 예약 신호가 와서 봤는데 보낼 것이 없던 실행은 남기지 않는다('즉시'는 5분마다 돌아 기록을 덮어쓴다) — 앞의 오류를 지울 때만 남긴다.
async function finish(r: RunResult, by: string, auto: boolean): Promise<RunResult> {
  if (auto && !r.error && !r.sent && !r.failed && !r.skipped && !r.held) { const prev = await getLast().catch(() => null); if (!prev?.error) return r; }
  const last: FormSmsLast = { at: new Date().toISOString(), by, sent: r.sent, failed: r.failed, skipped: r.skipped, ...(r.held ? { held: r.held } : {}), ...(r.error ? { error: r.error } : {}) };
  await setKv(LAST_KV, JSON.stringify(last)).catch(() => {});
  return r;
}

// 예약 신호(5분마다) — 지금 보낼 차례인지 정하고, 차례면 보낸다.
//  instant: 신호마다. daily: 오늘의 rule.time 이 지났고 오늘 아직 안 보냈으면 한 번.
//  daily 가 다시 해 볼 수 있는 실패(retry)로 끝났으면 '보냄' 표시를 하지 않아 다음 신호(5분 뒤)에 다시 한다 — 그 시각에서 한 시간까지만.
export async function tickFormSms(sb: SupabaseClient, now = Date.now()): Promise<RunResult> {
  const rule = await getRule();
  const idle = (note: string): RunResult => ({ ok: true, sent: 0, failed: 0, skipped: 0, note });
  if (!rule.on) return idle("꺼져 있습니다");
  if (rule.mode === "instant") return runFormSms(sb, "예약", true);
  const k = kstNow(now);
  if (k.hm < rule.time) return idle("아직 보낼 시각이 아닙니다");
  if ((await getKv(DAILY_KV)) === k.date) return idle("오늘은 이미 보냈습니다");
  const r = await runFormSms(sb, "예약", true);
  const [h, m] = rule.time.split(":").map(Number), [nh, nm] = k.hm.split(":").map(Number);
  const late = nh * 60 + nm - (h * 60 + m) >= RETRY_WINDOW_MIN;
  if (!r.retry || late) await setKv(DAILY_KV, k.date);
  return r;
}

// 시험 발송 — 적어 넣은 번호 한 곳으로. 기록 표에는 남기지 않는다(신청 건이 아니다).
export async function sendTest(p: { to: unknown; from: unknown; text: unknown }): Promise<void> {
  const to = normalizePhone(p.to), from = digits(p.from), text = String(p.text ?? "").trim();
  if (!to) throw new FormSmsError("받을 휴대폰 번호를 정확히 입력하세요.");
  if (from.length < 8) throw new FormSmsError("발신번호를 입력하세요.");
  if (!text) throw new FormSmsError("문구를 입력하세요.");
  const res = await sendSolapiSms({ from, text, to: [to] });
  if (res.failed.length) throw new FormSmsError(`솔라피가 접수하지 않았습니다 — ${res.failed[0].message}${res.failed[0].code ? ` (${res.failed[0].code})` : ""}`);
}

export const isMissingFormSms = (e: { message?: string } | null | undefined) => !!e && /form_sms_sends|does not exist|schema cache/i.test(e.message || "");
