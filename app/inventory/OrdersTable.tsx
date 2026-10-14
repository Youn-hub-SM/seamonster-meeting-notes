"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INV_TYPE_COLOR } from "@/app/lib/inventory";
import { matchKoQuery } from "@/app/lib/hangul";
import { useEscClose } from "@/app/lib/use-esc";
import type { LinkResultLite } from "@/app/lib/link-result";
import { RequestSelect, reqWarnOf, confirmUnlinkedInbound, linkMessage, type OpenReq } from "./TxnModal";
import { deleteLedger, isMoveTxn } from "./TxnTable";
import { useConfirm, useToast } from "@/app/components/Feedback";

// product_id·reason 은 대기 입고처리(요청서 잔여 확인·고객 반품 판정)에 쓴다 — 구 서버 응답엔 없다(없으면 잔여를 모른다고 확인을 받는다)
type OrderItem = { id: string; product_name: string; sku: string | null; qty: number; unit_amount: number | null; amount: number; product_id?: string | null; reason?: string | null };
type Order = {
  // '이동' = 소매↔도매 이동(출고+입고 두 행이 한 묶음) — [전체] 탭에서 유형 집계가 어긋나 보이지 않게 구분
  key: string; order_no: string | null; type: "입고" | "출고" | "이동"; status: "대기" | "완료"; txn_date: string; created_at: string;
  partner: string | null; memo: string | null; created_by: string | null;
  is_move?: boolean;                 // 서버 판정(isMoveRow) — 구 응답엔 없음
  source?: string | null;            // 출처 칸(131) — 서버가 실어 주면 이동·온라인발주 배치를 데이터로 가른다. 없으면(구 응답) 종전 표식
  grouped?: boolean;                 // key 가 group_id 인지(취소·처리 시 group_id= / id= 선택 기준). 구 서버 응답엔 없음 → order_no 로 폴백
  move_from?: string | null; move_to?: string | null; // 이동 행의 출고 칸 → 입고 칸
  item_count: number; total_qty: number; total_amount: number; items: OrderItem[];
};
// 이동 행 판별 — isMoveRow(app/lib/production-velocity.ts)와 같은 규칙(isMoveTxn): 출처 칸이 있으면 move·promo_close,
//  없으면 주문번호 없는 partner '채널이동'(주문번호 있는 옛 사람 입력 '채널이동'은 일반 입출고). 잠금은 서버 lockKindOf 가 정한다.
const isMoveOrder = (o: Order) => o.is_move ?? isMoveTxn({ source: o.source, partner: o.partner, order_no: o.order_no }); // 서버 판정(is_move) 우선, 구 응답이면 같은 규칙으로
const isGrouped = (o: Order) => o.grouped ?? !!o.order_no;
// B2B 연동 행(선점·발송 후 취소 미반품) — 발주에서 정리한다(서버 lockKindOf 와 같은 표식)
const isB2bOrder = (o: Order) => o.created_by === "B2B 자동출고" || String(o.source ?? "").startsWith("b2b");
// 온라인발주 출고 배치(택배 ④ 출고) — 취소하면 서버가 '처리완료 주문' 기록과 그 배치의 [재고 차감 기록]분까지 함께 지운다
//  (다른 살아 있는 배치로도 출고된 주문 키는 지우지 않고 그 배치로 넘긴다 — 135 cancel_fulfill_dispatch).
//  미반영분 출고([재고 차감 기록] 자체 묶음)는 출처 칸(fulfill·fulfill_unmatched)으로, 구 응답이면 메모 머리로 구분한다 — 확인창 문구 고르기에만 쓴다(판정은 서버).
const LATE_MEMO = "온라인발주 미반영분";
const isFulfillBatch = (o: Order) => o.source != null ? o.source === "fulfill" : o.partner === "온라인몰" && isGrouped(o) && !(o.memo || "").startsWith(LATE_MEMO);
const isLateBatch = (o: Order) => o.source != null ? o.source === "fulfill_unmatched" : o.partner === "온라인몰" && isGrouped(o) && (o.memo || "").startsWith(LATE_MEMO);
// 처리·취소 결과 배너(ok = 성공, 아니면 확인할 것이 남음)
type Flash = { ok: boolean; text: string };
const KST_TODAY = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 원장 메모 '행사 종료 자동 합류' = 폐지된 자동 합류 크론(2026-10-06 삭제)의 옛 기록 — 표시만 바꾼다
const displayMemo = (memo: string | null) => (memo === "행사 종료 자동 합류" ? "행사 전 자동 합류" : memo);

