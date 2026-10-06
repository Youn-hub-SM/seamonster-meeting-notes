"use client";

// 생산 요청 목록 — 신청번호(req_no)별 요청서 + 품목별 입고 처리. (/production/request '생산 요청' 메뉴)
//  재고 목록(/inventory)의 '선택 N종 생산 요청' 버튼이 여기로 넘어와 새 요청 창을 연다(권장 수량 채움).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PR_LINE_COLOR, PR_PURPOSES, PR_PURPOSE_LABEL, UNREQUESTED_ITEM_MEMO, lineState, allLinesFilled, toPrPurpose, isFactoryPurpose, CONFIRMED_PURPOSES,
  type ProductionRequest, type PrItem, type PrStatus, type PrPurpose, DUE_LABEL,
} from "@/app/lib/wholesale-production";
import { defaultDueDate, defaultProdStart } from "@/app/lib/production-schedule";
import { Combobox } from "@/app/b2b/orders/Combobox";

// KST 오늘 — 서버(UTC SSR)·클라이언트 모두 서울 벽시계 날짜로 일치(새벽 하이드레이션 불일치 방지)
function todayIso() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number) => Math.round(n * 100) / 100;

// 행 액션 버튼 공통 모양(요청서 · 수정 · 삭제 · 마감 · 다시 열기) — 글꼴·크기 동일. 좁으면 줄바꿈(가로 스크롤 금지)
const ACT = { padding: "2px 7px", fontSize: 12, textDecoration: "none", whiteSpace: "nowrap" } as const;

// 요청서의 미입고 잔여 = 품목별 max(0, 요청 − 입고) 합 — production-inbound 의 '입고 예정' 정의와 같은 규칙.
//  (헤더 합계 차이로 세면 한 품목의 초과 입고가 다른 품목의 미입고를 상쇄해 안내가 사라진다)
const openRemainQty = (items: { requested_qty: number; received_qty: number }[]) =>
  Math.round(items.reduce((s, it) => s + Math.max(0, it.requested_qty - it.received_qty), 0) * 100) / 100;

// ───────────────────────────── 도매 재고 생산 요청 ─────────────────────────────

type Prod = { product_id: string; sku: string | null; name: string; spec: string | null; unit: string; qty: number };

type NewLine = {
  item_id?: string;          // 수정 모드: 기존 라인 id (신규 추가 라인은 없음)
  received: number;          // 수정 모드: 입고 누계 — 입고 있는 라인은 뺄 수 없음
  product_id: string; sku: string | null; name: string; spec: string | null; unit: string;
  stock: number | null;      // 도매재고(모를 때 null 표시)
  requested_qty: string; memo: string;
  auto?: boolean;            // 수정 모드: '[요청서에 없음]' 자동 줄(요청 0·입고 있음) — 수량을 넣으면 정식 요청 줄로 승격
};

