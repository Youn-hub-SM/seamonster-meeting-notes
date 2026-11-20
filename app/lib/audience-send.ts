// 오디언스 추출 — 찾은 고객에게 정해 둔 알림톡을 바로 보낸다(2026-11-20 대표 지시). 서버 전용.
//  ■ 대표 결정(11-20): 정보성 알림톡만 · 문자 대체 발송 안 함 · 즉시 발송만(예약 없음) · 야간에는 보내지 않는다(업무도우미가 막는다).
//  ■ 누구에게 = 보내는 순간에 조건으로 다시 찾은 고객(탈리 응답자 제외도 그 순간의 응답으로 다시 뺀다) — 찾기는 app/api/audience/route.ts 가 한다.
//    휴대폰 번호가 아닌 번호는 알림톡이 가지 않으므로 뺀다. 한 번에 MAX_SEND 명까지 — 넘으면 멈추고 조건을 좁히게 한다.
//  ■ 두 번 보내지 않기 — 화면이 발송 창을 열 때 만든 요청 ID(request_id, unique)로 audience_sends(173)에 'sending' 줄을 먼저 만든다.
//    같은 요청이 다시 오면(두 번 누름·응답을 못 받고 다시 누름) 줄을 만들지 못해 보내지 않는다. 도중에 죽으면 'sending' 으로 남는다(화면에 '확인 필요').
//  ■ 묶음(CHUNK)으로 나눠 보낸다. 멈추는 경우 — 남은 묶음은 보내지 않고 몇 명에게 요청했는지 기록한다:
//    · 야간이 됨  · 솔라피가 요청을 거절함(그 묶음은 한 통도 접수되지 않음)  · 응답을 못 받음(접수 여부 모름 → 'unknown', 다시 보내지 않는다)
//    · 한 묶음이 전부 접수 실패(템플릿·변수가 맞지 않는 경우 — 나머지도 같은 결과라 멈춘다)
//  ■ 기록에는 전화번호·이름을 넣지 않는다(조건·템플릿·인원·결과만).
import type { SupabaseClient } from "@supabase/supabase-js";
import { kstNow } from "./form-sms";
import { fetchSolapiGroup, sendSolapiAlimtalk, SolapiRejected, type AlimtalkMessage, type AlimtalkTemplate } from "./solapi";

export const SEND_TABLE = "audience_sends";
export const MAX_SEND = 10_000;   // 한 번에 보내는 인원 상한
const CHUNK = 1_000;              // 솔라피 한 요청에 담는 수
export const SEND_OPEN = "08:00"; // 한국 시간 — 이 시각부터
export const SEND_CLOSE = "20:50"; // 이 시각 전까지만 보낸다(솔라피 실패 코드 3108 의 기준과 같게)
export const NIGHT_MSG = "야간(오후 8시 50분 ~ 오전 8시)에는 알림톡을 보내지 않습니다.";
export function sendWindowOpen(now = Date.now()): boolean {
  const { hm } = kstNow(now);
  return hm >= SEND_OPEN && hm < SEND_CLOSE;
}

export class SendError extends Error {}
export const isMissingSendTable = (e: { message?: string; code?: string } | null | undefined) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /audience_sends|does not exist|schema cache/i.test(e.message || ""));
const MISSING_MSG = "알림톡 발송 기록 표가 없습니다 — migration 173 을 먼저 적용하세요.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRequestId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

