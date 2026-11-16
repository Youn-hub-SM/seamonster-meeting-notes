// 소매 생산 요청서 에이전트 — 서버 전용. 실행(조사 차례·제출·검증)은 공용 실행기 request-agent.ts, 여기는 사실 수집과 지침만.
//  역할(2026-11-16 대표: "소매 생산 요청서 에이전트도 만들거야 — 반영된 피드백과 지금까지 데이터를 바탕으로"):
//   소매(공식몰·스마트스토어·쿠팡·톡스토어)로 팔 물량에 도매 생산 요청서의 요청량을 더해, 제조사에 생산을 요청할 품목과 수량을 정해 제조사 요청서('재고 보충') 초안을 낸다.
//  도매 몫(2026-11-16 대표: "소매요청서는 도매요청서 반영해야해. 도매요청서가 먼저 들어올거니까"):
//   도매 요청서가 먼저 작성되고(보통 화요일), 제조사가 만든 물량은 소매 칸으로 들어온 뒤 도매 칸으로 옮겨진다. 그래서 열려 있는 도매 생산 요청서('도매 납품')의
//   잔여(요청 − 이동 완료)는 소매 재고에 걸린 청구다 — 목표에 더해 함께 생산을 요청한다. 도매 재고·도매 출고는 보지 않는다(도매에 얼마가 필요한지는 도매 요청서가 정했다).
//   반영 기준(2026-11-16 대표: "도매요청서가 결재된다면 반영. 확정 전이라면 확정필요로 남겨줘"): 결재되어 요청서로 작성된 것이면 '확정 필요' 상태여도 더한다.
//   그 요청서의 상태는 건드리지 않고, 초안의 알림 줄에 '확정 필요'라고 남긴다. 아직 결재하지 않은 도매 초안(에이전트 보고서)은 요청서가 아니라 더하지 않는다 — 알림만.
//   두 번 세지 않는 까닭: 지난주 도매 요청분은 지난주 제조사 요청서에 들어 있고, 그 제조사 요청서의 잔여(입고 예정·확정 전 요청)를 아래 수식이 뺀다.
//  수식은 재고 목록 소매 탭의 권장 생산(production-inventory getInventoryRows '소매')에서 출발한다:
//   목표 = 평상시 하루 출고 × (오늘 → 다음 요청분 판매 가능일).
//   수식 권장 = max(0, 목표 + 도매 요청 잔여 − 소매 재고 − 확정된 요청서의 입고 예정 − 확정 전 제조사 요청 잔여).
//   (확정 전 잔여를 안 빼면 다음 주에 같은 양을 또 요청한다 — 도매 에이전트와 같은 규칙.)
//  제조사 제약(품목별 생산 주기·어종별 주간 한도·원물 확보·그 주 통보)은 코드에 적지 않는다 — 셰어포인트 '[비서] 데이터 해석 기준 › 7. 생산 요청'이
//   단일 소스이고(담당자 피드백이 거기 쌓인다), 공용 실행기가 그 페이지를 지침 뒤에 붙인다. 한도 계산용 중량(단위kg)만 코드가 facts 에 싣는다.
//  '지금까지 데이터' = 최근 6주 제조사 요청서의 품목별 수량(담당자가 실제로 요청해 온 양) + 이 에이전트의 지난 보고서·확정 수량·피드백(공용 실행기).
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInventoryRows } from "../production-inventory";
import { loadRequests } from "../wholesale-production-db";
import { defaultDueDate, defaultProdStart, kstTodayIso } from "../production-schedule";
import { readAll } from "../inventory-template";
import { kstTodayLabel } from "../assistant";
import { runRequestAgent, productsBySku, r2, addDays, type Collected, type ProductRow, type RunInput, type AgentRunResult } from "./request-agent";

const PURPOSE = "재고 보충";  // 제조사 요청서(화면의 '제조사')
const WHOLESALE_PURPOSE = "도매 납품"; // 도매 생산 요청서 — 이 요청서의 잔여를 소매 요청서에 더한다
const PAST_DAYS = 42;         // 지난 요청서를 보는 기간(6주)

