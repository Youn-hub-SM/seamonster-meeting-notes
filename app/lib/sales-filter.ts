// 주문검색·엑셀추출 공용 — 사용자 입력을 '리터럴 부분검색'으로 안전하게 PostgREST or(ilike) 필터로 변환.
//  방어: (1) 따옴표로 감싸 콤마·괄호·점이 or() 구분자로 해석되지 않게 (2) 내부 \" 이스케이프
//        (3) LIKE 와일드카드(% _)와 PostgREST 와일드카드(*)를 공백으로 무력화 → 의도치 않은 광범위 매칭 차단.
export function salesOrIlike(text: string): string | null {
  const v = (text || "").slice(0, 100).replace(/[\\"]/g, (m) => "\\" + m).replace(/[%_*]/g, " ").trim();
  if (!v) return null;
  const pat = `%${v}%`;
  return `product_name.ilike."${pat}",sku_code.ilike."${pat}",order_id.ilike."${pat}"`;
}
