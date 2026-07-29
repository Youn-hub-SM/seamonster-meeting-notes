"use client";

// 생산 요청 목록 — 신청번호(req_no)별 요청서 + 품목별 입고 처리. (/production/request '생산 요청' 메뉴)
//  '생산'(/production/inventory) 화면의 '생산 요청' 버튼이 여기 목록으로 요청을 만든다.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PR_LINE_COLOR, PR_PURPOSES, lineState, allLinesFilled,
  type ProductionRequest, type PrItem, type PrStatus, type PrPurpose,
} from "@/app/lib/wholesale-production";
import { addBusinessDays } from "@/app/lib/business-days";
import { Combobox } from "@/app/b2b/orders/Combobox";

// KST 오늘 — 서버(UTC SSR)·클라이언트 모두 서울 벽시계 날짜로 일치(새벽 하이드레이션 불일치 방지)
function todayIso() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }

// ───────────────────────────── 도매 재고 생산 요청 ─────────────────────────────

type Prod = { product_id: string; sku: string | null; name: string; spec: string | null; unit: string; qty: number };
type NewLine = {
  item_id?: string;          // 수정 모드: 기존 라인 id (신규 추가 라인은 없음)
  received: number;          // 수정 모드: 입고 누계 — 입고 있는 라인은 뺄 수 없음
  product_id: string; sku: string | null; name: string; spec: string | null; unit: string;
  stock: number | null;      // 도매재고(모를 때 null 표시)
  requested_qty: string; memo: string;
};

