import { supabaseAdmin } from "./supabase";
import { ORDER_STATUSES, PAYMENT_STATUSES, TAX_INVOICE_STATUSES } from "./b2b-orders";

// ─────────────────────────────────────────────
// B2B 운영 설정 (b2b_settings 키-값 테이블)
// ─────────────────────────────────────────────

const NOTIFY_KEY = "zapier_notify";

// 알림 설정: 이벤트별 발송 여부.
//  - boolean 이벤트(발주등록·입금기록·발주삭제): true=발송
//  - 상태형 이벤트(상태변경 등): 발송할 '결과 상태' 문자열 배열 (meta.to 가 포함되면 발송)
export type NotifyConfig = Record<string, boolean | string[]>;

// 기본값. 발주 라이프사이클은 켜짐(현재 동작 유지), 업체·원가표 변경은
// 관리성 작업이라 외부 알림은 기본 꺼짐(히스토리에는 항상 기록됨).
export const DEFAULT_NOTIFY: NotifyConfig = {
  "order.created": true,
  "payment.added": true,
  "order.deleted": true,
  "order.status_changed": [...ORDER_STATUSES],
  "shipment.status_changed": [...ORDER_STATUSES],
  "order.payment_status_changed": [...PAYMENT_STATUSES],
  "order.tax_invoice_changed": [...TAX_INVOICE_STATUSES],
  company: false, // company.created/updated/deleted 묶음
  product: false, // product.created/updated/deleted 묶음
};

// 이벤트 종류 → 설정 키 매핑. 업체·원가표는 등록/수정/삭제를 한 토글로 묶음.
function notifyKeyFor(eventType: string): string {
  if (eventType.startsWith("company.")) return "company";
  if (eventType.startsWith("product.")) return "product";
  return eventType;
}

// 설정 화면 구성용 메타데이터 (UI 가 이걸로 토글·체크박스를 그림)
export const NOTIFY_EVENTS: {
  key: string;
  label: string;
  desc: string;
  kind: "toggle" | "status";
  statuses?: readonly string[];
}[] = [
  { key: "order.created", label: "발주 등록", desc: "새 발주가 등록될 때", kind: "toggle" },
  { key: "order.status_changed", label: "발주 상태 변경", desc: "선택한 상태로 바뀔 때만 알림", kind: "status", statuses: ORDER_STATUSES },
  { key: "shipment.status_changed", label: "발송 차수 상태 변경", desc: "분할 발송(차수)이 선택한 상태로 바뀔 때만", kind: "status", statuses: ORDER_STATUSES },
  { key: "order.payment_status_changed", label: "입금 상태 변경", desc: "선택한 입금 상태로 바뀔 때만", kind: "status", statuses: PAYMENT_STATUSES },
  { key: "order.tax_invoice_changed", label: "세금계산서 상태 변경", desc: "선택한 상태로 바뀔 때만", kind: "status", statuses: TAX_INVOICE_STATUSES },
  { key: "payment.added", label: "입금 기록", desc: "입금이 기록될 때", kind: "toggle" },
  { key: "order.deleted", label: "발주 삭제", desc: "발주가 삭제될 때", kind: "toggle" },
  { key: "company", label: "업체 변경", desc: "업체 등록·수정·삭제 (기본 꺼짐)", kind: "toggle" },
  { key: "product", label: "원가표(품목) 변경", desc: "품목 등록·수정·삭제 (기본 꺼짐)", kind: "toggle" },
];

// 설정 읽기. 테이블 미적용(마이그레이션 015 전)이거나 행이 없으면 기본값(전부 발송).
export async function getNotifyConfig(): Promise<NotifyConfig> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", NOTIFY_KEY).maybeSingle();
    if (error) return DEFAULT_NOTIFY; // 테이블 없음 등 → 기존 동작(전부 발송) 유지
    if (!data) return DEFAULT_NOTIFY;
    return { ...DEFAULT_NOTIFY, ...(data.value as NotifyConfig) };
  } catch {
    return DEFAULT_NOTIFY;
  }
}