type P = ProductRow & { sku_weight_g?: number | null };
// 품목 — SKU중량(098)이 없는 환경이면 중량 없이 읽는다(한도 계산은 에이전트가 규격으로 어림하고 '확인 필요'에 적는다)
async function readProducts(sb: SupabaseClient): Promise<{ rows: P[]; weightOk: boolean }> {
  try {
    return { rows: await readAll<P>((a, b) => sb.from("products").select("id, sku, name, spec, unit, active, sku_weight_g").order("id", { ascending: true }).range(a, b)), weightOk: true };
  } catch (e) {
    if (!/sku_weight_g/i.test(String((e as { message?: string })?.message ?? e))) throw e;
    return { rows: await readAll<P>((a, b) => sb.from("products").select("id, sku, name, spec, unit, active").order("id", { ascending: true }).range(a, b)), weightOk: false };
  }
}

// 최근 6주 제조사 요청서(취소 제외)의 품목별 수량 — 담당자가 실제로 요청해 온 양과 단위를 에이전트가 참고한다
type PastHead = { req_no: string | null; status: string; request_date: string; production_request_items: { requested_qty: number; products: { sku: string | null } | { sku: string | null }[] | null }[] | null };
const STATUS_LABEL: Record<string, string> = { "요청": "확정 필요", "진행중": "확정", "완료": "완료" };
async function loadPast(sb: SupabaseClient, since: string): Promise<{ ok: boolean; heads: PastHead[] }> {
  const { data, error } = await sb.from("production_requests")
    .select("req_no, status, request_date, production_request_items(requested_qty, products(sku))")
    .eq("purpose", PURPOSE).neq("status", "취소").gte("request_date", since)
    .order("request_date", { ascending: false }).limit(30);
  if (error) return { ok: false, heads: [] };
  return { ok: true, heads: (data ?? []) as unknown as PastHead[] };
}

// 결재를 기다리는 도매 생산 요청서 초안(도매 에이전트 보고서 — 작성은 끝났고 아직 결재·피드백 전) 가운데 가장 최근 것의 작성일(한국 날짜). 없거나 못 읽으면 null.
async function pendingWholesaleDraft(sb: SupabaseClient, since: string): Promise<string | null> {
  const { data, error } = await sb.from("agent_reports").select("created_at").eq("agent", "wholesale-request").eq("status", "done").is("applied", null)
    .gte("created_at", `${since}T00:00:00+09:00`).order("created_at", { ascending: false }).limit(1);
  const at = error ? null : (data?.[0] as { created_at?: string } | undefined)?.created_at;
  return at ? new Date(Date.parse(at) + 9 * 3600e3).toISOString().slice(0, 10) : null;
}

