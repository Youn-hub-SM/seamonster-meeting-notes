import type { supabaseAdmin } from "./supabase";
import { computeTally, type TallyRow } from "./fulfill-scan";
import { readStockMap } from "./inventory-template";
import { getUntracked } from "./stock-tracked";
import { kstToday } from "./fulfill-db";

// 송장 스캔 피킹 리스트의 '부족량' — 소매 재고만 본다(2026-11-25 대표).
//  읽기만 한다. 스캔은 재고를 빼지도 넣지도 않는다(재고는 발주처리 ④ [출고 완료]가 뺀다).
//  순서가 ④ 출고 완료 → 스캔 → 포장이라, 스캔할 때의 소매 재고는 이 주문들이 이미 빠진 숫자다.
//  그래서 소매 재고가 0 아래면 그만큼이 모자란 것이다: 부족량 = 0 아래로 내려간 수량(이번에 가져갈 수량까지만).
//  도매·프로모션·도매 대량 칸은 보지 않는다. 세트는 집계가 이미 구성품으로 풀어 준다(S5).
//  '재고 관리 사용 안함'(121) 품목과 상품마스터에 없는 코드는 표시하지 않는다.

type Sb = ReturnType<typeof supabaseAdmin>;
export type ScanShort = { key: string; qty: number };
export type ScanStock = {
  tally: TallyRow[]; scannedCount: number; totalUnits: number;
  checked: boolean;    // false = 재고를 읽지 못했다 — '부족 없음'이 아니다(S4). 인쇄물과 화면이 그렇게 알린다
  reason?: string;
  short: ScanShort[];  // key = 집계 줄의 key(품목 id)
};

export async function computeScanStock(sb: Sb): Promise<ScanStock> {
  const base = await computeTally(sb);
  if (base.tally.length === 0) return { ...base, checked: true, short: [] };
  try {
    // 오늘(KST)까지의 소매 재고 — 공용 readStockMap(inventory_stock RPC 를 끝 쪽까지, S1·S4)
    const [stock, untracked] = await Promise.all([readStockMap(sb, { asof: kstToday(), chan: "소매" }), getUntracked(sb)]);
    const short: ScanShort[] = [];
    for (const t of base.tally) {
      if (t.unknown || untracked.ids.has(t.key)) continue;
      const lack = Math.min(t.qty, Math.max(0, -(stock.get(t.key) ?? 0)));
      if (lack > 0) short.push({ key: t.key, qty: lack });
    }
    return { ...base, checked: true, short };
  } catch (e) {
    return { ...base, checked: false, reason: e instanceof Error ? e.message : "재고 조회 실패", short: [] };
  }
}
