// CRM 메시지맵 — 타입·상수·정규화. (구 카페24 crm_message_map.html 이관)

export type CrmLinks = {
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
  created_at: string;
  updated_at: string;
}
export type CrmMessageInput = Omit<CrmMessage, "id" | "created_at" | "updated_at"> & { id?: string };

// 채널(발송 수단) — 배지 색은 CSS 클래스로.
export const CRM_CHANNELS: { key: string; label: string }[] = [
  { key: "kakao", label: "카카오 알림톡" },
  { key: "manual", label: "수동·기타" },
  { key: "cafe24", label: "카페24 자동" },
  { key: "custom", label: "맞춤 타겟" },
  { key: "onsite", label: "온사이트" },
  { key: "leaflet", label: "동봉물·전단" },
];
export const CRM_CHANNEL_LABEL: Record<string, string> = Object.fromEntries(CRM_CHANNELS.map((c) => [c.key, c.label]));

// 상태
export const CRM_STATUSES: { key: string; label: string }[] = [
  { key: "active", label: "활성(발송중)" },
  { key: "auto", label: "자동" },
  { key: "gap", label: "공백·미완" },
  { key: "paused", label: "중단" },
];
export const CRM_STATUS_LABEL: Record<string, string> = Object.fromEntries(CRM_STATUSES.map((s) => [s.key, s.label]));

// 링크 종류(카드에서 바로가기 버튼) — 순서 = 표시 순서.
export const CRM_LINK_TYPES: { key: keyof CrmLinks; label: string }[] = [
  { key: "solapi", label: "솔라피" },
  { key: "cafe24", label: "카페24" },
  { key: "meta", label: "메타광고" },
  { key: "sheets", label: "시트" },
  { key: "channel", label: "카카오채널" },
  { key: "blog", label: "블로그" },
  { key: "onsite", label: "온사이트" },
];

export const EMPTY_CRM_MESSAGE: CrmMessageInput = {
  stage_num: 0, stage: "", sub: "", title: "", status: "active", channel: "kakao",
  timing: "", detail: "", msg: "", img_url: "", links: {}, perf: {}, tags: "", sort_order: 0, active: true,
};

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const toInt = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };

export function normalizeCrmMessage(input: CrmMessageInput): CrmMessageInput {
  const links: CrmLinks = {};
  for (const { key } of CRM_LINK_TYPES) { const u = clean((input.links || {})[key]); if (u) links[key] = u; }
  const perfIn = input.perf || {};
  const perf: CrmPerf = {};
  (["sent", "reached", "opened", "clicked", "converted", "revenue"] as (keyof CrmPerf)[]).forEach((k) => {
    const raw = perfIn[k]; if (raw !== undefined && raw !== null && String(raw) !== "") perf[k] = toInt(raw);
  });
  return {
    id: input.id,
    stage_num: toInt(input.stage_num),
    stage: clean(input.stage),
    sub: clean(input.sub),
    title: clean(input.title),
    status: clean(input.status) || "active",
    channel: clean(input.channel),
    timing: clean(input.timing),
    detail: clean(input.detail),
    msg: clean(input.msg),
    img_url: clean(input.img_url),
    links, perf,
    tags: clean(input.tags),
    sort_order: toInt(input.sort_order),
    active: input.active !== false,
  };
}

// tags 문자열 → 배열
export function crmTags(tags: string): string[] {
  return (tags || "").split(/[,/]/).map((t) => t.trim()).filter(Boolean);
}