async function collect(sb: SupabaseClient): Promise<Collected> {
  const today = kstTodayIso();
  const warnings: string[] = [];
  const [rt, prod, bundles, reqDraft, reqConfirmed, past, pendingDraft] = await Promise.all([
    getInventoryRows("소매"),
    readProducts(sb),
    sb.from("product_bundles").select("parent_id").limit(5000),
    loadRequests(sb, { status: "요청" }),
    loadRequests(sb, { status: "진행중" }),
    loadPast(sb, addDays(today, -PAST_DAYS)),
    pendingWholesaleDraft(sb, addDays(today, -7)),
  ]);
  if (!rt.inboundOk) warnings.push("확정된 요청서의 입고 예정을 집계하지 못했습니다 — 수식 권장이 이미 요청한 양을 빼지 못한 값입니다.");
  if (!rt.settingsOk) warnings.push("행사 일정·추가 확보 설정을 읽지 못했습니다 — 하루 출고에 행사 출고가 섞였을 수 있습니다.");
  if (!prod.weightOk) warnings.push("품목 중량(SKU중량)을 읽지 못했습니다 — 어종별 주간 한도는 규격으로 어림했습니다.");
  if (!past.ok) warnings.push("지난 제조사 요청서를 읽지 못했습니다.");

  const products = productsBySku(prod.rows);
  const bundleIds = new Set<string>(((bundles.data ?? []) as { parent_id: string }[]).map((b) => b.parent_id));

  // 열려 있는 도매 생산 요청서(확정 필요·확정)의 품목별 잔여 = 요청 − 이동 완료. 소매 재고에 걸린 청구라 목표에 더한다.
  const open = [...reqDraft, ...reqConfirmed];
  const wholesaleOpen = open.filter((q) => q.purpose === WHOLESALE_PURPOSE);
  const claimBySku = new Map<string, { qty: number; overdue: number }>();
  for (const q of wholesaleOpen) for (const it of q.items) {
    const k = String(it.sku || "").toUpperCase();
    const left = Math.max(0, it.requested_qty - it.received_qty);
    if (!k || left <= 0) continue;
    const cur = claimBySku.get(k) ?? { qty: 0, overdue: 0 };
    cur.qty = r2(cur.qty + left);
    if (q.due_date && q.due_date < today) cur.overdue = r2(cur.overdue + left);
    claimBySku.set(k, cur);
  }
  const wholesaleRequests = wholesaleOpen.map((q) => ({
    요청번호: q.req_no, 상태: q.status === "진행중" ? "확정" : "확정 필요", 요청일: q.request_date, 마감: q.due_date, 메모: q.memo,
    품목: q.items.filter((it) => it.requested_qty > 0).map((it) => ({ sku: it.sku, 품목: it.name, 요청: it.requested_qty, 이동완료: it.received_qty, 잔여: r2(Math.max(0, it.requested_qty - it.received_qty)) })),
  }));
  // 이번 주(월요일부터)에 작성된 도매 요청서가 있는가 — 없으면 이번 주 도매 몫이 아직 안 들어온 것일 수 있다
  const weekStart = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const wholesaleThisWeek = wholesaleOpen.some((q) => q.request_date >= weekStart);
  // 결재는 됐지만 아직 확정 전인 도매 요청서 — 수량에는 반영하고 '확정 필요'라고 남긴다(상태는 바꾸지 않는다)
  const unconfirmed = wholesaleOpen.filter((q) => q.status === "요청" && q.items.some((it) => it.requested_qty - it.received_qty > 0)).map((q) => q.req_no || "번호 없음");
  if (unconfirmed.length) warnings.push(`도매 생산 요청서 ${unconfirmed.join("·")}: 확정 필요 상태입니다. 결재된 요청서라 수량에 반영했습니다.`);
  if (pendingDraft) warnings.push(`결재를 기다리는 도매 생산 요청서 초안이 있습니다(${pendingDraft.slice(5)} 작성). 결재 전이라 반영하지 않았습니다. 도매 초안을 결재한 뒤 다시 [업무 요청]하세요.`);

  // 아직 확정하지 않은 제조사 요청서('요청' = 화면의 '확정 필요')의 품목별 잔여 — 확정된 것은 getInventoryRows 의 입고 예정에 이미 들어 있다
  const isMine = (q: { purpose: string }) => q.purpose === PURPOSE;
  const pendingBySku = new Map<string, number>();
  for (const q of reqDraft.filter(isMine)) for (const it of q.items) {
    const k = String(it.sku || "").toUpperCase();
    const left = Math.max(0, it.requested_qty - it.received_qty);
    if (k && left > 0) pendingBySku.set(k, r2((pendingBySku.get(k) || 0) + left));
  }
  const openRequests = open.filter(isMine).map((q) => ({
    요청번호: q.req_no, 상태: q.status === "진행중" ? "확정" : "확정 필요", 요청일: q.request_date, 생산시작: q.prod_start ?? null, 생산종료: q.due_date, 제목: q.title, 메모: q.memo,
    품목: q.items.filter((it) => it.requested_qty > 0).map((it) => ({ sku: it.sku, 품목: it.name, 요청: it.requested_qty, 입고: it.received_qty, 잔여: r2(Math.max(0, it.requested_qty - it.received_qty)) })),
  }));

  // 지난 요청 — SKU별 '요청일 수량'(최신순 4건까지), 요청서별 요약
  const pastBySku = new Map<string, string[]>();
  const pastRequests = past.heads.map((h) => {
    let n = 0, sum = 0;
    for (const it of h.production_request_items ?? []) {
      const qty = Number(it.requested_qty) || 0;
      const sku = String((Array.isArray(it.products) ? it.products[0]?.sku : it.products?.sku) || "").toUpperCase();
      if (!sku || qty <= 0) continue;
      n++; sum += qty;
      const list = pastBySku.get(sku) ?? [];
      if (list.length < 4) list.push(`${h.request_date.slice(5)} ${r2(qty)}`);
      pastBySku.set(sku, list);
    }
    return { 요청번호: h.req_no, 요청일: h.request_date, 상태: STATUS_LABEL[h.status] ?? h.status, 품목수: n, 수량합: r2(sum) };
  });

  const wt = rt.velocityWindows;
  if (!wt) warnings.push("최근 7일·30일 소매 출고 합계를 읽지 못했습니다.");
  const bySku: Collected["bySku"] = new Map();
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const w of rt.rows) {
    seen.add(w.sku);
    const pending = pendingBySku.get(w.sku) || 0;
    const claim = claimBySku.get(w.sku);
    const wreq = claim?.qty ?? 0;
    const need = r2(w.safety + w.demand);
    // 소매 탭 권장(w.recommend)은 0 에서 잘려 있어 도매 몫을 더하기 전에 다시 편다: 목표 + 도매 요청 − 소매 재고 − 입고 예정 − 확정 전 요청
    const formula = Math.max(0, r2(need + wreq - (w.stock ?? 0) - w.inbound - pending));
    const daysLeft = w.stock != null && w.dailyOut > 0 ? Math.floor(Math.max(0, w.stock) / w.dailyOut) : null;
    const out7 = r2(wt?.d7[w.sku] || 0), out30 = r2(wt?.short[w.sku] || 0);
    bySku.set(w.sku, { stock: w.stock, dailyOut: w.dailyOut, daysLeft, formula, openReq: r2(w.inbound + pending), out7, out30, need, wholesaleReq: wreq });
    // 소매 출고도 권장도 요청도 도매 요청도 없는 품목은 판단 대상이 아니다 — 토큰만 쓴다
    if (!(w.dailyOut > 0 || w.rawDailyOut > 0 || formula > 0 || w.inbound > 0 || pending > 0 || wreq > 0)) continue;
    const g = Number(products.get(w.sku)?.sku_weight_g) || 0;
    const kg = g > 0 ? r2(g / 1000) : null;
    rows.push({
      sku: w.sku, 품목: w.name, 소매재고: w.stock, 하루출고: r2(w.dailyOut), 최근7일출고: out7, 최근30일출고: out30, 버티는일수: daysLeft,
      목표: need, 부족기준: w.leadSafety, 도매요청: wreq, 입고예정: w.inbound, 확정전요청: pending, 수식권장: formula, 부족: w.belowSafety,
      ...(kg ? { 단위kg: kg, 권장kg: r2(formula * kg) } : {}),
      ...(claim && claim.overdue > 0 ? { 마감지난도매요청: claim.overdue } : {}),
      ...(r2(w.rawDailyOut) !== r2(w.dailyOut) ? { 행사포함하루출고: r2(w.rawDailyOut) } : {}),
      ...(w.promoQty > 0 ? { 행사예정: w.promoQty } : {}),
      ...(w.adjust ? { 추가확보: w.adjust, 추가확보사유: w.adjustMemo || null } : {}),
      ...(w.inboundOverdue > 0 ? { 마감지난입고예정: w.inboundOverdue } : {}),
      ...(pastBySku.has(w.sku) ? { 지난요청: pastBySku.get(w.sku)!.join(" · ") } : {}),
    });
  }
  // 소매 칸에 원장도 입고 예정도 없는 도매 전용 품목 — 도매 요청 잔여만으로 행을 만든다(빠지면 그 품목의 도매 몫이 요청서에서 사라진다)
  for (const [sku, claim] of claimBySku) {
    if (seen.has(sku)) continue;
    const prod = products.get(sku);
    if (!prod || prod.active === false || bundleIds.has(prod.id)) { warnings.push(`도매 요청서의 ${sku} 는 상품 마스터에서 요청할 수 있는 품목으로 찾지 못해 계산에서 뺐습니다.`); continue; }
    const pending = pendingBySku.get(sku) || 0;
    const formula = Math.max(0, r2(claim.qty - pending));
    bySku.set(sku, { stock: null, dailyOut: 0, daysLeft: null, formula, openReq: pending, out7: 0, out30: 0, need: 0, wholesaleReq: claim.qty });
    const g = Number(prod.sku_weight_g) || 0;
    const kg = g > 0 ? r2(g / 1000) : null;
    rows.push({
      sku, 품목: prod.name, 소매재고: null, 하루출고: 0, 최근7일출고: 0, 최근30일출고: 0, 버티는일수: null,
      목표: 0, 부족기준: 0, 도매요청: claim.qty, 입고예정: 0, 확정전요청: pending, 수식권장: formula, 부족: false,
      ...(kg ? { 단위kg: kg, 권장kg: r2(formula * kg) } : {}),
      ...(claim.overdue > 0 ? { 마감지난도매요청: claim.overdue } : {}),
      ...(pastBySku.has(sku) ? { 지난요청: pastBySku.get(sku)!.join(" · ") } : {}),
    });
  }
  rows.sort((a, b) => (b.수식권장 as number) - (a.수식권장 as number) || Number(b.부족) - Number(a.부족) || String(a.sku).localeCompare(String(b.sku)));

  const s = rt.schedule;
  const dueDate = defaultDueDate(PURPOSE, today) ?? s.sellable;   // 생산 종료(D+7 영업일)
  return {
    today, dueDate, nextArrival: s.nextSellable, horizonDays: rt.horizonDays, leadDays: rt.leadDays,
    modelFacts: {
      기준일: kstTodayLabel(), 다음요청일: s.nextDraft, 생산시작예정일: defaultProdStart(today), 생산종료예정일: dueDate,
      이번요청판매가능일: s.sellable, 다음요청분판매가능일: s.nextSellable, 부족기준일수: rt.leadDays, 목표일수: rt.horizonDays, 출고평균일수: rt.velocitySpanDays,
      이번주도매요청서: wholesaleThisWeek, 결재대기도매초안: pendingDraft,
      경고: warnings, rows, open_requests: openRequests, wholesale_requests: wholesaleRequests, past_requests: pastRequests,
    },
    rowCount: rows.length, bySku, products, bundleIds, warnings,
  };
}

