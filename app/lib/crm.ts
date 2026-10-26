// CRM 메시지맵 — 타입·상수·정규화. (구 카페24 crm_message_map.html 이관, 2026-07 필드 개편)

export type CrmLinks = {
  /** 통합 링크 1개(버튼/랜딩 URL). 구 버전의 종류별 링크(solapi 등)는 저장 시 여기로 이관된다. */
  url?: string;
  /** GA 연동 키 — 이 메시지 링크의 utm_campaign 값(URL 아님). */
  utm_campaign?: string;
  // 구 데이터 호환(읽기 전용) — normalize 가 url 로 이관 후 버린다.
  solapi?: string; cafe24?: string; meta?: string; sheets?: string; channel?: string; blog?: string; onsite?: string;
};
export type CrmPerf = {
  sent?: number; reached?: number; opened?: number; clicked?: number; converted?: number; revenue?: number;
};

export interface CrmMessage {
  id: string;
  stage_num: number;
  stage: string;
  sub: string;
  title: string;
  status: string;
  channel: string;
  timing: string;
  detail: string;
  msg: string;
  img_url: string;
  links: CrmLinks;
  perf: CrmPerf;
  tags: string;
  sort_order: number;
  active: boolean;
  /** 진행 기간(YYYY-MM-DD, ""=제한 없음). migration 074 — 미적용 DB에선 항상 "". */
  start_date: string;
  end_date: string;
  /** 고객(어느 스토어 고객 대상) · 유형(메시지 형식). migration 077 — 미적용 DB에선 항상 "". */
  customer: string;
  msg_type: string;
  /** 트리거·D+n·목표 클릭률·솔라피 템플릿 ID(migration 150, 2026-10-27) — 미적용 DB 에선 기본값. utm_medium 은 149. */
  trigger: string;
  offset_days: number | null;
  offset_note: string;
  target_ctr: number | null;
  solapi_template_id: string;
  utm_medium: string;
  created_at: string;
  updated_at: string;
}
export type CrmMessageInput = Omit<CrmMessage, "id" | "created_at" | "updated_at"> & { id?: string };

// 고객 — 어느 스토어의 고객에게 나가는 메시지인가
export const CRM_CUSTOMERS: { key: string; label: string }[] = [
  { key: "naver", label: "네이버" },
  { key: "mall", label: "공식몰" },
  { key: "etc", label: "기타" },
];
export const CRM_CUSTOMER_LABEL: Record<string, string> = Object.fromEntries(CRM_CUSTOMERS.map((c) => [c.key, c.label]));

// 발송채널 — 무엇으로 발송하나(도구). 배지 색은 CSS 클래스로.
export const CRM_CHANNELS: { key: string; label: string }[] = [
  { key: "kakao", label: "카카오" },
  { key: "solapi", label: "솔라피" },
  { key: "cafe24", label: "카페24" },
  { key: "bloomai", label: "블룸ai" },
];
// 표시용 라벨은 구 채널 키도 포함 — 개편 전 저장된 행이 원래 이름으로 보이게(선택지에는 없음).
export const CRM_CHANNEL_LABEL: Record<string, string> = {
  ...Object.fromEntries(CRM_CHANNELS.map((c) => [c.key, c.label])),
  manual: "수동·기타", custom: "맞춤 타겟", onsite: "온사이트", leaflet: "동봉물·전단",
};

// 유형 — 메시지 형식
export const CRM_MSG_TYPES: { key: string; label: string }[] = [
  { key: "alimtalk", label: "알림톡" },
  { key: "friendtalk", label: "친구톡" },
];
export const CRM_MSG_TYPE_LABEL: Record<string, string> = Object.fromEntries(CRM_MSG_TYPES.map((t) => [t.key, t.label]));

// 상태 — 활성/비활성 2종. 구 상태(auto/gap/paused)는 statusKey 로 수렴.
export const CRM_STATUSES: { key: string; label: string }[] = [
  { key: "active", label: "활성" },
  { key: "inactive", label: "비활성" },
];
export const CRM_STATUS_LABEL: Record<string, string> = Object.fromEntries(CRM_STATUSES.map((s) => [s.key, s.label]));

