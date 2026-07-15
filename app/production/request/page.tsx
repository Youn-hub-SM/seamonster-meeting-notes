"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PR_STATUSES, PR_STATUS_COLOR, PR_STATUS_LABEL, PR_LINE_COLOR, lineState, allLinesFilled,
  type ProductionRequest, type PrItem, type PrStatus,
} from "@/app/lib/wholesale-production";
import { addBusinessDays } from "@/app/lib/business-days";
import { Combobox } from "@/app/b2b/orders/Combobox";

function todayIso() { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; }

export default function RequestPage() {
  const [tab, setTab] = useState<"wholesale" | "maker">("wholesale");
  return (
    <div className="b2b-container" style={{ maxWidth: 1040 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산요청서</h1>
          <p className="b2b-page-subtitle">MD가 도매 재고 생산을 요청하면, 생산 담당자가 확인 후 실제 생산량을 입고 처리합니다. (부분·초과·수정 입고 가능 · 입고 시 도매 재고 반영)</p>
        </div>
      </header>

      <div className="sm-tabbar" style={{ marginBottom: 16 }}>
        <button className={`sm-tab ${tab === "wholesale" ? "is-active" : ""}`} onClick={() => setTab("wholesale")}>도매 재고 생산 요청</button>
        <button className={`sm-tab ${tab === "maker" ? "is-active" : ""}`} onClick={() => setTab("maker")}>제조사 요청서(집계)</button>
      </div>

      {tab === "wholesale" ? <WholesaleTab /> : <MakerTab />}
    </div>
  );
}

// ───────────────────────────── 도매 재고 생산 요청 ─────────────────────────────

type Prod = { product_id: string; sku: string | null; name: string; spec: string | null; unit: string; qty: number };
type NewLine = { product_id: string; sku: string | null; name: string; spec: string | null; unit: string; stock: number; requested_qty: string; memo: string };

function WholesaleTab() {
  const [requests, setRequests] = useState<ProductionRequest[]>([]);
  const [filter, setFilter] = useState<"전체" | PrStatus>("전체");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [products, setProducts] = useState<Prod[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
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
        <div className="sm-col" style={{ gap: 10 }}>
          {displayed.map((r) => (
            <RequestCard
              key={r.id} req={r} expanded={expandedId === r.id} busy={busy}
              onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
              onReceive={(body) => receive(r.id, body)}
              onCancelReceipt={(rid) => cancelReceipt(r.id, rid)}
              onStatus={(s) => patchStatus(r.id, s)}
              onDelete={() => removeRequest(r.id)}
            />
          ))}
        </div>
      )}

      {createOpen && <CreateModal products={products} busy={busy} onClose={() => setCreateOpen(false)} onCreate={createRequest} />}
    </div>
  );
}

function ProgressBar({ received, requested }: { received: number; requested: number }) {
  const pct = requested > 0 ? Math.min(100, Math.round((received / requested) * 100)) : 0;
  const over = received > requested;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, minWidth: 80, height: 8, borderRadius: 5, background: "var(--sm-bg-subtle)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: over ? "var(--sm-danger)" : pct >= 100 ? "var(--sm-success)" : "var(--sm-orange)" }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, color: over ? "var(--sm-danger)" : "var(--sm-text-mid)", whiteSpace: "nowrap" }}>
        {received.toLocaleString()} / {requested.toLocaleString()}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: PrStatus }) {
  const c = PR_STATUS_COLOR[status];
  return <span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{PR_STATUS_LABEL[status]}</span>;
}

