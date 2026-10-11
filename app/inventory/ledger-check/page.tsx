"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

// 원장 점검(대표 결정 D4d) — 장부 이상을 종류별로 모아 사람이 확인·처리한다. 화면은 읽기만 하고 고치지 않는다(S12).
//  판정은 /api/inventory/ledger-check → inventory_ledger_check RPC(132) 한 곳(B2B 매출 원장 대조만 reconcileB2BSales).
//  확인하지 못한 항목(마이그레이션 미적용·조회 실패)은 0건이 아니라 '확인 못 함'으로 보인다(S4).

type Item = {
  ref_id: string | null; ref_no: string | null; partner: string | null;
  product_id: string | null; product_name: string | null; sku: string | null; channel: string | null;
  qty: number | null; txn_date: string | null; detail: string | null;
  tags?: string[]; // 처리 안내를 고르는 표식(132) — live·counted·multi·dup·old·covered·finished·deleted·b2b·backfill
};
type Group = { kind: string; count: number; items: Item[]; unavailable?: string; error?: string };

type Fix = { href: string; label: string };
// 처리 안내 한 줄 — when 이 있으면 그 경우의 행이 있을 때만 보인다(행 표시 상한에 잘렸으면 전부 보인다)
type Line = string | { when: (r: Item) => boolean; text: string; fix?: Fix };
type Area = "재고" | "입고" | "매출";
//  view: order = 발주 단위(발주번호 링크), product = 품목 단위, ref = 출고 배치·요청서·채널 단위
type Meta = { label: string; view: "order" | "product" | "ref"; area: Area; guide: Line[]; fix?: Fix };
const TRADE = { href: "/inventory/trade", label: "입고 및 출고" };
const MOVE = { href: "/inventory/move", label: "재고 이동" };
const ADJUST = { href: "/inventory/adjust", label: "재고 조정" };
const PRODUCTS = { href: "/b2b/products", label: "상품 목록" };
const ORDERS = { href: "/b2b/orders", label: "발주" };
const FULFILL = { href: "/fulfill", label: "발주처리" };
const PRODUCTION = { href: "/production/request", label: "생산 요청" };
const QUOTE = { href: "/inventory/quote", label: "월간매입 결산" };
const SALES_REPORT = { href: "/b2b/reports", label: "매출 집계" };
const SALES_UPLOAD = { href: "/sales/upload", label: "데이터 업로드" };
const tagged = (t: string) => (r: Item) => (r.tags ?? []).includes(t);
const notTagged = (t: string) => (r: Item) => !(r.tags ?? []).includes(t);
const isWholesale = (r: Item) => r.channel === "도매" || r.channel === "도매 대량";
// 차감일 뒤 실사(S12) — 그 실사가 이미 차감·복구를 대신했을 수 있어 재저장이 두 번 반영한다. 사람이 판단한다.
const COUNTED_DEDUCT: Line = { when: tagged("counted"), fix: ADJUST,
  text: "'발송일 뒤 실사 있음': 실사 때 그 물건이 이미 나가고 없었다면 다시 저장하면 두 번 빠집니다 — 저장한 뒤 같은 수량을 [재고 조정]으로 되돌리세요" };
