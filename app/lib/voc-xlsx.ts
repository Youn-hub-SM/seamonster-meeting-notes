// VOC 엑셀 일괄 등록 — 양식 헤더·예시 + 행 파싱/정규화(클라이언트/서버 공용, DB 코드 없음).
import { VOC_CATEGORIES, VOC_STATUSES, VOC_BUYER_TYPES, VOC_COMP_TYPES, VOC_FAULTS, suggestFault } from "./voc";

export const VOC_XLSX_HEADERS = [
  "접수일", "고객명", "구매자구분", "구매처", "구매상품", "구매일", "제품생산일",
  "클레임유형", "보상유형", "보상수량", "손해/보상금액", "손해귀책", "처리단계",
  "상세내용", "원인", "처리내용", "개선필요사항", "고객특이사항",
] as const;

export const VOC_XLSX_EXAMPLE: string[] = [
  "2026-05-03", "홍길동", "재구매", "공식몰", "대구순살 1kg", "2026-04-28", "",
  "가시", "교환·재발송", "1", "", "제조사", "접수",
  "제품에서 가시가 나왔다는 클레임", "가시 제거 공정 미흡 추정", "교환 재발송 안내함", "가시 제거 검수 강화 요청", "VIP 고객 · 응대 주의",
];

// 입력 가이드(템플릿 2번째 시트용) — 필드별 허용값.
export const VOC_XLSX_GUIDE: [string, string][] = [
  ["필수 항목", "접수일 · 상세내용 (나머지는 비워도 됨)"],
  ["접수일 / 구매일 / 제품생산일", "YYYY-MM-DD (예: 2026-05-03). 비우면 해당 항목 없음"],
  ["구매자구분", VOC_BUYER_TYPES.join(" / ") + " (또는 비움)"],
  ["클레임유형", VOC_CATEGORIES.join(" / ") + " · 비우면 '배송'"],
  ["보상유형", VOC_COMP_TYPES.join(" / ") + " · 비우면 '없음'"],
  ["손해귀책", VOC_FAULTS.join(" / ") + " · 비우면 유형에 따라 자동"],
  ["처리단계", VOC_STATUSES.join(" / ") + " · 비우면 '접수'"],
  ["보상수량 / 손해·보상금액", "숫자. 비우면 1 / 0"],
];

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const datePrefix = (s: string): string => { const m = String(s || "").trim().match(DATE_PREFIX); return m ? m[0] : ""; };
const coerce = (v: string, allowed: readonly string[], dflt: string): string => (allowed as readonly string[]).includes(v) ? v : dflt;
const numOr = (s: string, dflt: number): number => { const n = Number(String(s || "").replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : dflt; };

// 정규화된 VOC 임포트 1행 (apply 가 그대로 insert).
export interface VocImportRow {
  received_at: string; customer: string | null; buyer_type: string | null;
  purchase_place: string | null; product: string | null; purchase_date: string | null; production_date: string | null;
  category: string; comp_type: string; comp_qty: number; loss_amount: number; fault: string; status: string;
  content: string; cause: string | null; resolution: string | null; improvement: string | null; customer_note: string | null;
}

// 엑셀 셀값 → 문자열(날짜/수식/리치텍스트 대응).
export function cellStr(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("").trim();
    if (typeof o.text === "string") return o.text.trim();
    if (o.result != null) return String(o.result).trim();
    return "";
  }
  return String(v).trim();
}

// 한 행(헤더 접근자 get) → 정규화 행 또는 오류. 빈 행은 {} 반환.
export function parseVocRow(get: (h: string) => string): { row?: VocImportRow; err?: string } {
  const received = datePrefix(get("접수일"));
  const content = get("상세내용").trim();
  // 핵심 칸이 모두 비면 빈 행으로 스킵
  if (!received && !content && !get("고객명").trim() && !get("구매상품").trim()) return {};
  if (!received) return { err: "접수일(YYYY-MM-DD)이 필요합니다." };
  if (!content) return { err: "상세내용이 필요합니다." };

  const clean = (h: string): string | null => { const v = get(h).trim(); return v || null; };
  const category = coerce(get("클레임유형").trim(), VOC_CATEGORIES, "배송");
  const buyer = get("구매자구분").trim();
  const row: VocImportRow = {
    received_at: received,
    customer: clean("고객명"),
    buyer_type: (VOC_BUYER_TYPES as readonly string[]).includes(buyer) ? buyer : null,
    purchase_place: clean("구매처"),
    product: clean("구매상품"),
    purchase_date: datePrefix(get("구매일")) || null,
    production_date: datePrefix(get("제품생산일")) || null,
    category,
    comp_type: coerce(get("보상유형").trim(), VOC_COMP_TYPES, "없음"),
    comp_qty: Math.max(1, Math.round(numOr(get("보상수량"), 1))),
    loss_amount: Math.max(0, Math.round(numOr(get("손해/보상금액"), 0))),
    fault: coerce(get("손해귀책").trim(), VOC_FAULTS, suggestFault(category)),
    status: coerce(get("처리단계").trim(), VOC_STATUSES, "접수"),
    content,
    cause: clean("원인"),
    resolution: clean("처리내용"),
    improvement: clean("개선필요사항"),
    customer_note: clean("고객특이사항"),
  };
  return { row };
}
