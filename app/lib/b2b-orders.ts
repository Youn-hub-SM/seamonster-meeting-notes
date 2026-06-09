// B2B 발주 관련 타입·상수·헬퍼.
// supabase/migrations/001_b2b_init.sql 의 orders / order_items 와 1:1.

import { Company, TaxType } from "./b2b-types";

// ─────────────────────────────────────────────
// 상태 enum
// ─────────────────────────────────────────────
export const ORDER_STATUSES = [
  "발주확인/생산대기",
  "생산요청/생산중",
  "생산완료/발송대기",
  "발송완료",
  "취소",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ["미입금", "부분입금", "입금완료", "확인불필요"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const TAX_INVOICE_STATUSES = ["미발행", "발행대기", "발행완료", "면제"] as const;
export type TaxInvoiceStatus = (typeof TAX_INVOICE_STATUSES)[number];

// 색상 (UI 에서 status pill 에 사용).
// /orders 와 같은 팔레트.
export const STATUS_COLORS: Record<OrderStatus, { bg: string; fg: string }> = {
  "발주확인/생산대기": { bg: "#FFF4E0", fg: "#B86E00" },
  "생산요청/생산중": { bg: "#E0F0FF", fg: "#0A66C2" },
  "생산완료/발송대기": { bg: "#E0F5E5", fg: "#22863A" },
  "발송완료": { bg: "#EFEFEF", fg: "#666666" },
  "취소": { bg: "#FCE4E4", fg: "#C92A2A" },
};

export const STATUS_SHORT: Record<OrderStatus, string> = {
  "발주확인/생산대기": "대기",
  "생산요청/생산중": "생산중",
  "생산완료/발송대기": "발송대기",
  "발송완료": "발송완료",
  "취소": "취소",
};

export const PAYMENT_COLORS: Record<PaymentStatus, { bg: string; fg: string }> = {
  "미입금": { bg: "#FCE4E4", fg: "#C92A2A" },
  "부분입금": { bg: "#FFF4E0", fg: "#B86E00" },
  "입금완료": { bg: "#E0F5E5", fg: "#22863A" },
  "확인불필요": { bg: "#EFEFEF", fg: "#666666" },
};

export const TAX_INVOICE_COLORS: Record<TaxInvoiceStatus, { bg: string; fg: string }> = {
  "미발행": { bg: "#FCE4E4", fg: "#C92A2A" },
  "발행대기": { bg: "#FFF4E0", fg: "#B86E00" },
  "발행완료": { bg: "#E0F5E5", fg: "#22863A" },
  "면제": { bg: "#EFEFEF", fg: "#666666" },
};

// 발송 일정 상태 (분할 발송)
export const SHIPMENT_STATUSES = ["발송대기", "발송중", "발송완료", "취소"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_COLORS: Record<ShipmentStatus, { bg: string; fg: string }> = {
  "발송대기": { bg: "#FFF4E0", fg: "#B86E00" },
  "발송중": { bg: "#E0F0FF", fg: "#0A66C2" },
  "발송완료": { bg: "#E0F5E5", fg: "#22863A" },
  "취소": { bg: "#FCE4E4", fg: "#C92A2A" },
};

// ─────────────────────────────────────────────
// 데이터 타입
// ─────────────────────────────────────────────
export interface Order {
  id: string;
  order_no: string;
  company_id: string;
  order_date: string;          // YYYY-MM-DD
  production_date: string | null;
  ship_date: string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  tax_invoice_status: TaxInvoiceStatus;
  subtotal: number;
  vat: number;
  total: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string;        // 스냅샷
  option_label: string | null;
  spec: string | null;
  qty: number;
  unit_price: number;
  line_total: number;
  cost_at_order: number | null;
  tax_type: TaxType;           // 과세/면세 스냅샷
  sort_order: number;
  created_at: string;
}

// 리스트 조회 응답: 업체명·라인 미리보기 포함
export interface OrderLinePreview {
  product_name: string;
  spec: string | null;
  qty: number;
}

export interface OrderListItem extends Order {
  company_name: string;
  item_count: number;
  items: OrderLinePreview[];
}

// 단일 조회 응답: 풀 디테일
export interface OrderDetail extends Order {
  company: Company;
  items: OrderItem[];
  shipments: Shipment[];
}

// 입금 내역
export interface Payment {
  id: string;
  order_id: string;
  amount: number;
  paid_at: string;          // YYYY-MM-DD
  method: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
}

export interface PaymentInput {
  order_id: string;
  amount: number | string;
  paid_at: string;
  method: string;
  reference: string;
  notes: string;
}

// 공통 배송 정보 정규화
export function normalizeRecipient(s: RecipientInput): {
  recipient_name: string;
  recipient_phone: string;
  address: string;
  delivery_memo: string | null;
  courier: string | null;
} {
  const clean = (v: string): string | null => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  };
  return {
    recipient_name: (s.recipient_name ?? "").trim(),
    recipient_phone: (s.recipient_phone ?? "").trim(),
    address: (s.address ?? "").trim(),
    delivery_memo: clean(s.delivery_memo),
    courier: clean(s.courier),
  };
}

// ─────────────────────────────────────────────
// 입력 타입 (create / update)
// ─────────────────────────────────────────────
export interface OrderItemInput {
  id?: string;                 // 편집 시 기존 라인 id (없으면 신규)
  product_id: string | null;
  product_name: string;
  option_label: string;
  spec: string;
  qty: number | string;        // input value 라 string 도 허용 (저장 직전 변환)
  unit_price: number | string;
  cost_at_order: number | string;
  tax_type: TaxType;
  sort_order: number;
}

// 공통 배송 정보 — 모든 발송 일정이 공유 (보통 같은 수령인에게 나눠 보냄)
export interface RecipientInput {
  recipient_name: string;
  recipient_phone: string;
  address: string;
  delivery_memo: string;
  courier: string;
}

export const EMPTY_RECIPIENT: RecipientInput = {
  recipient_name: "",
  recipient_phone: "",
  address: "",
  delivery_memo: "",
  courier: "",
};

// 발송 일정에 담길 상품/수량 (정밀 분할)
export interface ShipmentItemInput {
  order_item_index: number; // 폼 내 발주상품 인덱스 (저장 시 order_item_id 로 매핑)
  qty: number | string;
}

// 발송 일정 1건 (입력)
export interface ShipmentScheduleInput {
  id?: string;
  ship_date: string;
  status: ShipmentStatus;
  tracking_no: string;
  items: ShipmentItemInput[]; // qty>0 인 것만 저장
}

export const EMPTY_SHIPMENT_SCHEDULE: ShipmentScheduleInput = {
  ship_date: "",
  status: "발송대기",
  tracking_no: "",
  items: [],
};

// DB 응답
export interface ShipmentItem {
  id: string;
  shipment_id: string;
  order_item_id: string | null;
  product_name: string;
  spec: string | null;
  qty: number;
}

export interface Shipment {
  id: string;
  order_id: string;
  seq: number;
  ship_date: string | null;
  status: ShipmentStatus;
  recipient_name: string;
  recipient_phone: string;
  address: string;
  delivery_memo: string | null;
  courier: string | null;
  tracking_no: string | null;
  shipped_at: string | null;
  created_at: string;
  items?: ShipmentItem[];
}

export interface OrderInput {
  id?: string;
  company_id: string;
  order_date: string;
  production_date: string;
  ship_date: string;  // 헤더 대표 발송일 — 저장 시 가장 이른 발송 일정으로 자동 채움
  status: OrderStatus;
  payment_status: PaymentStatus;
  tax_invoice_status: TaxInvoiceStatus;
  notes: string;
  items: OrderItemInput[];
  recipient: RecipientInput;            // 공통 배송 정보
  shipments: ShipmentScheduleInput[];   // 발송 일정 (분할 발송)
}

export const EMPTY_ORDER_ITEM: OrderItemInput = {
  product_id: null,
  product_name: "",
  option_label: "",
  spec: "",
  qty: 1,
  unit_price: 0,
  cost_at_order: 0,
  tax_type: "taxable",
  sort_order: 0,
};

export const EMPTY_ORDER: OrderInput = {
  company_id: "",
  order_date: "",
  production_date: "",
  ship_date: "",
  status: "발주확인/생산대기",
  payment_status: "미입금",
  tax_invoice_status: "미발행",
  notes: "",
  items: [{ ...EMPTY_ORDER_ITEM }],
  recipient: { ...EMPTY_RECIPIENT },
  shipments: [],
};

// ─────────────────────────────────────────────
// 긴급도 (/orders 와 같은 규칙)
// ─────────────────────────────────────────────
export type Urgency = "overdue" | "urgent" | "normal";

export const URGENCY_LABEL: Record<Exclude<Urgency, "normal">, string> = {
  overdue: "지연",
  urgent: "임박",
};

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 발주의 긴급도 계산.
// - overdue: 발송일 지났는데 미발송 / 생산일 지났는데 대기·생산중
// - urgent: 발송일이 오늘 또는 내일인데 아직 발송 안 됨
export function getUrgency(o: Pick<Order, "status" | "production_date" | "ship_date">, todayIso: string): Urgency {
  if (o.status === "발송완료" || o.status === "취소") return "normal";
  const tomorrowIso = addDaysISO(todayIso, 1);

  // 여기 도달 시 status 는 '발송완료' / '취소' 가 아님 (위에서 걸렀음)

  // 발송일 지남
  if (o.ship_date && o.ship_date < todayIso) return "overdue";
  // 생산일 지남 + 아직 생산대기/생산중
  if (
    o.production_date &&
    o.production_date < todayIso &&
    (o.status === "발주확인/생산대기" || o.status === "생산요청/생산중")
  ) {
    return "overdue";
  }
  // 발송 임박
  if (o.ship_date && (o.ship_date === todayIso || o.ship_date === tomorrowIso)) {
    return "urgent";
  }
  return "normal";
}

// ─────────────────────────────────────────────
// 입력 정규화 (string → number, "" → null 등)
// ─────────────────────────────────────────────
export function normalizeOrderItem(it: OrderItemInput): {
  product_id: string | null;
  product_name: string;
  option_label: string | null;
  spec: string | null;
  qty: number;
  unit_price: number;
  cost_at_order: number | null;
  tax_type: TaxType;
  sort_order: number;
} {
  const cleanStr = (v: string | null): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  return {
    product_id: it.product_id || null,
    product_name: String(it.product_name || "").trim(),
    option_label: cleanStr(it.option_label),
    spec: cleanStr(it.spec),
    qty: Number(it.qty) || 0,
    unit_price: Number(it.unit_price) || 0,
    cost_at_order: it.cost_at_order === "" || it.cost_at_order === null ? null : Number(it.cost_at_order) || null,
    tax_type: it.tax_type === "exempt" ? "exempt" : "taxable",
    sort_order: Number(it.sort_order) || 0,
  };
}

export function validateOrder(input: OrderInput): string | null {
  if (!input.company_id) return "업체를 선택하세요.";
  if (!input.order_date) return "발주일을 입력하세요.";
  if (!input.items || input.items.length === 0) return "라인아이템이 최소 1개 필요합니다.";
  for (let i = 0; i < input.items.length; i++) {
    const it = input.items[i];
    if (!it.product_name?.trim()) return `${i + 1}번째 라인의 품목명을 입력하세요.`;
    if (!Number(it.qty)) return `${i + 1}번째 라인의 수량을 입력하세요.`;
  }
  return null;
}

// ─────────────────────────────────────────────
// 포맷
// ─────────────────────────────────────────────
export function formatMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return Number(n).toLocaleString();
}

export function formatQty(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "-";
  const num = Number(n);
  if (isNaN(num)) return String(n);
  // 정수면 그냥, 소수면 3자리까지
  return Number.isInteger(num) ? num.toLocaleString() : num.toFixed(3).replace(/\.?0+$/, "");
}
