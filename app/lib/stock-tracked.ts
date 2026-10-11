import type { supabaseAdmin } from "./supabase";

// '재고 관리 사용 안함' 상품(products.stock_tracked=false, migration 121) — 드라이아이스·이벤트 상품 등.
//  재고 화면(목록·입출고·조정·양식·이동·대사·생산 권장)에서 빼고, 자동 출고 원장(온라인 출고·B2B 발송 선점)도 남기지 않는다.
//  판매·B2B 발주·택배·송장 스캔은 그대로 — products.active('미사용')와 다른 축이다.
//
// 읽기 실패 = 멈춤(S4, 2026-10-11). 조회 오류를 빈 집합으로 삼키면 그 순간 재고 관리 안 함 품목(드라이아이스 등)이
//  온라인 출고·B2B 선점·엑셀 반영에서 차감되고, 실사 양식·대사·권장에 섞인다 — 그래서 오류는 던진다.
//  빈 집합은 121 미적용(컬럼 없음)일 때만 — 그때는 '재고 관리 안 함' 품목이 있을 수 없다.
//  대상은 몇 개뿐이지만 1,000행 상한에 잘린 채 '전부 읽었다'고 보지 않도록 id 순으로 끝까지 읽는다.

type Sb = ReturnType<typeof supabaseAdmin>;
export type Untracked = { ids: Set<string>; skus: Set<string> }; // skus = trim().toUpperCase()

export const EMPTY_UNTRACKED = (): Untracked => ({ ids: new Set(), skus: new Set() });

// 121 미적용(stock_tracked 컬럼 없음) 오류인가 — 메시지에 컬럼 이름이 보일 때만(재연결 중 일시 오류 등은 아니다)
const missing121 = (e: { code?: string; message?: string }) => {
  const msg = e.message || "";
  return /stock_tracked/i.test(msg)
    && (e.code === "42703" || e.code === "PGRST204" || /does not exist|could not find|schema cache/i.test(msg));
};

export async function getUntracked(sb: Sb): Promise<Untracked> {
  const u = EMPTY_UNTRACKED();
  for (let from = 0; from < 1_000_000; from += 1000) {
    const { data, error } = await sb.from("products").select("id, sku").eq("stock_tracked", false)
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) {
      if (missing121(error)) return EMPTY_UNTRACKED(); // 121 미적용 — 제외할 품목 자체가 없다
      throw new Error(`'재고 관리 사용 안함' 품목을 읽지 못했습니다 — 다시 시도하세요. (${error.message})`);
    }
    const rows = (data ?? []) as { id: string; sku: string | null }[];
    for (const p of rows) {
      u.ids.add(p.id);
      if (p.sku) u.skus.add(String(p.sku).trim().toUpperCase());
    }
    if (rows.length < 1000) return u;
  }
  throw new Error("'재고 관리 사용 안함' 품목이 너무 많아 읽지 못했습니다.");
}

// product_id → 수량 맵에서 재고 관리 안 함 품목을 뺀다(제자리). 묶음 전개(expandBundleQty) 뒤의 구성품 맵에만 쓴다 —
//  이벤트 세트(부모)가 재고 관리 안 함이어도 그 안의 관리 대상 구성품은 계속 빠져야 한다.
export function dropUntracked<T>(m: Map<string, T>, u: Untracked): Map<string, T> {
  if (u.ids.size) for (const id of u.ids) m.delete(id);
  return m;
}
