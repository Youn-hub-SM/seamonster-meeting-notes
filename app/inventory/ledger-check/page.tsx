"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

// 원장 점검(대표 결정 D4d) — 장부 이상을 사람이 확인·처리한다. 화면은 읽기만 하고 고치지 않는다(S12).
//  판정은 /api/inventory/ledger-check → inventory_ledger_check RPC(132) 한 곳(B2B 매출 원장 대조만 reconcileB2BSales).
//  확인하지 못한 항목(마이그레이션 미적용·조회 실패)은 0건이 아니라 '확인 못 함'으로 보인다(S4).
//  2026-10-11 대표 피드백 "보기 어렵다" — 고치는 화면별로 묶고, 항목마다 쉬운 제목 + 할 일 한 줄만. 목록·예외는 펼쳐서 본다.

type Item = {
  ref_id: string | null; ref_no: string | null; partner: string | null;
  product_id: string | null; product_name: string | null; sku: string | null; channel: string | null;
  qty: number | null; txn_date: string | null; detail: string | null;
  tags?: string[]; // 132 표식 — live·counted·multi·dup·old·covered·finished·deleted·b2b·backfill
};
type Group = { kind: string; count: number; items: Item[]; unavailable?: string; error?: string };

type Fix = { href: string; label: string };
const TRADE: Fix = { href: "/inventory/trade", label: "입고 및 출고" };
const MOVE: Fix = { href: "/inventory/move", label: "재고 이동" };
const ADJUST: Fix = { href: "/inventory/adjust", label: "재고 조정" };
const PRODUCTS: Fix = { href: "/b2b/products", label: "상품 목록" };
const ORDERS: Fix = { href: "/b2b/orders", label: "발주" };
const FULFILL: Fix = { href: "/fulfill", label: "발주처리" };
const PRODUCTION: Fix = { href: "/production/request", label: "생산 요청" };
const QUOTE: Fix = { href: "/inventory/quote", label: "월간매입 결산" };
const SALES_REPORT: Fix = { href: "/b2b/reports", label: "매출 집계" };
const SALES_UPLOAD: Fix = { href: "/sales/upload", label: "데이터 업로드" };

// 고치는 곳 — 화면은 이 순서로 묶는다
type Where = "발주" | "택배" | "재고" | "생산" | "매출";
const WHERE: { key: Where; title: string; fix: Fix }[] = [
  { key: "발주", title: "발주에서 고칠 것", fix: ORDERS },
  { key: "택배", title: "발주처리(택배)에서 고칠 것", fix: FULFILL },
  { key: "재고", title: "재고 화면에서 고칠 것", fix: TRADE },
  { key: "생산", title: "생산 요청에서 고칠 것", fix: PRODUCTION },
  { key: "매출", title: "매출에서 고칠 것", fix: SALES_REPORT },
];