// 트리거(기준 사건) — 메시지가 '무슨 사건 뒤 며칠째' 나가는지(2026-10-27, docs/crm-message-map-plan.md).
//  estimable = 업무도우미 매출 원장으로 그 주 대상자 수를 셀 수 있는 것(발송 수 추정).
export const CRM_TRIGGERS: { key: string; label: string; estimable: boolean }[] = [
  { key: "signup", label: "가입", estimable: false },
  { key: "first_order", label: "첫 구매", estimable: true },
  { key: "reorder", label: "재구매", estimable: true },
  { key: "shipped", label: "출고", estimable: true },
  { key: "delivered", label: "배송 완료", estimable: true },
  { key: "cart", label: "장바구니 이탈", estimable: false },
  { key: "subscription", label: "정기배송 회차", estimable: true },
  { key: "inactive", label: "마지막 구매 후 경과", estimable: true },
  { key: "event", label: "행사·기획전", estimable: false },
  { key: "always", label: "상시", estimable: false },
];
export const CRM_TRIGGER_LABEL: Record<string, string> = Object.fromEntries(CRM_TRIGGERS.map((t) => [t.key, t.label]));
/** 추적 메시지 = utm_campaign 이 있는 메시지(대표 결정 2026-10-26 — 따로 켜고 끄지 않는다) */
export const isTracked = (m: { links?: CrmLinks }) => !!(m.links?.utm_campaign || "").trim();
/** 트리거 D+n 짧은 표기: '첫 구매 D+3', '정기배송 회차 D-3', '상시' */
export function triggerText(m: { trigger: string; offset_days: number | null; offset_note?: string }): string {
  if (!m.trigger) return "";
  const base = CRM_TRIGGER_LABEL[m.trigger] || m.trigger;
  if (m.trigger === "always" || m.offset_days == null) return m.offset_note ? `${base} · ${m.offset_note}` : base;
  const d = m.offset_days;
  return `${base} D${d >= 0 ? "+" : "-"}${Math.abs(d)}${m.offset_note ? ` · ${m.offset_note}` : ""}`;
}

/** 구 상태 체계를 2종으로 수렴: auto(자동발송 중)=활성, gap(공백)·paused(중단)=비활성. */
export function statusKey(s: string): "active" | "inactive" {
  const v = (s || "").trim().toLowerCase();
  if (v === "active" || v === "auto" || v === "") return "active";
  if (v === "inactive" || v === "gap" || v === "paused") return "inactive";
  return "inactive"; // 알 수 없는 값은 '나가고 있다'로 오해하지 않게 비활성 취급
}

