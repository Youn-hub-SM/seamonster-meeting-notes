// 생산 요청서 생성 — 화면 POST(/api/production/requests)와 주간 AI 초안(/api/production/requests/draft)이 같은 규칙으로 만든다.
//  머리(production_requests) + 품목(production_request_items) 삽입, 선택 컬럼 미적용 폴백, 작성 알림까지 한 곳에.
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRequests, formatRequestDetail } from "./wholesale-production-db";
import { logProductionRequestCreated } from "./b2b-activity";
import { CONFIRMED_PURPOSES, type PrPurpose, type ProductionRequest } from "./wholesale-production";
import { defaultDueDate, defaultProdStart, kstTodayIso } from "./production-schedule";

// 일정 기본값(D+5·D+9)은 화면도 쓰므로 클라이언트 안전한 production-schedule 에 있다 — 이 파일은 서버 전용(알림·DB).
export { defaultDueDate, defaultProdStart, kstTodayIso, PROD_START_BDAYS, PROD_DUE_BDAYS, WHOLESALE_DUE_BDAYS } from "./production-schedule";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CreateItem = { product_id: string; requested_qty: number; memo: string | null; reserved_qty?: number }; // reserved_qty = 담은 행사·대량 몫(119)
export type CreateInput = {
  title?: string | null;
  requested_by?: string | null;
  request_date?: string | null;   // 없으면 오늘(KST)
  due_date?: string | null;       // 없으면 용도 기본값(확정형은 비움)
  prod_start?: string | null;     // 제조사 전용. 종료일보다 뒤면 무시
  purpose: PrPurpose;
  order_id?: string | null;
  company_id?: string | null;
  memo?: string | null;
  items: CreateItem[];
  status?: "요청" | "진행중";
  assignee?: string | null;
  created_by: string | null;
};

export class CreateError extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

export function normalizeItems(raw: unknown): CreateItem[] {
  const arr = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  return arr
    .map((it) => {
      const requested_qty = Math.round((Number(it.requested_qty) || 0) * 100) / 100; // 소수 둘째 자리 허용(104)
      const reserved_qty = Math.min(requested_qty, Math.max(0, Math.round((Number(it.reserved_qty) || 0) * 100) / 100));
      return { product_id: String(it.product_id || ""), requested_qty, memo: String(it.memo || "").trim() || null, reserved_qty };
    })
    .filter((it) => it.product_id && it.requested_qty > 0);
}