// 표식 → 행 배지(짧게) · 그런 행이 있을 때만 펼친 곳에 한 줄 주의(데이터가 틀어지는 경우만)
const TAG: Record<string, { badge: string; tone: "warn" | "info"; note?: string; fix?: Fix }> = {
  counted: { badge: "발송일 뒤 실사 있음", tone: "warn", fix: ADJUST,
    note: "'발송일 뒤 실사 있음' — 실사가 이미 맞췄을 수 있어 다시 저장하면 두 번 반영됩니다. 저장한 뒤 같은 수량을 [재고 조정]으로 되돌리세요." },
  live: { badge: "살아 있는 회차", tone: "warn",
    note: "'살아 있는 회차' — [수정]으로 저장하지 마세요. 발주 목록에서 '발송대기'로 되돌린 뒤 다시 '취소'하세요." },
  dup: { badge: "회차 두 벌", tone: "warn",
    note: "'회차 두 벌' — [수정] 대신 발송일 칸에서 겹친(안 나간) 회차를 ✕로 지우고 [저장]하세요." },
  multi: { badge: "회차 두 벌", tone: "warn",
    note: "'회차 두 벌' — [수정] 대신 발송일 칸에서 겹친(안 나간) 회차를 ✕로 지우고 [저장]하세요." },
  finished: { badge: "출고 끝난 뒤 재고만 취소됨", tone: "warn", fix: TRADE,
    note: "'출고 끝난 뒤 재고만 취소됨' — 원래 파일을 다시 올리지 마세요(두 번 빠집니다). 실제로 나갔으면 [입고 및 출고]에서 직접 출고를 기록하세요." },
  covered: { badge: "다른 배치로 출고됨", tone: "info",
    note: "'다른 배치로 출고됨' — 재고는 이미 빠졌습니다. [발송 안 함]으로 정리만 하세요." },
  old: { badge: "오래됨", tone: "info",
    note: "'오래됨' — [발주처리] 목록에 안 보입니다. [입고 및 출고]에서 확인해 직접 정리하세요." },
  deleted: { badge: "발주 삭제됨", tone: "info", fix: SALES_REPORT,
    note: "'발주 삭제됨' — [매출 집계]에서 [원장 대조] 뒤 [다시 맞추기]로 지우세요." },
  backfill: { badge: "옛 시트 매출", tone: "info",
    note: "'옛 시트 매출' — 다시 맞추면 귀속 월·금액이 바뀔 수 있습니다. 대표 확인 후 하세요." },
  b2b: { badge: "도매", tone: "info" },
};

