// 매출 데이터 공용 정규화·해시 — 웹 업로드 / 백필 스크립트 / 주문검색이 '바이트 동일'하게 공유.
//  불변식: normalizePhoneDigits + customerKey + rowHash 가 세 경로에서 동일해야
//  (a)멱등 적재(중복 0)와 (b)신규/재구매 판정 연속성이 동시에 성립한다.
//  파이썬 매출리포트_ver_260623.py 의 정규화 규칙을 1:1 포팅(digits-only, 국가코드 변환 없음).
//  ⚠️ Node 런타임 전용(crypto·pepper). runtime="nodejs" 라우트/스크립트에서만 import.
import { createHmac, createHash } from "crypto";

const ZERO_WIDTH_AND_SPACES = /[\s ​‌‍﻿]+/g;

// 엑셀/CSV 한글 헤더 → 영문 컬럼(파이썬 HEADER_MAP_KR_TO_EN 1:1). 영문 헤더는 매핑에 없어 그대로 통과.
export const HEADER_MAP_KR_TO_EN: Record<string, string> = {
  "판매처": "channel", "주문일자": "order_date", "주문번호": "order_id",
  "상품명": "product_name", "옵션명": "option_name", "관리코드": "sku_code",
  "수량": "quantity", "판매가": "selling_price", "옵션금액": "option_price",
  "결제금액": "subtotal_amount", "배송비결제금액": "shipping_fee",
  "주문자": "customer_name", "수령자": "customer_name",
  "주문자전화번호": "customer_phone", "주문자휴대폰": "customer_phone", "휴대폰": "customer_phone",
};

export function normalizeColname(s: unknown): string {
  return (s == null ? "" : String(s)).trim().replace(ZERO_WIDTH_AND_SPACES, "");
}

// 전화 → 숫자만(해시 입력). 파이썬 load_dataframe 규칙 정본. formatPhone(하이픈)과 절대 혼용 금지.
export function normalizePhoneDigits(raw: unknown): string {
  if (raw == null) return "";
  return String(raw).normalize("NFKC").replace(/[^0-9]/g, "");
}

// customer_key = HMAC-SHA256(pepper, digits). 빈 전화 → ''(해시 안 함; 무전화 고객 뭉침 방지).
export function customerKey(rawPhone: unknown): string {
  const digits = normalizePhoneDigits(rawPhone);
  if (!digits) return "";
  const pepper = process.env.SALES_PII_PEPPER;
  if (!pepper) throw new Error("SALES_PII_PEPPER 환경변수가 설정되어 있지 않습니다.");
  return createHmac("sha256", pepper).update(digits, "utf8").digest("hex");
}

