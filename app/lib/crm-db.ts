// crm_messages 저장 공용 — 선택 컬럼 폴백 계층(messages 라우트·엑셀 가져오기가 같이 쓴다). 2026-11-06 messages/route.ts 에서 분리.
import { extractErrorMsg } from "./supabase";
import type { CrmMessageInput } from "./crm";

// 선택 컬럼 폴백(기존 패턴: 에러에 컬럼명이 보이면 그 컬럼 빼고 재시도):
//  start/end_date = migration 074 · customer/msg_type = migration 077.
//  단계: 전체 → 077 제외 → 074도 제외. 응답 플래그로 화면이 해당 입력만 숨긴다.
export const BASE_COLS = "id, stage_num, stage, sub, title, status, channel, timing, detail, msg, img_url, links, perf, tags, sort_order, active, created_at, updated_at";
//  triggers = migration 149(utm_medium)+150(trigger·offset_days·offset_note·target_ctr·solapi_template_id) — 2026-10-27
export const TRIGGER_COLS = "trigger, offset_days, offset_note, target_ctr, solapi_template_id, utm_medium";
export const TIERS = [
  { cols: `${BASE_COLS}, start_date, end_date, customer, msg_type, ${TRIGGER_COLS}`, dates: true, fields: true, triggers: true },
  { cols: `${BASE_COLS}, start_date, end_date, customer, msg_type`, dates: true, fields: true, triggers: false },
  { cols: `${BASE_COLS}, start_date, end_date`, dates: true, fields: false, triggers: false },
  { cols: BASE_COLS, dates: false, fields: false, triggers: false },
] as const;
export const missing = (err: unknown) => {
  const m = extractErrorMsg(err, "");
  return { fields: /customer|msg_type/.test(m), dates: /start_date|end_date/.test(m), triggers: /trigger|offset_days|offset_note|target_ctr|solapi_template_id|utm_medium/.test(m) };
};

// 저장용 행 — 날짜 ""는 date 컬럼이 거부하므로 null 로. 미적용 컬럼은 키 자체를 뺀다.
export function toRow(n: CrmMessageInput, tier: (typeof TIERS)[number]) {
  const { id: _omit, start_date, end_date, customer, msg_type, trigger, offset_days, offset_note, target_ctr, solapi_template_id, utm_medium, ...rest } = n;
  void _omit;
  return {
    ...rest,
    ...(tier.dates ? { start_date: start_date || null, end_date: end_date || null } : {}),
    ...(tier.fields ? { customer, msg_type } : {}),
    ...(tier.triggers ? { trigger, offset_days, offset_note, target_ctr, solapi_template_id, utm_medium } : {}),
  };
}

export const flags = (tier: (typeof TIERS)[number]) => ({ datesSupported: tier.dates, fieldsSupported: tier.fields, triggersSupported: tier.triggers });