// ── 변수 — 템플릿의 #{이름} 마다 '고객 이름' 또는 '적은 글자' ──
export type VarRule = { kind: "name" } | { kind: "text"; value: string };
export const NAME_FALLBACK = "고객"; // 이름이 비어 있는 고객에게 들어가는 말
const VALUE_MAX = 200;
export function normalizeVars(raw: unknown, names: string[]): Record<string, VarRule> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, { kind?: unknown; value?: unknown }>;
  const out: Record<string, VarRule> = {};
  for (const n of names) {
    const r = o[n];
    if (r?.kind === "name") { out[n] = { kind: "name" }; continue; }
    const value = String(r?.value ?? "").trim();
    if (r?.kind !== "text" || !value) throw new SendError(`변수 #{${n}}에 넣을 값을 정하세요.`);
    if (value.length > VALUE_MAX) throw new SendError(`변수 #{${n}}의 값이 너무 깁니다(${VALUE_MAX}자까지).`);
    out[n] = { kind: "text", value };
  }
  return out;
}
export function buildVariables(vars: Record<string, VarRule>, customerName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, r] of Object.entries(vars)) out[`#{${n}}`] = r.kind === "name" ? (customerName.trim() || NAME_FALLBACK) : r.value;
  return out;
}
// 기록·확인 창에 보이는 말 — '#{고객명} = 고객 이름, #{기한} = 11월 30일'
export const varsText = (vars: Record<string, VarRule>): string => Object.entries(vars).map(([n, r]) => `#{${n}} = ${r.kind === "name" ? "고객 이름" : r.value}`).join(", ");

// ── 보내기 ──
export type Recipient = { phone: string; name: string };
export type SendStatus = "sending" | "sent" | "partial" | "failed" | "unknown";
export type SendOutcome = { id: number; status: SendStatus; target: number; attempted: number; accepted: number; failed: number; reason: string };
export type SendInput = {
  requestId: string; kind: "send" | "test"; mode: "buy" | "sub" | "test"; cond: Record<string, unknown> | null; summary: string;
  template: AlimtalkTemplate; vars: Record<string, VarRule>; recipients: Recipient[]; by: string; from?: string;
};

export async function runSend(sb: SupabaseClient, p: SendInput): Promise<SendOutcome> {
  if (!sendWindowOpen()) throw new SendError(NIGHT_MSG);
  if (!p.recipients.length) throw new SendError("보낼 고객이 없습니다.");
  if (p.recipients.length > MAX_SEND) throw new SendError(`한 번에 ${MAX_SEND.toLocaleString("ko-KR")}명까지 보냅니다 — 지금 ${p.recipients.length.toLocaleString("ko-KR")}명입니다. 조건을 좁히세요.`);
  if (!p.template.channelId) throw new SendError("템플릿의 카카오 채널을 찾지 못했습니다.");

  // ① 줄을 먼저 만든다 — 만든 쪽만 보낸다
  const ins = await sb.from(SEND_TABLE).insert({
    request_id: p.requestId, kind: p.kind, mode: p.mode, cond: p.cond, cond_summary: p.summary,
    template_id: p.template.templateId, template_name: p.template.name, channel_id: p.template.channelId, variables: p.vars,
    target_count: p.recipients.length, status: "sending", sent_by: p.by,
  }).select("id").single();
  if (ins.error) {
    if (ins.error.code === "23505") throw new SendError("이미 처리한 발송 요청입니다. 아래 알림톡 발송 기록을 확인하세요.");
    if (isMissingSendTable(ins.error)) throw new SendError(MISSING_MSG);
    throw new Error(`발송 기록을 만들지 못했습니다: ${ins.error.message}`);
  }
  const id = Number((ins.data as { id: number }).id);

  // ② 묶음으로 보낸다
  let attempted = 0, accepted = 0, failed = 0, stop = "", unknown = false;
  const groups: string[] = [];
  const codes = new Map<string, { message: string; n: number }>();
  for (let i = 0; i < p.recipients.length; i += CHUNK) {
    if (!sendWindowOpen()) { stop = "야간이 되어 멈췄습니다"; break; }
    const part = p.recipients.slice(i, i + CHUNK);
    const messages: AlimtalkMessage[] = part.map((r) => ({ to: r.phone, variables: buildVariables(p.vars, r.name) }));
    try {
      const res = await sendSolapiAlimtalk({ pfId: p.template.channelId, templateId: p.template.templateId, from: p.from, messages });
      attempted += part.length;
      if (res.groupId) groups.push(res.groupId);
      failed += res.failed.length;
      accepted += part.length - res.failed.length;
      for (const f of res.failed) { const c = codes.get(f.code) || { message: f.message, n: 0 }; c.n++; codes.set(f.code, c); }
      if (res.failed.length >= part.length) { if (i + CHUNK < p.recipients.length) stop = "한 묶음이 모두 접수 실패해 멈췄습니다"; break; }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "발송 요청 실패";
      if (e instanceof SolapiRejected) stop = msg;                                   // 이 묶음은 한 통도 접수되지 않았다
      else { unknown = true; attempted += part.length; stop = `솔라피 응답을 받지 못했습니다(${msg}) — 이 묶음 ${part.length.toLocaleString("ko-KR")}명은 접수됐는지 알 수 없습니다`; }
      break;
    }
  }

  // ③ 결과를 적는다
  const why = [...codes.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3).map(([code, c]) => `${c.message}(${code}) ${c.n.toLocaleString("ko-KR")}건`);
  const left = p.recipients.length - attempted;
  const reason = [stop, left > 0 ? `${left.toLocaleString("ko-KR")}명에게는 보내지 않았습니다` : "", why.length ? `접수 실패 — ${why.join(", ")}` : ""].filter(Boolean).join(" · ");
  const status: SendStatus = unknown ? "unknown" : accepted === 0 ? "failed" : accepted === p.recipients.length ? "sent" : "partial";
  const up = await sb.from(SEND_TABLE).update({ status, attempted, accepted, failed, reason: reason || null, group_ids: groups, finished_at: new Date().toISOString() }).eq("id", id);
  if (up.error) console.error("[audience-send] 결과 기록 실패", up.error.message); // 보낸 것은 보낸 것 — 줄은 'sending' 으로 남아 화면에 '확인 필요'가 보인다
  return { id, status, target: p.recipients.length, attempted, accepted, failed, reason };
}