export function RequestList() {
  const [requests, setRequests] = useState<ProductionRequest[]>([]);
  const [showDone, setShowDone] = useState(false); // 기본 진행(요청·진행중)만 — 완료·취소는 토글로
  // 탭 = 용도(PR_PURPOSES) 그대로 — 제조사(재고 보충, 이행=입고) / 도매(도매 납품) / 프로모션(113) / 도매 대량(115).
  //  라벨은 PR_PURPOSE_LABEL. 용도가 늘면 탭도 같이 는다.
  const [tab, setTab] = useState<PrPurpose>("재고 보충");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ warn: boolean; text: string } | null>(null); // 프로모션 마감 합류 결과
  const [products, setProducts] = useState<Prod[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editReq, setEditReq] = useState<ProductionRequest | null>(null); // 수정 모달 대상
  const [busy, setBusy] = useState(false);
  const [prefill, setPrefill] = useState<NewLine[] | null>(null); // 재고 목록에서 넘어온 품목·권장수량

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/production/requests", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRequests(j.requests || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const byTab = useMemo(
    () => requests.filter((r) => toPrPurpose(r.purpose) === tab), // 모르는 값(옛 데이터·미적용 환경)은 재고 보충 = 제조사 탭
    [requests, tab]);
  const displayed = useMemo(
    () => (showDone ? byTab : byTab.filter((r) => r.status === "요청" || r.status === "진행중")),
    [byTab, showDone]);
  // 이동으로 채우는 탭(도매·프로모션·도매 대량) 종합 — 열린(요청·진행중) 요청을 품목별로 합산해 한눈에.
  const wholesaleSummary = useMemo(() => {
    if (isFactoryPurpose(tab)) return [];
    const agg = new Map<string, { name: string; sku: string | null; requested: number; received: number }>();
    for (const r of byTab) {
      if (r.status !== "요청" && r.status !== "진행중") continue;
      for (const it of r.items) {
        const k = it.product_id;
        const cur = agg.get(k) ?? { name: it.name, sku: it.sku, requested: 0, received: 0 };
        cur.requested += it.requested_qty;
        cur.received += it.received_qty;
        agg.set(k, cur);
      }
    }
    return [...agg.values()].sort((a, b) => (b.requested - b.received) - (a.requested - a.received));
  }, [tab, byTab]);

  // 용도별 열린(요청·진행중) 건수 — 탭 배지. 용도가 늘어도 이 블록은 그대로다.
  const tabCounts = useMemo(() => {
    const m = new Map<PrPurpose, number>(PR_PURPOSES.map((p) => [p, 0]));
    for (const r of requests) {
      if (r.status !== "요청" && r.status !== "진행중") continue;
      const p = toPrPurpose(r.purpose);
      m.set(p, (m.get(p) || 0) + 1);
    }
    return m;
  }, [requests]);

  // 담당자 '확인' 버튼용 로그인 사용자 이름
  const [userName, setUserName] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" }).then((r) => r.json()).then((j) => setUserName(j?.ok ? j.name || null : null)).catch(() => {});
  }, []);

  const [retailQty, setRetailQty] = useState<Map<string, number>>(new Map()); // 소매 현재고(제조사 요청 작성 시 표시)
  // 도매 필요량 = 열린(요청·진행중) 도매 요청의 잔여(요청-이전) 합 — 제조사 요청 수량 판단 근거
  const wholesaleNeed = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of requests) {
      if (r.purpose !== "도매 납품" || (r.status !== "요청" && r.status !== "진행중")) continue;
      for (const it of r.items) m.set(it.product_id, (m.get(it.product_id) || 0) + Math.max(0, it.requested_qty - it.received_qty));
    }
    return m;
  }, [requests]);
  useEffect(() => {
    (async () => {
      try {
        const [w, r] = await Promise.all([
          (await fetch("/api/inventory/overview?channel=도매", { cache: "no-store" })).json(),
          (await fetch("/api/inventory/overview?channel=소매", { cache: "no-store" })).json(),
        ]);
        // 묶음(세트)은 자체 재고가 없어(구성품 기준) 생산 입고 대상이 아님 → 선택기에서 제외.
        if (w.ok) setProducts((w.rows || []).filter((x: { is_bundle?: boolean }) => !x.is_bundle).map((x: Prod) => ({ product_id: x.product_id, sku: x.sku, name: x.name, spec: x.spec, unit: x.unit, qty: x.qty })));
        if (r.ok) setRetailQty(new Map((r.rows || []).map((x: { product_id: string; qty: number }) => [x.product_id, Number(x.qty) || 0])));
      } catch { /* noop */ }
    })();
  }, []);

  // 권장 원자료 — 재고 목록 권장 열과 같은 합산식(①원값+②−⑤)을 창 안에서 재계산한다(수정 창의 자기 잔여 차감 때문).
  //  recReady=false 면 모달은 권장을 '-' 로 표시한다(로드 전/실패를 '권장 0' 으로 오독하면 수량을 깎게 된다).
  //  소매 행은 권장뿐 아니라 원값(입고 예정·현재고·안전재고·수요)까지 보관한다 — 수정 창이 자기 요청서 잔여를 빼고 다시 계산하기 위해.
  //  요청서를 만들거나 고치면(잔여가 바뀌면) 다시 조회한다 — 마운트 스냅샷만 쓰면 방금 만든 요청서가 '입고 예정 0' 으로 보여 같은 물량을 또 시킨다.
  const [recRetail, setRecRetail] = useState<Map<string, RecRow>>(new Map());
  const [recWhole, setRecWhole] = useState<Map<string, number>>(new Map()); // 도매 gross ② — 제조사 planFor 전용
  const [recWholeReq, setRecWholeReq] = useState<Map<string, number>>(new Map()); // 도매 요청 잔여(R) — 도매 납품 권장에서만 뺀다
  const [wholeReqOk, setWholeReqOk] = useState(true);
  const [recReady, setRecReady] = useState(false);
  const [inbOk, setInbOk] = useState(true); // 입고 예정 집계 실패면 권장이 시켜 둔 물량을 못 뺀 값 — 창에 경고
  const recSeq = useRef(0); // 순번 가드 — 늦게 온 옛 응답이 최신 입고 예정을 덮어쓰지 않게
  const loadRec = useCallback(async () => {
    const seq = ++recSeq.current;
    setRecReady(false);
    try {
      const [r, w] = await Promise.all([
        (await fetch("/api/production/inventory?channel=소매", { cache: "no-store" })).json(),
        (await fetch("/api/production/inventory?channel=도매", { cache: "no-store" })).json(),
      ]);
      if (seq !== recSeq.current) return; // 그 사이 새 조회가 나감 — 이 응답은 버린다
      type Row = { sku: string; recommend: number; inbound?: number; stock?: number | null; safety?: number; demand?: number; wholesaleReq?: number };
      if (r.ok) {
        setRecRetail(new Map(((r.rows || []) as Row[]).map((x) => [x.sku.toUpperCase(), {
          recommend: Number(x.recommend) || 0, inbound: Number(x.inbound) || 0,
          stock: x.stock == null ? null : Number(x.stock), safety: Number(x.safety) || 0, demand: Number(x.demand) || 0,
        }])));
        setInbOk(r.inboundOk !== false);
      }
      if (w.ok) {
        setRecWhole(new Map(((w.rows || []) as Row[]).map((x) => [x.sku.toUpperCase(), Number(x.recommend) || 0])));
        setRecWholeReq(new Map(((w.rows || []) as Row[]).map((x) => [x.sku.toUpperCase(), Number(x.wholesaleReq) || 0])));
        setWholeReqOk(w.wholesaleReqOk !== false);
      }
      if (r.ok && w.ok) setRecReady(true);
    } catch { /* 권장 없이도 요청 작성은 가능 — 권장 열은 '-' 로 남는다 */ }  }, []);
  useEffect(() => { loadRec(); }, [loadRec]);

  // 재고 목록 '선택 N종 생산 요청' → 핸드오프: sessionStorage 의 {purpose, at, items:[{sku, qty}]} 를
  //  품목 목록 로드 후 SKU로 매칭해, 권장 수량이 채워진 새 요청 모달을 자동으로 연다. (구 배열 형식도 허용)
  useEffect(() => {
    if (!products.length) return;
    let raw: string | null = null;
    try { raw = sessionStorage.getItem("prod_req_prefill"); sessionStorage.removeItem("prod_req_prefill"); } catch { /* noop */ }
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const obj = parsed && !Array.isArray(parsed) && typeof parsed === "object" ? (parsed as { purpose?: unknown; at?: unknown; items?: unknown }) : null;
      // 넘어온 지 10분이 지난 권장은 버린다 — 품목 로드 실패로 소비되지 않고 남았다가 한참 뒤 낡은 수량으로 열리는 것 방지
      const at = Number(obj?.at) || 0;
      if (at && Date.now() - at > 10 * 60_000) return;
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(obj?.items) ? (obj!.items as unknown[]) : [];
      // 안 넘어왔거나 모르는 값이면 null = 탭을 바꾸지 않는다(toPrPurpose 는 모르는 값을 재고 보충으로 바꾸므로 여기선 쓰지 않는다)
      const purpose: PrPurpose | null = (PR_PURPOSES as readonly string[]).includes(String(obj?.purpose ?? "")) ? (obj!.purpose as PrPurpose) : null;
      const lines: NewLine[] = [];
      const missed: string[] = [];
      for (const it of arr as { sku?: unknown; qty?: unknown }[]) {
        const sku = String(it?.sku ?? "").trim();
        if (!sku) continue;
        const p = products.find((x) => (x.sku || "").toUpperCase() === sku.toUpperCase());
        if (!p) { missed.push(sku); continue; }
        const qty = Math.max(0, Math.round(Number(it?.qty) || 0));
        lines.push({ received: 0, product_id: p.product_id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit, stock: p.qty, requested_qty: qty ? String(qty) : "", memo: "" });
      }
      if (missed.length) setError(`넘어온 품목 중 ${missed.length}종은 품목 목록에 없어 제외했습니다: ${missed.join(", ")} (묶음이거나 SKU 미등록)`);
      if (lines.length) {
        if (purpose) setTab(purpose); // 모달 기본 요청도 탭을 따라간다
        setPrefill(lines); setCreateOpen(true);
      }
    } catch { /* 형식 오류 — 무시 */ }
  }, [products]);

  // 목록 갱신 후 펼친 요청서 최신본 반영
  function applyUpdated(updated: ProductionRequest) {
    setRequests((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
  }

  async function createRequest(payload: unknown) {
    setBusy(true); setError("");
    try {
      const j = await (await fetch("/api/production/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).json();
      if (!j.ok) throw new Error(j.error || "생성 실패");
      setCreateOpen(false);
      setPrefill(null); // 소비 완료 — 안 지우면 다음 '+ 새 생산 요청'에 방금 요청한 품목이 다시 채워져 중복 요청이 된다
      void loadRec(); // 방금 만든 요청서 잔여가 '입고 예정'에 반영되도록 권장 재조회
      await load();
      if (j.request?.purpose) setTab(toPrPurpose(j.request.purpose)); // 창에서 용도를 바꿔 만들었으면 그 탭으로 — 안 보이면 또 만든다
      setExpandedId(j.request?.id ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "생성 오류"); }
    setBusy(false);
  }

  async function updateRequest(id: string, payload: unknown) {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/production/requests/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await res.json();
      // 409(그사이 완료·취소·상태 변경) — 창을 닫아 새로 읽은 목록과 오류가 보이게 한다(창이 가리면 같은 저장을 되풀이한다)
      if (!j.ok) { if (res.status === 409) { setEditReq(null); setCreateOpen(false); void load(); window.scrollTo({ top: 0, behavior: "smooth" }); } throw new Error(j.error || "수정 실패"); }
      applyUpdated(j.request);
      setEditReq(null);
      void loadRec(); // 수량·상태 변경 = 잔여 변경 → 입고 예정·권장 재조회
    } catch (e) { setError(e instanceof Error ? e.message : "수정 오류"); }
    setBusy(false);
  }

  // expect_status = 화면이 알고 있던 상태 — 그사이 자동 완료·취소됐으면 서버가 409 로 거부하고 목록을 새로 읽는다(스냅샷으로 되살리기 방지)
  async function patchStatus(id: string, status: PrStatus, expect?: PrStatus) {
    setBusy(true); setError(""); setNotice(null);
    try {
      const res = await fetch(`/api/production/requests/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, ...(expect ? { expect_status: expect } : {}) }) });
      const j = await res.json();
      if (!j.ok) { if (res.status === 409) void load(); throw new Error(j.error || "변경 실패"); }
      applyUpdated(j.request);
      // 프로모션 마감 = 소매 합류 결과
      const pr = j.promo_release as { moved: { name: string; qty: number }[]; kept: { name: string; qty: number }[]; failed: string[]; error?: string } | undefined;
      if (pr) {
        const list = (xs: { name: string; qty: number }[]) => xs.map((x) => `${x.name} ×${x.qty.toLocaleString()}`).join(", ");
        if (pr.error) setNotice({ warn: true, text: `${status}했지만 프로모션 재고를 소매로 옮기지 못했습니다(${pr.error}) — '재고 이동'에서 프로모션 → 소매로 직접 옮기세요.` });
        else setNotice({
          warn: pr.failed.length > 0,
          text: [
            pr.moved.length ? `${status} — 프로모션 재고를 소매로 옮겼습니다: ${list(pr.moved)}` : `${status} — 소매로 옮길 프로모션 재고가 없습니다.`,
            pr.kept.length ? `다른 열린 프로모션 요청서 몫으로 남김: ${list(pr.kept)}` : "",
            pr.failed.length ? `옮기지 못함: ${pr.failed.join(", ")} — '재고 이동'에서 직접 옮기세요.` : "",
          ].filter(Boolean).join(" · "),
        });
      }
      void loadRec(); // 완료·취소·다시 열기 = 입고 예정 변경
    } catch (e) { setError(e instanceof Error ? e.message : "변경 오류"); }
    setBusy(false);
  }

  async function removeRequest(r: ProductionRequest) {
    // 입고 기록이 있으면 삭제 불가(입고 증거·재고 정합) → '취소' 상태 전환으로 대체.
    const hasReceipts = r.items.some((it) => it.receipts.length > 0);
    // 제조사 요청의 미입고 잔여는 재고 목록 '입고 예정'으로 권장생산에서 빠져 있다 — 닫으면 그만큼 권장이 다시 올라간다
    const remain = openRemainQty(r.items);
    const inbNote = r.purpose === "재고 보충" && remain > 0 ? `\n\n미입고 ${remain.toLocaleString()}개는 '입고 예정'에서 빠져 재고 목록의 권장생산이 그만큼 늘어납니다.`
      : r.purpose === "도매 납품" && remain > 0 ? `\n\n미이동 ${remain.toLocaleString()}개는 도매 '입고 예정'에서 빠져 도매 권장생산이 그만큼 늘어납니다.`
      : r.purpose === "프로모션" && hasReceipts ? "\n\n취소하면 이 요청서 품목의 프로모션 재고가 소매로 넘어갑니다(같은 품목의 다른 열린 프로모션 요청서에 배정된 수량은 남깁니다)." : "";
    if (hasReceipts) {
      if (!confirm(`입고 기록이 있어 삭제할 수 없습니다.\n대신 '취소' 상태로 바꿀까요?\n(기록은 보존되고 목록·이행률에서 빠집니다)${inbNote}`)) return;
      await patchStatus(r.id, "취소", r.status);
      return;
    }
    if (!confirm(`이 요청서를 삭제할까요?${inbNote}`)) return;
    setBusy(true); setError("");
    try {
      const j = await (await fetch(`/api/production/requests/${r.id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "삭제 실패");
      setRequests((prev) => prev.filter((x) => x.id !== r.id));
      void loadRec();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 오류"); }
    setBusy(false);
  }

  async function cancelReceipt(id: string, rid: string) {
    if (!confirm("이 입고를 취소할까요? 도매 재고에서도 원복됩니다.")) return;
    setBusy(true); setError("");
    try {
      const j = await (await fetch(`/api/production/requests/${id}/receive?rid=${rid}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "취소 실패");
      applyUpdated(j.request);
      void loadRec(); // 입고 취소 = 잔여 복원
    } catch (e) { setError(e instanceof Error ? e.message : "취소 오류"); }
    setBusy(false);
  }

  const doneCount = useMemo(() => byTab.filter((r) => r.status === "완료" || r.status === "취소").length, [byTab]);
  // 종료일 지난 열린 제조사·도매 요청서(현재 탭) — 잔여가 입고 예정에 남아 권장을 누르므로 마감(또는 종료일 수정) 대상.
  //  도매 요청 잔여는 도매 탭 권장에서 빠진다(2026-09-29) — 자동 마감이 없어 잊힌 요청이 도매 권장을 누른다.
  const overdueOpen = useMemo(() => {
    const t = todayIso();
    if (tab !== "재고 보충" && tab !== "도매 납품") return 0;
    return requests.filter((r) => r.purpose === tab && (r.status === "요청" || r.status === "진행중") && !!r.due_date && r.due_date < t && openRemainQty(r.items) > 0).length;
  }, [requests, tab]);

  // 행사일(목표일)이 된 열린 프로모션 요청서 — 자동 합류가 없으니(2026-10-06) 사람이 '마감'해야 확보분이 소매로 간다
  const promoDue = useMemo(() => {
    if (tab !== "프로모션") return 0;
    const t = todayIso();
    return requests.filter((r) => r.purpose === "프로모션" && (r.status === "요청" || r.status === "진행중") && !!r.due_date && r.due_date <= t).length;
  }, [requests, tab]);

  // 생산 담당자 확인 — 담당자=본인 기록 + 진행중 전환(제조사에 전달했다는 표시)
  async function confirmRequest(r: ProductionRequest) {
    await updateRequest(r.id, { assignee: userName || "확인", status: r.status === "요청" ? "진행중" : r.status, expect_status: r.status });
  }

  return (
    <div>
      {error && <div className="b2b-error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className={notice.warn ? "sm-warn" : "sm-success"} style={{ marginBottom: 12 }}>{notice.text}</div>}

      <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div className="sm-row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div className="sm-tabs" style={{ margin: 0 }}>
            {PR_PURPOSES.map((pp) => (
              <button key={pp} className={`sm-tab ${tab === pp ? "is-active" : ""}`} onClick={() => setTab(pp)}>{PR_PURPOSE_LABEL[pp]} 요청<span className="sm-tab-count">{tabCounts.get(pp) || 0}</span></button>
            ))}
          </div>
          {tab === "프로모션" && promoDue > 0 && (
            <span className="b2b-status-pill" style={{ background: "var(--sm-danger-bg)", color: "var(--sm-danger)" }}>행사일이 된 프로모션 요청서 {promoDue}건 — '마감'을 누르면 확보분이 소매로 넘어갑니다</span>
          )}
          {(tab === "재고 보충" || tab === "도매 납품") && overdueOpen > 0 && (
            <span className="b2b-status-pill" style={{ background: "var(--sm-danger-bg)", color: "var(--sm-danger)" }}>종료일 지난 요청서 {overdueOpen}건 — 마감하거나 종료일을 고치세요</span>
          )}
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)", cursor: "pointer" }}>
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 완료·취소 보기 <span className="sm-faint" style={{ fontSize: 12 }}>({doneCount})</span>
          </label>
        </div>
        <div className="sm-row" style={{ gap: 8 }}>
          <button className="b2b-btn-secondary" onClick={() => { load(); void loadRec(); }} disabled={loading}>{loading ? "불러오는 중..." : "새로고침"}</button>
          <button className="b2b-btn-primary" onClick={() => { setError(""); setCreateOpen(true); }} disabled={busy}>+ 새 생산 요청</button>
        </div>
      </div>

      {!isFactoryPurpose(tab) && wholesaleSummary.length > 0 && (
        <section className="b2b-form-section" style={{ marginBottom: 16 }}>
          <div className="b2b-form-section-title" style={{ marginBottom: 10 }}>{PR_PURPOSE_LABEL[tab]} 요청 종합 <span className="sm-faint" style={{ fontWeight: 400, textTransform: "none" }}>· 열린 요청 기준</span></div>
          <div className="b2b-table-wrap">
            <table className="b2b-table" style={{ tableLayout: "fixed", minWidth: 560, fontSize: 15 }}>
              <thead><tr><th>품목</th><th className="num" style={{ width: "14%" }}>요청</th><th className="num" style={{ width: "14%" }}>이전 완료</th><th className="num" style={{ width: "14%" }}>잔여</th><th className="num" style={{ width: "12%" }}>이행률</th></tr></thead>
              <tbody>
                {wholesaleSummary.map((r) => {
                  const remain = r.requested - r.received;
                  const pct = r.requested > 0 ? Math.round((r.received / r.requested) * 100) : 0;
                  return (
                    <tr key={`${r.name}-${r.sku}`}>
                      <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}{r.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{r.sku}</span> : null}</td>
                      <td className="num b2b-money">{r.requested.toLocaleString()}</td>
                      <td className="num b2b-money">{r.received.toLocaleString()}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700, color: remain > 0 ? "var(--sm-orange)" : "var(--sm-success)" }}>{remain.toLocaleString()}</td>
                      <td className="num" style={{ color: pct >= 100 ? "var(--sm-success)" : "var(--sm-text-mid)" }}>{pct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : displayed.length === 0 ? (
        <div className="b2b-empty">{showDone ? `${PR_PURPOSE_LABEL[tab]} 요청이 없습니다.` : `진행 중인 ${PR_PURPOSE_LABEL[tab]} 요청이 없습니다.`}</div>
      ) : (
        <section className="b2b-form-section">
        <div className="b2b-form-section-title" style={{ marginBottom: 10 }}>{PR_PURPOSE_LABEL[tab]} 요청 목록</div>
        <div className="b2b-table-wrap">
          {/* tableLayout fixed — 탭(제조사/도매) 전환 시 내용 길이와 무관하게 두 탭의 표 모양 동일 */}
          <table className="b2b-table" style={{ tableLayout: "fixed", minWidth: 940 }}>
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th style={{ width: "9%" }}>요청번호</th>
                <th>품목</th>
                <th className="b2b-col-date" style={{ width: "11%" }}>진행</th>
                <th className="b2b-col-date" style={{ width: "9%" }}>요청일</th>
                <th className="b2b-col-date" style={{ width: "11%" }}>마감일</th>
                <th className="b2b-col-date" style={{ width: "8%" }}>담당</th>
                <th style={{ width: "18%" }}></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((r) => (
                <RequestRow
                  key={r.id} req={r} expanded={expandedId === r.id} busy={busy}
                  onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
                  onCancelReceipt={(rid) => cancelReceipt(r.id, rid)}
                  onStatus={(s) => patchStatus(r.id, s, r.status)}
                  onConfirm={() => confirmRequest(r)}
                  onEdit={() => { setError(""); setEditReq(r); }}
                  onDelete={() => removeRequest(r)}
                />
              ))}
            </tbody>
          </table>
        </div>
        </section>
      )}

      {createOpen && <RequestModal products={products} retailQty={retailQty} wholesaleNeed={wholesaleNeed} error={error} recRetail={recRetail} recWhole={recWhole} recWholeReq={recWholeReq} wholeReqOk={wholeReqOk} recReady={recReady} inbOk={inbOk} prefill={prefill ?? undefined} defaultPurpose={tab} busy={busy} onClose={() => { setCreateOpen(false); setPrefill(null); }} onSubmit={createRequest} />}
      {editReq && <RequestModal initial={editReq} products={products} retailQty={retailQty} wholesaleNeed={wholesaleNeed} error={error} recRetail={recRetail} recWhole={recWhole} recWholeReq={recWholeReq} wholeReqOk={wholeReqOk} recReady={recReady} inbOk={inbOk} busy={busy} onClose={() => setEditReq(null)} onSubmit={(payload) => updateRequest(editReq.id, payload)} />}
    </div>
  );
}

// 진행(입고/요청) 표시 — 테이블 셀용 텍스트. 초과=danger, 완료=success, 그 외 회색.
function ProgressCell({ received, requested }: { received: number; requested: number }) {
  const over = received > requested;
  const done = requested > 0 && received >= requested;
  const color = over ? "var(--sm-danger)" : done ? "var(--sm-success)" : "var(--sm-text-mid)";
  const pct = requested > 0 ? (received / requested) * 100 : null;
  // 열 너비(fixed layout)를 넘지 않게 %는 둘째 줄로 — 숫자가 길어도 옆 칸을 침범하지 않는다
  return (
    <span style={{ fontSize: 15, fontWeight: 600, color, whiteSpace: "nowrap" }}>
      {received.toLocaleString()} / {requested.toLocaleString()}
      {pct != null && <span className="sm-faint" style={{ display: "block", fontSize: 12, fontWeight: 400 }}>({Math.round(pct)}%)</span>}
    </span>
  );
}

// 발주관리 테이블과 동일한 형태 — 한 줄=한 요청, 클릭하면 그 아래 확장 행으로 입고 처리 상세가 펼쳐짐.
function RequestRow({ req, expanded, busy, onToggle, onCancelReceipt, onStatus, onConfirm, onEdit, onDelete }: {
  req: ProductionRequest; expanded: boolean; busy: boolean;
  onToggle: () => void;
  onCancelReceipt: (rid: string) => void;
  onStatus: (s: PrStatus) => void;
  onConfirm: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const suggestComplete = req.status === "진행중" && allLinesFilled(req.items);
  const editable = req.status === "요청" || req.status === "진행중";
  // 요청수량 0 = 요청서에 없던 품목이 그 주간에 입고돼 자동으로 붙은 줄 — '×0' 대신 그 뜻을 적는다
  const itemLabel = (it: PrItem) => `${it.name}${it.spec ? ` ${it.spec}` : ""}${it.requested_qty <= 0 && it.memo === UNREQUESTED_ITEM_MEMO ? ` (요청서에 없음 +${it.received_qty.toLocaleString()})` : ` ×${it.requested_qty.toLocaleString()}`}`;
  const itemPreview = req.items.slice(0, 2).map(itemLabel).join(" · ");
  // 셀이 말줄임으로 잘리므로 전체 품목은 마우스 오버 툴팁으로 — 한 줄에 한 품목
  const itemsFull = req.items.map(itemLabel).join("\n");
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }} className={expanded ? "is-parent" : ""}>
        <td style={{ padding: "8px", color: "var(--sm-text-light)" }}>{expanded ? "▾" : "▸"}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          <span style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontWeight: 700, color: "var(--sm-dark)" }}>{req.req_no || "—"}</span>
          {req.title ? <span className="sm-faint" style={{ display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{req.title}</span> : null}
        </td>
        <td title={itemsFull} style={{ fontSize: 15, color: "var(--sm-text-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {itemPreview || "품목 없음"}
          {req.items.length > 2 ? <span className="sm-faint"> 외 {req.items.length - 2}종</span> : null}
        </td>
        <td className="b2b-col-date"><ProgressCell received={req.total_received} requested={req.total_requested} /></td>
        <td className="b2b-col-date" style={{ whiteSpace: "nowrap" }}>
          {req.request_date}
          {req.requested_by ? <span className="sm-faint" style={{ display: "block", fontSize: 12 }}>{req.requested_by}</span> : null}
        </td>
        <td className="b2b-col-date" style={{ whiteSpace: "nowrap" }}>
          {req.due_date || "-"}
          {req.purpose === "재고 보충" && req.prod_start ? <span className="sm-faint" style={{ display: "block", fontSize: 12 }}>{req.prod_start.slice(5)}~{(req.due_date || "").slice(5)}</span> : null}
          {/* 종료일이 지났는데 열려 있으면 마감(또는 종료일 수정)이 필요하다 — 잔여가 입고 예정에 남아 권장을 누른다 */}
          {(req.purpose === "재고 보충" || req.purpose === "도매 납품") && (req.status === "요청" || req.status === "진행중") && req.due_date && req.due_date < todayIso() && openRemainQty(req.items) > 0
            ? <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--sm-danger)" }}>지남 · 잔여 {openRemainQty(req.items).toLocaleString()}</span> : null}
          {req.purpose === "프로모션" && (req.status === "요청" || req.status === "진행중") && req.due_date && req.due_date <= todayIso()
            ? <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--sm-danger)" }}>행사일 · 마감하면 소매로</span> : null}
        </td>
        <td className="b2b-col-date" onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
          {/* 생산 담당자 확인 — 확인하면 담당=본인 기록(+진행중 전환). 요청서를 제조사에 건네는 사람이 담당. */}
          {req.assignee ? (
            <span style={{ fontSize: 15, fontWeight: 600 }}>{req.assignee}
              {(req.status === "완료" || req.status === "취소") && <span className="sm-faint" style={{ marginLeft: 5, fontSize: 12 }}>{req.status}</span>}
            </span>
          ) : (req.status === "요청" || req.status === "진행중") ? (
            <button className="b2b-btn-secondary" style={{ padding: "2px 7px", fontSize: 12 }} disabled={busy} onClick={onConfirm}>확인</button>
          ) : (
            <span className="sm-faint" style={{ fontSize: 12 }}>{req.status}</span>
          )}
        </td>
        <td onClick={(e) => e.stopPropagation()} style={{ paddingLeft: 8, paddingRight: 8 }}>
          {/* 행 액션 4개(요청서 · 수정 · 삭제 · 마감)는 같은 버튼 모양·글꼴 — 대표 지시. 닫힌 요청서는 마감 대신 다시 열기 */}
          <div className="sm-row" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <a className="b2b-btn-secondary" style={ACT} href={`/api/production/requests/${req.id}/sheet`}>요청서</a>
          {editable && <button className="b2b-btn-secondary" style={ACT} disabled={busy} onClick={onEdit}>수정</button>}
          {(req.status === "완료" || req.status === "취소") ? (
            <button className="b2b-btn-secondary" style={ACT} disabled={busy} onClick={() => onStatus("진행중")}>다시 열기</button>
          ) : (
            <>
              <button className="b2b-btn-secondary" style={ACT} disabled={busy} onClick={onDelete}>삭제</button>
              {/* 마감 — 전 품목 100%면 자동으로 닫히지만, 덜 들어온 채 끝낼 때 사람이 닫는다(수동 마감은 입고 취소로 되살아나지 않음).
                  프로모션은 자동으로 닫히지 않고 마감 = 확보분 소매 합류(2026-10-06) */}
              <button className="b2b-btn-secondary" style={ACT} disabled={busy}
                onClick={() => {
                  const pct = req.total_requested > 0 ? Math.round((req.total_received / req.total_requested) * 100) : 0;
                  const remain = openRemainQty(req.items);
                  const inbNote = req.purpose === "재고 보충" && remain > 0
                    ? `\n\n미입고 ${remain.toLocaleString()}개는 입고 예정에서 빠집니다. 아직 올 물량이면 마감하지 마세요.`
                    : req.purpose === "도매 납품" && remain > 0
                    ? `\n\n미이동 ${remain.toLocaleString()}개는 도매 입고 예정에서 빠집니다. 아직 옮길 물량이면 마감하지 마세요.`
                    : req.purpose === "프로모션"
                    ? "\n\n마감하면 이 요청서 품목의 프로모션 재고가 소매로 넘어갑니다(같은 품목의 다른 열린 프로모션 요청서에 배정된 수량은 남깁니다). 행사 판매를 시작할 때 누르세요."
                    : "";
                  if (confirm(`이행률 ${pct}% (${req.total_received.toLocaleString()}/${req.total_requested.toLocaleString()}) — 마감할까요?${inbNote}`)) onStatus("완료");
                }}>마감</button>
            </>
          )}
          </div>
        </td>
      </tr>

      {expanded && (
        <tr className="b2b-child-row">
          <td></td>
          <td colSpan={7} style={{ padding: "8px 18px 16px" }}>
            {req.memo && <p className="sm-faint" style={{ fontSize: 15, marginBottom: 10, whiteSpace: "pre-line" }}>메모: {req.memo}</p>}
            <div className="b2b-table-wrap">
              <table className="b2b-table" style={{ tableLayout: "fixed", minWidth: 700 }}>
                <thead>
                  <tr><th>품목</th><th className="num" style={{ width: "12%" }}>요청</th><th className="num" style={{ width: "12%" }}>{req.purpose === "재고 보충" ? "입고" : "이전"}</th><th className="num" style={{ width: "12%" }}>잔여</th><th style={{ width: "10%" }}>상태</th><th style={{ width: "18%" }}>입고 이력</th></tr>
                </thead>
                <tbody>
                  {req.items.map((it) => (
                    <ItemRow key={it.id} item={it} canEdit={req.status !== "완료" && req.status !== "취소"} busy={busy} onCancelReceipt={onCancelReceipt} />
                  ))}
                </tbody>
              </table>
            </div>

            {suggestComplete && (req.status === "요청" || req.status === "진행중") && (
              <p style={{ fontSize: 15, color: "var(--sm-success)", margin: "10px 0 0" }}>{req.purpose === "프로모션"
                ? "모든 품목이 배정됐습니다 — 행사 판매를 시작할 때 행의 '마감'을 누르면 확보분이 소매로 넘어갑니다."
                : "모든 품목이 요청 수량 이상 들어왔습니다 — 행의 '마감'을 누르세요."}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ItemRow({ item, canEdit, busy, onCancelReceipt }: {
  item: PrItem; canEdit: boolean; busy: boolean;
  onCancelReceipt: (rid: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const remaining = item.requested_qty - item.received_qty;
  const st = lineState(item.requested_qty, item.received_qty);

  return (
    <>
      <tr>
        <td>
          <div style={{ fontWeight: 600 }}>{item.name}</div>
          <div style={{ fontSize: 15, color: "var(--sm-text-light)" }}>{item.sku || ""}{item.spec ? ` · ${item.spec}` : ""}</div>
        </td>
        <td className="num">{st === "요청서에 없음" ? <span className="sm-faint" title="요청서에 없던 품목이 이 주간에 입고돼 자동으로 붙은 줄">-</span> : item.requested_qty.toLocaleString()}</td>
        <td className="num" style={{ fontWeight: 700 }}>{item.received_qty.toLocaleString()}</td>
        <td className="num" style={{ color: st === "요청서에 없음" ? "var(--sm-text-light)" : remaining > 0 ? "var(--sm-text-mid)" : remaining < 0 ? "var(--sm-danger)" : "var(--sm-success)" }}>{st === "요청서에 없음" ? "-" : remaining.toLocaleString()}</td>
        <td><span style={{ fontSize: 15, fontWeight: 700, color: PR_LINE_COLOR[st] }}>{st}</span></td>
        <td>
          {item.receipts.length > 0 ? (
            <button className="b2b-btn-secondary" style={{ padding: "4px 12px" }} disabled={busy} onClick={() => setOpen((v) => !v)}>{open ? "닫기" : "입고 이력"}</button>
          ) : <span style={{ fontSize: 15, color: "var(--sm-text-light)" }}>—</span>}
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={6} style={{ background: "var(--sm-bg-subtle)" }}>

            {item.receipts.length > 0 ? (
              <div style={{ marginTop: canEdit ? 10 : 2 }}>
                <div className="sm-faint" style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>입고 이력</div>
                {item.receipts.map((rc) => (
                  <div key={rc.id} className="sm-row" style={{ gap: 8, alignItems: "center", fontSize: 15, padding: "3px 2px", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--sm-text-light)" }}>{rc.receipt_date}</span>
                    <span style={{ fontWeight: 700, color: rc.qty < 0 ? "var(--sm-danger)" : "var(--sm-success)" }}>{rc.qty > 0 ? "+" : ""}{rc.qty.toLocaleString()}</span>
                    {rc.received_by && <span style={{ color: "var(--sm-text-mid)" }}>{rc.received_by}</span>}
                    {rc.memo && <span style={{ color: "var(--sm-text-mid)" }}>· {rc.memo}</span>}
                    {/* 링크형 입고(이전 연동·기간 자동 매칭)는 원장이 다른 화면 소유 — 여기서 취소하면
                        실제 재고 원장까지 지워지므로 버튼을 막고 원래 화면으로 안내한다 */}
                    {canEdit && ((rc.memo?.includes("이전 연동") || rc.memo?.includes("이전 배정"))
                      ? <span className="sm-faint" style={{ fontSize: 12 }} title="재고 이동 최근 내역, 입고 및 출고 목록의 이동 행, 변경 기록에서 취소하면 두 칸이 함께 원복됩니다">취소는 이동 행에서</span>
                      : (rc.memo?.includes("기간 자동 매칭") || rc.memo?.includes("입고 연결") || rc.memo?.includes("입고/출고 연동"))
                      ? <span className="sm-faint" style={{ fontSize: 12 }}>취소는 입고 및 출고 화면에서</span>
                      : <button className="b2b-link-btn" style={{ fontSize: 15, color: "var(--sm-danger)" }} disabled={busy} onClick={() => onCancelReceipt(rc.id)}>취소</button>)}
                  </div>
                ))}
              </div>
            ) : (
              <p className="sm-faint" style={{ fontSize: 15, margin: "4px 2px" }}>아직 입고 기록이 없습니다.</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// 생성/수정 겸용 — initial 이 있으면 수정 모드(기존 라인 id 유지, 입고 있는 라인은 뺄 수 없음).
// 소매 수식 행의 원값 — 수정 창에서 자기 요청서 잔여를 빼고 권장을 다시 계산하는 데 쓴다
type RecRow = { recommend: number; inbound: number; stock: number | null; safety: number; demand: number };

function RequestModal({ initial, prefill, defaultPurpose, products, retailQty, wholesaleNeed, error, recRetail, recWhole, recWholeReq, wholeReqOk, recReady, inbOk, busy, onClose, onSubmit }: {
  initial?: ProductionRequest; prefill?: NewLine[]; defaultPurpose?: PrPurpose; products: Prod[]; retailQty: Map<string, number>; wholesaleNeed: Map<string, number>; error?: string; recRetail: Map<string, RecRow>; recWhole: Map<string, number>; recWholeReq: Map<string, number>; wholeReqOk: boolean; recReady: boolean; inbOk: boolean; busy: boolean; onClose: () => void; onSubmit: (payload: unknown) => void;
}) {
  const isEdit = !!initial;
  const stockOf = (pid: string): number | null => { const p = products.find((x) => x.product_id === pid); return p ? p.qty : null; };
  const [requestedBy, setRequestedBy] = useState(initial?.requested_by || "");
  const [date, setDate] = useState(initial?.request_date || todayIso());
  // 생산 일정(영업일, 2026-09-29 대표 정정): 작성 D → 컨펌·제출 D+1 → 생산 시작 D+3 → 생산 마감 D+7 → 판매 가능 D+8.
  //  제조사 요청 기본값 = 생산시작일 D+3 · 생산종료일 D+7. 도매 납품은 +7영업일. 옛 요청서에 마감일이 비어 있으면 기본값으로 채워서 연다.
  //  확정형(프로모션·도매 대량)은 목표일을 비워 둔다 — 기본값이 그대로 저장되면 그 날짜에 자동 마감·합류가 돈다.
  const initPurpose: PrPurpose = initial?.purpose || defaultPurpose || "재고 보충";
  const [dueDate, setDueDate] = useState(initial ? (initial.due_date || defaultDueDate(initPurpose, initial.request_date) || "") : (defaultDueDate(initPurpose, todayIso()) || ""));
  // 생산시작일(118) — 입고 화면이 기본 요청서를 고르는 기간의 시작(제조사 요청 전용). 새 요청 기본 = D+3영업일.
  //  요청일부터 잡으면 요청 당일 기록된 무관한 입고가 새 요청서에 전량 잡힌다(2026-09-23 사고).
  const [prodStart, setProdStart] = useState(initial ? (initial.prod_start || "") : defaultProdStart(todayIso()));
  const datesTouched = useRef(false); // 사람이 날짜를 손댔으면 요청일·용도를 바꿔도 기본값을 다시 채우지 않는다
  const initialProdStart = initial?.prod_start || "";
  const [title, setTitle] = useState(initial?.title || "");
  // 용도(082) — 새 요청은 현재 탭 기준(제조사 탭=재고 보충 / 도매 탭=도매 납품), 수정은 기존 값.
  const [purpose, setPurpose] = useState<PrPurpose>(initial?.purpose || defaultPurpose || "재고 보충");
  // 확정형(도매 대량)이 어느 거래처·발주 몫인지(115). 발주는 상위가 넘겨줄 때만 찬다.
  const [companyId, setCompanyId] = useState(initial?.company_id || "");
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (purpose !== "도매 대량" || companies.length) return;
    (async () => {
      try {
        const j = await (await fetch("/api/b2b/companies?limit=500", { cache: "no-store" })).json();
        if (j.ok) setCompanies((j.companies || j.rows || []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
      } catch { /* 거래처 없이도 등록은 된다 */ }
    })();
  }, [purpose, companies.length]);
  const [memo, setMemo] = useState(initial?.memo || "");
  const [lines, setLines] = useState<NewLine[]>(() =>
    initial
      ? initial.items.map((it) => ({
          item_id: it.id, received: it.received_qty,
          product_id: it.product_id, sku: it.sku, name: it.name, spec: it.spec, unit: it.unit,
          stock: stockOf(it.product_id), requested_qty: String(it.requested_qty),
          // 자동 줄은 표식 memo 를 입력칸에 싣지 않는다(승격 시 엑셀 비고·알림에 찍히지 않게) — 서버가 유지 시 표식을 다시 붙인다
          memo: it.requested_qty <= 0 && it.memo === UNREQUESTED_ITEM_MEMO ? "" : (it.memo || ""),
          auto: it.requested_qty <= 0 && it.memo === UNREQUESTED_ITEM_MEMO,
        }))
      : (prefill ?? [])   // 재고 목록에서 넘어온 품목·권장수량 (없으면 빈 목록)
  );

  function addLine(p: Prod) {
    setLines((prev) => [...prev, { received: 0, product_id: p.product_id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit, stock: p.qty, requested_qty: "", memo: "" }]);
  }
  // 수정 창: 이 요청서 자신의 저장된 잔여(SKU 별) — 서버 입고 예정에서 자기 몫을 빼 '다른 요청서'만 남긴다
  const ownRawBySku = useMemo(() => {
    const m = new Map<string, number>();
    if (!initial || initial.purpose !== "재고 보충") return m;
    for (const it of initial.items) {
      const k = (it.sku || "").toUpperCase();
      if (k) m.set(k, r2((m.get(k) || 0) + Math.max(0, it.requested_qty - it.received_qty)));
    }
    return m;
  }, [initial]);
  // 수정 창(도매 납품): 이 요청서 자신의 잔여(SKU 별) — 도매 요청 잔여(R)에서 자기 몫을 빼 '다른 요청서'만 남긴다
  const ownWholeBySku = useMemo(() => {
    const m = new Map<string, number>();
    if (!initial || initial.purpose !== "도매 납품") return m;
    for (const it of initial.items) {
      const k = (it.sku || "").toUpperCase();
      if (k) m.set(k, r2((m.get(k) || 0) + Math.max(0, it.requested_qty - it.received_qty)));
    }
    return m;
  }, [initial]);
  // 품목별 입고 예정·권장(소매+도매). 수정 창은 서버 입고 예정에서 자기 잔여를 빼 '다른 요청서'만 남긴다.
  function planFor(sku: string) {
    const rr = recRetail.get(sku);
    const inb = rr ? r2(Math.max(0, rr.inbound - (ownRawBySku.get(sku) ?? 0))) : 0;
    const g = !rr ? 0 : rr.stock == null ? rr.demand : Math.max(0, rr.demand + rr.safety - rr.stock);
    const recommend = Math.max(0, r2(g + (recWhole.get(sku) ?? 0) - inb));
    return { inb, recommend };
  }
  function updateLine(i: number, patch: Partial<NewLine>) { setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l))); }
  function removeLine(i: number) { setLines((prev) => prev.filter((_, idx) => idx !== i)); }

  // 입고·배정 기록이 있는 요청서는 용도를 바꿀 수 없다(서버도 거부) — 탭을 잠근다
  const purposeLocked = isEdit && lines.some((l) => l.received > 0);
  // 시작일이 비면 요청일이 기간 시작이다(서버 규칙과 동일) — 요청일 > 종료일 역전도 막는다
  const startAfterEnd = purpose === "재고 보충" && !!dueDate && (prodStart || date) > dueDate;
  const valid = lines.some((l) => Number(l.requested_qty) > 0) && !!dueDate && !startAfterEnd;


  function submit() {
    const items = lines
      // 자동 줄·입고 있는 줄은 수량 0 이어도 보낸다 — 자동 줄은 서버가 표식 그대로 유지하고, 실제 줄의 0 은 서버가 명확한 오류로 막는다
      .filter((l) => Number(l.requested_qty) > 0 || l.auto || l.received > 0)
      .map((l) => {
        const requested_qty = Math.round(Number(l.requested_qty) * 100) / 100; // 소수 둘째 자리 허용(104)
        return { id: l.item_id, product_id: l.product_id, requested_qty, memo: l.memo.trim() || undefined };
      });
    onSubmit({
      title: title.trim() || (isEdit ? "" : undefined),
      purpose,
      requested_by: requestedBy.trim() || (isEdit ? "" : undefined),
      request_date: date,
      due_date: dueDate,
      // 생산시작일 — 제조사(재고 보충)만. 수정 시엔 바뀐 경우에만 보낸다(안 바뀌었는데 보내면 창 변경으로 오인해 전체 재매칭이 돈다)
      ...(purpose === "재고 보충" ? ((!isEdit || prodStart !== initialProdStart) ? { prod_start: prodStart || null } : {}) : (isEdit && initialProdStart ? { prod_start: null } : {})), // 확정형으로 바꾸면 숨은 시작일을 비운다(시작일 > 목표일 400 방지)
      company_id: purpose === "도매 대량" ? (companyId || null) : null,
      order_id: purpose === "도매 대량" ? (initial?.order_id || null) : null,
      memo: memo.trim() || (isEdit ? "" : undefined),
      items,
    });
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" style={{ maxWidth: "min(1400px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">{isEdit ? `요청서 수정 ${initial?.req_no || ""}` : "새 생산 요청"}</h2><button className="b2b-modal-close" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body">
          {/* 저장 오류는 창 안에도 — 페이지 위 배너는 창에 가려 보이지 않는다 */}
          {error && <div className="b2b-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div className="sm-col" style={{ gap: 3 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>요청</span>
              <div className="sm-tabs" style={{ margin: 0 }}>
                {PR_PURPOSES.map((pp) => (
                  <button key={pp} type="button" className={`sm-tab ${purpose === pp ? "is-active" : ""}`} disabled={purposeLocked && pp !== purpose} title={purposeLocked && pp !== purpose ? "입고·배정 기록이 있어 용도를 바꿀 수 없습니다" : undefined} onClick={() => {
                    setPurpose(pp);
                    // 수정 창에서 확정형으로 바꾸면 옛 생산종료일이 행사 시작일로 남지 않게 비운다(사람이 넣게)
                    if (isEdit) { if (CONFIRMED_PURPOSES.includes(pp) && !CONFIRMED_PURPOSES.includes(purpose)) setDueDate(""); return; }
                    // 확정형은 늘 목표일을 비운다(사람이 행사 시작일·납품일을 넣는다) — 제조사 기본 종료일이 행사 시작일로 저장되면 그 날 자동 마감·합류가 돈다
                    if (CONFIRMED_PURPOSES.includes(pp)) { setDueDate(""); return; }
                    if (!datesTouched.current) { setDueDate(defaultDueDate(pp, date || todayIso()) || ""); setProdStart(defaultProdStart(date || todayIso())); }
                    else if (!dueDate) setDueDate(defaultDueDate(pp, date || todayIso()) || "");
                  }}>{PR_PURPOSE_LABEL[pp]}</button>
                ))}
              </div>
            </div>
            <label className="sm-col" style={{ gap: 3 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>요청자(MD)</span>
              <input className="b2b-input" style={{ width: 160 }} value={requestedBy} onChange={(e) => setRequestedBy(e.target.value)} placeholder="이름(비우면 본인)" />
            </label>
            <label className="sm-col" style={{ gap: 3 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>요청일</span>
              <input type="date" className="b2b-input" style={{ width: 150 }} value={date} onChange={(e) => { const v = e.target.value; setDate(v); if (!isEdit && !datesTouched.current && DATE_OK.test(v)) { setDueDate(defaultDueDate(purpose, v) || ""); setProdStart(defaultProdStart(v)); } }} />
            </label>
            {purpose === "재고 보충" && (
              <label className="sm-col" style={{ gap: 3 }}>
                {/* 생산기간의 시작 — 이 날부터 생산종료일까지 기록된 입고가 이 요청서에 잡힌다(넘쳐도 초과로 기록) */}
                <span style={{ fontSize: 15, fontWeight: 600 }}>생산시작일 <span style={{ fontWeight: 400, color: "var(--sm-text-light)" }}>· 입고 매칭 시작</span></span>
                <input type="date" className="b2b-input" style={{ width: 150 }} value={prodStart} max={dueDate || undefined} onChange={(e) => { datesTouched.current = true; setProdStart(e.target.value); }} />
              </label>
            )}
            <label className="sm-col" style={{ gap: 3 }}>
              {/* 확정형은 마감이 아니라 그날 물건이 있어야 하는 날이다 — 라벨을 용도에 맞춘다(115) */}
              <span style={{ fontSize: 15, fontWeight: 600 }}>{DUE_LABEL[purpose]}{purpose === "재고 보충" && <span style={{ fontWeight: 400, color: "var(--sm-text-light)" }}> · 입고 매칭 끝</span>}</span>
              <input type="date" className="b2b-input" style={{ width: 150 }} value={dueDate} onChange={(e) => { datesTouched.current = true; setDueDate(e.target.value); }} />
            </label>
            {startAfterEnd && <div className="b2b-error" style={{ flexBasis: "100%", margin: 0 }}>{prodStart ? "생산시작일" : "요청일"}이 생산종료일보다 뒤입니다 — 기간을 확인하세요.</div>}
            {purpose === "도매 대량" && (
              <label className="sm-col" style={{ gap: 3, minWidth: 200 }}>
                {/* 발주가 아직 없을 수 있다(영업이 구두로 확보한 당일 등록) — 그때는 거래처만 고른다 */}
                <span style={{ fontSize: 15, fontWeight: 600 }}>거래처 <span style={{ fontWeight: 400, color: "var(--sm-text-light)" }}>· 선택</span></span>
                {/* 제목이 옛 거래처 이름(자동 제목) 그대로면 비워서 새 거래처 이름으로 다시 채워지게 한다 — 서버가 빈 제목을 거래처 이름으로 채운다 */}
                <select className="b2b-input" style={{ width: 200 }} value={companyId} onChange={(e) => { const prevName = companies.find((c) => c.id === companyId)?.name; if (prevName && title.trim() === prevName) setTitle(""); setCompanyId(e.target.value); }}>
                  <option value="">(미지정)</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label className="sm-col" style={{ gap: 3, flex: 1, minWidth: 180 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>제목(선택)</span>
              <input className="b2b-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={purpose === "도매 대량" ? "비우면 거래처 이름" : "예: 3월 2주차 도매 생산"} />
            </label>
          </div>

          {/* 품목 추가 — 다른 검색창과 동일한 콤보박스(이름·SKU·규격 아무 글자나 검색, 한글 입력 기본) */}
          <div style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>생산 품목 추가</span>
            <div style={{ marginTop: 3 }}>
              <Combobox
                value=""
                options={products
                  .filter((p) => !lines.some((l) => l.product_id === p.product_id))
                  .map((p) => ({ id: p.product_id, label: `${p.name}${p.spec ? ` — ${p.spec}` : ""}`, sub: p.sku ?? "" }))}
                onSelect={(o) => { const p = products.find((x) => x.product_id === o.id); if (p) addLine(p); }}
                placeholder="품목명·SKU·규격으로 검색해서 선택"
                ariaLabel="생산 품목 추가"
                emptyText="일치하는 품목이 없습니다"
              />
            </div>
          </div>

          {!wholeReqOk && purpose === "도매 납품" && (
            <div className="sm-warn" style={{ marginBottom: 8 }}>&lsquo;도매 요청 잔여&rsquo;(열린 도매 요청서)를 불러오지 못했습니다 — 권장이 이미 요청한 양을 빼지 못해 실제보다 클 수 있습니다.</div>
          )}
          {!inbOk && purpose === "재고 보충" && (
            <div className="sm-warn" style={{ marginBottom: 8 }}>&lsquo;입고 예정&rsquo;(열린 요청서 잔여)을 불러오지 못했습니다 — 권장이 시켜 둔 물량을 빼지 못해 실제보다 클 수 있습니다.</div>
          )}
          {lines.length === 0 ? (
            <div className="b2b-empty" style={{ padding: 20 }}>추가한 품목이 없습니다.</div>
          ) : (
            // flexShrink 0 — 창 본문(flex 세로)이 넘치면 표가 한 줄 높이로 눌려 작은 스크롤 안에 갇힌다(추가한 품목이 안 보여 '선택이 안 된다'로 보이던 버그)
            <div className="b2b-table-wrap" style={{ flexShrink: 0 }}>
              <table className="b2b-table">
                {/* 권장 = 재고 목록 권장 열과 같은 합산식 — 제조사: max(0, ①원값+② − ⑤입고 예정), 도매: ② 도매 수식.
                    확정형(프로모션·도매 대량)은 수량을 사람이 아는 칸이라 권장 없음('-') */}
                {/* 첫 숫자 열(재고) 폭은 두 탭 모두 100 — 탭 전환 시 표가 흔들리지 않게 */}
                {/* 확정형(프로모션·도매 대량)은 입고 품목만 요청 — 재고·권장 열 없이 품목·요청수량·메모만 */}
                {CONFIRMED_PURPOSES.includes(purpose) ? (
                  <thead><tr><th>품목</th><th className="num" style={{ width: 110 }}>요청수량</th><th>메모</th><th style={{ width: 60 }}></th></tr></thead>
                ) : purpose === "도매 납품" ? (
                  <thead><tr><th>품목</th><th className="num" style={{ width: 100 }}>도매 재고</th><th className="num" style={{ width: 90 }}>권장</th><th className="num" style={{ width: 110 }}>요청수량</th><th>메모</th><th style={{ width: 60 }}></th></tr></thead>
                ) : (
                  <thead><tr><th>품목</th><th className="num" style={{ width: 100 }}>소매 재고</th><th className="num" style={{ width: 84 }} title={isEdit ? "다른 열린 제조사 요청서에서 아직 안 온 양(이 요청서 자신의 잔여는 뺀 값) — 권장은 이 양을 이미 뺀 값" : "시켜 두고 아직 안 온 양(열린 제조사 요청서 잔여) — 권장은 이 양을 이미 뺀 값"}>입고 예정</th><th className="num" style={{ width: 100 }}>도매 필요량</th><th className="num" style={{ width: 90 }}>권장</th><th className="num" style={{ width: 110 }}>요청수량</th><th>메모</th><th style={{ width: 60 }}></th></tr></thead>
                )}
                <tbody>
                  {lines.map((l, i) => {
                    const retail = retailQty.get(l.product_id) ?? null;
                    const need = wholesaleNeed.get(l.product_id) ?? 0;
                    const rk = (l.sku || "").toUpperCase();
                    // 제조사 권장 = max(0, ①원값 + ② − ⑤) — 입고 예정(⑤)을 합계에서 한 번만 뺀다(기획 14절 #8). 수정 창은 자기 잔여를 뺀 '다른 요청서' 기준(planFor).
                    const pl = planFor(rk);
                    const inb = pl.inb;
                    // 확정형(프로모션·도매 대량)은 목표 수량을 사람이 안다(행사 계획·선결제 발주서) — 수식 권장 없음('-')
                    const recommend = !recReady || CONFIRMED_PURPOSES.includes(purpose) ? null
                      // 도매 납품 = max(0, gross ② − 다른 열린 도매 요청 잔여). 자기 잔여는 0 바닥 전에 되돌린다(net + own 은 과대)
                      : purpose === "도매 납품" ? Math.max(0, r2((recWhole.get(rk) ?? 0) - Math.max(0, (recWholeReq.get(rk) ?? 0) - (ownWholeBySku.get(rk) ?? 0))))
                      : pl.recommend;
                    return (
                      <tr key={l.item_id || l.product_id}>
                        <td style={{ overflow: "hidden", textOverflow: "ellipsis" }}><div style={{ fontWeight: 600 }}>{l.name}</div><div style={{ fontSize: 15, color: "var(--sm-text-light)" }}>{l.sku || ""}{l.spec ? ` · ${l.spec}` : ""}</div></td>
                        {CONFIRMED_PURPOSES.includes(purpose) ? null : purpose === "도매 납품" ? (
                          <>
                            <td className="num" style={{ color: "var(--sm-text-mid)" }}>{l.stock == null ? "-" : l.stock.toLocaleString()}</td>
                            <td className="num" style={{ fontWeight: 700, color: (recommend ?? 0) > 0 ? "var(--sm-dark)" : "var(--sm-text-light)" }}>{recommend == null ? "-" : recommend.toLocaleString()}</td>
                          </>
                        ) : (
                          <>
                            <td className="num" style={{ color: "var(--sm-text-mid)" }}>{retail == null ? "-" : retail.toLocaleString()}</td>
                            <td className="num" style={{ color: inb > 0 ? "var(--sm-info)" : "var(--sm-text-light)" }}>{!recReady || !inbOk ? "-" : inb > 0 ? inb.toLocaleString() : "0"}</td>
                            <td className="num" style={{ color: need > 0 ? "var(--sm-orange)" : "var(--sm-text-mid)", fontWeight: need > 0 ? 700 : 400 }}>{need.toLocaleString()}</td>
                            <td className="num" style={{ fontWeight: 700, color: (recommend ?? 0) > 0 ? "var(--sm-dark)" : "var(--sm-text-light)" }}>{recommend == null ? "-" : recommend.toLocaleString()}</td>
                          </>
                        )}
                        <td className="num"><input type="number" step={0.01} min={0} className="b2b-input" style={{ width: 100, textAlign: "right" }} value={l.auto && Number(l.requested_qty) <= 0 ? "" : l.requested_qty} onChange={(e) => updateLine(i, { requested_qty: e.target.value })} placeholder={l.auto ? "요청 없음" : "0"} title={l.auto ? "요청서에 없던 품목이 이 주간에 입고돼 자동으로 붙은 줄 — 수량을 넣으면 정식 요청 품목이 됩니다" : undefined} /></td>
                        <td>
                          {l.auto && Number(l.requested_qty) <= 0
                            ? <span className="b2b-status-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-info)" }} title="요청서에 없던 품목의 입고 기록 자리 — 제조사 엑셀·이행률에는 들어가지 않습니다">요청서에 없음 · 입고 {l.received.toLocaleString()}</span>
                            : <input className="b2b-input" value={l.memo} onChange={(e) => updateLine(i, { memo: e.target.value })} placeholder="(선택)" />}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {l.received > 0 ? (
                            <span className="sm-faint" style={{ fontSize: 12, whiteSpace: "nowrap" }} title="입고 기록이 있어 뺄 수 없습니다">입고 {l.received.toLocaleString()}</span>
                          ) : (
                            <button className="b2b-link-btn" style={{ color: "var(--sm-danger)", whiteSpace: "nowrap" }} onClick={() => removeLine(i)}>삭제</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <label className="sm-col" style={{ gap: 3, marginTop: 12 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>요청 메모(선택)</span>
            <textarea className="b2b-input" style={{ minHeight: memo.split("\n").length > 3 ? 180 : 72 }} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="생산 담당자에게 전달할 내용" />
          </label>
        </div>
        <div className="b2b-modal-foot">
          <button className="b2b-btn-secondary" onClick={onClose}>취소</button>
          <button className="b2b-btn-primary" disabled={busy || !valid} onClick={submit}>{isEdit ? "수정 저장" : "요청서 만들기"}</button>
        </div>
      </div>
    </div>
  );
}