export function RequestList() {
  const [requests, setRequests] = useState<ProductionRequest[]>([]);
  const [showDone, setShowDone] = useState(false); // 기본 진행(요청·진행중)만 — 완료·취소는 토글로
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [products, setProducts] = useState<Prod[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editReq, setEditReq] = useState<ProductionRequest | null>(null); // 수정 모달 대상
  const [busy, setBusy] = useState(false);
  const [prefill, setPrefill] = useState<NewLine[] | null>(null); // 생산 조언에서 넘어온 품목·권장수량

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

  const displayed = useMemo(
    () => (showDone ? requests : requests.filter((r) => r.status === "요청" || r.status === "진행중")),
    [requests, showDone]);

  // 담당자 '확인' 버튼용 로그인 사용자 이름
  const [userName, setUserName] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" }).then((r) => r.json()).then((j) => setUserName(j?.ok ? j.name || null : null)).catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch("/api/inventory/overview?channel=도매", { cache: "no-store" })).json();
        // 묶음(세트)은 자체 재고가 없어(구성품 기준) 생산 입고 대상이 아님 → 선택기에서 제외.
        if (j.ok) setProducts((j.rows || []).filter((r: { is_bundle?: boolean }) => !r.is_bundle).map((r: Prod) => ({ product_id: r.product_id, sku: r.sku, name: r.name, spec: r.spec, unit: r.unit, qty: r.qty })));
      } catch { /* noop */ }
    })();
  }, []);

  // 생산 조언 → '생산 요청 만들기' 핸드오프: 조언 화면이 sessionStorage에 담은 {sku, qty}[] 를
  //  품목 목록 로드 후 SKU로 매칭해, 권장 수량이 채워진 새 요청 모달을 자동으로 연다.
  useEffect(() => {
    if (!products.length) return;
    let raw: string | null = null;
    try { raw = sessionStorage.getItem("prod_req_prefill"); sessionStorage.removeItem("prod_req_prefill"); } catch { /* noop */ }
    if (!raw) return;
    try {
      const items = JSON.parse(raw) as { sku?: unknown; qty?: unknown }[];
      const lines: NewLine[] = [];
      const missed: string[] = [];
      for (const it of Array.isArray(items) ? items : []) {
        const sku = String(it?.sku ?? "").trim();
        if (!sku) continue;
        const p = products.find((x) => (x.sku || "").toUpperCase() === sku.toUpperCase());
        if (!p) { missed.push(sku); continue; }
        const qty = Math.max(0, Math.round(Number(it?.qty) || 0));
        lines.push({ received: 0, product_id: p.product_id, sku: p.sku, name: p.name, spec: p.spec, unit: p.unit, stock: p.qty, requested_qty: qty ? String(qty) : "", memo: "" });
      }
      if (missed.length) setError(`생산 조언 품목 중 ${missed.length}종은 품목 목록에 없어 제외했습니다: ${missed.join(", ")} (묶음이거나 SKU 미등록)`);
      if (lines.length) { setPrefill(lines); setCreateOpen(true); }
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

  const doneCount = useMemo(() => requests.filter((r) => r.status === "완료" || r.status === "취소").length, [requests]);

  // 제조사에게 건넬 요청서 텍스트 — 담당자가 확인 후 복사해 전달(제조사 전달용, DB 저장 없음).
  const [copiedId, setCopiedId] = useState<string | null>(null);
  async function copyRequestSheet(r: ProductionRequest) {
    // 제조사 전달용 — 내부 정보(요청자·담당·제목·용도)는 빼고 번호·날짜·품목만(대표 확정 서식).
    const L: string[] = [];
    L.push(`[생산 요청서] ${r.req_no || ""}`.trim());
    L.push("");
    L.push(`요청일 ${r.request_date}`);
    L.push(`생산마감일 ${r.due_date || "-"}`);
    L.push("");
    L.push("--------------------------------");
    L.push("");
    r.items.forEach((it, i) => L.push(`${i + 1}. ${it.name}${it.spec ? ` ${it.spec}` : ""}${it.sku ? ` [${it.sku}]` : ""}  ×${it.requested_qty.toLocaleString()}${it.unit || ""}${it.memo ? ` — ${it.memo}` : ""}`));
    L.push("");
    L.push("--------------------------------");
    L.push("");
    L.push(`총 ${r.items.length}품목 · ${r.total_requested.toLocaleString()}개`);
    try {
      await navigator.clipboard.writeText(L.join("\n"));
      setCopiedId(r.id); setTimeout(() => setCopiedId(null), 2000);
    } catch { setError("복사 실패 — 브라우저 권한을 확인하세요."); }
  }

  // 생산 담당자 확인 — 담당자=본인 기록 + 진행중 전환(제조사에 전달했다는 표시)
  async function confirmRequest(r: ProductionRequest) {
    await updateRequest(r.id, { assignee: userName || "확인", status: r.status === "요청" ? "진행중" : r.status });
  }

  return (
    <div>
      {error && <div className="b2b-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)", cursor: "pointer" }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 완료·취소 보기 <span className="sm-faint" style={{ fontSize: 12 }}>({doneCount})</span>
        </label>
        <div className="sm-row" style={{ gap: 8 }}>
          <button className="b2b-btn-secondary" onClick={() => load()} disabled={loading}>{loading ? "불러오는 중..." : "새로고침"}</button>
          <button className="b2b-btn-primary" onClick={() => setCreateOpen(true)} disabled={busy}>+ 새 생산 요청</button>
        </div>
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : displayed.length === 0 ? (
        <div className="b2b-empty">{showDone ? "요청이 없습니다." : "진행 중인 생산 요청이 없습니다. ‘+ 새 생산 요청’으로 시작하세요."}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead>
              <tr>
                <th style={{ width: 1 }}></th>
                <th>요청번호</th>
                <th>품목</th>
                <th className="b2b-col-date">진행</th>
                <th className="b2b-col-date">요청일</th>
                <th className="b2b-col-date">마감일</th>
                <th className="b2b-col-date">담당</th>
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((r) => (
                <RequestRow
                  key={r.id} req={r} expanded={expandedId === r.id} busy={busy}
                  onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
                  onCancelReceipt={(rid) => cancelReceipt(r.id, rid)}
                  onStatus={(s) => patchStatus(r.id, s)}
                  onConfirm={() => confirmRequest(r)}
                  onCopySheet={() => copyRequestSheet(r)}
                  copied={copiedId === r.id}
                  onEdit={() => setEditReq(r)}
                  onDelete={() => removeRequest(r.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && <RequestModal products={products} prefill={prefill ?? undefined} busy={busy} onClose={() => { setCreateOpen(false); setPrefill(null); }} onSubmit={createRequest} />}
      {editReq && <RequestModal initial={editReq} products={products} busy={busy} onClose={() => setEditReq(null)} onSubmit={(payload) => updateRequest(editReq.id, payload)} />}
    </div>
  );
}

// 진행(입고/요청) 표시 — 테이블 셀용 텍스트. 초과=danger, 완료=success, 그 외 회색.
function ProgressCell({ received, requested }: { received: number; requested: number }) {
  const over = received > requested;
  const done = requested > 0 && received >= requested;
  const color = over ? "var(--sm-danger)" : done ? "var(--sm-success)" : "var(--sm-text-mid)";
  const pct = requested > 0 ? (received / requested) * 100 : null;
  return (
    <span style={{ fontSize: 13, fontWeight: 600, color, whiteSpace: "nowrap" }}>
      {received.toLocaleString()} / {requested.toLocaleString()}
      {pct != null && <span className="sm-faint" style={{ marginLeft: 4, fontSize: 11.5, fontWeight: 400 }}>({Math.round(pct)}%)</span>}
    </span>
  );
}

// 발주관리 테이블과 동일한 형태 — 한 줄=한 요청, 클릭하면 그 아래 확장 행으로 입고 처리 상세가 펼쳐짐.
function RequestRow({ req, expanded, busy, onToggle, onCancelReceipt, onStatus, onConfirm, onCopySheet, copied, onEdit, onDelete }: {
  req: ProductionRequest; expanded: boolean; busy: boolean;
  onToggle: () => void;
  onCancelReceipt: (rid: string) => void;
  onStatus: (s: PrStatus) => void;
  onConfirm: () => void;
  onCopySheet: () => void;
  copied: boolean;
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
        <td className="b2b-col-date" onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
          {/* 생산 담당자 확인 — 확인하면 담당=본인 기록(+진행중 전환). 요청서를 제조사에 건네는 사람이 담당. */}
          {req.assignee ? (
            <span style={{ fontSize: 13, fontWeight: 600 }}>{req.assignee}
              {(req.status === "완료" || req.status === "취소") && <span className="sm-faint" style={{ marginLeft: 5, fontSize: 11 }}>{req.status}</span>}
            </span>
          ) : (req.status === "요청" || req.status === "진행중") ? (
            <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} disabled={busy} onClick={onConfirm}>확인</button>
          ) : (
            <span className="sm-faint" style={{ fontSize: 12 }}>{req.status}</span>
          )}
        </td>
        <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          <button className="b2b-link-btn" disabled={busy} onClick={onCopySheet} title="제조사에 건넬 요청서 텍스트 복사">{copied ? "복사됨 ✓" : "요청서"}</button>
          {editable && <button className="b2b-link-btn" style={{ marginLeft: 6 }} disabled={busy} onClick={onEdit}>수정</button>}
          <button className="b2b-link-btn" style={{ color: "var(--sm-danger)", marginLeft: 6 }} disabled={busy} onClick={onDelete}>삭제</button>
        </td>
      </tr>

      {expanded && (
        <tr className="b2b-child-row">
          <td></td>
          <td colSpan={7} style={{ padding: "8px 18px 16px" }}>
            {req.memo && <p className="sm-faint" style={{ fontSize: 13, marginBottom: 10 }}>메모: {req.memo}</p>}

            <p className="sm-faint" style={{ fontSize: 12.5, marginBottom: 8 }}>
              입고는 <strong>입고 및 출고</strong> 메뉴에서 하세요 — 같은 품목이 입고되면 이 요청에 자동으로 연결됩니다(오래된 요청부터). 잘못 연결된 입고는 아래 입고 이력에서 취소.
            </p>
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead>
                  <tr><th>품목</th><th className="num">요청</th><th className="num">입고</th><th className="num">잔여</th><th>상태</th><th>입고 이력</th></tr>
                </thead>
                <tbody>
                  {req.items.map((it) => (
                    <ItemRow key={it.id} item={it} canEdit={req.status !== "완료" && req.status !== "취소"} busy={busy} onCancelReceipt={onCancelReceipt} />
                  ))}
                </tbody>
              </table>
            </div>

            {suggestComplete && (
              <div className="sm-row" style={{ gap: 10, marginTop: 10, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "var(--sm-success)" }}>모든 품목이 요청 수량 이상 입고되었습니다.</span>
                <button className="b2b-btn-primary" style={{ padding: "5px 14px", fontSize: 12.5 }} disabled={busy} onClick={() => onStatus("완료")}>생산 완료 처리</button>
              </div>
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
          <div style={{ fontSize: 13, color: "var(--sm-text-light)" }}>{item.sku || ""}{item.spec ? ` · ${item.spec}` : ""}</div>
        </td>
        <td className="num">{item.requested_qty.toLocaleString()}</td>
        <td className="num" style={{ fontWeight: 700 }}>{item.received_qty.toLocaleString()}</td>
        <td className="num" style={{ color: remaining > 0 ? "var(--sm-text-mid)" : remaining < 0 ? "var(--sm-danger)" : "var(--sm-success)" }}>{remaining.toLocaleString()}</td>
        <td><span style={{ fontSize: 13, fontWeight: 700, color: PR_LINE_COLOR[st] }}>{st}</span></td>
        <td>
          {item.receipts.length > 0 ? (
            <button className="b2b-btn-secondary" style={{ padding: "4px 12px" }} disabled={busy} onClick={() => setOpen((v) => !v)}>{open ? "닫기" : "입고 이력"}</button>
          ) : <span style={{ fontSize: 13, color: "var(--sm-text-light)" }}>—</span>}
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={6} style={{ background: "var(--sm-bg-subtle)" }}>

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
function RequestModal({ initial, prefill, products, busy, onClose, onSubmit }: {
  initial?: ProductionRequest; prefill?: NewLine[]; products: Prod[]; busy: boolean; onClose: () => void; onSubmit: (payload: unknown) => void;
}) {
  const isEdit = !!initial;
  const stockOf = (pid: string): number | null => { const p = products.find((x) => x.product_id === pid); return p ? p.qty : null; };
  const [requestedBy, setRequestedBy] = useState(initial?.requested_by || "");
  const [date, setDate] = useState(initial?.request_date || todayIso());
  // 생산마감일 필수 — 기본 요청일+7영업일(급발주 시 수정). 옛 요청서에 마감일이 비어 있으면 기본값으로 채워서 연다.
  const [dueDate, setDueDate] = useState(initial ? (initial.due_date || addBusinessDays(initial.request_date, 7)) : addBusinessDays(todayIso(), 7));
  const [title, setTitle] = useState(initial?.title || "");
  // 용도(082): 자동 생성('생산' 화면)은 재고 보충으로 만들어지므로, MD가 직접 여는 이 모달은 기본 도매 납품.
  const [purpose, setPurpose] = useState<PrPurpose>(initial?.purpose || "도매 납품");
  const [memo, setMemo] = useState(initial?.memo || "");
  const [lines, setLines] = useState<NewLine[]>(() =>
    initial
      ? initial.items.map((it) => ({
          item_id: it.id, received: it.received_qty,
          product_id: it.product_id, sku: it.sku, name: it.name, spec: it.spec, unit: it.unit,
          stock: stockOf(it.product_id), requested_qty: String(it.requested_qty), memo: it.memo || "",
        }))
      : (prefill ?? [])   // 생산 조언에서 넘어온 품목·권장수량 (없으면 빈 목록)
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
      purpose,
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
            <div className="sm-col" style={{ gap: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>용도</span>
              <div className="sm-tabs" style={{ margin: 0 }}>
                {PR_PURPOSES.map((pp) => (
                  <button key={pp} type="button" className={`sm-tab ${purpose === pp ? "is-active" : ""}`} onClick={() => setPurpose(pp)}>{pp}</button>
                ))}
              </div>
            </div>
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