export async function setNotifyConfig(config: NotifyConfig): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("b2b_settings")
    .upsert({ key: NOTIFY_KEY, value: config, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

// ─────────────────────────────────────────────
// Flow(플로우) 봇 알림 — flow.team Open API 로 B2B 알림을 지정 수신자에게 직접 발송(Zapier 대체, 비용 절감).
//  API: POST https://api.flow.team/v1/bots/{botId}/notifications/bulk
//  헤더: x-flow-api-key: <봇 키>   본문: { receivers:[{receiverId}], title, contents }
//  응답: { response: { success, code, message, error? } }
//  · flow_bot_id · flow_bot_api_key · flow_bot_receivers 가 모두 있으면 Zapier 대신 Flow 로 발송.
//  · VOC용 flow_api_key(voc-flow.ts) 와는 별개의 봇 키라 flow_bot_api_key 로 분리 저장(서로 다른 키일 수 있음).
//  · app_base_url 은 알림에 넣을 주문 상세 링크(/b2b/orders/{id})의 도메인. 미설정 시 Vercel 프로덕션 도메인.
//  값은 b2b_settings kv({v:...}) 저장(코드/깃에 두지 않음).
// ─────────────────────────────────────────────
export async function getKv(key: string): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", key).maybeSingle();
    if (error || !data) return "";
    const v = data.value as { v?: string } | string | null;
    const s = typeof v === "string" ? v : v?.v;
    return s && String(s).trim() ? String(s).trim() : "";
  } catch { return ""; }
}
export async function setKv(key: string, value: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("b2b_settings")
    .upsert({ key, value: { v: value.trim() }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

export const getFlowBotId = () => getKv("flow_bot_id");
export const setFlowBotId = (s: string) => setKv("flow_bot_id", s);
export const getFlowBotApiKey = () => getKv("flow_bot_api_key");
export const setFlowBotApiKey = (s: string) => setKv("flow_bot_api_key", s);
export const getFlowAlertTitle = async () => (await getKv("flow_alert_title")) || "씨몬스터 B2B 알림";
export const setFlowAlertTitle = (s: string) => setKv("flow_alert_title", s);
export const getFlowReceiversRaw = () => getKv("flow_bot_receivers");
export const setFlowReceiversRaw = (s: string) => setKv("flow_bot_receivers", s);

// 수신자: 줄바꿈/콤마/세미콜론/공백 구분 → 이메일 배열(이메일엔 공백이 없어 안전).
export async function getFlowReceivers(): Promise<string[]> {
  const raw = await getFlowReceiversRaw();
  return raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

export type FlowBotConfig = { botId: string; apiKey: string; receivers: string[]; title: string };
export async function getFlowBotConfig(): Promise<FlowBotConfig> {
  const [botId, apiKey, receivers, title] = await Promise.all([
    getFlowBotId(), getFlowBotApiKey(), getFlowReceivers(), getFlowAlertTitle(),
  ]);
  return { botId, apiKey, receivers, title };
}
// 봇 ID·API 키·수신자가 모두 있어야 Flow 로 발송(아니면 Zapier 폴백).
export async function isFlowBotConfigured(): Promise<boolean> {
  const c = await getFlowBotConfig();
  return !!(c.botId && c.apiKey && c.receivers.length);
}

export const setAppBaseUrl = (s: string) => setKv("app_base_url", s);

// 앱 접속 URL(끝 슬래시 제거). 설정 없으면 Vercel 프로덕션 도메인, 그것도 없으면 빈 문자열.
export async function getAppBaseUrl(): Promise<string> {
  const s = await getKv("app_base_url");
  if (s) return s.replace(/\/+$/, "");
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? `https://${prod}` : "";
}

// 이 이벤트(+결과 상태)를 Zapier 로 보낼지 판단.
export function shouldNotify(config: NotifyConfig, eventType: string, meta?: Record<string, unknown> | null): boolean {
  const v = config[notifyKeyFor(eventType)];
  if (v === undefined) return true; // 미정의 이벤트 → 안전하게 발송
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    const to = meta?.to;
    if (typeof to !== "string") return v.length > 0; // 결과 상태 없으면 하나라도 켜져있으면 발송
    return v.includes(to);
  }
  return true;
}
