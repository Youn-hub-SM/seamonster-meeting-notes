import type { supabaseAdmin } from "./supabase";

// '재고 관리 사용 안함' 상품(products.stock_tracked=false, migration 121) — 드라이아이스·이벤트 상품 등.
//  재고 화면(목록·입출고·조정·양식·이동·대사·생산 권장)에서 빼고, 자동 출고 원장(온라인 출고·B2B 발송 선점)도 남기지 않는다.
//  판매·B2B 발주·택배·송장 스캔은 그대로 — products.active('미사용')와 다른 축이다.
//
// 조회 실패·121 미적용이면 빈 집합(= 오늘과 같은 동작)을 돌려준다. 절대 던지지 않는다 —
//  이 조회 하나 때문에 발주 저장·온라인 출고가 멈추면 안 된다. 대상은 몇 개뿐이라 페이지 나눔 없이 한 번에 읽는다.

type Sb = ReturnType<typeof supabaseAdmin>;
export type Untracked = { ids: Set<string>; skus: Set<string> }; // skus = trim().toUpperCase()

export const EMPTY_UNTRACKED = (): Untracked => ({ ids: new Set(), skus: new Set() });

export async function getUntracked(sb: Sb): Promise<Untracked> {
  try {
    const { data, error } = await sb.from("products").select("id, sku").eq("stock_tracked", false);
    if (error) {
      if (!/stock_tracked/i.test(error.message || "")) console.warn("[stock-tracked] 조회 실패 — 제외 없이 진행:", error.message);
      return EMPTY_UNTRACKED();
    }
    const u = EMPTY_UNTRACKED();
    for (const p of (data ?? []) as { id: string; sku: string | null }[]) {
      u.ids.add(p.id);
      if (p.sku) u.skus.add(String(p.sku).trim().toUpperCase());
    }
    return u;
  } catch (e) {
    console.warn("[stock-tracked] 조회 예외 — 제외 없이 진행:", e);
    return EMPTY_UNTRACKED();
  }
}

// product_id → 수량 맵에서 재고 관리 안 함 품목을 뺀다(제자리). 묶음 전개(expandBundleQty) 뒤의 구성품 맵에만 쓴다 —
//  이벤트 세트(부모)가 재고 관리 안 함이어도 그 안의 관리 대상 구성품은 계속 빠져야 한다.
export function dropUntracked<T>(m: Map<string, T>, u: Untracked): Map<string, T> {
  if (u.ids.size) for (const id of u.ids) m.delete(id);
  return m;
}