// 항목 — 제목은 쉬운 말, 할 일은 한 줄. first = 다른 정리·실사보다 먼저 할 것.
//  view: order = 발주 단위, product = 품목 단위, ref = 출고 배치·요청서·채널 단위
type Meta = {
  label: string; where: Where; view: "order" | "product" | "ref"; todo: string; fix: Fix; also?: Fix[]; first?: boolean;
  todoFor?: (r: Item) => string | null; // 행마다 할 일이 다를 때(예: 칸에 따라)
  notes?: Record<string, string>;        // 이 항목에서 표식별 주의를 다르게 할 때(같은 표식도 항목마다 처리 방향이 다르다)
};
const META: Record<string, Meta> = {
  b2b_overdue: { label: "발송일이 지났는데 아직 발송대기인 발주", where: "발주", view: "order", fix: ORDERS, first: true,
    todo: "나갔으면 '발송완료'(실제 발송일 입력), 안 나갔으면 발송일 칸에서 날짜를 다시 잡으세요." },
  b2b_cancelled: { label: "취소했는데 재고가 빠진 채인 발주", where: "발주", view: "order", fix: ORDERS,
    notes: { counted: "'발송일 뒤 실사 있음' — 실사 때 그 물건이 창고에 있었다면, 정리하면 재고가 두 번 되살아납니다. 정리한 뒤 같은 수량을 [재고 조정]으로 빼세요." },
    todo: "발주를 열어 [수정]으로 다시 저장하세요. 실제로 나갔는데 안 돌아왔으면 '발송완료'로 되돌린 뒤 다시 '취소', 이어서 '안 돌아옴'." },
  b2b_no_deduct: { label: "발송했는데 재고가 안 빠진 발주", where: "발주", view: "order", fix: ORDERS,
    todo: "발주를 열어 발송일을 확인하고 [수정]으로 다시 저장하세요." },
  b2b_stock_off: { label: "재고 차감이 꺼진 발송 회차", where: "발주", view: "order", fix: ORDERS,
    todo: "발주를 열어 [수정]으로 다시 저장하세요(차감이 켜집니다)." },
  b2b_qty_mismatch: { label: "빠진 재고 수량이 발주와 다른 발주", where: "발주", view: "order", fix: ORDERS,
    todo: "발주를 열어 [수정]으로 다시 저장하세요. 수량 = 빠져야 할 수량 − 빠진 수량." },
  b2b_date_mismatch: { label: "재고가 빠진 날짜가 첫 발송일과 다른 발주", where: "발주", view: "order", fix: ORDERS,
    todo: "발주를 열어 [수정]으로 다시 저장하세요(첫 발송일 하루로 합쳐지고 재고 총량은 그대로)." },
  b2b_dup_shipment: { label: "발송 회차가 두 번 잡힌 발주", where: "발주", view: "order", fix: ORDERS,
    todo: "발주 목록의 발송일 칸에서 겹친(안 나간) 회차를 ✕로 지우고 [저장]하세요. 발송완료 회차는 지우지 마세요." },
  b2b_over_alloc: { label: "회차별 수량 합이 발주 수량보다 많은 발주", where: "발주", view: "order", fix: ORDERS,
    todo: "발송일 칸에서 회차별 수량을 발주 수량 안으로 고치거나 겹친 회차를 지우고 [저장]하세요." },
  b2b_unlinked_line: { label: "상품과 연결 안 된 발주 줄", where: "발주", view: "order", fix: ORDERS,
    todo: "재고 품목이면 발주를 열어 품목을 목록에서 다시 고르고 [수정]하세요. 배송비 같은 줄은 그대로 둡니다." },
  shipped_no_sales: { label: "매출이 빠진 발송완료 발주", where: "발주", view: "order", fix: ORDERS,
    todo: "발주를 열어 [수정]으로 다시 저장하세요." },
  sales_not_shipped: { label: "발송 안 됐는데 매출이 잡힌 발주", where: "발주", view: "order", fix: ORDERS, also: [SALES_REPORT],
    todo: "발주를 열어 [수정]으로 다시 저장하세요.",
    todoFor: (r) => ((r.tags ?? []).includes("deleted") ? "[매출 집계]에서 [원장 대조] 뒤 [다시 맞추기]" : null) },

  fulfill_interrupted: { label: "중간에 끊긴 택배 출고", where: "택배", view: "ref", fix: FULFILL, also: [TRADE],
    todo: "원래 발주엑셀을 다시 올려 ④ [출고 완료]를 누르세요. 그 사이 재고를 직접 맞췄으면 확인창에서 [취소]를 누르고 '재고를 이미 맞췄나요?'에 [확인]." },
  fulfill_not_dispatched: { label: "CN 파일만 받고 출고 완료 안 한 배치", where: "택배", view: "ref", fix: FULFILL, also: [TRADE],
    notes: { old: "'오래됨'(14일 지남) — [발주처리] 목록에 안 보입니다. 그 주문이 다른 배치로 나갔는지 [입고 및 출고]에서 먼저 확인하고, 안 나간 것만 소매 출고로 직접 기록하세요." },
    todo: "나갔으면 원래 발주엑셀을 다시 올려 ④ [출고 완료], 안 보냈으면 [발송 안 함]." },
  fulfill_unmatched: { label: "재고가 안 빠진 택배 상품 코드", where: "택배", view: "ref", fix: FULFILL, also: [PRODUCTS, ADJUST],
    notes: { old: "'오래됨'(60일 지남) — [발주처리] 목록에 안 보입니다. 그 품목을 [재고 조정]으로 맞추세요." },
    todo: "[상품 목록]에 코드를 등록한 뒤 [발주처리]의 [재고 차감 기록]. 그 사이 실사했으면 [확인 완료]." },

  negative_balance: { label: "마이너스 재고", where: "재고", view: "product", fix: ADJUST, also: [MOVE], first: true,
    todo: "발송일 지난 발송대기부터 정리한 뒤 맞추세요.",
    todoFor: (r) => (r.channel === "도매" || r.channel === "도매 대량"
      ? "[재고 이동]에서 소매에서 이 칸으로 모자란 만큼 옮기기(조정으로 0 맞추지 않기)"
      : "실물을 세어 [재고 조정]") },
  move_unpaired: { label: "한쪽만 남은 재고 이동", where: "재고", view: "product", fix: MOVE, also: [ADJUST],
    todo: "실물을 보고 빠진 쪽을 [재고 이동]으로 보충하거나, 남은 쪽을 [재고 조정]으로 상쇄하세요." },
  old_pending: { label: "7일 넘게 대기 중인 입출고", where: "재고", view: "product", fix: TRADE,
    todo: "실제로 들어오거나 나갔으면 [입고처리]·[출고처리], 아니면 취소하세요." },
  future_done: { label: "오늘 이후 날짜로 완료된 입출고", where: "재고", view: "product", fix: TRADE,
    todo: "아직 안 일어난 일이면 취소하고 그날 다시 기록하세요." },
  bundle_row: { label: "세트 이름으로 남은 재고 기록", where: "재고", view: "product", fix: TRADE,
    todo: "구성품으로 다시 기록한 뒤 원래 기록을 취소하세요." },
  fulfill_late_orphan: { label: "취소된 배치에 남은 늦은 출고", where: "재고", view: "product", fix: TRADE,
    todo: "[입고 및 출고]에서 이 출고를 취소하세요(두 번 빠진 상태)." },
  b2b_kept_orphan: { label: "발주 없이 남은 '안 돌아옴' 출고", where: "재고", view: "order", fix: TRADE,
    todo: "물건이 정말 안 돌아왔으면 그대로, 돌아왔으면 사유 '고객 반품'으로 입고하세요." },
  return_no_out: { label: "재고에서 안 뺀 제조사 반품", where: "재고", view: "product", fix: TRADE, also: [QUOTE],
    todo: "실물을 보냈으면 반품일 날짜로 출고(사유 '제조사 반품')를 기록하세요. 결산만 고친 반품이면 그대로." },
  return_after_count: { label: "실사 뒤에 기록된 제조사 반품 출고", where: "재고", view: "product", fix: TRADE,
    todo: "실사 때 이미 나가 있었다면 이 출고를 취소하세요. 실사 때 창고에 있었다면 그대로." },
  promo_stranded: { label: "요청서 없이 남은 프로모션 재고", where: "재고", view: "product", fix: MOVE,
    todo: "행사 몫이 아니면 [재고 이동]에서 프로모션에서 소매로 옮기세요." },
  inactive_balance: { label: "미사용 품목에 남은 재고", where: "재고", view: "product", fix: PRODUCTS, also: [ADJUST],
    todo: "[상품 목록]에서 잠시 '사용 중'으로 바꾸고 [재고 조정]으로 0을 맞춘 뒤 다시 해제하세요." },
  untracked_balance: { label: "'재고 관리 안 함' 품목에 남은 재고", where: "재고", view: "product", fix: PRODUCTS, also: [ADJUST],
    todo: "'재고 관리 사용 안함'을 잠시 풀고 [재고 조정]으로 0을 맞춘 뒤 다시 체크하세요." },

  promo_unreleased: { label: "소매 합류 확인 안 된 프로모션 요청서", where: "생산", view: "ref", fix: PRODUCTION,
    todo: "'완료·취소 보기'를 켜고 그 요청서의 [합류 다시 실행]을 누르세요." },
  receipt_unlinked: { label: "요청서에 연결 안 된 제조사 입고", where: "생산", view: "product", fix: PRODUCTION,
    todo: "그 요청서의 [입고 연결]로 붙이세요(재고는 그대로). 협의 생산분이면 그대로." },

  b2b_sales_ledger: { label: "매출 원장과 다른 B2B 발주", where: "매출", view: "order", fix: SALES_REPORT,
    todo: "[매출 집계]에서 그 날짜가 든 기간으로 [원장 대조] 뒤 [다시 맞추기]." },
  sales_future: { label: "오늘 이후 날짜의 매출", where: "매출", view: "ref", fix: SALES_UPLOAD, also: [ORDERS],
    todo: "업로드 날짜 오타면 최근 업로드에서 [되돌리기] 후 다시 올리세요.",
    todoFor: (r) => ((r.tags ?? []).includes("b2b") ? "발주의 발송일을 실제 발송일로 고쳐 저장" : null) },
};
const ORDER = Object.keys(META);

