// 입고 → 요청서 연결 결과를 한 문장으로(입고 화면 알림용). 서버 LinkResult 와 같은 모양.
export type LinkResultLite = {
  ok: boolean;
  reason?: string;
  req_no?: string;
  status?: string;
  lines: { product_id: string; qty: number; over: number; unrequested: boolean }[];
};

export function formatLinkResult(link: LinkResultLite, nameOf: (productId: string) => string): string {
  if (!link.ok) return `요청서에 연결되지 않았습니다 — ${link.reason || "원인 불명"}`;
  if (!link.lines.length) return `${link.req_no || "요청서"}에 새로 연결된 품목이 없습니다.`;
  const parts = link.lines.map((l) => {
    const n = nameOf(l.product_id);
    if (l.unrequested) return `${n} ${l.qty.toLocaleString()} (요청서에 없음)`;
    return l.over > 0 ? `${n} ${l.qty.toLocaleString()} (초과 ${l.over.toLocaleString()})` : `${n} ${l.qty.toLocaleString()}`;
  });
  const tail = link.status === "완료" ? " — 전량 입고, 요청서 마감됨" : "";
  return `${link.req_no || "요청서"}에 연결: ${parts.join(", ")}${tail}`;
}