// 입출고 '주문(묶음)' 목록 — BoxHero 구매목록 스타일. 한 번에 입력한 라인이 하나의 주문번호로 묶임.
export default function OrdersTable({ reloadKey = 0 }: { reloadKey?: number }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // 필터 — 유형(전체/입고/출고)·기간은 서버 쿼리, 품목 검색은 로드된 목록에서(초성·다중단어)
  const [fType, setFType] = useState<"전체" | "입고" | "출고">("전체");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [search, setSearch] = useState("");
  // 검색은 서버에서 전체 기록을 뒤진다 — 최근 N행 캡 안에서만 거르면 [전체] 탭에서 과거 매칭 건이
  // 빠진다(입고+출고 합산이 캡을 먼저 채움). 타이핑마다 요청하지 않게 350ms 디바운스.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebouncedSearch(search.trim()), 350); return () => clearTimeout(t); }, [search]);
  // 세부 내역 '전 → 후' 재고 변동 — 펼칠 때 1회 조회해 캐시
  const [balances, setBalances] = useState<Record<string, { before: number; after: number } | null>>({});
  // 세부 내역 단가 인라인 수정 — 단가만 고친다(수량·품목·날짜는 재고에 영향 → 취소 후 재기록)
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);
  // 처리·취소 결과(서버 notice·요청서 연결 결과) — 창이 닫힌 뒤에도 목록 위에 남긴다
  const [flash, setFlash] = useState<Flash | null>(null);

  // 지금 화면의 orders 가 어떤 검색어로 서버 필터된 것인지 — 클라 재필터를 건너뛸지 판단에 쓴다
  const [loadedQ, setLoadedQ] = useState("");
  // '이전 내역 더 보기' 페이징 — [전체] 탭은 입고+출고 합산이 행 캡을 먼저 채워 과거가 일찍 잘린다.
  const [more, setMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  // 더 보기로 확장한 깊이(행 한도) — 취소·입고처리 후 재조회가 1페이지로 접히지 않게 유지.
  //  서버 상한(4000행)까지만. 필터·검색이 바뀌면 기본으로 되돌린다.
  const rowLimitRef = useRef(1500);
  // 요청 순번 가드 — 검색 요청(느림)과 일반 요청(빠름)이 겹칠 때 늦게 도착한 이전 응답이
  // 최신 목록을 덮어쓰지 않게 한다(검색어를 지웠는데 검색 결과가 남는 경합).
  const seqRef = useRef(0);

  const kstDay = (back = 0) => { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - back); return d.toISOString().slice(0, 10); };
  const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true); setError("");
    setMore(false); setNextBefore(null); // 재조회 중 '더 보기'가 옛 커서로 눌리는 것 방지 — 응답이 복원
    try {
      const qs = new URLSearchParams();
      if (fType !== "전체") qs.set("type", fType);
      if (DATE_OK.test(fFrom)) qs.set("from", fFrom);
      if (DATE_OK.test(fTo)) qs.set("to", fTo);
      if (debouncedSearch) qs.set("q", debouncedSearch);
      if (rowLimitRef.current > 1500) qs.set("limit", String(rowLimitRef.current));
      const j = await (await fetch("/api/inventory/orders" + (qs.toString() ? "?" + qs.toString() : ""), { cache: "no-store" })).json();
      if (seq !== seqRef.current) return; // 그 사이 새 요청이 나감 — 이 응답은 버린다
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setOrders(j.orders || []);
      setLoadedQ(debouncedSearch);
      setMore(!!j.more);
      setNextBefore(j.next_before || null);
    } catch (e) { if (seq === seqRef.current) setError(e instanceof Error ? e.message : "조회 오류"); }
    if (seq === seqRef.current) setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fType, fFrom, fTo, debouncedSearch]);
  useEffect(() => { rowLimitRef.current = 1500; }, [fType, fFrom, fTo, debouncedSearch]); // 필터가 바뀌면 깊이 초기화
  useEffect(() => { load(); }, [load, reloadKey]);

  const shown = useMemo(() => {
    const q = search.trim();
    if (!q) return orders;
    // 서버가 이미 이 검색어로 거른 목록이면 그대로 쓴다 — 서버(토큰 분해 ilike)와 클라(원문
    // matchKoQuery)의 판정 차이로 "(주)" 같은 검색어에서 찾아온 결과를 떨어뜨리는 일 방지.
    if (q === loadedQ) return orders;
    // 타이핑 중(디바운스 대기)엔 지금 로드된 목록에서 즉시 필터해 반응성 유지
    return orders.filter((o) => matchKoQuery(`${o.items.map((it) => `${it.product_name} ${it.sku || ""}`).join(" ")} ${o.partner || ""} ${o.order_no || ""}`, q));
  }, [orders, search, loadedQ]);

  function toggle(k: string) {
    setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    // 펼칠 때 그 주문 품목들의 '전 → 후' 잔고 조회(미조회분만)
    const o = orders.find((x) => x.key === k);
    if (!o || open.has(k)) return;
    const need = o.items.map((it) => it.id).filter((id) => !(id in balances));
    if (!need.length) return;
    fetch("/api/inventory/orders/balance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txn_ids: need }) })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) setBalances((prev) => ({ ...prev, ...j.balances })); })
      .catch(() => {});
  }
  async function loadMore() {
    if (!nextBefore || moreBusy) return;
    const seq = seqRef.current; // 필터·검색이 바뀌면(새 load 가 seq 증가) 이 응답은 버린다
    setMoreBusy(true);
    try {
      const qs = new URLSearchParams();
      if (fType !== "전체") qs.set("type", fType);
      if (DATE_OK.test(fFrom)) qs.set("from", fFrom);
      if (DATE_OK.test(fTo)) qs.set("to", fTo);
      qs.set("before", nextBefore);
      const j = await (await fetch("/api/inventory/orders?" + qs.toString(), { cache: "no-store" })).json();
      if (seq === seqRef.current && j.ok) {
        const incoming: Order[] = j.orders || [];
        const seen = new Set(orders.map((o) => o.key));
        const add = incoming.filter((o) => !seen.has(o.key)); // 커서 경계 안전망(중복 제거)
        if (!add.length) {
          setMore(false); setNextBefore(null); // 진전 없음 — 과거 내역 끝
        } else {
          setOrders((prev) => {
            const s2 = new Set(prev.map((o) => o.key));
            return [...prev, ...incoming.filter((o) => !s2.has(o.key))];
          });
          rowLimitRef.current = Math.min(4000, rowLimitRef.current + 1500);
          setMore(!!j.more);
          setNextBefore(j.next_before || null);
        }
      }
    } catch { /* 더 보기 실패는 표시만 유지 */ }
    setMoreBusy(false);
  }

  async function cancel(o: Order) {
    // 이동(채널이동 짝)은 move DELETE 로 — 음수 가드·요청서 재개 판정이 거기에만 있고, orders DELETE 는 이동을 거절한다(409).
    const move = isMoveOrder(o);
    const label = move ? `${o.move_from || "?"} → ${o.move_to || "?"} 이동` : (o.order_no || "이 건");
    const cnt = move ? Math.max(1, new Set(o.items.map((x) => `${x.sku ?? ""}|${x.product_name}`)).size) : o.item_count; // 이동은 출발·도착 두 행이라 품목 수로 센다
    const fulfillTail = move ? "" : isFulfillBatch(o)
      ? " 온라인발주 출고 묶음입니다 — 처리완료 주문 기록도 지워져 같은 주문을 다시 올리면 다시 출고됩니다(다른 배치로도 출고된 주문은 처리완료로 남습니다). 이 배치의 [재고 차감 기록]분도 함께 취소됩니다."
      : isLateBatch(o) && isGrouped(o)
        ? " 한 번에 기록한 묶음이면 그 코드가 [재고 차감 기록] 목록에 다시 올라갑니다."
        : "";
    if (!(await confirm({ title: `${label} (${cnt}개 품목) 취소`, body: `${move ? "양쪽 칸 재고와 요청서 배정이 원복됩니다." : o.status === "대기" ? "대기 기록이 지워집니다." : "재고가 원복됩니다."}${fulfillTail}`, action: move ? "이동 취소" : "기록 취소" }))) return;
    const url = move
      ? `/api/inventory/move?group_id=${encodeURIComponent(o.key)}`
      : `/api/inventory/orders?${isGrouped(o) ? `group_id=${encodeURIComponent(o.key)}` : `id=${encodeURIComponent(o.key)}`}`;
    setFlash(null);
    // 409 confirm_required(배치 한 줄·되살릴 수 없는 [재고 차감 기록] 묶음)는 서버 문구로 한 번 더 묻고 confirm=1 로 다시 보낸다.
    //  locked_* 등 규칙상 거부는 문구만 보인다(deleteLedger).
    const res = await deleteLedger(url, { confirm, error: toast.error });
    if (!res.ok) return;
    // 부분 성공(재고 행은 지웠고 처리완료 기록·[재고 차감 기록] 목록 재오픈 등 뒤처리만 실패)도 ok — 다시 읽고, 적어 둘 코드가 든 서버 문구를 경고로 남긴다(S9)
    if (res.notice) setFlash({ ok: !res.warn, text: res.notice });
    await load();
  }
  async function saveUnit(it: OrderItem) {
    if (saving) return;
    setSaving(true);
    const r = await fetch("/api/inventory/txn", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, unit_amount: editVal.trim() === "" ? null : Number(editVal) }),
    });
    const j = await r.json().catch(() => null);
    setSaving(false);
    if (!r.ok || !j?.ok) { toast.error(`단가 수정 실패: ${j?.error || "서버 오류"} — 새로고침 후 다시 시도하세요.`); return; }
    setEditId(null);
    // 목록을 다시 불러오지 않고 제자리 갱신 — '더 보기'로 내려간 과거 주문을 고쳐도 화면이 접히지 않게.
    //  금액 계산은 서버와 동일(단가 × 수량, 합계는 품목 합).
    const v = editVal.trim() === "" ? null : Math.max(0, Math.round(Number(editVal) || 0));
    setOrders((prev) => prev.map((o) => {
      if (!o.items.some((x) => x.id === it.id)) return o;
      const items = o.items.map((x) => (x.id === it.id ? { ...x, unit_amount: v, amount: (v || 0) * x.qty } : x));
      return { ...o, items, total_amount: items.reduce((s, x) => s + x.amount, 0) };
    }));
  }
  // 대기 → 입고처리/출고처리 — 처리일(실제로 들어오거나 나간 날, 기본 오늘)을 받는 창을 연다(ProcessModal)
  const [proc, setProc] = useState<Order | null>(null);
  // created_at(UTC timestamptz)을 한국(KST) 시각으로 표시. sv-SE 로케일 = "YYYY-MM-DD HH:mm:ss".
  const dt = (iso: string) => {
    if (!iso) return "-";
    try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16); }
    catch { return iso.slice(0, 16).replace("T", " "); }
  };

  const filtered = !!(fFrom || fTo || search || fType !== "전체");
  const clearFilters = () => { setFType("전체"); setFFrom(""); setFTo(""); setSearch(""); };
  const filters = (
    <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
      <div className="sm-tabs" style={{ margin: 0 }}>
        {(["전체", "입고", "출고"] as const).map((t) => (
          <button key={t} type="button" className={`sm-tab ${fType === t ? "is-active" : ""}`} onClick={() => setFType(t)}>{t}</button>
        ))}
      </div>
      <div className="sm-tabs" style={{ margin: 0 }}>
        <button type="button" className="sm-tab" onClick={() => { setFFrom(kstDay(0)); setFTo(kstDay(0)); }}>오늘</button>
        <button type="button" className="sm-tab" onClick={() => { setFFrom(kstDay(1)); setFTo(kstDay(1)); }}>어제</button>
        <button type="button" className="sm-tab" onClick={() => { setFFrom(kstDay(6)); setFTo(kstDay(0)); }}>7일</button>
        <button type="button" className="sm-tab" onClick={() => { setFFrom(""); setFTo(""); }}>전체</button>
      </div>
      <input className="b2b-input" type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={{ width: 145 }} title="시작일" />
      <span className="sm-faint">~</span>
      <input className="b2b-input" type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{ width: 145 }} title="종료일" />
      <input className="b2b-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="품목·SKU 검색" aria-label="품목·SKU·거래처·주문번호 검색(품목은 초성 가능)" style={{ width: 280, maxWidth: "100%" }} />
      {filtered && (
        <button className="b2b-link-btn" onClick={clearFilters}>조건 지우기</button>
      )}
    </div>
  );

  const today = KST_TODAY();
  const procModal = proc && <ProcessModal o={proc} onClose={() => setProc(null)} onDone={(f) => { setProc(null); setFlash(f); void load(); }} />;
  // 결과 배너 — 연결 안내·연결 실패는 경고, 그 밖은 성공. 여러 줄(연결 실패 품목)을 그대로 보인다.
  const flashEl = flash && (
    <div className={flash.ok ? "sm-success" : "sm-warn"} style={{ marginBottom: 12, whiteSpace: "pre-line", display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ flex: 1 }}>{flash.text}</span>
      <button className="b2b-link-btn" onClick={() => setFlash(null)}>닫기</button>
    </div>
  );
  const head = <>{filters}{flashEl}</>;

  // 재검색·재조회 중엔 기존 목록을 그대로 두고(깜빡임 방지), 첫 로드만 전체 로딩 표시
  if (loading && orders.length === 0) return <>{head}<div className="b2b-loading">불러오는 중...</div></>;
  if (error) return <>{head}<div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div></>;
  if (shown.length === 0) {
    if (loading) return <>{head}<div className="b2b-loading">검색 중...</div></>;
    return <>{head}<div className="b2b-empty">{orders.length === 0 && !filtered ? "입고·출고 기록이 없습니다." : "조건에 맞는 기록이 없습니다."}{filtered && <div className="b2b-empty-action"><button className="b2b-btn-secondary" onClick={clearFilters}>조건 지우기</button></div>}</div></>;
  }

  return (
    <>
    {head}
    <div className="b2b-table-wrap">
      <table className="b2b-table is-clickable">
        <thead><tr><th>상태</th><th>일시</th><th>주문번호</th><th>거래처</th><th>품목 수</th><th className="num">총수량</th><th className="num">총액</th><th>메모</th><th></th></tr></thead>
        <tbody>
          {shown.map((o) => {
            // 이동은 유형 색 지도에 없는 파생 라벨 — 중립 배지로 표시
            const c = o.type === "이동" ? { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" } : INV_TYPE_COLOR[o.type];
            const isOpen = open.has(o.key);
            const done = o.status === "완료";
            // 완료인데 거래일이 오늘 뒤 = 출고 예정(대부분 B2B 선점) — 오늘 재고에 아직 안 들어간 것과 구분해 보인다(S6·D1)
            const future = done && o.type !== "이동" && !!o.txn_date && o.txn_date > today;
            const badge = !done ? { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" } : future ? { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" } : c;
            return (
              <FragmentRows key={o.key}>
                <tr onClick={() => toggle(o.key)}>
                  {/* 이동 배지는 실제 칸 방향(출고 칸 → 입고 칸) — 도매 대량·프로모션 이동을 도매 이동으로 읽지 않게 */}
                  <td style={{ whiteSpace: "nowrap" }}>
                    <span className="b2b-status-pill" style={{ background: badge.bg, color: badge.fg }}>{o.type === "이동" ? (o.move_from && o.move_to ? `이동(${o.move_from}→${o.move_to})` : "이동") : future ? `${o.type} 예정 ${o.txn_date.slice(5)}` : `${o.type} ${o.status}`}</span>
                    {!done && o.txn_date && <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{o.txn_date.slice(5)}</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{dt(o.created_at)}</td>
                  <td style={{ whiteSpace: "nowrap", fontWeight: 700 }}>{o.order_no || <span className="sm-faint">단건</span>}</td>
                  <td>{o.partner || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{o.item_count}개 품목 <span style={{ color: "var(--sm-text-light)", fontSize: 12 }}>{isOpen ? "▲" : "▼"}</span></td>
                  <td className="num b2b-money">{o.total_qty.toLocaleString()}</td>
                  <td className="num b2b-money" style={{ fontWeight: 700 }}>{o.total_amount.toLocaleString()}</td>
                  <td style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={displayMemo(o.memo) || ""}>{displayMemo(o.memo) || "-"}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                    {!done && <button className="b2b-btn-secondary" style={{ padding: "3px 10px", fontSize: 12, marginRight: 6 }} onClick={() => setProc(o)}>{o.type === "입고" ? "입고처리" : "출고처리"}</button>}
                    {isB2bOrder(o)
                      ? <span className="sm-faint" style={{ fontSize: 12 }} title={o.source === "b2b_cancel_kept" ? "발송 후 취소(미반품) 출고 — 발주를 복구하면 함께 정리됩니다" : "발주의 발송일정에서 수정·삭제하면 재고가 함께 원복됩니다"}>발주에서</span>
                      : <button className="b2b-link-btn" onClick={() => cancel(o)} style={{ color: "var(--sm-danger)" }}>기록 취소</button>}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={9} style={{ background: "var(--sm-bg-subtle)", padding: "10px 16px" }}>
                      {/* tableLayout fixed — 어느 주문을 펼쳐도 세부 표 셀 폭 동일 */}
                      <div className="b2b-table-wrap">
                      <table className="b2b-table" style={{ background: "var(--sm-white)", tableLayout: "fixed", minWidth: 640 }}>
                        <thead><tr><th>제품</th><th className="num" style={{ width: 210 }}>수량</th><th className="num" style={{ width: 120 }}>단가</th><th className="num" style={{ width: 140 }}>금액</th></tr></thead>
                        <tbody>
                          {o.items.map((it) => {
                            const bal = balances[it.id];
                            return (
                              <tr key={it.id}>
                                <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.product_name}{it.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{it.sku}</span> : null}</td>
                                <td className="num" style={{ whiteSpace: "nowrap" }}>
                                  <span className="b2b-money" style={{ fontWeight: 700 }}>{it.qty.toLocaleString()}</span>
                                  {bal && <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>({bal.before.toLocaleString()} → {bal.after.toLocaleString()})</span>}
                                </td>
                                <td className="num b2b-money" style={{ whiteSpace: "nowrap" }}>
                                  {editId === it.id ? (
                                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                      <input
                                        autoFocus type="number" min={0} className="b2b-input" value={editVal}
                                        onChange={(e) => setEditVal(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") saveUnit(it); if (e.key === "Escape") setEditId(null); }}
                                        style={{ width: 80, padding: "3px 8px", fontSize: 15, textAlign: "right" }}
                                      />
                                      <button className="b2b-link-btn" onClick={() => saveUnit(it)} disabled={saving}>단가 저장</button>
                                      <button className="b2b-link-btn sm-faint" onClick={() => setEditId(null)}>그만두기</button>
                                    </span>
                                  ) : (
                                    <>
                                      {it.unit_amount ? it.unit_amount.toLocaleString() : "-"}
                                      <button className="b2b-link-btn sm-faint" style={{ marginLeft: 6, fontSize: 12 }} title="단가만 수정합니다 — 수량·날짜는 취소 후 다시 기록"
                                        onClick={() => { setEditId(it.id); setEditVal(it.unit_amount ? String(it.unit_amount) : ""); }}>단가 수정</button>
                                    </>
                                  )}
                                </td>
                                <td className="num b2b-money">{it.amount.toLocaleString()}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      </div>
                    </td>
                  </tr>
                )}
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
    </div>
    {more && !search.trim() ? (
      <div style={{ textAlign: "center", marginTop: 12 }}>
        <button className="b2b-btn-secondary" onClick={loadMore} disabled={moreBusy || loading}>
          {moreBusy ? "불러오는 중..." : "이전 내역 더 보기"}
        </button>
      </div>
    ) : !loading && (
      // 버튼이 없으면 "전부 불러온 것"임을 명시 — 버튼 부재가 미완성처럼 보이지 않게
      <p className="sm-faint" style={{ textAlign: "center", marginTop: 10, fontSize: 12 }}>
        {search.trim() ? `검색 결과 ${shown.length.toLocaleString()}건` : `${shown.length.toLocaleString()}건 — 전체를 불러왔습니다`}
      </p>
    )}
    {procModal}
    </>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) { return <>{children}</>; }

// 대기 → 완료 처리 창. 처리일 = 실제로 들어오거나 나간 날(기본 오늘 KST, 미래 불가 — 서버도 400).
//  서버가 거래일을 처리일로 바꿔 저장한다(S6 — 대기로 잡아 둔 날짜로 완료되면 과거 실사·과거 재고가 실제와 어긋난다).
//  제조사 입고는 즉시 처리 입고 화면과 같게 요청서를 고른다(지정 매칭, 기본 = 처리일이 생산기간에 드는 요청서).
//  '연결 안 함'이면 열린 요청서 잔여 확인(S9) — 대기로 저장할 때는 요청서를 고를 수 없어 여기가 유일한 확인 지점이다.
//  고객 반품(D4b)은 매입이 아니라 연결하지 않는다(서버도 연결 대상에서 뺀다).
function ProcessModal({ o, onClose, onDone }: { o: Order; onClose: () => void; onDone: (flash: Flash | null) => void }) {
  const confirm = useConfirm();
  const today = KST_TODAY();
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEscClose(onClose, busy);
  const label = o.type === "입고" ? "입고처리" : "출고처리";
  const customerReturn = o.type === "입고" && o.items.length > 0 && o.items.every((it) => it.reason === "고객 반품");
  const linkable = o.type === "입고" && !customerReturn;
  // 요청서 목록 — 처리일이 바뀌면 다시 받는다. 조회 실패면 선택을 비우고 경고(옛 목록·옛 기본값으로 연결하지 않게, S4).
  const [reqs, setReqs] = useState<OpenReq[]>([]);
  const [reqId, setReqId] = useState("");
  const [reqWarn, setReqWarn] = useState("");
  const [reqLoading, setReqLoading] = useState(linkable);
  const reqTouched = useRef(false);
  useEffect(() => {
    if (!linkable || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let alive = true;
    setReqLoading(true);
    fetch(`/api/production/requests/open?date=${date}`, { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!alive) return;
      setReqWarn(reqWarnOf(j));
      if (!j?.ok) { setReqId(""); setReqs([]); return; }
      const list: OpenReq[] = j.requests || [];
      setReqs(list);
      setReqId((cur) => (reqTouched.current && list.some((x) => x.id === cur) ? cur : reqTouched.current ? "" : j.default_id || ""));
    }).catch(() => { if (alive) { setReqWarn(reqWarnOf(null)); setReqId(""); setReqs([]); } })
      .finally(() => { if (alive) setReqLoading(false); });
    return () => { alive = false; };
  }, [linkable, date]);
  // 잔여 확인·연결 결과 문구용 품목(중복 제거). product_id 가 없는 구 응답이면 빈 id → 확인창이 잔여를 모른다고 묻는다.
  const checkItems = useMemo(() => {
    const seen = new Set<string>();
    return o.items.filter((it) => it.reason !== "고객 반품").flatMap((it) => {
      const pid = it.product_id || "";
      if (pid && seen.has(pid)) return [];
      if (pid) seen.add(pid);
      return [{ product_id: pid, name: it.product_name }];
    });
  }, [o.items]);
  const nameOf = (pid: string) => o.items.find((it) => it.product_id === pid)?.product_name || "품목";
  async function submit() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError("처리일을 고르세요."); return; }
    if (date > today) { setError("처리일은 오늘 이후로 할 수 없습니다."); return; }
    setBusy(true); setError("");
    try {
      const requestId = linkable ? reqId : "";
      // 연결 안 함 — 열린 요청서에 남은 수량이 있는 품목이면 확인(S9). 이미 물었으니 서버의 같은 안내(notice)는 다시 띄우지 않는다.
      const asked = linkable && !requestId;
      if (asked && !(await confirmUnlinkedInbound(date, checkItems, confirm))) { setBusy(false); return; }
      const key = isGrouped(o) ? { group_id: o.key } : { id: o.key };
      let r: Response;
      let j: { ok?: boolean; error?: string; link?: LinkResultLite | null; notice?: string | null } | null = null;
      try {
        r = await fetch(`/api/inventory/orders`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...key, status: "완료", date, ...(requestId ? { request_id: requestId } : {}) }) });
        j = await r.json().catch(() => null);
      } catch { throw new Error("응답을 받지 못했습니다 — 처리됐을 수 있으니 목록을 새로고침해 먼저 확인하세요."); }
      if (!r.ok || !j?.ok) throw new Error(`${label} 실패: ${j?.error || "서버 오류"}`);
      // 처리는 끝났다 — 연결 결과(실패 포함)·서버 안내(notice)는 목록 위 배너로 남기고 목록을 다시 불러온다.
      //  연결이 빠지면 입고는 그대로 두고 [입고 연결]로 다시 잇는다(S11). 연결 안 함을 이미 확인받았으면 같은 안내를 다시 띄우지 않는다.
      const title = `${label} ${o.order_no || "단건"} · `;
      if (j.link) onDone({ ok: !!j.link.ok && !(j.link.failed?.length), text: title + linkMessage(j.link, nameOf) });
      else if (j.notice && !asked) onDone({ ok: false, text: title + j.notice });
      else onDone(null);
      return;
    } catch (e) { setError(e instanceof Error ? e.message : `${label} 실패`); }
    setBusy(false);
  }
  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: linkable ? 480 : 400 }}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{label} · {o.order_no || "단건"}</span>
          <button className="b2b-modal-close" aria-label="닫기" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <label className="b2b-field"><span className="b2b-field-label">처리일</span>
            <input className="b2b-input" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} autoFocus /></label>
          <p className="sm-faint" style={{ fontSize: 12, margin: "4px 0 0" }}>
            거래일이 처리일로 바뀝니다{o.txn_date ? `(대기 날짜 ${o.txn_date.slice(5)})` : ""}{customerReturn ? " · 고객 반품이라 요청서에 연결하지 않습니다" : ""}
          </p>
          {linkable && (
            <div style={{ marginTop: 12 }}>
              <RequestSelect reqs={reqs} value={reqId} disabled={reqLoading} warn={reqWarn} onChange={(v) => { reqTouched.current = true; setReqId(v); }} />
            </div>
          )}
          {error && <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          <span />
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={busy}>그만두기</button>
            <button className="b2b-btn-primary" onClick={submit} disabled={busy || (linkable && reqLoading)}>{busy ? "처리 중..." : linkable && reqLoading ? "요청서 확인 중..." : label}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