// 확인하지 못한 항목(마이그레이션 미적용·조회 실패) — 건수를 믿을 수 없다
const unknownOf = (g: Group) => g.error || g.unavailable || "";
const num = (n: number | null) => (n === null || !Number.isFinite(n) ? "-" : (Math.round(n * 100) / 100).toLocaleString());
// 서버 설명(132)의 내부 용어를 이 화면 용어로 — 차수 → 회차, 선점 → 미리 빠진 재고
const plain = (s: string | null) => (s ? s.replace(/차수/g, "회차").replace(/선점/g, "미리 빠진 재고") : s);
const tagsOf = (r: Item) => [...new Set((r.tags ?? []).filter((t) => TAG[t]).map((t) => (t === "multi" ? "dup" : t)))];

function TagPills({ r }: { r: Item }) {
  const ts = tagsOf(r);
  if (!ts.length) return null;
  return (
    <span className="sm-row-wrap" style={{ gap: "var(--sm-space-1)" }}>
      {ts.map((t) => (
        <span key={t} className="b2b-status-pill" style={{
          background: TAG[t].tone === "warn" ? "var(--sm-warning-bg)" : "var(--sm-info-bg)",
          color: TAG[t].tone === "warn" ? "var(--sm-warning)" : "var(--sm-info)",
        }}>{TAG[t].badge}</span>
      ))}
    </span>
  );
}