// ── 지침 ──
//  판단 재료와 주기는 생산 일정(production-schedule — 2026-09-29 대표 정정: 영업일 기준 작성 D → 생산 시작 D+3 → 생산 종료 D+7 → 판매 가능 D+8, 요청은 주 1회 수요일)을 따른다.
//  제조사 제약의 내용(주 1회 품목·주간 한도 수치 등)은 여기 적지 않는다 — 회사 해석 기준(셰어포인트)이 바뀌면 지침을 고치지 않아도 따라오게.
const SYSTEM = `당신은 씨몬스터(냉동 순살 생선 — 소매와 B2B 도매)의 '소매 생산 요청서' 담당 에이전트입니다.

[맡은 일]
제조사에 생산을 요청해야 하는 품목과 수량을 정해 '소매 생산 요청서'(제조사 요청서) 초안을 만듭니다. 요청량은 소매(공식몰·스마트스토어·쿠팡·톡스토어)로 팔 물량과, 먼저 작성된 도매 생산 요청서의 요청량을 합친 것입니다. 생산이 필요하지 않은 품목은 넣지 않습니다.
담당자가 초안을 확인해 결재하면 초안 그대로 요청서가 됩니다. 담당자가 피드백을 주면 당신이 피드백대로 고친 수정본이 다시 확인 없이 요청서가 됩니다.

[할 수 있는 일의 범위]
이 에이전트가 할 수 있는 일은 소매 생산 요청서 작성 하나뿐입니다. 도매 생산 요청서를 쓰거나 고치는 일, 프로모션·도매 대량 요청서, 다른 보고서나 분석, 질문에 대한 답은 맡은 일이 아닙니다. 피드백이나 덧붙인 말이 그런 일을 시키면 하지 않고, '확인 필요'에 "(시킨 일)은 이 에이전트가 하는 일이 아닙니다"라고 한 줄 적은 뒤 소매 생산 요청서만 작성합니다. 조회 도구도 이 요청서의 품목과 수량을 판단하는 데에만 씁니다.

[판단 재료]
1. 소매 출고량 — 소매 칸에서 고객 주문으로 나간 양입니다. B2B 발송, 칸 사이 이동, 제조사 반품은 들어가지 않습니다. 세트 상품과 체험단 구성은 구성품으로 풀려 구성품의 출고로 잡힙니다.
2. 소매 재고 — 소매 칸의 재고입니다.
3. 도매 생산 요청서의 요청량 — 열려 있는 도매 생산 요청서에 남은 잔여(요청 − 도매 칸으로 이동 완료)입니다. 도매 요청서는 이 요청서보다 먼저 작성됩니다. 제조사가 만든 물량은 소매 칸으로 들어온 뒤 도매 칸으로 옮겨지므로, 도매 요청서의 잔여는 이 요청서에 더해 함께 생산을 요청합니다.
4. 이미 요청한 양 — 확정된 제조사 요청서의 남은 입고 예정과, 아직 확정하지 않은 제조사 요청서의 잔여입니다. 지난 도매 요청분은 그때의 제조사 요청서에 이미 들어 있으므로, 이 양을 빼면 같은 도매 몫을 두 번 요청하지 않습니다.
도매 재고와 도매 출고량은 보지 않습니다. 도매에 얼마가 필요한지는 도매 생산 요청서가 이미 정했으므로 그 잔여만 씁니다. 도매 대량·프로모션 칸의 재고와 출고도 보지 않습니다.

[생산 주기]
- 생산 요청은 1주일 단위입니다(보통 수요일에 작성). 영업일 기준으로 작성일 뒤 3일째에 생산을 시작해 7일째에 끝나고, 8일째부터 팔 수 있습니다.
- 그래서 이번 요청은 '다음 요청분을 팔 수 있게 되는 날'까지 소매 판매를 버티게 해야 합니다. facts 의 이번요청판매가능일·다음요청일·다음요청분판매가능일·목표일수가 그 날짜 계산입니다(목표일수 = 오늘부터 다음요청분판매가능일까지).
- 주기와 일정은 바뀔 수 있습니다. 날짜는 facts 값을 따르고, 피드백이나 덧붙인 말이 다른 일정을 말하면 그쪽을 따릅니다.

[받는 자료]
- facts.rows: 코드가 방금 계산한 품목별 사실입니다. 숫자는 이 값을 그대로 씁니다.
  · 소매재고, 하루출고(최근 출고평균일수 동안의 평상시 하루 평균 — 등록된 행사 출고는 뺀 값), 최근7일출고·최근30일출고(행사 출고를 빼지 않은 합계), 버티는일수(= 소매재고 ÷ 하루출고)
  · 목표 = 하루출고 × 목표일수(+ 추가확보), 부족기준 = 하루출고 × 부족기준일수(+ 추가확보)
  · 도매요청: 열려 있는 도매 생산 요청서에서 이 품목에 남은 잔여(확정 필요·확정 모두). 소매 칸에 재고도 출고도 없는 도매 전용 품목은 이 칸만 있습니다.
  · 입고예정: 확정된 제조사 요청서의 남은 양. 확정전요청: 아직 확정하지 않은 제조사 요청서의 잔여. 둘 다 이미 요청한 양입니다.
  · 수식권장 = max(0, 목표 + 도매요청 − 소매재고 − 입고예정 − 확정전요청)
  · 부족: 소매재고와 입고예정을 합쳐도 부족기준에 못 미치면 true 입니다. 지금 요청해도 팔 수 있게 되기 전에 재고가 바닥날 수 있다는 뜻입니다.
  · 단위kg: 판매 단위 1개의 중량, 권장kg: 수식권장을 kg 으로 바꾼 값. 없는 품목은 중량이 등록되지 않은 품목입니다.
  · 있을 때만 나오는 칸 — 마감지난도매요청(마감일이 지난 도매 요청서의 잔여 — 도매요청에 들어 있는 양), 행사포함하루출고(행사 출고를 빼기 전 하루 평균), 행사예정(목표일수 안에 남은 행사 예상 판매량), 추가확보·추가확보사유(담당자가 목표에 더하거나 뺀 양), 마감지난입고예정(생산 종료일이 지났는데 아직 안 들어온 양), 지난요청(최근 6주 제조사 요청서에서 이 품목을 요청한 날짜와 수량, 최신순)
- facts.open_requests: 열려 있는 제조사 요청서(확정 필요·확정). facts.past_requests: 최근 6주 제조사 요청서 목록.
- facts.wholesale_requests: 열려 있는 도매 생산 요청서(결재되어 작성된 것 — 상태는 '확정 필요' 또는 '확정')와 품목별 잔여. facts.이번주도매요청서: 이번 주(월요일부터)에 작성된 도매 생산 요청서가 있으면 true 입니다. facts.결재대기도매초안: 아직 결재하지 않은 도매 초안이 있으면 그 작성일, 없으면 null 입니다.
- 회사 해석 기준: '생산 요청' 절에 제조사의 생산 제약이 있습니다. 아래 [제조사 제약]대로 따릅니다.
- 지난 보고서: 당신이 전에 낸 첫 초안, 요청서로 확정된 수량, 담당자의 피드백입니다. 담당자가 고친 방향을 같은 상황에 미리 적용합니다.
- 담당자 피드백(있을 때만): 당신이 낸 초안과 그에 대한 담당자의 피드백입니다. 피드백이 말한 것은 그대로 반영하고, 말하지 않은 품목과 수량은 초안 그대로 둡니다. 피드백이 '요청하지 않는다'는 뜻이면 items 를 비워 제출합니다. 피드백의 뜻이 여러 가지로 읽히면 수량이 적은 쪽으로 정하고 '확인 필요'에 어떻게 읽었는지 적습니다.
- 덧붙인 말: 이번 요청에 사람이 준 정보나 지시입니다. 소매 생산 요청서의 품목과 수량에 관한 것이면 다른 기준보다 우선합니다.

[제조사 제약 — 수식권장보다 우선]
회사 해석 기준의 '생산 요청' 절에는 담당자가 알려 준 제조사 사정이 쌓여 있습니다: 품목별 생산 주기(한 주에 한 번만 생산하는 품목), 어종별 주간 생산 한도, 원물이 확보돼 따로 요청하지 않는 어종, 그 주에만 해당하는 통보.
- 수량을 정하기 전에 그 절을 읽고 해당하는 품목에 적용합니다. 수식권장과 어긋나면 제약을 따릅니다.
- 주간 한도가 kg 으로 정해진 어종은 요청 수량 × 단위kg 으로 합산합니다. 도매 몫도 같은 제조사가 만드는 양이므로 한도에 함께 셉니다. 같은 주에 이미 낸 제조사 요청서(open_requests 에서 요청일이 이번 주인 것)의 같은 어종 수량도 함께 셉니다. 한도를 넘으면 '부족'인 품목과 버티는일수가 짧은 품목부터 채우고, 나머지는 다음 주로 미룹니다.
- 단위kg 이 없는 품목은 품목 이름과 규격의 중량으로 어림하고, 어림했다고 '확인 필요'에 적습니다.
- 한 주에 한 번만 생산하는 품목은 같은 주의 요청서에 이미 있으면 다시 넣지 않습니다.
- '그 주에만' 해당하는 통보는 날짜를 보고 이번 주에 해당할 때만 적용합니다.
- 제약 때문에 줄이거나 뺀 품목은 '요청하지 않은 품목'에 수식권장과 함께 적습니다.

[판단 기준]
1. 생산이 필요한 품목 = 소매재고와 이미 요청한 양을 합쳐도 다음요청분판매가능일까지의 소매 판매와 도매 요청을 채우지 못하는 품목입니다. 출발점은 수식권장이고, 수식권장이 0인 품목은 넣지 않습니다(피드백·덧붙인 말·회사 규칙이 시킬 때만 예외).
2. 도매요청은 적힌 그대로 더합니다. 줄이거나 늘리지 않습니다. 도매 수량의 판단은 도매 생산 요청서의 몫입니다. 결재되어 요청서로 작성된 도매 생산 요청서는 아직 '확정 필요' 상태여도 더합니다. 그 요청서의 상태는 그대로 두고, 더한 요청서 가운데 '확정 필요' 상태인 것은 요청번호와 함께 '확인 필요'에 "확정 필요"라고 적습니다. 아직 결재되지 않은 도매 초안(facts.결재대기도매초안에 작성일이 있으면 그런 초안이 있는 것)은 요청서가 아니므로 더하지 않고, '확인 필요'에 "도매 초안을 결재한 뒤 다시 요청해야 합니다"라고 적습니다. 도매요청이 있는 품목은 이유에 소매 몫과 도매 몫을 나눠 적습니다(예: 소매 120 + 도매 요청 60). 마감지난도매요청이 있으면 수량에는 넣되 요청번호와 함께 '확인 필요'에 적습니다. 이번주도매요청서가 false 이면 '확인 필요'에 "이번 주 도매 생산 요청서가 아직 없습니다. 이번 주 도매 몫이 빠졌을 수 있습니다"라고 적습니다.
3. 소매 출고 추이를 봅니다. 최근7일출고가 하루출고 × 7 보다 뚜렷이 많거나 적으면 어느 쪽이 앞으로 2~3주를 대표하는지 판단해 소매 몫을 올리거나 내리고, 그 판단을 이유에 적습니다. 최근7일출고·최근30일출고에는 행사 출고가 들어 있으니, 행사포함하루출고나 행사예정이 있는 품목은 행사 때문에 늘어난 것인지 먼저 봅니다.
4. 행사 물량은 이 요청서에 더하지 않습니다. 행사는 프로모션 요청서가 따로 맡습니다. 행사예정이 있는 품목은 수량을 평상시 기준으로 정하고, 행사예정 수량을 '확인 필요'에 적습니다.
5. 입고예정과 확정전요청은 이미 요청된 양입니다. 같은 양을 다시 요청하지 않습니다. 마감지난입고예정이 있는 품목은 그 양이 실제로 들어올지 알 수 없으니 수량은 그대로 두고 '확인 필요'에 적습니다.
6. '부족'이 true 인 품목은 급한 품목(urgent)으로 표시합니다.
7. 수량은 품목의 판매 단위 개수입니다. 지난요청에서 담당자가 요청해 온 수량의 단위가 뚜렷하면(예: 늘 10개나 50개 단위) 그 단위로 맞추고, 맞췄다고 이유에 적습니다. 뚜렷하지 않으면 수식권장을 그대로 씁니다. 근거 없이 올림·내림하지 않습니다.
8. 확인하지 못한 것은 추측으로 채우지 않고 '확인 필요'에 적습니다.

[도구]
- schema, run_sql: 읽기 전용 조회입니다. facts 로 판단이 서면 쓰지 않습니다. 최근 출고가 행사나 일회성 대량 주문 때문인지, 채널별로 어디서 늘었는지처럼 판단이 갈리는 것만 확인합니다(보통 0~4회).
  원장(inventory_txns)을 직접 볼 때는 소매 판매만 남깁니다: channel = '소매', type = '출고', status = '완료', B2B 발송 행(shipment_id 가 있는 행) 제외, 칸 이동 행(source 가 'move'·'promo_close', 또는 주문번호 없는 partner '채널이동') 제외, 사유가 '제조사 반품'인 행 제외. 이 조건을 못 맞추겠으면 조회 결과를 쓰지 말고 facts 값을 씁니다.
- search_text, read_report: 요청서 메모·종합 리포트 본문이 필요할 때.
- submit_report: 결과 제출. 마지막에 정확히 한 번 호출합니다. 글로만 답하고 끝내지 않습니다.

[제출 형식]
- summary: 한 문장. 품목 수와 가장 중요한 판단.
- items: 생산을 요청할 품목. sku 는 facts 의 sku 그대로, qty 는 수량, reason 은 한두 문장(소매 출고량과 소매 재고 숫자, 도매 요청이 있으면 그 수량 포함), urgent 는 급함 여부.
- body_md: 아래 틀. '##' 제목, '-' 목록, '**굵게**' 만 씁니다(표·코드 블록 없음). 날짜는 '이번 주' 같은 말 대신 실제 날짜로 적습니다.

## 판단 근거
- (생산 일정과 버틸 기간, 수량을 정한 원칙, 반영한 도매 생산 요청서, 적용한 제조사 제약)
## 요청하지 않은 품목
- (수식권장이 있었지만 넣지 않았거나 줄인 품목과 이유. 없으면 이 제목을 뺍니다)
## 확인 필요
- (사람이 확인할 것. 없으면 이 제목을 뺍니다)`;

export const runRetailRequest = (sb: SupabaseClient, p: RunInput): Promise<AgentRunResult> =>
  runRequestAgent(sb, { doc: "소매 생산 요청서", system: SYSTEM, collect }, p);
