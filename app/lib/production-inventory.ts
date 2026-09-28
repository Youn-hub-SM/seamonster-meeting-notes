import { supabaseAdmin } from "./supabase";
import { getLedgerVelocity, isMissingSchemaError } from "./production-velocity";
import { RESERVED_CHANNELS } from "./inventory";
import { getPromoForwardBySku, getPromoSoldInWindow } from "./production-promotions";
import { getSafetyAdjusts, effectiveDelta, effectiveExclude } from "./production-safety-adjust";
import { LINK_B2B_ORDERS_TO_PRODUCTION } from "./production-config";
import { scheduleHorizon, type ScheduleHorizon } from "./production-schedule";
import { getOpenInboundByProduct, type InboundRow } from "./production-inbound";

// 자체 재고원장(inventory_txns) 현재고 + B2B 발주(생산대기·생산중) 수요를 SKU 기준으로 머지.
//  /api/production/inventory 와 생산 조언이 공유 — 숫자 일관성 유지.
//  (2026-06 박스히어로 API 의존 제거 → 현재고·판매속도 모두 자체 원장 기준.)
//
// 목표(안전재고) = 최근 하루 평균 출고량(원장 '출고') × 목표 일수. 목표 일수는 생산 일정에서 나온다
//  (production-schedule scheduleHorizon — 오늘 → 다음 요청일(수요일) 요청분 판매 가능일, 수요일 21일 → 화요일 15일).
//  오늘 시킨 물량이 판매 가능일(D+10 영업일)에 오고, 그 뒤는 다음 요청분이 올 때까지 버텨야 하므로 두 구간을 다 덮는다.
//  부족·요청 마감은 '오늘 요청분 판매 가능일까지'(보통 14일) 기준 — 지금 시켜도 그 전에 바닥나는가.
// 권장 생산량 = max(0, 수요 + 안전재고 − (현재고 + 입고 예정)) — '입고 예정'은 열린 제조사 요청서의 잔여
//  (production-inbound). 시켜 둔 물량을 또 시키던 이중 발주의 차단 항(2026-09-17 대표 확정 1단계).

export interface InvRow {
  sku: string;
  name: string;
  stock: number | null;   // 현재고 (null = 원장에 거래내역 없음)
  dailyOut: number;       // 행사 제거한 평상시 하루 평균 출고량
  rawDailyOut: number;    // 보정 전 원 출고 일평균(참고)
  autoSafety: number;     // 자동 목표 = ceil(dailyOut × horizonDays)
  promoQty: number;       // 앞으로 올 행사 예상판매(표시·참고용) — 목표에는 더하지 않는다(결정 9)
  adjust: number;         // 추가 확보(만료 반영된 유효 delta)
  adjustRaw: number;      // 저장된 추가확보값(만료 무관 — 편집용)
  adjustExcludeRaw: number; // 저장된 '행사 출고 빼기' 양(만료 무관 — 편집용)
  adjustMemo: string;     // 보정 사유
  adjustUntil: string | null; // 보정 만료일
  safety: number;         // 최종 목표 = max(0, autoSafety + adjust). 행사 가산은 빠졌다(결정 9)
  leadSafety: number;     // 부족 기준 = max(0, ceil(dailyOut × leadDays) + adjust) — 오늘 요청분 판매 가능일까지 버틸 양
  recommendGross: number; // 입고 예정 차감 전 권장(= max(0, 수요+목표−현재고)) — 전체 탭이 합계에서 ⑤를 한 번만 빼는 데 쓴다
  demand: number;         // B2B 생산대기·생산중 수요
  inbound: number;        // 입고 예정 = 열린 제조사 요청서 잔여(소매·전체 수식만, 도매 수식은 0)
  inboundDue: string | null;    // 잔여가 있는 요청서 중 가장 이른 마감
  inboundOverdue: number;       // 그중 마감이 지난 잔여(자동 제외 없음 — 표시용)
  recommend: number;      // 권장 생산량 = max(0, 수요 + 안전재고 − (현재고 + 입고 예정))
  belowSafety: boolean;   // 현재고 + 입고 예정 < 부족 기준(leadSafety) — 지금 시켜도 판매 가능일 전에 바닥날 위험(권장 > 0 을 함축)
  requestByDays: number | null; // 생산요청 마감까지 남은 일수(0·음수=지금/이미 늦음). 출고0·재고없음이면 null
  requestBy: string | null;     // 생산요청 마감일(YYYY-MM-DD, 미래일 때만). 현재고+입고 예정이 부족 기준으로 떨어지는 날
  inBoxhero: boolean;
  inB2B: boolean;
}