function RequestCard({ req, expanded, busy, onToggle, onReceive, onCancelReceipt, onStatus, onDelete }: {
  req: ProductionRequest; expanded: boolean; busy: boolean;
  onToggle: () => void;
  onReceive: (body: { item_id: string; qty: number; receipt_date: string; memo: string }) => Promise<boolean>;
  onCancelReceipt: (rid: string) => void;
  onStatus: (s: PrStatus) => void;
  onDelete: () => void;
}) {
  const suggestComplete = req.status === "진행중" && allLinesFilled(req.items);
  return (
    <div className="b2b-card" style={{ padding: 0, overflow: "hidden" }}>
      {/* 헤더 줄 */}
      <button onClick={onToggle} style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 14, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--sm-text-light)" }}>{expanded ? "▾" : "▸"}</span>
        <span style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 13, fontWeight: 700, color: "var(--sm-dark)" }}>{req.req_no || "—"}</span>
        <StatusBadge status={req.status} />
        <span style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>{req.request_date}{req.due_date ? ` · 마감 ${req.due_date}` : ""}{req.requested_by ? ` · 요청 ${req.requested_by}` : ""}</span>
        {req.title && <span style={{ fontSize: 13, color: "var(--sm-black)", fontWeight: 600 }}>{req.title}</span>}
        {/* 발주 ItemsPreview 처럼 품목 개수 대신 '품목명 ×수량'을 최대 2종 미리보기(나머지는 외 N종) */}
        <span className="sm-nowrap" style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>
          {req.items.slice(0, 2).map((it) => `${it.name}${it.spec ? ` ${it.spec}` : ""} ×${it.requested_qty.toLocaleString()}`).join(" · ") || "품목 없음"}
          {req.items.length > 2 ? <span className="sm-faint"> 외 {req.items.length - 2}종</span> : null}
        </span>
        <span style={{ flex: 1, minWidth: 140, maxWidth: 260 }}><ProgressBar received={req.total_received} requested={req.total_requested} /></span>
      </button>

      {expanded && (
        <div style={{ borderTop: "1px solid var(--sm-border-light)", padding: 14 }}>
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

          {suggestComplete && <p style={{ fontSize: 13, color: "var(--sm-success)", marginTop: 10 }}>모든 품목이 요청 수량 이상 입고되었습니다. 생산이 끝났다면 ‘완료’를 누르세요.</p>}

          <div className="sm-row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {req.status === "요청" && (
              <button className="b2b-btn-primary" style={{ padding: "6px 14px" }} disabled={busy} onClick={() => onStatus("진행중")}>{PR_STATUS_LABEL["진행중"]}</button>
            )}
            {req.status !== "완료" && req.status !== "취소" && (
              <button className={req.status === "진행중" ? "b2b-btn-primary" : "b2b-btn-secondary"} style={{ padding: "6px 14px" }} disabled={busy} onClick={() => onStatus("완료")}>완료</button>
            )}
            {(req.status === "완료" || req.status === "취소") && (
              // 복구 — 입고 기록이 있으면 진행중, 없으면 요청(이전 단계)으로 되돌림.
              <button className="b2b-btn-secondary" style={{ padding: "6px 14px" }} disabled={busy} onClick={() => onStatus(req.total_received > 0 ? "진행중" : "요청")}>복구</button>
            )}
            {req.status !== "취소" && (
              <button className="b2b-btn-secondary" style={{ padding: "6px 14px" }} disabled={busy} onClick={() => onStatus("취소")}>취소</button>
            )}
            <button className="b2b-btn-danger" style={{ padding: "6px 14px" }} disabled={busy} onClick={onDelete}>삭제</button>
          </div>
        </div>
      )}
    </div>
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