function KindRows({ m, g }: { m: Meta; g: Group }) {
  const rowTodo = (r: Item) => m.todoFor?.(r) ?? null;
  const showTodoCol = !!m.todoFor && g.items.some((r) => rowTodo(r));
  // 이 항목에서 값이 하나도 없는 열은 숨긴다
  const showDate = g.items.some((r) => r.txn_date);
  const showMark = g.items.some((r) => r.detail || tagsOf(r).length);
  return (
    <div className="b2b-table-wrap">
      <table className="b2b-table is-responsive">
        <thead>
          <tr>
            {m.view === "product" ? <><th>품목</th><th>칸</th></> : <><th>{m.view === "order" ? "발주" : "번호"}</th><th>{m.view === "order" ? "거래처" : "구분"}</th></>}
            {showDate && <th>날짜</th>}<th className="num">수량</th>{showMark && <th>표시</th>}{showTodoCol && <th>할 일</th>}
          </tr>
        </thead>
        <tbody>
          {g.items.map((r, i) => (
            <tr key={`${r.ref_id || r.product_id || r.ref_no}-${r.channel}-${r.txn_date}-${i}`}>
              {m.view === "product" ? (
                <>
                  <td data-label="품목"><strong>{r.product_name || "(품목 없음)"}</strong>{r.sku && <div className="sm-faint" style={{ fontSize: "var(--sm-fs-xs)" }}>{r.sku}</div>}</td>
                  <td data-label="칸">{r.channel || "-"}</td>
                </>
              ) : (
                <>
                  <td data-label={m.view === "order" ? "발주" : "번호"}>
                    {m.view === "order" && r.ref_id
                      ? <Link className="sm-link" href={`/b2b/orders/${r.ref_id}`}>{r.ref_no || "발주"}</Link>
                      : <strong>{r.ref_no || "-"}</strong>}
                  </td>
                  <td data-label={m.view === "order" ? "거래처" : "구분"}>{r.partner || r.channel || "-"}</td>
                </>
              )}
              {showDate && <td data-label="날짜" className="sm-nowrap">{r.txn_date || "-"}</td>}
              <td data-label="수량" className="num b2b-money" style={{ color: (r.qty ?? 0) < 0 ? "var(--sm-danger)" : undefined }}>{num(r.qty)}</td>
              {showMark && (
                <td data-label="표시">
                  <TagPills r={r} />
                  {r.detail && <div className="sm-faint" style={{ fontSize: "var(--sm-fs-xs)" }}>{plain(r.detail)}</div>}
                </td>
              )}
              {showTodoCol && <td data-label="할 일">{rowTodo(r) || "-"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KindBlock({ kind, g, itemCap }: { kind: string; g: Group; itemCap: number }) {
  const m = META[kind];
  const [open, setOpen] = useState(false);
  // 이 항목 행에 붙은 표식의 주의 한 줄(그런 행이 있을 때만 — 행 상한에 잘렸으면 다 보인다)
  const cut = g.count > g.items.length;
  const notes = [...new Set(g.items.flatMap(tagsOf))].map((t) => m.notes?.[t] ?? TAG[t].note).filter((n): n is string => !!n);
  const links = [m.fix, ...(m.also ?? [])];
  return (
    <div style={{ borderTop: "1px solid var(--sm-border)", padding: "var(--sm-space-3) 0" }}>
      <div className="sm-between" style={{ gap: "var(--sm-space-3)", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="sm-col" style={{ gap: "var(--sm-space-1)", minWidth: 0, flex: "1 1 320px" }}>
          <div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)", alignItems: "center" }}>
            <strong>{m.label}</strong>
            <span className="b2b-status-pill" style={{ background: "var(--sm-danger-bg)", color: "var(--sm-danger)" }}>{g.count.toLocaleString()}건</span>
            {m.first && <span className="b2b-status-pill" style={{ background: "var(--sm-warning-bg)", color: "var(--sm-warning)" }}>먼저</span>}
          </div>
          <span className="sm-muted">{m.todo}</span>
        </div>
        <div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)" }}>
          <button type="button" className="b2b-btn-secondary" onClick={() => setOpen((v) => !v)}>{open ? "목록 닫기" : "목록 보기"}</button>
          {links.map((f) => <Link key={f.href} className="b2b-btn-secondary" href={f.href}>{f.label}</Link>)}
        </div>
      </div>
      {open && (
        <div className="sm-col" style={{ gap: "var(--sm-space-2)", marginTop: "var(--sm-space-3)" }}>
          {notes.length > 0 && <div className="sm-warn sm-col" style={{ gap: "var(--sm-space-1)" }}>{notes.map((n) => <span key={n}>{n}</span>)}</div>}
          <KindRows m={m} g={g} />
          {cut && <p className="sm-faint" style={{ fontSize: "var(--sm-fs-xs)" }}>앞 {itemCap.toLocaleString()}건만 표시</p>}
        </div>
      )}
    </div>
  );
}

export default function LedgerCheckPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [today, setToday] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [fnStale, setFnStale] = useState(false); // 원장 점검 함수가 옛 판(132 다시 적용 필요)
  const [itemCap, setItemCap] = useState(200);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showClean, setShowClean] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/inventory/ledger-check", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "원장 점검 결과를 불러오지 못했습니다. [다시 확인]을 누르세요.");
      setGroups(j.groups || []);
      setToday(j.today || "");
      setTruncated(!!j.truncated);
      setFnStale(!!j.fnStale);
      if (j.itemCap) setItemCap(Number(j.itemCap));
    } catch (e) {
      setGroups([]);
      setError(e instanceof Error ? e.message : "원장 점검 결과를 불러오지 못했습니다. [다시 확인]을 누르세요.");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const byKind = useMemo(() => new Map(groups.map((g) => [g.kind, g])), [groups]);
  const sorted = useMemo(() => ORDER.map((k) => byKind.get(k)).filter((g): g is Group => !!g), [byKind]);
  const unknown = sorted.filter((g) => !!unknownOf(g));
  const bad = sorted.filter((g) => !unknownOf(g) && g.count > 0);
  const clean = sorted.filter((g) => !unknownOf(g) && g.count === 0);
  const total = bad.reduce((s, g) => s + g.count, 0);
  const firsts = bad.filter((g) => META[g.kind].first);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">원장 점검</h1>
          <p className="b2b-page-subtitle">매주 수요일 생산 요청 전에 봅니다. 읽기 전용{today ? `, 기준일 ${today}` : ""}</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "확인 중..." : "다시 확인"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {!loading && !error && fnStale && <div className="sm-warn">원장 점검 함수가 옛 판입니다 — supabase/migrations/132_reconcile_fix_ledger_check.sql 을 한 번 더 적용하세요.</div>}
      {truncated && <div className="sm-warn">이상 기록이 많아 일부만 읽었습니다 — 위 항목부터 정리한 뒤 [다시 확인]을 누르세요.</div>}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : !error && (
        <>
          {/* 한 줄 요약 */}
          {total === 0 && unknown.length === 0
            ? <div className="sm-success">이상이 없습니다.</div>
            : (
              <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: "var(--sm-space-4)" }}>
                <div className="b2b-stat-card">
                  <div className="b2b-stat-card-label">정리할 것</div>
                  <div className="b2b-stat-card-value" style={{ color: total ? "var(--sm-danger)" : "var(--sm-black)" }}>{total.toLocaleString()}건</div>
                  <div className="b2b-stat-card-hint">{bad.length}개 항목</div>
                </div>
                {unknown.length > 0 && (
                  <div className="b2b-stat-card">
                    <div className="b2b-stat-card-label">확인 못 함</div>
                    <div className="b2b-stat-card-value" style={{ color: "var(--sm-warning)" }}>{unknown.length}개 항목</div>
                    <div className="b2b-stat-card-hint">0건이 아닙니다</div>
                  </div>
                )}
              </div>
            )}

          {firsts.length > 0 && (
            <div className="sm-warn" style={{ marginBottom: "var(--sm-space-4)" }}>
              먼저 정리: {firsts.map((g) => `${META[g.kind].label} ${g.count.toLocaleString()}건`).join(", ")} — 실사·다른 정리보다 먼저
            </div>
          )}

          {WHERE.map((w) => {
            const list = bad.filter((g) => META[g.kind].where === w.key);
            if (!list.length) return null;
            const n = list.reduce((s, g) => s + g.count, 0);
            return (
              <section key={w.key} className="b2b-card" style={{ marginBottom: "var(--sm-space-5)" }}>
                <div className="b2b-card-head sm-between" style={{ flexWrap: "wrap", gap: "var(--sm-space-2)" }}>
                  <span className="b2b-card-title">{w.title} <span style={{ color: "var(--sm-danger)" }}>{n.toLocaleString()}건</span></span>
                </div>
                {list.map((g) => <KindBlock key={g.kind} kind={g.kind} g={g} itemCap={itemCap} />)}
              </section>
            );
          })}

          {unknown.length > 0 && (
            <section className="b2b-card" style={{ marginBottom: "var(--sm-space-5)" }}>
              <div className="b2b-card-head"><span className="b2b-card-title">확인 못 한 항목</span></div>
              <div className="sm-warn sm-col" style={{ gap: "var(--sm-space-1)" }}>
                {unknown.map((g) => <span key={g.kind}>{META[g.kind].label} — {unknownOf(g)}</span>)}
              </div>
            </section>
          )}

          {clean.length > 0 && (
            <section className="b2b-card">
              <button type="button" className="b2b-link-btn" onClick={() => setShowClean((v) => !v)}>
                {showClean ? "이상 없는 항목 닫기" : `이상 없는 항목 ${clean.length}개 보기`}
              </button>
              {showClean && (
                <div className="sm-faint sm-col" style={{ gap: "var(--sm-space-1)", marginTop: "var(--sm-space-2)" }}>
                  {clean.map((g) => <span key={g.kind}>{META[g.kind].label}</span>)}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
