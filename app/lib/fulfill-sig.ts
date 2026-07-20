import { createHash } from "node:crypto";

// 온라인 발주 공용 서명 — 서버 전용(node:crypto). 클라이언트에서 import 금지.

// 출고 배치 서명: SKU별 '합산' 수량 기준. generate(파일 분석)와 dispatch(출고)가 같은 산식을 써서
//  '이 파일 = 이 출고 배치'를 잇는 열쇠가 된다.
export function itemsSig(items: { sku: string; qty: number }[]): string {
  const merged = new Map<string, number>();
  for (const i of items) { const k = i.sku.trim().toUpperCase(); merged.set(k, (merged.get(k) || 0) + Math.round(i.qty)); }
  const norm = [...merged.entries()].map(([k, q]) => `${k}:${q}`).sort().join("|");
  return createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

// 주문번호 키 — 개인정보 없이 주문번호만 해시. 이미 처리된 주문 필터의 단위.
export function orderKey(orderNo: string): string {
  return createHash("sha1").update(orderNo.trim()).digest("hex").slice(0, 16);
}
