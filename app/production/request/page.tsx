"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PR_STATUSES, PR_STATUS_COLOR, PR_STATUS_LABEL, PR_LINE_COLOR, lineState, allLinesFilled,
  type ProductionRequest, type PrItem, type PrStatus,
} from "@/app/lib/wholesale-production";
import { addBusinessDays } from "@/app/lib/business-days";
import { Combobox } from "@/app/b2b/orders/Combobox";

// KST 오늘 — 서버(UTC SSR)·클라이언트 모두 서울 벽시계 날짜로 일치(새벽 하이드레이션 불일치 방지)
function todayIso() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }

// 도매 재고 생산 요청 — 제조사 요청서(집계)는 /production/maker-request 로 분리됨.
export default function RequestPage() {
  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">도매 재고 생산 요청</h1>
          <p className="b2b-page-subtitle">입고 시 도매 재고에 반영됩니다</p>
        </div>
      </header>

      <WholesaleTab />
    </>
  );
}

// ───────────────────────────── 도매 재고 생산 요청 ─────────────────────────────

type Prod = { product_id: string; sku: string | null; name: string; spec: string | null; unit: string; qty: number };
type NewLine = {
  item_id?: string;          // 수정 모드: 기존 라인 id (신규 추가 라인은 없음)
  received: number;          // 수정 모드: 입고 누계 — 입고 있는 라인은 뺄 수 없음
  product_id: string; sku: string | null; name: string; spec: string | null; unit: string;
  stock: number | null;      // 도매재고(모를 때 null 표시)
  requested_qty: string; memo: string;
};

