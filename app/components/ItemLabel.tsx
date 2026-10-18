// 품목 한 줄(화면용) — '상품명 · 규격 ×수량' 한 가지 꼴. 2026-10-17 디자인 3차: 품목명은 이 도구의 '얼굴'이라 화면마다 조합이 다르면 안 된다.
//  상품명 검정, 규격 회색(sm-faint), 수량 중간 회색(sm-muted). 문자열이 필요한 자리(툴팁·option)는 app/lib/format 의 itemText.
//  SKU 를 같이 보여야 하는 화면은 sku 를 넘기면 규격 뒤 괄호로 붙는다.
export default function ItemLabel({ name, spec, qty, sku, unit }: { name: string; spec?: string | null; qty?: number | null; sku?: string | null; unit?: string }) {
  const q = qty == null ? null : Number.isInteger(qty) ? qty.toLocaleString() : qty.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return (
    <span className="sm-nowrap">
      {name}
      {spec ? <span className="sm-faint"> · {spec}</span> : null}
      {sku ? <span className="sm-faint"> ({sku})</span> : null}
      {q != null ? <span className="sm-muted"> ×{q}{unit ?? ""}</span> : null}
    </span>
  );
}