export const EMPTY_CRM_MESSAGE: CrmMessageInput = {
  stage_num: 0, stage: "", sub: "", title: "", status: "active", channel: "kakao",
  timing: "", detail: "", msg: "", img_url: "", links: {}, perf: {}, tags: "", sort_order: 0, active: true,
  start_date: "", end_date: "", customer: "", msg_type: "",
  trigger: "", offset_days: null, offset_note: "", target_ctr: null, solapi_template_id: "", utm_medium: "",
};

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const toInt = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const toYmd = (v: unknown): string => { const s = clean(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; };

// 구 종류별 링크 키 — url 이관용(입력 UI 는 통합 1칸만)
const LEGACY_LINK_KEYS = ["solapi", "cafe24", "meta", "sheets", "channel", "blog", "onsite"] as const;

export function normalizeCrmMessage(input: CrmMessageInput): CrmMessageInput {
  const raw = input.links || {};
  const links: CrmLinks = {};
  // 통합 링크: url 우선, 없으면 구 종류별 링크 중 첫 번째를 이관(편집·저장만 해도 새 모델로 수렴)
  const url = clean(raw.url) || LEGACY_LINK_KEYS.map((k) => clean(raw[k])).find(Boolean) || "";
  if (url) links.url = url;
  const utm = clean(raw.utm_campaign);
  if (utm) links.utm_campaign = utm;
  const perfIn = input.perf || {};
  const perf: CrmPerf = {};
  (["sent", "reached", "opened", "clicked", "converted", "revenue"] as (keyof CrmPerf)[]).forEach((k) => {
    const v = perfIn[k]; if (v !== undefined && v !== null && String(v) !== "") perf[k] = toInt(v);
  });
  return {
    id: input.id,
    stage_num: toInt(input.stage_num),
    stage: clean(input.stage),
    sub: clean(input.sub),
    title: clean(input.title),
    status: statusKey(clean(input.status)),
    channel: clean(input.channel),
    timing: clean(input.timing),
    detail: clean(input.detail),
    msg: clean(input.msg),
    img_url: clean(input.img_url),
    links, perf,
    tags: clean(input.tags),
    sort_order: toInt(input.sort_order),
    active: input.active !== false,
    start_date: toYmd(input.start_date),
    end_date: toYmd(input.end_date),
    customer: clean(input.customer),
    msg_type: clean(input.msg_type),
    trigger: CRM_TRIGGERS.some((t) => t.key === clean(input.trigger)) ? clean(input.trigger) : "",
    offset_days: input.offset_days === null || input.offset_days === undefined || String(input.offset_days) === "" ? null : toInt(input.offset_days),
    offset_note: clean(input.offset_note),
    target_ctr: input.target_ctr === null || input.target_ctr === undefined || String(input.target_ctr) === "" ? null : Math.max(0, Math.round(Number(input.target_ctr) * 10) / 10),
    solapi_template_id: clean(input.solapi_template_id),
    utm_medium: clean(input.utm_medium),
  };
}

// tags 문자열 → 배열
export function crmTags(tags: string): string[] {
  return (tags || "").split(/[,/]/).map((t) => t.trim()).filter(Boolean);
}

// ── 선택지(발송채널·고객·유형) — 화면에서 추가/삭제 ──
//  기본값 = 위 상수. 저장은 서버 전용 crm-options.ts(b2b_settings KV) — 이 파일은 클라이언트도 import 하므로 서버 의존 금지.
//  새 선택지의 key 는 라벨 그대로(한글 키 허용). 선택지를 지워도 기존 메시지 값은 유지되고 "(구)" 로 표시된다.
export type CrmOption = { key: string; label: string };
export type CrmOptions = { channels: CrmOption[]; customers: CrmOption[]; msgTypes: CrmOption[] };

export const DEFAULT_CRM_OPTIONS: CrmOptions = {
  channels: CRM_CHANNELS,
  customers: CRM_CUSTOMERS,
  msgTypes: CRM_MSG_TYPES,
};

const OPT_MAX_ITEMS = 30;
const OPT_MAX_LABEL = 20;

function sanitizeOptionList(v: unknown, fallback: CrmOption[]): CrmOption[] {
  if (!Array.isArray(v)) return fallback;
  const seen = new Set<string>();
  const out: CrmOption[] = [];
  for (const item of v) {
    const key = typeof (item as CrmOption)?.key === "string" ? (item as CrmOption).key.trim().slice(0, OPT_MAX_LABEL) : "";
    const label = ((typeof (item as CrmOption)?.label === "string" ? (item as CrmOption).label.trim() : "") || key).slice(0, OPT_MAX_LABEL);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label });
    if (out.length >= OPT_MAX_ITEMS) break;
  }
  return out.length > 0 ? out : fallback; // 전부 지우면 기본값 복귀(빈 셀렉트 방지)
}

export function sanitizeCrmOptions(v: unknown): CrmOptions {
  const o = (v && typeof v === "object" ? v : {}) as Partial<CrmOptions>;
  return {
    channels: sanitizeOptionList(o.channels, DEFAULT_CRM_OPTIONS.channels),
    customers: sanitizeOptionList(o.customers, DEFAULT_CRM_OPTIONS.customers),
    msgTypes: sanitizeOptionList(o.msgTypes, DEFAULT_CRM_OPTIONS.msgTypes),
  };
}

// ── 기준일 판정 ── 그 날짜(YYYY-MM-DD)에 '진행 중'인가.
//  규칙: 비활성=아니오 · 기간이 있으면 기간 안이어야 함(경계 포함) · 기간 없으면 상시=예.
export function crmOnDate(m: Pick<CrmMessage, "status" | "start_date" | "end_date">, ymd: string): boolean {
  if (statusKey(m.status) === "inactive") return false;
  if (m.start_date && ymd < m.start_date) return false;
  if (m.end_date && ymd > m.end_date) return false;
  return true;
}