function WholesaleTab() {
  const [requests, setRequests] = useState<ProductionRequest[]>([]);
  const [filter, setFilter] = useState<"전체" | PrStatus>("전체");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [products, setProducts] = useState<Prod[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editReq, setEditReq] = useState<ProductionRequest | null>(null); // 수정 모달 대상
  const [busy, setBusy] = useState(false);

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

  const displayed = useMemo(() => (filter === "전체" ? requests : requests.filter((r) => r.status === filter)), [requests, filter]);

  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch("/api/inventory/overview?channel=도매", { cache: "no-store" })).json();
        // 묶음(세트)은 자체 재고가 없어(구성품 기준) 생산 입고 대상이 아님 → 선택기에서 제외.
        if (j.ok) setProducts((j.rows || []).filter((r: { is_bundle?: boolean }) => !r.is_bundle).map((r: Prod) => ({ product_id: r.product_id, sku: r.sku, name: r.name, spec: r.spec, unit: r.unit, qty: r.qty })));
      } catch { /* noop */ }
    })();
  }, []);

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
      await load();
      setExpandedId(j.request?.id ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "생성 오류"); }
    setBusy(false);
  }

  async function updateRequest(id: string, payload: unknown) {
    setBusy(true); setError("");
    try {
      const j = await (await fetch(`/api/production/requests/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).json();
      if (!j.ok) throw new Error(j.error || "수정 실패");
      applyUpdated(j.request);
      setEditReq(null);
    } catch (e) { setError(e instanceof Error ? e.message : "수정 오류"); }
    setBusy(false);
  }

  async function patchStatus(id: string, status: PrStatus) {
    setBusy(true); setError("");
    try {
      const j = await (await fetch(`/api/production/requests/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) })).json();
      if (!j.ok) throw new Error(j.error || "변경 실패");
      applyUpdated(j.request);
    } catch (e) { setError(e instanceof Error ? e.message : "변경 오류"); }
    setBusy(false);
  }

  async function removeRequest(id: string) {
    if (!confirm("이 요청서를 삭제할까요? (입고 기록이 있으면 삭제 대신 '취소'만 됩니다)")) return;
    setBusy(true); setError("");
    try {
      const j = await (await fetch(`/api/production/requests/${id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "삭제 실패");
      setRequests((prev) => prev.filter((r) => r.id !== id));
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 오류"); }
    setBusy(false);
  }

  async function receive(id: string, body: { item_id: string; qty: number; receipt_date: string; memo: string }) {
    setBusy(true); setError("");
    try {
      const j = await (await fetch(`/api/production/requests/${id}/receive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      if (!j.ok) throw new Error(j.error || "입고 실패");
      applyUpdated(j.request);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "입고 오류"); return false; }
    finally { setBusy(false); }
  }

  async function cancelReceipt(id: string, rid: string) {
    if (!confirm("이 입고를 취소할까요? 도매 재고에서도 원복됩니다.")) return;
    setBusy(true); setError("");
    try {
      const j = await (await fetch(`/api/production/requests/${id}/receive?rid=${rid}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "취소 실패");
      applyUpdated(j.request);
    } catch (e) { setError(e instanceof Error ? e.message : "취소 오류"); }
    setBusy(false);
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { 전체: requests.length };
    for (const s of PR_STATUSES) c[s] = requests.filter((r) => r.status === s).length;
    return c;
  }, [requests]);

  return (
    <div>
      {error && <div className="b2b-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div className="sm-tabbar">
          {(["전체", ...PR_STATUSES] as const).map((s) => (
            <button key={s} className={`sm-tab ${filter === s ? "is-active" : ""}`} onClick={() => setFilter(s)}>
              {s === "전체" ? "전체" : PR_STATUS_LABEL[s]}<span className="sm-tab-count">{counts[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="sm-row" style={{ gap: 8 }}>
          <button className="b2b-btn-secondary" onClick={() => load()} disabled={loading}>{loading ? "불러오는 중..." : "새로고침"}</button>
          <button className="b2b-btn-primary" onClick={() => setCreateOpen(true)} disabled={busy}>+ 새 생산 요청</button>
        </div>
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : displayed.length === 0 ? (
        <div className="b2b-empty">{filter === "전체" ? "아직 생산 요청이 없습니다. ‘+ 새 생산 요청’으로 시작하세요." : `‘${PR_STATUS_LABEL[filter as PrStatus]}’ 상태의 요청이 없습니다.`}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead>
              <tr>
                <th style={{ width: 1 }}></th>
                <th>요청번호</th>
                <th className="b2b-col-status" style={{ width: 160, minWidth: 160 }}>상태</th>
                <th>품목</th>
                <th className="b2b-col-date">진행</th>
                <th className="b2b-col-date">요청일</th>
                <th className="b2b-col-date">마감일</th>
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((r) => (
                <RequestRow
                  key={r.id} req={r} expanded={expandedId === r.id} busy={busy}
                  onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
                  onReceive={(body) => receive(r.id, body)}
                  onCancelReceipt={(rid) => cancelReceipt(r.id, rid)}
                  onStatus={(s) => patchStatus(r.id, s)}
                  onEdit={() => setEditReq(r)}
                  onDelete={() => removeRequest(r.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && <RequestModal products={products} busy={busy} onClose={() => setCreateOpen(false)} onSubmit={createRequest} />}
      {editReq && <RequestModal initial={editReq} products={products} busy={busy} onClose={() => setEditReq(null)} onSubmit={(payload) => updateRequest(editReq.id, payload)} />}
    </div>
  );
}

// 진행(입고/요청) 표시 — 테이블 셀용 텍스트. 초과=danger, 완료=success, 그 외 회색.
function ProgressCell({ received, requested }: { received: number; requested: number }) {
  const over = received > requested;
  const done = requested > 0 && received >= requested;
  const color = over ? "var(--sm-danger)" : done ? "var(--sm-success)" : "var(--sm-text-mid)";
  return <span style={{ fontSize: 13, fontWeight: 600, color, whiteSpace: "nowrap" }}>{received.toLocaleString()} / {requested.toLocaleString()}</span>;
}

// 발주관리 테이블과 동일한 형태 — 한 줄=한 요청, 클릭하면 그 아래 확장 행으로 입고 처리 상세가 펼쳐짐.
function RequestRow({ req, expanded, busy, onToggle, onReceive, onCancelReceipt, onStatus, onEdit, onDelete }: {
  req: ProductionRequest; expanded: boolean; busy: boolean;
  onToggle: () => void;
  onReceive: (body: { item_id: string; qty: number; receipt_date: string; memo: string }) => Promise<boolean>;
  onCancelReceipt: (rid: string) => void;
  onStatus: (s: PrStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const suggestComplete = req.status === "진행중" && allLinesFilled(req.items);
  const editable = req.status === "요청" || req.status === "진행중";
  const itemPreview = req.items.slice(0, 2).map((it) => `${it.name}${it.spec ? ` ${it.spec}` : ""} ×${it.requested_qty.toLocaleString()}`).join(" · ");
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }} className={expanded ? "is-parent" : ""}>
        <td style={{ padding: "8px", color: "var(--sm-text-light)" }}>{expanded ? "▾" : "▸"}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          <span style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontWeight: 700, color: "var(--sm-dark)" }}>{req.req_no || "—"}</span>
          {req.title ? <span className="sm-faint" style={{ display: "block", fontSize: 11 }}>{req.title}</span> : null}
        </td>
        <td className="b2b-col-status" onClick={(e) => e.stopPropagation()}>
          {/* 발주관리처럼 상태를 인라인 select 로 바로 변경(요청/진행중/완료/취소) */}
          <select
            className="b2b-status-select"
            value={req.status}
            disabled={busy}
            onChange={(e) => onStatus(e.target.value as PrStatus)}
            style={{ background: PR_STATUS_COLOR[req.status].bg, color: PR_STATUS_COLOR[req.status].fg, maxWidth: "none", width: "100%", minWidth: 148, fontSize: 12.5, padding: "6px 10px" }}
          >
            {PR_STATUSES.map((s) => <option key={s} value={s}>{PR_STATUS_LABEL[s]}</option>)}
          </select>
        </td>
        <td className="sm-nowrap" style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>
          {itemPreview || "품목 없음"}
          {req.items.length > 2 ? <span className="sm-faint"> 외 {req.items.length - 2}종</span> : null}
        </td>
        <td className="b2b-col-date"><ProgressCell received={req.total_received} requested={req.total_requested} /></td>
        <td className="b2b-col-date" style={{ whiteSpace: "nowrap" }}>
          {req.request_date}
          {req.requested_by ? <span className="sm-faint" style={{ display: "block", fontSize: 11 }}>{req.requested_by}</span> : null}
        </td>
        <td className="b2b-col-date" style={{ whiteSpace: "nowrap" }}>{req.due_date || "-"}</td>
        <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          {editable && <button className="b2b-link-btn" disabled={busy} onClick={onEdit}>수정</button>}
          <button className="b2b-link-btn" style={{ color: "var(--sm-danger)", marginLeft: 6 }} disabled={busy} onClick={onDelete}>삭제</button>
        </td>
      </tr>

      {expanded && (
        <tr className="b2b-child-row">
          <td></td>
          <td colSpan={7} style={{ padding: "8px 18px 16px" }}>
            {req.memo && <p className="sm-faint" style={{ fontSize: 13, marginBottom: 10 }}>메모: {req.memo}</p>}

            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead>
                  <tr><th>품목</th><th className="num">요청</th><th className="num">입고</th><th className="num">잔여</th><th>상태</th><th>입고 처리</th></tr>
                </thead>
                <tbody>
                  {req.items.map((it) => (
                    <ItemRow key={it.id} item={it} canEdit={req.status !== "완료" && req.status !== "취소"} busy={busy} onReceive={onReceive} onCancelReceipt={onCancelReceipt} />
                  ))}
                </tbody>
              </table>
            </div>

            {suggestComplete && <p style={{ fontSize: 13, color: "var(--sm-success)", marginTop: 10 }}>모든 품목이 요청 수량 이상 입고되었습니다. 생산이 끝났다면 위 상태를 ‘완료’로 바꾸세요.</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function ItemRow({ item, canEdit, busy, onReceive, onCancelReceipt }: {
  item: PrItem; canEdit: boolean; busy: boolean;
  onReceive: (body: { item_id: string; qty: number; receipt_date: string; memo: string }) => Promise<boolean>;
  onCancelReceipt: (rid: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const remaining = item.requested_qty - item.received_qty;
  const [qty, setQty] = useState("");
  const [date, setDate] = useState(todayIso());
  const [memo, setMemo] = useState("");
  const st = lineState(item.requested_qty, item.received_qty);
  // 열 때만 1회 잔여수량 자동 채움. deps=[open]로 좁혀, 열려있는 동안 remaining이 바뀌어도
  //  사용자가 입력 중인 값을 덮어쓰지 않게 함(입고 취소 시 remaining 증가 → 덮어쓰기 방지).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setQty(remaining > 0 ? String(remaining) : ""); }, [open]);

  async function submit() {
    const n = Math.round(Number(qty) || 0);
    if (n === 0) return;
    const ok = await onReceive({ item_id: item.id, qty: n, receipt_date: date, memo: memo.trim() });
    if (ok) { setOpen(false); setMemo(""); }
  }

  return (
    <>
      <tr>
        <td>
          <div style={{ fontWeight: 600 }}>{item.name}</div>
          <div style={{ fontSize: 13, color: "var(--sm-text-light)" }}>{item.sku || ""}{item.spec ? ` · ${item.spec}` : ""}</div>
        </td>
        <td className="num">{item.requested_qty.toLocaleString()}</td>
        <td className="num" style={{ fontWeight: 700 }}>{item.received_qty.toLocaleString()}</td>
        <td className="num" style={{ color: remaining > 0 ? "var(--sm-text-mid)" : remaining < 0 ? "var(--sm-danger)" : "var(--sm-success)" }}>{remaining.toLocaleString()}</td>
        <td><span style={{ fontSize: 13, fontWeight: 700, color: PR_LINE_COLOR[st] }}>{st}</span></td>
        <td>
          {(canEdit || item.receipts.length > 0) ? (
            <button className="b2b-btn-secondary" style={{ padding: "4px 12px" }} disabled={busy} onClick={() => setOpen((v) => !v)}>{open ? "닫기" : canEdit ? "입고" : "이력"}</button>
          ) : <span style={{ fontSize: 13, color: "var(--sm-text-light)" }}>—</span>}
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={6} style={{ background: "var(--sm-bg-subtle)" }}>
            {canEdit && (
              <>
                <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end", padding: "4px 2px" }}>
                  <label className="sm-col" style={{ gap: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>실제 입고 수량</span>
                    <input type="number" className="b2b-input" style={{ width: 120 }} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="예: 90" />
                  </label>
                  <label className="sm-col" style={{ gap: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>입고일</span>
                    <input type="date" className="b2b-input" style={{ width: 150 }} value={date} onChange={(e) => setDate(e.target.value)} />
                  </label>
                  <label className="sm-col" style={{ gap: 3, flex: 1, minWidth: 160 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>사유·메모(선택)</span>
                    <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="부분입고 / 초과생산 / 수정 등" />
                  </label>
                  <button className="b2b-btn-primary" style={{ padding: "6px 14px" }} disabled={busy || Math.round(Number(qty) || 0) === 0} onClick={submit}>입고 기록</button>
                </div>
                <p className="sm-faint" style={{ fontSize: 13, margin: "6px 2px 0" }}>초과 생산은 요청보다 많게, 수정(회수)은 음수로 입력하세요. 입고 즉시 도매 재고에 반영됩니다.</p>
              </>
            )}

            {item.receipts.length > 0 ? (
              <div style={{ marginTop: canEdit ? 10 : 2 }}>
                <div className="sm-faint" style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>입고 이력</div>
                {item.receipts.map((rc) => (
                  <div key={rc.id} className="sm-row" style={{ gap: 8, alignItems: "center", fontSize: 13, padding: "3px 2px", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--sm-text-light)" }}>{rc.receipt_date}</span>
                    <span style={{ fontWeight: 700, color: rc.qty < 0 ? "var(--sm-danger)" : "var(--sm-success)" }}>{rc.qty > 0 ? "+" : ""}{rc.qty.toLocaleString()}</span>
                    {rc.received_by && <span style={{ color: "var(--sm-text-mid)" }}>{rc.received_by}</span>}
                    {rc.memo && <span style={{ color: "var(--sm-text-mid)" }}>· {rc.memo}</span>}
                    {canEdit && <button className="b2b-link-btn" style={{ fontSize: 13, color: "var(--sm-danger)" }} disabled={busy} onClick={() => onCancelReceipt(rc.id)}>취소</button>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="sm-faint" style={{ fontSize: 13, margin: "4px 2px" }}>아직 입고 기록이 없습니다.</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// 생성/수정 겸용 — initial 이 있으면 수정 모드(기존 라인 id 유지, 입고 있는 라인은 뺄 수 없음).
function RequestModal({ initial, products, busy, onClose, onSubmit }: {
  initial?: ProductionRequest; products: Prod[]; busy: boolean; onClose: () => void; onSubmit: (payload: unknown) => void;
}) {
  const isEdit = !!initial;
  const stockOf = (pid: string): number | null => { const p = products.find((x) => x.product_id === pid); return p ? p.qty : null; };
  const [requestedBy, setRequestedBy] = useState(initial?.requested_by || "");
  const [date, setDate] = useState(initial?.request_date || todayIso());
  // 생산마감일 필수 — 기본 요청일+7영업일(급발주 시 수정). 옛 요청서에 마감일이 비어 있으면 기본값으로 채워서 연다.
  const [dueDate, setDueDate] = useState(initial ? (initial.due_date || addBusinessDays(initial.request_date, 7)) : addBusinessDays(todayIso(), 7));
  const [title, setTitle] = useState(initial?.title || "");
  const [memo, setMemo] = useState(initial?.memo || "");
  const [lines, setLines] = useState<NewLine[]>(() =>
    initial
      ? initial.items.map((it) => ({
          item_id: it.id, received: it.received_qty,
          product_id: it.product_id, sku: it.sku, name: it.name, spec: it.spec, unit: it.unit,
          stock: stockOf(it.product_id), requested_qty: String(it.requested_qty), memo: it.memo || "",
        }))
      : []
  );

  function addLine(p: Prod) {
    setLines((prev) => [...prev, { received: 0, product_id: p.product_id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit, stock: p.qty, requested_qty: "", memo: "" }]);
  }
  function updateLine(i: number, patch: Partial<NewLine>) { setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l))); }
  function removeLine(i: number) { setLines((prev) => prev.filter((_, idx) => idx !== i)); }

  const valid = lines.some((l) => Number(l.requested_qty) > 0) && !!dueDate;

  function submit() {
    const items = lines
      .filter((l) => Number(l.requested_qty) > 0)
      .map((l) => ({ id: l.item_id, product_id: l.product_id, requested_qty: Math.round(Number(l.requested_qty)), memo: l.memo.trim() || undefined }));
    onSubmit({
      title: title.trim() || (isEdit ? "" : undefined),
      requested_by: requestedBy.trim() || (isEdit ? "" : undefined),
      request_date: date,
      due_date: dueDate,
      memo: memo.trim() || (isEdit ? "" : undefined),
      items,
    });
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">{isEdit ? `요청서 수정 ${initial?.req_no || ""}` : "새 도매 생산 요청"}</h2><button className="b2b-modal-close" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body">
          <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <label className="sm-col" style={{ gap: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>요청자(MD)</span>
              <input className="b2b-input" style={{ width: 160 }} value={requestedBy} onChange={(e) => setRequestedBy(e.target.value)} placeholder="이름(비우면 본인)" />
            </label>
            <label className="sm-col" style={{ gap: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>요청일</span>
              <input type="date" className="b2b-input" style={{ width: 150 }} value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="sm-col" style={{ gap: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>생산마감일 <span style={{ fontWeight: 400, color: "var(--sm-text-light)" }}>· 기본 7영업일</span></span>
              <input type="date" className="b2b-input" style={{ width: 150 }} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
            <label className="sm-col" style={{ gap: 3, flex: 1, minWidth: 180 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>제목(선택)</span>
              <input className="b2b-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 3월 2주차 도매 생산" />
            </label>
          </div>

          {/* 품목 추가 — 다른 검색창과 동일한 콤보박스(이름·SKU·규격 아무 글자나 검색, 한글 입력 기본) */}
          <div style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>생산 품목 추가</span>
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

          {lines.length === 0 ? (
            <div className="b2b-empty" style={{ padding: 20 }}>위에서 품목을 검색해 추가하세요.</div>
          ) : (
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>품목</th><th className="num">도매재고</th><th className="num">요청수량</th><th>메모</th><th></th></tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.item_id || l.product_id}>
                      <td><div style={{ fontWeight: 600 }}>{l.name}</div><div style={{ fontSize: 13, color: "var(--sm-text-light)" }}>{l.sku || ""}{l.spec ? ` · ${l.spec}` : ""}</div></td>
                      <td className="num" style={{ color: "var(--sm-text-mid)" }}>{l.stock == null ? "-" : l.stock.toLocaleString()}</td>
                      <td className="num"><input type="number" className="b2b-input" style={{ width: 100, textAlign: "right" }} value={l.requested_qty} onChange={(e) => updateLine(i, { requested_qty: e.target.value })} placeholder="0" /></td>
                      <td><input className="b2b-input" value={l.memo} onChange={(e) => updateLine(i, { memo: e.target.value })} placeholder="(선택)" /></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {l.received > 0 ? (
                          <span className="sm-faint" style={{ fontSize: 12, whiteSpace: "nowrap" }} title="입고 기록이 있어 뺄 수 없습니다">입고 {l.received.toLocaleString()}</span>
                        ) : (
                          <button className="b2b-link-btn" style={{ color: "var(--sm-danger)", whiteSpace: "nowrap" }} onClick={() => removeLine(i)}>삭제</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <label className="sm-col" style={{ gap: 3, marginTop: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>요청 메모(선택)</span>
            <textarea className="b2b-input" style={{ minHeight: 56 }} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="생산 담당자에게 전달할 내용" />
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
