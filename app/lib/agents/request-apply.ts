// 보고서의 초안(또는 피드백을 반영한 수정본)을 실제 생산 요청서로 작성한다 — 서버 전용. 요청서 에이전트(도매·소매) 공용.
//  부르는 곳은 둘뿐: 담당자의 [결재](초안 그대로) / 피드백 반영이 끝난 직후(수정본). 에이전트가 스스로 부르는 길은 없다.
//  요청서는 '요청'(화면의 '확정 필요') 상태로 생기고, 작성자는 결재하거나 피드백을 준 담당자다. 작성 알림(팀즈)은 생성 함수가 보낸다.
//  같은 보고서로 두 번 불려도 재시도 키(136, agent:<보고서 id>)로 요청서는 한 장이다.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createProductionRequest } from "../production-request-create";
import type { PrPurpose } from "../wholesale-production";
import { markApplied } from "./store";
import type { AgentReport, AppliedItem } from "./registry";

// 에이전트 → 요청서 용도. 도매 = '도매 납품', 소매 = '재고 보충'(제조사 요청서 — 생산 시작일은 생성 함수가 요청일 기준 D+3 영업일로 채운다).
const PURPOSE: Record<string, PrPurpose> = { "wholesale-request": "도매 납품", "retail-request": "재고 보충" };
export const isRequestAgent = (agent: string): boolean => agent in PURPOSE;

export type ApplyResult = { request_no: string | null; items: number };

export async function applyRequestDraft(sb: SupabaseClient, report: AgentReport, who: string | null, via: "결재" | "피드백 반영"): Promise<ApplyResult> {
  const purpose = PURPOSE[report.agent];
  if (!purpose) throw new Error("요청서를 만드는 에이전트의 보고서가 아닙니다.");
  // 첫 초안 대비 무엇이 바뀌었는지 남긴다(다음 실행의 사례). 피드백이 없었으면 초안 = 확정.
  const first = new Map((report.facts?.first_draft ?? report.draft).map((d) => [d.sku, d.qty]));
  const applied: AppliedItem[] = report.draft
    .filter((d) => d.product_id && d.qty > 0)
    .map((d) => ({ sku: d.sku, product_id: d.product_id as string, qty: d.qty, draft_qty: first.has(d.sku) ? (first.get(d.sku) as number) : null }));
  if (!applied.length) {
    // 요청할 품목이 없다(피드백이 '이번엔 요청하지 않는다'였거나 초안이 비었다) — 요청서 없이 닫는다
    await markApplied(sb, report.id, { request_id: null, request_no: null, applied: [], who });
    return { request_no: null, items: 0 };
  }
  const reasonOf = new Map(report.draft.map((d) => [d.sku, d.reason]));
  const { request } = await createProductionRequest(sb, {
    purpose,
    due_date: report.facts?.due_date || null,
    memo: `AI 에이전트 초안 · ${via}${report.summary ? ` — ${report.summary}` : ""}`.slice(0, 500),
    items: applied.map((a) => ({ product_id: a.product_id, requested_qty: a.qty, memo: (reasonOf.get(a.sku) || "").slice(0, 200) || null })),
    status: "요청",
    created_by: who,
    client_key: `agent:${report.id}`,
  });
  await markApplied(sb, report.id, { request_id: request.id, request_no: request.req_no, applied, who });
  return { request_no: request.req_no, items: applied.length };
}