// ── 기록 ──
export type SendRow = {
  id: number; kind: string; mode: string; cond_summary: string | null; template_name: string | null; variables: Record<string, VarRule> | null;
  target_count: number; attempted: number | null; accepted: number | null; failed: number | null; status: SendStatus; reason: string | null;
  result: { success: number; failed: number; pending: number; checked_at: string } | null; sent_by: string | null; created_at: string;
};
const ROW_COLS = "id, kind, mode, cond_summary, template_name, variables, target_count, attempted, accepted, failed, status, reason, result, sent_by, created_at";
// 표가 아직 없으면 null — 화면은 기록 없이 뜨고, 보내려 할 때 안내가 나온다
export async function listSends(sb: SupabaseClient): Promise<SendRow[] | null> {
  const r = await sb.from(SEND_TABLE).select(ROW_COLS).order("created_at", { ascending: false }).limit(50);
  if (r.error) { if (isMissingSendTable(r.error)) return null; throw new Error(`알림톡 발송 기록을 읽지 못했습니다: ${r.error.message}`); }
  return (r.data ?? []) as unknown as SendRow[];
}

// [결과 확인] — 솔라피에 발송 묶음의 실제 결과(수신 완료·실패·아직 결과 없음)를 물어 기록에 적는다
export async function checkSendResult(sb: SupabaseClient, id: number): Promise<SendRow> {
  const r = await sb.from(SEND_TABLE).select("id, group_ids").eq("id", id).maybeSingle();
  if (r.error) { if (isMissingSendTable(r.error)) throw new SendError(MISSING_MSG); throw new Error(`발송 기록을 읽지 못했습니다: ${r.error.message}`); }
  const groups = ((r.data as { group_ids?: string[] | null } | null)?.group_ids || []).filter(Boolean);
  if (!r.data) throw new SendError("발송 기록을 찾지 못했습니다.");
  if (!groups.length) throw new SendError("솔라피에 접수된 발송이 없어 확인할 결과가 없습니다.");
  const result = { success: 0, failed: 0, pending: 0, checked_at: new Date().toISOString() };
  for (const g of groups) { const c = await fetchSolapiGroup(g); result.success += c.success; result.failed += c.failed; result.pending += c.pending; }
  const up = await sb.from(SEND_TABLE).update({ result }).eq("id", id).select(ROW_COLS).single();
  if (up.error) throw new Error(`결과를 기록하지 못했습니다: ${up.error.message}`);
  return up.data as unknown as SendRow;
}
