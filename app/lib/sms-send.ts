// 고객 문자 보내기 — 화면·서버 공용 규칙(클라이언트 안전: DB·SDK import 없음).
//  발송은 중계 서버(클라우드웨이즈)가 알리고 API 로 한다. 알리고 규격(2026-11-12 spec 확인):
//   · 받는 번호는 한 번에 1,000개까지, 본문 1~2,000바이트(EUC-KR 기준 — 한글 2, 영문·숫자 1), 90바이트 이하는 SMS·넘으면 LMS
//   · EUC-KR 에 없는 글자(이모지 등)는 물음표로 바뀐다
//  실행기(scripts/aligo-sms-runner.mjs)는 여기 값을 다시 계산하지 않고 서버가 정한 msg_type 을 그대로 보낸다.

export const SMS_MAX_RECEIVERS = 1000;
export const SMS_BYTES = 90;
export const LMS_BYTES = 2000;
export const LMS_TITLE_BYTES = 44;
export type SmsType = "SMS" | "LMS";
export type SmsStatus = "대기" | "실행중" | "완료" | "실패" | "확인 필요";

// 발송 가능 시간(한국 시간) — 밤에 고객에게 문자가 가지 않게. 실행기 크론도 같은 시간대에만 돈다.
export const SEND_FROM_HOUR = 8;   // 08:00 부터
export const SEND_UNTIL_HOUR = 21; // 21:00 전까지
export const QUEUE_EXPIRE_MS = 30 * 60_000;  // 대기 30분이 넘으면 보내지 않는다
export const CLAIM_ORPHAN_MS = 10 * 60_000;  // 선점 뒤 10분 동안 보고가 없으면 '확인 필요'
export const RUNNER_LATE_MS = 10 * 60_000;   // 발송 서버의 마지막 신호가 이보다 오래됐으면 화면이 알린다

export function inSendWindow(nowMs: number): boolean {
  const h = new Date(nowMs + 9 * 3600_000).getUTCHours();
  return h >= SEND_FROM_HOUR && h < SEND_UNTIL_HOUR;
}

// EUC-KR 바이트 수 — ASCII 1, 그 밖 2. 줄바꿈은 통신사에서 2바이트로 셀 수 있어 2로 본다(SMS 로 정했는데 LMS 로 넘어가는 일을 막는다).
export function smsBytes(text: string): number {
  let n = 0;
  for (const ch of text.replace(/\r\n/g, "\n")) n += ch === "\n" ? 2 : ch.charCodeAt(0) < 128 ? 1 : 2;
  return n;
}
export const msgTypeOf = (text: string): SmsType => (smsBytes(text) <= SMS_BYTES ? "SMS" : "LMS");
// 문자에서 물음표로 바뀌는 글자(이모지·그림 문자)
export const hasUnsupportedChars = (text: string): boolean => /\p{Extended_Pictographic}/u.test(text);

// 받는 번호 입력 → 휴대폰 번호(숫자만). 중복은 한 번만.
//  줄바꿈·쉼표·세미콜론으로 나눈다. 한 토막이 통째로 번호면('010 1234 5678', '+82 10-1234-5678') 그대로 읽고,
//  아니면 공백으로 다시 나눠 본다('010-1111-2222 010-3333-4444').
const MOBILE_RE = /^01[016789]\d{7,8}$/;
const toDigits = (t: string): string => {
  let d = t.replace(/[^0-9+]/g, "");
  if (d.startsWith("+82")) d = "0" + d.slice(3);
  return d.replace(/\D/g, "");
};
export function parseReceivers(raw: string): { valid: string[]; invalid: string[]; duplicates: number } {
  const valid: string[] = [], invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const take = (t: string): boolean => {
    const d = toDigits(t);
    if (!MOBILE_RE.test(d)) return false;
    if (seen.has(d)) duplicates++; else { seen.add(d); valid.push(d); }
    return true;
  };
  for (const piece of raw.split(/[\n\r,;]+/)) {
    const t = piece.trim();
    if (!t || take(t)) continue;
    for (const tok of t.split(/\s+/)) if (tok && !take(tok)) invalid.push(tok);
  }
  return { valid, invalid, duplicates };
}
export const maskPhone = (d: string): string => (d.length >= 10 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : d);

// 화면 계약 — 받는 번호는 가려서 준다
export type SmsSend = {
  id: number; message: string; title: string | null; msg_type: SmsType; receiver_count: number; receiver_preview: string;
  status: SmsStatus; test: boolean | null; success_cnt: number | null; error_cnt: number | null; error: string | null;
  requested_by: string | null; created_at: string; executed_at: string | null;
};
export const PENDING_167 = "DB 준비 전입니다 — supabase/migrations/167_sms_sends.sql 을 적용하세요.";