// 처리 = 수동 절차(docs/ledger-standard.md §3) — 화면의 실제 버튼·메뉴 이름 그대로. 표시 순서 = 이 객체의 순서
const META: Record<string, Meta> = {
  b2b_overdue: { label: "발송일 지난 발송대기", view: "order", area: "재고", fix: ORDERS,
    guide: ["나갔으면 발송완료로 바꾸고 실제 발송일 입력, 안 나갔으면 발송일 칸에서 날짜를 다시 잡기 — 재고 실사 전에 먼저 정리"] },
  b2b_cancelled: { label: "취소에 남은 B2B 선점", view: "order", area: "재고", fix: ORDERS,
    guide: [
      // 옛 발주 취소는 헤더만 바꿔 차수가 살아 있다 — [수정] 재저장은 선점을 다시 쓰고, 복수 발송이면 발주를 '발송대기'로 되살린다
      { when: tagged("live"),
        text: "'살아 있는 차수': [수정]으로 저장하지 마세요(발주가 다시 살아납니다) — 발주 목록에서 상태를 '발송대기'로 되돌린 뒤 다시 '취소'(복수 발송은 체크 후 '상태 일괄 변경')" },
      { when: (r) => !tagged("live")(r), text: "그 밖: 발주를 열어 [수정]으로 다시 저장하면 선점이 지워집니다" },
      "실제로 나갔는데 안 돌아온 물건이면: 그 발주(복수 발송은 차수)를 '발송완료'(실제 발송일)로 되돌린 뒤 다시 '취소' → '안 돌아옴'",
      { when: tagged("counted"), fix: ADJUST,
        text: "'발송일 뒤 실사 있음': 실사 때 그 물건이 창고에 있었다면 선점을 지우면 두 번 되살아납니다 — 정리한 뒤 같은 수량을 [재고 조정]으로 빼세요" },
    ] },
  b2b_no_deduct: { label: "선점이 없는 B2B 발주", view: "order", area: "재고", fix: ORDERS,
    guide: ["발주를 열어 발송일을 확인하고 [수정]으로 다시 저장 · 2026-08-05 이후 발주만", COUNTED_DEDUCT] },
  b2b_stock_off: { label: "재고 차감이 꺼진 B2B 차수", view: "order", area: "재고", fix: ORDERS,
    guide: ["발주를 열어 [수정]으로 다시 저장하면 차감이 켜지고 선점이 다시 기록됩니다 · 2026-08-05 이후 발주만", COUNTED_DEDUCT] },
  b2b_qty_mismatch: { label: "선점 수량·칸이 발주와 다름", view: "order", area: "재고", fix: ORDERS,
    guide: [
      { when: notTagged("dup"), text: "발주를 열어 [수정]으로 다시 저장하면 발주 전량(취소 차수 뺌)으로 다시 기록됩니다 · 수량 = 기대 − 선점(양수면 덜 빠짐)" },
      // [수정] 재저장은 DB 차수를 그대로 다시 저장한다 — 두 벌인 차수·넘친 배분이 남아 다른 항목이 계속 뜬다
      { when: tagged("dup"),
        text: "'차수 두 벌'·'배분 초과': [수정] 대신 발주 목록의 발송일 칸에서 겹친(안 나간) 차수를 ✕로 지우거나 차수별 수량을 발주 수량 안으로 고친 뒤 [저장] — 선점이 발주 전량 한 번으로 다시 기록됩니다" },
      { when: tagged("counted"), fix: ADJUST,
        text: "'발송일 뒤 실사 있음': 실사가 이미 그 차이를 맞췄을 수 있습니다 — 다시 저장하면 두 번 반영되니 저장한 뒤 차이만큼 [재고 조정]으로 되돌리세요" },
    ] },
  b2b_date_mismatch: { label: "선점 날짜가 첫 발송일과 다름", view: "order", area: "재고", fix: ORDERS,
    guide: [
      // 차수별로 빠진 옛 분할 발주(2026-07-31 전)도 여기 — 정상 차수를 지우게 하지 않는다. 'multi' = 이중 선점 증거가 있을 때만(132)
      { when: notTagged("multi"), text: "발주를 열어 [수정]으로 다시 저장하면 첫 발송일 하루로 다시 기록됩니다(차수마다 빠졌던 옛 분할 발주도 합쳐짐 · 재고 총량 그대로)" },
      { when: tagged("multi"),
        text: "'차수 두 벌'·'선점이 기대보다 많음': 두 저장이 겹쳐 선점이 두 벌입니다 — [수정] 대신 발주 목록의 발송일 칸에서 겹친(안 나간) 차수를 ✕로 지우고 [저장] · 겹친 차수가 없으면 차수별 수량을 발주 수량 안으로 고친 뒤 [저장]" },
    ] },
  b2b_dup_shipment: { label: "차수가 두 벌인 발주", view: "order", area: "재고", fix: ORDERS,
    guide: ["발주 목록의 발송일 칸에서 겹친(안 나간) 차수를 ✕로 지우고 [저장] — 선점이 발주 전량 한 번으로 다시 기록됩니다 · 발송완료 차수는 지우지 마세요"] },
  b2b_over_alloc: { label: "배분이 발주 수량보다 많은 발주", view: "order", area: "재고", fix: ORDERS,
    guide: ["발주 목록의 발송일 칸에서 차수별 수량을 발주 수량 안으로 고치거나 겹친 차수를 지운 뒤 [저장] — 그 전에는 저장이 막힙니다"] },
  b2b_unlinked_line: { label: "재고와 연결 안 된 발주 라인", view: "order", area: "재고", fix: ORDERS,
    guide: ["재고 품목이면 발주를 열어 품목칸에서 목록 상품을 다시 고른 뒤 [수정] · 배송비 같은 비재고 줄은 그대로 두기 · 2026-08-05 이후·최근 60일 발주만"] },
  b2b_kept_orphan: { label: "주인 없는 '출고 유지' 기록", view: "order", area: "재고", fix: TRADE,
    guide: ["발주가 지워졌거나 발송한 취소 차수가 없어 발주 복구로 정리되지 않는 출고입니다 — 물건이 정말 안 돌아왔으면 그대로 두고, 돌아왔으면 [입고 및 출고]에서 사유 '고객 반품'으로 입고"] },
  fulfill_interrupted: { label: "중단된 온라인 출고", view: "ref", area: "재고",
    guide: [
      // 'finished'(132 v5) = 대기 키 없음 + 그 배치 처리완료 키 있음 — ④는 끝났고 재고만 나중에 지워졌다(대개 옛 화면 묶음 취소).
      //  generate 는 대기 키로만 이어받기를 판정해 중복 확인 기간 안에는 그 주문을 처리됨으로 빼고(400), 기간이 지나면 통과해 ④가 이어서 차감한다.
      { when: tagged("finished"), fix: TRADE,
        text: "'출고 완료 뒤 재고만 취소됨': 원래 파일을 다시 올리지 마세요 — 대조 기간(기본 45일) 안에는 이미 처리된 주문으로 막히고, 그 뒤에는 이어서 차감돼 두 번 빠집니다 · 실물이 나갔는데 안 빠졌으면 [입고 및 출고]에서 소매 출고를 직접 기록한 뒤 관리자에게 출고 이력 정리 요청" },
      // 일부러 취소한 배치(옛 화면 묶음 취소 · 1품목 배치의 한 줄 취소)도 같은 모양일 수 있다 — 다시 출고·기록하면 두 번 빠진다
      { when: notTagged("finished"), fix: TRADE,
        text: "[입고 및 출고]에서 일부러 취소했거나 한 줄만 정정한 배치면 다시 출고·기록하지 마세요(관리자에게 출고 이력 정리 요청)" },
      // 대기 키가 남은 중단만 — ④ 출고는 중단 이력을 출고일과 무관하게 이어받는다(dispatch 1단계, 132 v4 — 기간 표식 없음).
      //  그 사이 실사·직접 기록이 있으면 ④가 묻고, 이미 맞췄으면 두 번째 확인창 [확인]으로 차감 없이 닫는다(closeInterrupted).
      { when: notTagged("finished"), fix: FULFILL,
        text: "그 밖: 원래 발주엑셀을 [발주처리]에 다시 올려 ④ [출고 완료] — 출고일과 무관하게 이어서 차감됩니다 · 그 사이 직접 기록했거나 실사로 맞췄으면 확인창에서 [취소] → '재고를 이미 맞췄나요?'에 [확인](차감 없이 닫힘)" },
      { when: notTagged("finished"), fix: TRADE,
        text: "원래 파일이 없을 때만: [입고 및 출고]에서 소매 출고를 직접 기록한 뒤 관리자에게 출고 이력 정리 요청 · 나중에 그 파일을 다시 올리면 이어서 차감하지 말고 차감 없이 닫기(두 번 빠집니다)" },
    ] },
  fulfill_not_dispatched: { label: "CN 받고 출고 안 한 배치", view: "ref", area: "재고", fix: FULFILL,
    guide: [
      { when: notTagged("covered"), text: "나갔으면 원래 발주엑셀을 [발주처리]에 다시 올려 ④ [출고 완료], 안 보냈으면 [발주처리] 목록의 [발송 안 함]" },
      // 누적 파일을 다시 받아 다른 배치로 ④ 출고한 경우 — 그 주문은 이미 빠졌다(132 pk_cov). 14일 지난 것은 목록에서 뺀다
      { when: tagged("covered"),
        text: "'주문 모두 다른 배치로 출고됨': 재고는 그 배치로 빠졌습니다 — 다시 출고·기록하지 말고 [발주처리] 목록의 [발송 안 함]으로 정리" },
      { when: tagged("old"), fix: TRADE,
        text: "'14일 지남': [발주처리] 목록에 안 보입니다 — 그 주문이 다른 배치로 나갔는지 [입고 및 출고]에서 먼저 확인하고, 안 나간 것만 소매 출고로 직접 기록한 뒤 관리자에게 정리 요청" },
    ] },
  fulfill_unmatched: { label: "재고가 빠지지 않은 온라인 출고 코드", view: "ref", area: "재고", fix: FULFILL,
    guide: [
      { when: () => true, fix: PRODUCTS, text: "[상품 목록]에 코드를 등록한 뒤 [발주처리]의 [재고 차감 기록] · 그 사이 실사했으면 [확인 완료]" },
      { when: tagged("old"), fix: ADJUST,
        text: "'60일 지남': [발주처리] 목록에 안 보입니다 — 그 품목을 [재고 조정]으로 맞춘 뒤 관리자에게 정리 요청" },
    ] },
  fulfill_late_orphan: { label: "연결 끊긴 늦은 출고", view: "product", area: "재고", fix: TRADE,
    guide: ["배치는 취소됐는데 [재고 차감 기록]분만 남아 이중 차감됩니다 — [입고 및 출고]에서 이 출고를 취소"] },
  move_unpaired: { label: "짝이 안 맞는 재고 이동", view: "product", area: "재고", fix: MOVE,
    guide: ["실물을 보고 빠진 쪽을 [재고 이동]으로 보충하거나, 남은 쪽을 [재고 조정]으로 상쇄"] },
  bundle_row: { label: "세트에 남은 원장 행", view: "product", area: "재고", fix: TRADE,
    guide: ["구성품으로 다시 기록한 뒤 원래 행을 취소"] },
  old_pending: { label: "7일 넘은 대기", view: "product", area: "재고", fix: TRADE,
    guide: ["실제로 들어오거나 나갔으면 입고처리·출고처리, 아니면 취소"] },
  future_done: { label: "오늘 이후 날짜로 완료된 기록", view: "product", area: "재고", fix: TRADE,
    guide: ["아직 안 일어난 일이면 취소하고 그날 다시 기록 · B2B 선점(출고 예정)은 제외"] },
  promo_stranded: { label: "요청서 없는 프로모션 재고", view: "product", area: "재고", fix: MOVE,
    guide: ["행사 몫이 아니면 [재고 이동]에서 프로모션 → 소매로 옮기기"] },
  promo_unreleased: { label: "합류 확인 안 된 프로모션 요청서", view: "ref", area: "재고", fix: PRODUCTION,
    guide: ["[생산 요청]에서 '완료·취소 보기'를 켜고 그 요청서의 [합류 다시 실행]"] },
  return_no_out: { label: "재고 출고가 없는 제조사 반품", view: "product", area: "재고", fix: TRADE,
    guide: [
      "실물을 보냈으면 [입고 및 출고]에서 반품일 날짜로 소매 출고(사유 '제조사 반품') 기록 · 결산만 고친 반품이면 그대로",
      { when: () => true, fix: QUOTE, text: "반품 기록은 [월간매입 결산]의 제조사 반품에서 확인 · 최근 90일(9월 이후)만" },
    ] },
  return_after_count: { label: "실사 뒤 소급된 제조사 반품 출고", view: "product", area: "재고", fix: TRADE,
    guide: ["실사 때 그 물건이 이미 나가 있었다면 실사가 반품을 반영했습니다 — [입고 및 출고]에서 이 출고를 취소 · 실사 때 창고에 있었다면 그대로"] },
  // 도매·도매 대량은 소매에서 옮겨 채우는 칸 — 마이너스면 옮기기를 빠뜨린 것이고 물건은 소매에서 나갔다.
  //  그 칸을 조정으로 0 맞추면 소매가 그만큼 부풀어 유령 재고가 생긴다.
  negative_balance: { label: "마이너스 재고", view: "product", area: "재고",
    guide: [
      { when: isWholesale, fix: MOVE,
        text: "도매·도매 대량: 발송일 지난 발송대기부터 정리한 뒤 [재고 이동]에서 소매 → 이 칸으로 모자란 만큼 옮기기(물건은 소매에서 나갔습니다, 조정으로 0 맞추지 마세요) · 소매도 모자라면 두 칸을 함께 실사" },
      { when: (r) => !isWholesale(r), fix: ADJUST,
        text: "소매·프로모션: 발송일 지난 발송대기부터 정리한 뒤 실물을 세어 [재고 조정]" },
    ] },
  inactive_balance: { label: "미사용 품목에 남은 재고", view: "product", area: "재고", fix: PRODUCTS,
    guide: ["[상품 목록]에서 잠시 '사용 중'으로 바꾸고 [재고 조정]으로 0 맞춘 뒤 다시 해제"] },
  untracked_balance: { label: "재고 관리 안 함 품목에 남은 재고", view: "product", area: "재고", fix: PRODUCTS,
    guide: ["[상품 목록]에서 '재고 관리 사용 안함'을 잠시 풀고 [재고 조정]으로 0 맞춘 뒤 다시 체크"] },
  receipt_unlinked: { label: "요청서에 연결 안 된 제조사 입고", view: "product", area: "입고", fix: PRODUCTION,
    guide: ["[생산 요청]에서 그 요청서의 [입고 연결]로 붙이기(재고는 그대로, 입고 예정만 줄어듭니다) · 협의 생산분이면 그대로 · 최근 21일 입고만"] },
  shipped_no_sales: { label: "매출이 없는 발송완료 발주", view: "order", area: "매출", fix: ORDERS,
    guide: ["발주를 열어 [수정]으로 다시 저장하면 매출이 다시 기록됩니다"] },
  sales_not_shipped: { label: "발송완료가 아닌데 매출이 있는 발주", view: "order", area: "매출", fix: ORDERS,
    guide: [
      { when: notTagged("deleted"), text: "발주를 열어 [수정]으로 다시 저장하면 매출 행이 지워집니다" },
      { when: tagged("deleted"), fix: SALES_REPORT, text: "'발주 삭제됨': [매출 집계]에서 그 날짜가 든 기간으로 [원장 대조] → [다시 맞추기]" },
    ] },
  b2b_sales_ledger: { label: "B2B 매출 원장 대조", view: "order", area: "매출", fix: SALES_REPORT,
    guide: [
      "[매출 집계]에서 그 날짜가 든 기간으로 [원장 대조] → 그 발주의 [다시 맞추기] · 최근 90일 발송분",
      { when: tagged("backfill"), text: "'백필 행': 다시 맞추면 귀속 월·금액이 바뀔 수 있습니다 — 대표 확인 후" },
    ] },
  sales_future: { label: "오늘 이후 날짜의 매출", view: "ref", area: "매출",
    guide: [
      { when: tagged("b2b"), fix: ORDERS, text: "도매: 발주 목록에서 그 발주의 발송일을 실제 발송일로 고쳐 저장(매출 인식일이 함께 옮겨집니다)" },
      { when: notTagged("b2b"), fix: SALES_UPLOAD, text: "업로드 날짜 오타면 [데이터 업로드]의 최근 업로드에서 [되돌리기]한 뒤 고친 파일로 다시 올리기" },
    ] },
};
const ORDER = Object.keys(META);
const AREAS: Area[] = ["재고", "입고", "매출"];

