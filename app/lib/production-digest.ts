import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRequests } from "./wholesale-production-db";
import { PR_PURPOSE_LABEL, DUE_LABEL, toPrPurpose, type ProductionRequest } from "./wholesale-production";

// B2B 일정 알림(다이제스트)에 붙는 '생산 요청 할 일' — 2026-10-06 대표 지시(새 요청서·행사일·종료일을 놓쳐서).
//  상태 알림은 한 번 오고 묻히므로, 처리될 때까지 발송 시각마다 다시 보인다(처리하면 다음 발송에서 빠진다).
//  ① 확정 안 된 열린 요청서(담당 없음 — 확정해야 입고 예정에 잡힌다) ② 행사일이 된 열린 프로모션('마감'하면 확보분이 소매로)
//  ③ 목표일 지난 열린 제조사·도매·도매 대량 요청서 ④ 내일 행사 시작 프로모션(예고) ⑤ 소매 합류 미확인 프로모션(136).
export type ProdTodo = { lines: string[]; count: number };

const OPEN = ["요청", "진행중"] as const;
const md = (d: string) => d.slice(5);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const cut = (arr: string[], n: number) => (arr.length > n ? `${arr.slice(0, n).join(", ")} 외 ${arr.length - n}건` : arr.join(", "));
// 미입고(미이동) 잔여 = 품목별 max(0, 요청 − 이행) 합 — 생산 요청 목록의 '지남 · 잔여'와 같은 규칙
const remainOf = (r: ProductionRequest) =>
  Math.round(r.items.reduce((s, it) => s + Math.max(0, (Number(it.requested_qty) || 0) - (Number(it.received_qty) || 0)), 0) * 100) / 100;

export async function buildProductionTodo(sb: SupabaseClient, today: string): Promise<ProdTodo> {
  const open = (await Promise.all(OPEN.map((s) => loadRequests(sb, { status: s })))).flat();
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const label = (r: ProductionRequest) => PR_PURPOSE_LABEL[toPrPurpose(r.purpose)];
  const name = (r: ProductionRequest) => `${r.req_no || "(번호 없음)"} ${label(r)}${r.title ? ` '${r.title}'` : ""}`;
  const byDue = (a: ProductionRequest, b: ProductionRequest) => String(a.due_date || "").localeCompare(String(b.due_date || ""));
  const isPromo = (r: ProductionRequest) => toPrPurpose(r.purpose) === "프로모션";

  const unconfirmed = open.filter((r) => !r.assignee)
    .sort((a, b) => String(a.request_date || "").localeCompare(String(b.request_date || "")));
  const promoDue = open.filter((r) => isPromo(r) && !!r.due_date && r.due_date <= today).sort(byDue);
  const overdue = open.filter((r) => !isPromo(r) && !!r.due_date && r.due_date < today).sort(byDue);
  const promoTomorrow = open.filter((r) => isPromo(r) && r.due_date === tomorrow);

  const L: string[] = [];
  if (unconfirmed.length) L.push("", `생산 요청 확정 필요 (${unconfirmed.length}건) — 생산 요청에서 '확정'(확정해야 입고 예정에 잡힘)`,
    ` · ${cut(unconfirmed.map((r) => `${name(r)} 요청 ${md(String(r.request_date || ""))}`), 8)}`);
  if (promoDue.length) L.push("", `행사일이 된 프로모션 (${promoDue.length}건) — '마감'하면 확보분이 소매로`,
    ` · ${cut(promoDue.map((r) => { const d = daysBetween(String(r.due_date), today); return `${name(r)} 행사일 ${md(String(r.due_date))}${d > 0 ? ` ${d}일 지남` : " 오늘"}`; }), 8)}`);
  if (overdue.length) L.push("", `목표일 지난 생산 요청 (${overdue.length}건) — 마감하거나 날짜 수정`,
    ` · ${cut(overdue.map((r) => { const rem = remainOf(r); return `${name(r)} ${DUE_LABEL[toPrPurpose(r.purpose)]} ${md(String(r.due_date))}${rem > 0 ? ` 잔여 ${rem.toLocaleString()}` : toPrPurpose(r.purpose) === "재고 보충" ? " 다 들어옴" : " 다 옮김"}`; }), 8)}`);
  if (promoTomorrow.length) L.push("", `내일 행사 시작 프로모션 (${promoTomorrow.length}건) — 판매 시작 때 '마감'`,
    ` · ${cut(promoTomorrow.map((r) => name(r)), 8)}`);

  // ⑤ 합류 미확인 — 마감·취소했는데 소매 합류 완료 표시(136 promo_released_at)가 비어 있는 프로모션(합류 중 끊김·일부 실패).
  //  확보분이 프로모션 칸에 남아 행사 판매가 나가는 소매가 비어 있을 수 있다. 136 미적용이면 건너뛴다.
  const pending: { id: string; req_no: string | null; title: string | null; status: string }[] = [];
  {
    const { data, error } = await sb.from("production_requests").select("id, req_no, title, status")
      .eq("purpose", "프로모션").in("status", ["완료", "취소"]).is("promo_released_at", null).order("updated_at", { ascending: false }).limit(50);
    if (!error) pending.push(...((data ?? []) as typeof pending));
    else if (!/promo_released_at/i.test(error.message)) console.warn("[production-digest] 합류 미확인 조회 실패", error.message);
  }
  if (pending.length) L.push("", `소매 합류 미확인 프로모션 (${pending.length}건) — 생산 요청에서 [합류 다시 실행]`,
    ` · ${cut(pending.map((r) => `${r.req_no || "(번호 없음)"} 프로모션${r.title ? ` '${r.title}'` : ""} ${r.status}`), 8)}`);

  const count = new Set([...unconfirmed, ...promoDue, ...overdue, ...promoTomorrow].map((r) => r.id)).size + pending.length;
  return { lines: L, count };
}