// 요청서 한 장 생성 → 전체본(loadRequests) 반환. 알림(팀즈 게시물)까지 보낸다.
export async function createProductionRequest(sb: SupabaseClient, input: CreateInput): Promise<ProductionRequest> {
  const items = input.items.filter((it) => it.product_id && it.requested_qty > 0);
  if (!items.length) throw new CreateError("요청 품목과 수량을 1개 이상 입력하세요.");

  // 묶음(세트) 품목은 자체 재고가 없어(구성품 기준 도출) 입고 대상이 아님 → 거부.
  const pids = [...new Set(items.map((it) => it.product_id))];
  const { data: bundles, error: be } = await sb.from("product_bundles").select("parent_id").in("parent_id", pids);
  if (!be && (bundles ?? []).length) throw new CreateError("묶음(세트) 품목은 생산 요청에 담을 수 없습니다. 구성품(단품)으로 요청하세요.");

  // 요청번호(PR-000001)
  let req_no: string | null = null;
  try { const { data } = await sb.rpc("next_production_request_no"); if (data) req_no = String(data); } catch { /* 069 미적용 */ }

  const purpose = input.purpose;
  const request_date = DATE_RE.test(String(input.request_date || "")) ? String(input.request_date) : kstTodayIso();
  // 생산종료일(마감)은 확정형 외 필수 — 안 오거나 형식이 틀리면 용도 기본값(제조사 D+9영업일·도매 D+7영업일)으로 서버가 채운다.
  const due_date = DATE_RE.test(String(input.due_date || "")) ? String(input.due_date) : defaultDueDate(purpose, request_date);
  // 생산시작일(118) — 입고 화면이 기본 요청서를 고르는 기간의 시작. 종료일보다 뒤면 무시(기간이 비면 기본 선택이 안 잡힌다).
  //  제조사 요청서에 시작일이 안 오면 기본 D+5영업일(생산 일정) — 종료일보다 뒤면 비운다(요청일이 기간 시작).
  //  사람이 비워서 보낸 것("" / null)은 그대로 비운다(기간 시작 = 요청일) — 급발주에서 입고 기본 선택이 빠지지 않게.
  const startIn = DATE_RE.test(String(input.prod_start || "")) ? String(input.prod_start) : (input.prod_start === undefined && purpose === "재고 보충" ? defaultProdStart(request_date) : "");
  const prod_start = startIn && (!due_date || startIn <= due_date) ? startIn : undefined;
  // 시작일이 비면 요청일이 기간 시작 — 요청일 > 종료일이면 기간이 비어 입고 화면의 기본 선택에 영영 안 잡힌다.
  if (purpose === "재고 보충" && !prod_start && due_date && request_date > due_date)
    throw new CreateError("요청일이 생산종료일보다 뒤입니다 — 생산시작일·생산종료일을 확인하세요.");
  const who = input.created_by;
  const head: Record<string, unknown> = {
    req_no,
    title: String(input.title || "").trim() || null,
    requested_by: String(input.requested_by || "").trim() || who,
    status: input.status || "요청",
    purpose,
    ...(input.assignee ? { assignee: input.assignee } : {}),
    memo: String(input.memo || "").trim() || null,
    created_by: who,
    request_date,
  };
  // 확정형이 어느 발주·거래처 몫인지(115). 둘 다 선택 — 구두 확보 당일엔 발주가 아직 없어 거래처만 찬다.
  if (UUID_RE.test(String(input.order_id || ""))) head.order_id = String(input.order_id);
  if (UUID_RE.test(String(input.company_id || ""))) head.company_id = String(input.company_id);
  if (due_date) head.due_date = due_date;     // 071. 미적용 환경이면 아래에서 컬럼만 빼고 재시도.
  if (prod_start) head.prod_start = prod_start; // 118. 미적용 환경이면 아래에서 컬럼만 빼고 재시도.

  let { data: reqRow, error: he } = await sb.from("production_requests").insert(head).select("id").single();
  // 113·115 미적용(purpose 체크 제약에 그 용도가 없음)이면 조용히 재고 보충으로 강등하지 않고 명시 오류 —
  //  강등되면 파도소리 화면·자동 매칭에 잘못 흘러들고, 선결제분이 소매 칸으로 섞인다.
  if (he && CONFIRMED_PURPOSES.includes(purpose) && /purpose/i.test(he.message))
    throw new CreateError(`${purpose} 용도가 아직 없습니다 — migration ${purpose === "프로모션" ? "113" : "115"} 을 먼저 적용하세요.`, 500);
  // 선택 컬럼(071 due_date · 082 purpose · 118 prod_start) 미적용 환경 폴백 — 에러 메시지에 보이는 컬럼만 빼고 재시도.
  for (const col of ["order_id", "company_id", "due_date", "purpose", "prod_start"] as const) {
    if (he && col in head && new RegExp(col, "i").test(he.message)) {
      delete head[col];
      ({ data: reqRow, error: he } = await sb.from("production_requests").insert(head).select("id").single());
    }
  }
  if (he) throw he;
  const requestId = (reqRow as { id: string }).id;

  // 담은 행사·대량 몫(119)은 제조사 요청서에만 — 있는 줄만 컬럼을 싣고, 미적용 환경이면 그 컬럼만 빼고 재시도
  const withReserved = purpose === "재고 보충" && items.some((it) => (it.reserved_qty ?? 0) > 0);
  const itemRows: Record<string, unknown>[] = items.map((it, i) => ({
    request_id: requestId, product_id: it.product_id, requested_qty: it.requested_qty, memo: it.memo, sort: i,
    ...(withReserved ? { reserved_qty: Math.min(it.requested_qty, it.reserved_qty ?? 0) } : {}),
  }));
  let { error: ie } = await sb.from("production_request_items").insert(itemRows);
  if (ie && withReserved && /reserved_qty/i.test(ie.message)) {
    for (const r of itemRows) delete r.reserved_qty;
    ({ error: ie } = await sb.from("production_request_items").insert(itemRows));
  }
  if (ie) { await sb.from("production_requests").delete().eq("id", requestId); throw ie; }

  // 작성 알림 — 게시물 본문에 품목·수량·마감·담당 전체(팀즈 게시물 전환으로 긴 내용 허용 — 2026-09-16)
  const label = String(input.title || "").trim() || `품목 ${items.length}종 · ${items.reduce((s, it) => s + it.requested_qty, 0).toLocaleString()}개`;
  let full: ProductionRequest | undefined;
  try { [full] = await loadRequests(sb, { id: requestId }); } catch { /* 상세 없이 발송 */ }
  await logProductionRequestCreated(req_no || "", label, who, full ? formatRequestDetail(full) : undefined);

  if (!full) [full] = await loadRequests(sb, { id: requestId });
  return full;
}