type CaseLine = Exclude<Line, string>;
const allLines = (m: Meta): CaseLine[] => m.guide.map((l) => (typeof l === "string" ? { when: () => true, text: l } : l));
// 이 종류에서 보여 줄 안내 줄 — 행 표시 상한에 잘렸으면 어떤 경우가 숨었는지 몰라 전부 보인다
function guideLines(m: Meta, g: Group): CaseLine[] {
  const all = g.count > g.items.length;
  return allLines(m).filter((l) => all || g.items.some(l.when));
}
// 처리 화면 링크 — 기본 + 안내 줄의 링크(같은 화면은 한 번)
function fixLinks(m: Meta, lines: CaseLine[]): Fix[] {
  const out: Fix[] = [];
  for (const f of [m.fix, ...lines.map((l) => l.fix)]) if (f && !out.some((o) => o.href === f.href)) out.push(f);
  return out;
}
// 확인하지 못한 항목(마이그레이션 미적용·조회 실패) — 건수를 믿을 수 없다
const unknownOf = (g: Group) => g.error || g.unavailable || "";

const num = (n: number | null) => (n === null || !Number.isFinite(n) ? "-" : (Math.round(n * 100) / 100).toLocaleString());

export default function LedgerCheckPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [today, setToday] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [fnStale, setFnStale] = useState(false); // 원장 점검 함수가 옛 판(132 다시 적용 필요 — 처리 안내 표식이 다름)
  const [itemCap, setItemCap] = useState(200);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/inventory/ledger-check", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "불러오기 실패");
      setGroups(j.groups || []);
      setToday(j.today || "");
      setTruncated(!!j.truncated);
      setFnStale(!!j.fnStale);
      if (j.itemCap) setItemCap(Number(j.itemCap));
    } catch (e) {
      setGroups([]);
      setError(e instanceof Error ? e.message : "불러오기 오류");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const byKind = useMemo(() => new Map(groups.map((g) => [g.kind, g])), [groups]);
  const sorted = useMemo(() => ORDER.map((k) => byKind.get(k)).filter((g): g is Group => !!g), [byKind]);
  const known = sorted.filter((g) => !unknownOf(g));
  const unknown = sorted.filter((g) => !!unknownOf(g));
  const total = known.reduce((s, g) => s + g.count, 0);
  const areaTotal = (a: Area) => known.filter((g) => META[g.kind]?.area === a).reduce((s, g) => s + g.count, 0);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">원장 점검</h1>
          <p className="b2b-page-subtitle">매주 수요일 생산 요청 전 확인 · 화면은 읽기만 하고 고치지 않습니다{today ? ` · 기준일 ${today}` : ""}</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "확인 중..." : "다시 확인"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {!loading && !error && fnStale && <div className="sm-warn">원장 점검 함수가 옛 판입니다 — supabase/migrations/132_reconcile_fix_ledger_check.sql 을 한 번 더 적용해야 처리 안내가 맞습니다.</div>}
      {truncated && <div className="sm-warn">이상 행이 너무 많아 일부만 읽었습니다 — 위 항목부터 정리한 뒤 다시 확인하세요.</div>}
      {!loading && !error && unknown.length > 0 && (
        <div className="sm-warn">확인하지 못한 항목 {unknown.length}개 — {unknown.map((g) => `${META[g.kind].label}(${unknownOf(g)})`).join(" · ")}</div>
      )}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : !error && (
        <>
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: "var(--sm-space-4)" }}>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">이상 합계</div><div className="b2b-stat-card-value" style={{ color: total ? "var(--sm-danger)" : unknown.length ? "var(--sm-warning)" : "var(--sm-success)" }}>{total.toLocaleString()}건</div></div>
            {AREAS.map((a) => {
              const n = areaTotal(a);
              return <div key={a} className="b2b-stat-card"><div className="b2b-stat-card-label">{a}</div><div className="b2b-stat-card-value" style={{ color: n ? "var(--sm-danger)" : "var(--sm-black)" }}>{n.toLocaleString()}건</div></div>;
            })}
          </div>

          {total === 0 && unknown.length === 0 && <div className="sm-success">이상이 없습니다.</div>}

          {/* 항목별 건수 — 0건도 보여 준다(무엇을 봤는지 알 수 있게). 확인 못 한 항목은 건수 대신 '확인 못 함' */}
          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">점검 항목</span></div>
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>항목</th><th>구분</th><th className="num">건수</th><th>처리 화면</th></tr></thead>
                <tbody>
                  {sorted.map((g) => {
                    const m = META[g.kind];
                    const links = fixLinks(m, allLines(m));
                    const why = unknownOf(g);
                    return (
                      <tr key={g.kind}>
                        <td>{g.count && !why ? <a className="sm-link" href={`#lc-${g.kind}`}>{m.label}</a> : <span className="sm-faint">{m.label}</span>}</td>
                        <td className="sm-faint">{m.area}</td>
                        {why
                          ? <td className="num" style={{ color: "var(--sm-warning)", fontWeight: 700 }} title={why}>확인 못 함</td>
                          : <td className="num b2b-money" style={{ fontWeight: 700, color: g.count ? "var(--sm-danger)" : "var(--sm-text-light)" }}>{g.count.toLocaleString()}</td>}
                        <td>{links.length ? links.map((f, i) => (
                          <span key={f.href}>{i > 0 && <span className="sm-faint"> · </span>}<Link className="sm-link" href={f.href}>{f.label}</Link></span>
                        )) : "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {known.filter((g) => g.count > 0).map((g) => {
            const m = META[g.kind];
            const lines = guideLines(m, g);
            const links = fixLinks(m, lines);
            return (
              <section key={g.kind} id={`lc-${g.kind}`} className="b2b-card" style={{ marginTop: "var(--sm-space-5)" }}>
                <div className="b2b-card-head sm-between" style={{ flexWrap: "wrap", gap: "var(--sm-space-2)" }}>
                  <span className="b2b-card-title">{m.label} <span style={{ color: "var(--sm-danger)" }}>{g.count.toLocaleString()}건</span></span>
                  {links.length > 0 && (
                    <div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)" }}>
                      {links.map((f) => <Link key={f.href} className="b2b-btn-secondary" href={f.href}>{f.label}</Link>)}
                    </div>
                  )}
                </div>
                <div className="sm-muted sm-col" style={{ fontSize: "var(--sm-fs-sm)", gap: "var(--sm-space-1)", margin: "0 0 var(--sm-space-2)" }}>
                  {lines.map((l, i) => <span key={i}>{i === 0 ? "처리: " : "· "}{l.text}</span>)}
                </div>
                <div className="b2b-table-wrap">
                  <table className="b2b-table is-responsive">
                    {m.view === "order" ? (
                      <>
                        <thead><tr><th>발주번호</th><th>거래처</th><th>날짜</th><th className="num">수량</th><th>칸</th><th>내용</th></tr></thead>
                        <tbody>
                          {g.items.map((r, i) => (
                            <tr key={`${r.ref_id}-${i}`}>
                              <td data-label="발주번호">{r.ref_id ? <Link className="sm-link" href={`/b2b/orders/${r.ref_id}`}>{r.ref_no || "발주"}</Link> : (r.ref_no || "-")}</td>
                              <td data-label="거래처">{r.partner || "-"}</td>
                              <td data-label="날짜" className="sm-nowrap">{r.txn_date || "-"}</td>
                              <td data-label="수량" className="num b2b-money">{num(r.qty)}</td>
                              <td data-label="칸">{r.channel || "-"}</td>
                              <td data-label="내용" className="sm-faint">{r.detail || "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </>
                    ) : m.view === "ref" ? (
                      <>
                        <thead><tr><th>번호</th><th>구분</th><th>날짜</th><th className="num">수량</th><th>내용</th></tr></thead>
                        <tbody>
                          {g.items.map((r, i) => (
                            <tr key={`${r.ref_id || r.partner}-${r.txn_date}-${i}`}>
                              <td data-label="번호"><strong>{r.ref_no || "-"}</strong></td>
                              <td data-label="구분">{r.partner || r.channel || "-"}</td>
                              <td data-label="날짜" className="sm-nowrap">{r.txn_date || "-"}</td>
                              <td data-label="수량" className="num b2b-money">{num(r.qty)}</td>
                              <td data-label="내용" className="sm-faint">{r.detail || "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </>
                    ) : (
                      <>
                        <thead><tr><th>품목</th><th>코드</th><th>칸</th><th className="num">수량</th><th>날짜</th><th>내용</th></tr></thead>
                        <tbody>
                          {g.items.map((r, i) => (
                            <tr key={`${r.ref_id || r.product_id}-${r.channel}-${i}`}>
                              <td data-label="품목"><strong>{r.product_name || "(품목 없음)"}</strong></td>
                              <td data-label="코드" className="sm-faint" style={{ fontSize: "var(--sm-fs-xs)" }}>{r.sku || "-"}</td>
                              <td data-label="칸">{r.channel || "-"}</td>
                              <td data-label="수량" className="num b2b-money" style={{ color: (r.qty ?? 0) < 0 ? "var(--sm-danger)" : undefined }}>{num(r.qty)}</td>
                              <td data-label="날짜" className="sm-nowrap">{r.txn_date || "-"}</td>
                              <td data-label="내용" className="sm-faint">{[r.detail, r.ref_no, r.partner].filter(Boolean).join(" · ") || "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </>
                    )}
                  </table>
                </div>
                {g.count > g.items.length && <p className="sm-faint" style={{ fontSize: "var(--sm-fs-xs)", marginTop: "var(--sm-space-2)" }}>앞 {itemCap.toLocaleString()}건만 표시</p>}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