function CreateModal({ products, busy, onClose, onCreate }: {
  products: Prod[]; busy: boolean; onClose: () => void; onCreate: (payload: unknown) => void;
}) {
  const [requestedBy, setRequestedBy] = useState("");
  const [date, setDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(addBusinessDays(todayIso(), 7)); // 생산마감일 기본=요청일+7영업일(급발주 시 수정)
  const [title, setTitle] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<NewLine[]>([]);

  function addLine(p: Prod) {
    setLines((prev) => [...prev, { product_id: p.product_id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit, stock: p.qty, requested_qty: "", memo: "" }]);
  }
  function updateLine(i: number, patch: Partial<NewLine>) { setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l))); }
  function removeLine(i: number) { setLines((prev) => prev.filter((_, idx) => idx !== i)); }

  const valid = lines.some((l) => Number(l.requested_qty) > 0);

  function submit() {
    const items = lines
      .filter((l) => Number(l.requested_qty) > 0)
      .map((l) => ({ product_id: l.product_id, requested_qty: Math.round(Number(l.requested_qty)), memo: l.memo.trim() || undefined }));
    onCreate({ title: title.trim() || undefined, requested_by: requestedBy.trim() || undefined, request_date: date, due_date: dueDate || undefined, memo: memo.trim() || undefined, items });
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">새 도매 생산 요청</h2><button className="b2b-modal-close" onClick={onClose}>✕</button></div>
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
                    <tr key={l.product_id}>
                      <td><div style={{ fontWeight: 600 }}>{l.name}</div><div style={{ fontSize: 13, color: "var(--sm-text-light)" }}>{l.sku || ""}{l.spec ? ` · ${l.spec}` : ""}</div></td>
                      <td className="num" style={{ color: "var(--sm-text-mid)" }}>{l.stock.toLocaleString()}</td>
                      <td className="num"><input type="number" className="b2b-input" style={{ width: 100, textAlign: "right" }} value={l.requested_qty} onChange={(e) => updateLine(i, { requested_qty: e.target.value })} placeholder="0" /></td>
                      <td><input className="b2b-input" value={l.memo} onChange={(e) => updateLine(i, { memo: e.target.value })} placeholder="(선택)" /></td>
                      <td><button className="b2b-link-btn" style={{ color: "var(--sm-danger)" }} onClick={() => removeLine(i)}>삭제</button></td>
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
          <button className="b2b-btn-primary" disabled={busy || !valid} onClick={submit}>요청서 만들기</button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── 제조사 요청서(집계) — 기존 기능 ─────────────────────────────

type AggRow = { name: string; spec: string; qty: number; manual: boolean };
type AggData = { from: string; to: string; label: string; rows: AggRow[]; total: number };
const PERIODS = [1, 7, 14, 30] as const;

function MakerTab() {
  const [days, setDays] = useState<number>(7);
  const [date, setDate] = useState(todayIso());
  const [data, setData] = useState<AggData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch(`/api/production/request?days=${days}&date=${date}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setData(j);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [days, date]);
  useEffect(() => { load(); }, [load]);

  const downloadUrl = `/api/production/request?days=${days}&date=${date}&format=xlsx`;

  return (
    <div>
      <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <p className="sm-faint" style={{ fontSize: 13, margin: 0 }}>제조사에 보낼 생산 요청을 생산예정일 기준으로 일/주/월 단위 집계합니다.</p>
        <a className="b2b-btn-primary" href={downloadUrl} style={{ textDecoration: "none" }}>엑셀 다운로드</a>
      </div>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div className="sm-tabs">
            {PERIODS.map((n) => (
              <button key={n} className={`sm-tab ${days === n ? "is-active" : ""}`} onClick={() => setDays(n)}>{n}일</button>
            ))}
          </div>
          <input type="date" className="b2b-input" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "auto" }} />
          {data && <span style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>{data.from} ~ {data.to}</span>}
        </div>
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : !data || data.rows.length === 0 ? (
        <div className="b2b-empty">이 기간에 생산 예정인 품목이 없습니다. (생산예정일이 비어있으면 집계되지 않습니다)</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead>
              <tr><th>품목명</th><th>규격</th><th className="num">생산량</th><th>비고</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.name}</td>
                  <td>{r.spec || "-"}</td>
                  <td className="num"><strong>{r.qty.toLocaleString()}</strong></td>
                  <td>{r.manual ? <span className="prod-side-manual-tag">직접</span> : ""}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}><strong>합계</strong></td>
                <td className="num"><strong style={{ color: "var(--sm-orange)" }}>{data.total.toLocaleString()}</strong></td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