// 전화번호 하이픈 포맷(파이썬 format_phone 1:1) — sales_customers.phone 저장용.
export function formatPhone(value: unknown): string {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  if (/^\d{2,4}-\d{3,4}-\d{4}$/.test(raw)) return raw;   // 이미 정상 포맷
  const s = raw.replace(/\D/g, "");
  if (!s) return raw;
  if (s.length === 11) return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
  if (s.length === 12) return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;   // 안심번호 0504
  if (s.length === 10) return s.startsWith("02") ? `${s.slice(0, 2)}-${s.slice(2, 6)}-${s.slice(6)}`
                                                 : `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
  return raw;
}

// 숫자 정수화(콤마 제거). 파이썬 convert_amount_for_upload 1:1.
export function toInt(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "" || s.toLowerCase() === "nan") return 0;
  const n = Math.trunc(Number(s));
  return Number.isFinite(n) ? n : 0;
}

// 엑셀 시리얼 → yyyymmdd (origin 1899-12-30, UTC로 날짜부만 추출해 TZ 이동 방지).
function excelSerialToInt(serial: number): number {
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400_000;
  const d = new Date(ms);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// 주문일자 → yyyymmdd 정수(파싱 실패 시 null). Date객체/엑셀시리얼/yyyymmdd/날짜시각문자열(오전·오후 포함) 대응.
export function parseOrderDateInt(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date && !isNaN(value.getTime()))
    return value.getFullYear() * 10000 + (value.getMonth() + 1) * 100 + value.getDate();
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 19000101) return Math.trunc(value);           // 이미 yyyymmdd
    if (value >= 1 && value < 100000) return excelSerialToInt(value);  // 엑셀 시리얼
    return null;
  }
  let s = String(value).trim();
  if (!s) return null;
  if (/^\d{8}$/.test(s)) return Number(s);                     // yyyymmdd 문자열
  const numLike = s.replace(/,/g, ".");
  if (/^\d+(\.\d+)?$/.test(numLike)) {                          // 순수 숫자 → 엑셀 시리얼
    const n = Number(numLike);
    return n >= 19000101 ? Math.trunc(n) : excelSerialToInt(n);
  }
  // 날짜(시각) 문자열: 앞부분에서 YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD 추출
  const m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  return null;
}

// yyyymmdd → "YYYY-MM-DD"
export function intToIsoDate(n: number): string {
  const s = String(n).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// 멱등 유니크키. 순서·구분자 고정(백필=업로드 동일). customer_key 제외(나중 보정 가능).
export function rowHash(f: {
  channel: string; order_date_int: number; order_id: string; sku_code: string;
  product_name: string; option_name: string; quantity: number;
  selling_price: number; option_price: number; subtotal_amount: number; shipping_fee: number;
}): string {
  const s = [f.channel, f.order_date_int, f.order_id, f.sku_code, f.product_name, f.option_name,
             f.quantity, f.selling_price, f.option_price, f.subtotal_amount, f.shipping_fee].join("|");
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// sales_orders 삽입 행(원본 전화/이름 없음 — PII 격리).
export type SalesOrderRow = {
  channel: string; order_date: string; order_date_int: number; order_id: string;
  product_name: string; option_name: string; sku_code: string; quantity: number;
  selling_price: number; option_price: number; subtotal_amount: number; shipping_fee: number;
  customer_key: string; row_hash: string;
};
export type SalesCustomerRow = { customer_key: string; phone: string; phone_digits: string; customer_name: string | null; order_date: string };
export type NormalizedRow = { ok: boolean; error?: string; order?: SalesOrderRow; customer?: SalesCustomerRow };

// 원본 행(키=원본 헤더) → 정규화된 sales_orders/sales_customers 행. 웹업로드·백필 공용.
export function normalizeRow(raw: Record<string, unknown>): NormalizedRow {
  const en: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) {
    const nk = normalizeColname(k);
    const col = HEADER_MAP_KR_TO_EN[nk] || nk;
    en[col] = raw[k];
  }
  const s = (k: string) => (en[k] == null ? "" : String(en[k]).trim());

  const odi = parseOrderDateInt(en["order_date"]);
  if (odi == null) return { ok: false, error: `주문일자 파싱 실패: ${JSON.stringify(en["order_date"] ?? "")}` };

  const order: SalesOrderRow = {
    channel: s("channel"),
    order_date: intToIsoDate(odi),
    order_date_int: odi,
    order_id: s("order_id"),
    product_name: s("product_name"),
    option_name: s("option_name"),
    sku_code: s("sku_code"),
    quantity: toInt(en["quantity"]),
    selling_price: toInt(en["selling_price"]),
    option_price: toInt(en["option_price"]),
    subtotal_amount: toInt(en["subtotal_amount"]),
    shipping_fee: toInt(en["shipping_fee"]),
    customer_key: "",
    row_hash: "",
  };
  order.customer_key = customerKey(en["customer_phone"]);
  order.row_hash = rowHash(order);

  let customer: SalesCustomerRow | undefined;
  const digits = normalizePhoneDigits(en["customer_phone"]);
  if (digits && order.customer_key) {
    customer = {
      customer_key: order.customer_key,
      phone: formatPhone(en["customer_phone"]),
      phone_digits: digits,
      customer_name: s("customer_name") || null,
      order_date: order.order_date,
    };
  }
  return { ok: true, order, customer };
}