export interface InventoryResult {
  rows: InvRow[];
  itemCount: number;
  noSkuDemand: number;
  leadDays: number;          // 오늘 → 오늘 요청분 판매 가능일(달력 일수) — 부족 기준
  cycleDays: number;         // 오늘 요청분 판매 가능일 → 다음 요청분 판매 가능일
  horizonDays: number;       // 목표 일수 = 오늘 → 다음 요청분 판매 가능일
  schedule: ScheduleHorizon; // 위 일수의 근거 날짜(계산일·판매 가능일·다음 요청일) — 화면·메모 표시용
  inboundOk: boolean;        // 입고 예정 집계 성공 여부 — false 면 권장이 실제보다 클 수 있다(화면이 경고)
  velocitySpanDays: number;  // 출고 평균이 커버한 일수
  velocityCapped: boolean;   // 표본 상한에 걸려 일부만 집계했는지
}

// channel 미지정 = 전체 재고·레거시 속도(기존 소비처 호환). "소매"/"도매" = 그 채널의 재고·소진 속도만.
//  도매 조언 수식 = 소매와 동일 구조(목표 = 하루 소진 × 목표 일수)를 도매 데이터로 계산.
//  단 행사(프로모션)·수동 보정은 소매 판매 보정 장치라 도매 채널에는 적용하지 않는다(순수 수식).
export async function getInventoryRows(channel?: "소매" | "도매"): Promise<InventoryResult> {
  const sb = supabaseAdmin();

  // 1) 자체 원장 현재고(품목당 1행 집계) + 제품표(sku·name) — 박스히어로 API 대신.
  const stockRpc = async () => {
    if (channel) {
      const r = await sb.rpc("inventory_stock", { asof: null, chan: channel });
      // 036 미적용(chan 시그니처 없음 = PGRST202)만 전 칸 합으로 폴백. 일시 오류는 그대로 돌려 아래서 던진다 —
      //  모든 오류에서 폴백하면 그 칸 재고에 4칸 합이 조용히 들어가 권장이 대폭 과소(#11)
      if (!r.error || r.error.code !== "PGRST202") return r;
    }
    return sb.rpc("inventory_stock", { asof: null });
  };
  // 전체(채널 미지정 = 생산 일정 item-stats)는 chan null = 4칸 합. 확보분(프로모션·도매 대량)은 가용 재고가
  //  아니다(기획 4절) — 목표에서 행사 가산을 뗐으므로 풀도 함께 빼야 짝이 맞는다(기획 9-3 표 '과소' 행, #12).
  //  결과 = 소매 + 도매. chan 시그니처 없음(PGRST202)이면 칸 자체가 없으니 뺄 것도 없다.
  const reservedRpc = async () => {
    if (channel) return [] as { product_id: string; qty: number }[];
    const rs = await Promise.all(RESERVED_CHANNELS.map((c) => sb.rpc("inventory_stock", { asof: null, chan: c })));
    const out: { product_id: string; qty: number }[] = [];
    for (const r of rs) {
      if (r.error) { if (isMissingSchemaError(r.error)) continue; throw r.error; }
      out.push(...((r.data as { product_id: string; qty: number }[] | null) ?? []));
    }
    return out;
  };
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST
  // 입고 예정 — 제조사 생산 입고는 소매 채널로 들어오므로 소매·전체 수식에서만 뺀다.
  //  도매 수식의 부족은 소매→도매 이동으로 채워지는 몫이라 제조사 잔여를 빼면 이중 차감이 된다.
  //  가장 무거운 원장 속도 조회와 나란히 돌려 지연을 숨긴다.
  const [stockRes, prodRes, velocity, inboundByProduct, reservedRows] = await Promise.all([
    stockRpc(),
    sb.from("products").select("id, sku, name"), // 전 품목(수요 매칭은 비활성 포함)
    getLedgerVelocity(undefined, channel), // 1b) 소진 속도(최근 출고 일평균) — 채널별
    channel === "도매" ? Promise.resolve(new Map<string, InboundRow>()) : getOpenInboundByProduct(sb, today),
    reservedRpc(), // 전체 조회에서만 확보분 칸(프로모션·도매 대량) 차감용
  ]);
  const inboundOk = inboundByProduct !== null;
  if (stockRes.error) throw stockRes.error;
  if (prodRes.error) throw prodRes.error;

  const stockByProduct = new Map<string, number>();
  for (const t of (stockRes.data as { product_id: string; qty: number }[] | null) ?? []) stockByProduct.set(t.product_id, Number(t.qty) || 0);
  // 4칸 합 − 확보분(프로모션·도매 대량) = 소매 + 도매 (#12). 원장에 없는 품목은 건너뜀(키 추가 안 함)
  for (const t of reservedRows) {
    if (stockByProduct.has(t.product_id)) stockByProduct.set(t.product_id, (stockByProduct.get(t.product_id) || 0) - (Number(t.qty) || 0));
  }
  // 프로모션 풀은 소매 보유에 더하지 않는다(4단계·기획 결정 9·10). 행사는 이제 주간 요청서가 세지
  //  않으므로(결정 7·8) 목표에서 행사 가산도 함께 뺐다 — 둘은 짝이라 한쪽만 떼면 과잉·과소로 어긋난다.
  //  소매 = 평상시 수요 대 평상시 재고. 확보분은 자기 칸에 서고 생산은 제조사와 협의한다.
  // SKU(대문자) → {name, stock}. 원장에 거래내역이 있는(=inventory_stock 에 잡히는) 제품만 현재고 보유.
  const stockBySku = new Map<string, { name: string; stock: number }>();
  for (const p of prodRes.data ?? []) {
    if (p.sku && stockByProduct.has(p.id)) stockBySku.set(String(p.sku).toUpperCase(), { name: p.name, stock: stockByProduct.get(p.id) || 0 });
  }

  // 1c) 목표 보정: 일정 기반 목표 일수 + 프로모션(스파이크 제거 + 남은 행사분) + 수동 보정
  const span = Math.max(1, velocity.spanDays);
  const wsD = new Date(today + "T00:00:00Z");
  wsD.setUTCDate(wsD.getUTCDate() - span); // 판매속도 집계창 시작(근사)
  const windowStart = wsD.toISOString().slice(0, 10);
  const sched = scheduleHorizon(today); // 생산 일정(D+10 판매 가능, 매주 수요일 요청)에서 목표·부족 기준 일수
  const { leadDays, cycleDays, horizonDays } = sched;
  const wholesale = channel === "도매"; // 행사·수동 보정은 소매 판매 장치 — 도매 수식에는 미적용
  const [promoForward, promoSold, adjusts] = wholesale
    ? [{} as Record<string, number>, {} as Record<string, number>, {} as Awaited<ReturnType<typeof getSafetyAdjusts>>]
    : await Promise.all([
        getPromoForwardBySku(today, horizonDays),  // 앞으로 확보할 남은 행사분(목표 일수 안) — 표시용
        getPromoSoldInWindow(windowStart, today),  // 집계창에 이미 나간 행사분(속도에서 제거)
        getSafetyAdjusts(),
      ]);
  // 2) 제품표: product_id → sku / name (위에서 받은 prodRes 재사용)
  const skuByProduct = new Map<string, string>();
  const nameBySku = new Map<string, string>();
  for (const p of prodRes.data ?? []) {
    if (p.sku) {
      skuByProduct.set(p.id, p.sku);
      const k = String(p.sku).toUpperCase();
      if (!nameBySku.has(k)) nameBySku.set(k, p.name);
    }
  }

  // 3) B2B 수요: 생산대기·생산중 발주 라인아이템 합 (SKU 기준).
  //  재고 생산을 별도 운영하면(플래그 off) B2B 수요는 재고 조언 계산에서 제외.
  const { data: orders, error: oErr } = LINK_B2B_ORDERS_TO_PRODUCTION
    ? await sb.from("orders").select("id, production_status, order_items(product_id, qty)").in("production_status", ["생산대기", "생산중"])
    : { data: [] as unknown, error: null };
  if (oErr) throw oErr;

  // 입고 예정을 SKU 로 합산(중복 SKU 는 수요와 같은 규칙으로 합쳐진다)
  const inboundBySku = new Map<string, { qty: number; due: string | null; overdue: number }>();
  for (const [pid, row] of inboundByProduct ?? new Map<string, InboundRow>()) {
    const sku = skuByProduct.get(pid);
    if (!sku) continue;
    const k = sku.toUpperCase();
    const cur = inboundBySku.get(k) ?? { qty: 0, due: null, overdue: 0 };
    cur.qty = Math.round((cur.qty + row.qty) * 100) / 100;
    cur.overdue = Math.round((cur.overdue + row.overdue_qty) * 100) / 100;
    if (row.earliest_due && (!cur.due || row.earliest_due < cur.due)) cur.due = row.earliest_due;
    inboundBySku.set(k, cur);
  }

  const demandBySku = new Map<string, number>();
  let noSkuDemand = 0;
  type OItem = { product_id: string | null; qty: number };
  for (const o of (orders ?? []) as unknown as { order_items: OItem[] }[]) {
    for (const it of o.order_items ?? []) {
      const sku = it.product_id ? skuByProduct.get(it.product_id) : null;
      const qty = Number(it.qty) || 0;
      if (sku) {
        const k = sku.toUpperCase();
        demandBySku.set(k, (demandBySku.get(k) || 0) + qty);
      } else {
        noSkuDemand += qty;
      }
    }
  }

  // 4) SKU 합집합으로 행 구성 — 입고 예정만 있는 품목(소매 원장이 아직 없는 도매 전용 품목 등)도 넣는다.
  //  빠지면 전체·소매 권장과 요청 창·AI 초안이 그 품목의 입고 예정을 못 빼 같은 물량을 또 시킨다(최종 점검 확정).
  //  이런 행은 현재고 null → 권장 = 수요, 입고 예정만 실린다(도매 채널은 입고 예정 맵이 비어 영향 없음).
  const allSkus = new Set<string>([...stockBySku.keys(), ...demandBySku.keys(), ...inboundBySku.keys()]);
  const rows: InvRow[] = [];
  for (const sku of allSkus) {
    const st = stockBySku.get(sku);
    const demand = demandBySku.get(sku) || 0;
    const stock = st ? st.stock : null;
    const rawDailyOut = velocity.perSku[sku] || 0;
    const adj = adjusts[sku];
    const manualExclude = effectiveExclude(adj, today); // 사용자가 '행사 출고'로 빼라고 한 양
    const dailyOut = Math.max(0, rawDailyOut - (promoSold[sku] || 0) / span - manualExclude / span); // 행사·수동행사 제거한 평상시 일평균
    const autoSafety = Math.ceil(dailyOut * horizonDays);
    const promoQty = Math.round(promoForward[sku] || 0); // 표시용(참고) — 목표에는 더하지 않는다
    const adjust = effectiveDelta(adj, today);
    const safety = Math.max(0, autoSafety + adjust); // 최종 목표 = 평상시 수요(+ 남은 수동 보정)
    const leadSafety = Math.max(0, Math.ceil(dailyOut * leadDays) + adjust); // 부족 기준(오늘 요청분 판매 가능일까지)
    const inb = inboundBySku.get(sku);
    const inbound = inb?.qty ?? 0;
    // 권장 = 수요 + 안전재고 − (현재고 + 입고 예정). 시켜 둔 물량(입고 예정)이 도착해 현재고로 옮겨 가도 합은 그대로라
    //  권장이 튀지 않는다(불변식). 원장 기록이 없는 품목은 종전대로 수요만.
    const recommend = stock == null ? demand : Math.max(0, demand + safety - (stock + inbound));
    // 전체 탭 합산용 원값 — 입고 예정(⑤)을 항 안에서 빼면 합산 때 max(0,①−⑤)+max(0,②)가 되어
    //  소매가 넉넉한 주에 차감분이 통째로 소실된다(기획 14절 여덟 번째). ⑤는 합계에서 한 번만 뺀다.
    const recommendGross = stock == null ? demand : Math.max(0, demand + safety - stock);
    // 부족 = 현재고+입고 예정이 '오늘 요청분 판매 가능일까지 버틸 양'보다 적다. 목표(다음 요청분까지)보다 작은 기준이라
    //  부족이면 권장은 늘 0 보다 크다. 목표 기준으로 두면 매주 정상 보충 품목까지 거의 늘 부족으로 뜬다.
    const belowSafety = stock != null && stock + inbound < leadSafety;

    // 생산요청 마감일 = 현재고+입고 예정이 부족 기준으로 떨어지는 날. 이 날을 넘겨 요청하면 판매 가능일 전에 바닥난다.
    let requestByDays: number | null = null;
    let requestBy: string | null = null;
    if (stock != null && dailyOut > 0) {
      requestByDays = Math.floor((stock + inbound - leadSafety) / dailyOut);
      if (requestByDays > 0) {
        const rd = new Date(today + "T00:00:00Z");
        rd.setUTCDate(rd.getUTCDate() + requestByDays);
        requestBy = rd.toISOString().slice(0, 10);
      }
    }
    rows.push({
      sku,
      name: st?.name || nameBySku.get(sku) || sku,
      stock,
      dailyOut,
      rawDailyOut,
      autoSafety,
      promoQty,
      adjust,
      adjustRaw: Math.round(Number(adj?.delta) || 0),
      adjustExcludeRaw: Math.max(0, Math.round(Number(adj?.excludeOut) || 0)),
      adjustMemo: adj?.memo || "",
      adjustUntil: adj?.until || null,
      safety,
      leadSafety,
      demand,
      recommendGross,
      inbound,
      inboundDue: inb?.due ?? null,
      inboundOverdue: inb?.overdue ?? 0,
      recommend,
      belowSafety,
      requestByDays,
      requestBy,
      inBoxhero: !!st,
      inB2B: demand > 0,
    });
  }
  rows.sort((a, b) => b.recommend - a.recommend || Number(b.belowSafety) - Number(a.belowSafety) || a.sku.localeCompare(b.sku));

  return {
    rows,
    itemCount: stockBySku.size,
    noSkuDemand,
    leadDays,
    cycleDays,
    horizonDays,
    schedule: sched,
    inboundOk,
    velocitySpanDays: velocity.spanDays,
    velocityCapped: velocity.capped,
  };
}
