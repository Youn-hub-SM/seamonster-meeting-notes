"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { VOC_SOURCES, VOC_CATEGORIES, VOC_STATUSES, VOC_STATUS_COLOR, type Voc, type VocStatus } from "@/app/lib/voc";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST

type Form = {
  id?: string;
  received_at: string; source: string; channel: string; customer: string; product: string;
  category: string; content: string; assignee: string; status: string; loss_amount: string; resolution: string;
};
const emptyForm = (): Form => ({
  received_at: TODAY(), source: "직접입력", channel: "", customer: "", product: "",
  category: "불만", content: "", assignee: "", status: "접수", loss_amount: "", resolution: "",
});

export default function VocPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"전체" | VocStatus>("전체");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/voc", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 오류");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { 전체: rows.length };
    for (const s of VOC_STATUSES) c[s] = 0;
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== "전체" && r.status !== tab) return false;
      if (q && !(`${r.content} ${r.customer || ""} ${r.product || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [rows, tab, search]);

  function openNew() { setEdit(emptyForm()); }
  function openEdit(r: Voc) {
    setEdit({
      id: r.id, received_at: r.received_at, source: r.source, channel: r.channel || "", customer: r.customer || "",
      product: r.product || "", category: r.category, content: r.content, assignee: r.assignee || "",
      status: r.status, loss_amount: r.loss_amount ? String(r.loss_amount) : "", resolution: r.resolution || "",
    });
  }

  async function save() {
    if (!edit) return;
    if (!edit.content.trim()) { setError("내용을 입력하세요."); return; }
    setSaving(true); setError("");
    try {
      const method = edit.id ? "PATCH" : "POST";
      const res = await fetch("/api/voc", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...edit, loss_amount: Number(edit.loss_amount) || 0 }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setEdit(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    }
    setSaving(false);
  }

  async function changeStatus(r: Voc, status: string) {
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, status: status as VocStatus } : x)));
    try {
      const res = await fetch("/api/voc", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id, status }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "변경 실패");
    } catch (e) { setError(e instanceof Error ? e.message : "변경 실패"); await load(); }
  }

  async function remove() {
    if (!edit?.id) return;
    if (!window.confirm("이 VOC를 삭제할까요? 복구되지 않습니다.")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/voc?id=${encodeURIComponent(edit.id)}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "삭제 실패");
      setEdit(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
    setSaving(false);
  }

  const setF = (k: keyof Form, v: string) => setEdit((f) => (f ? { ...f, [k]: v } : f));

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">VOC 처리 상태</h1>
          <p className="b2b-page-subtitle">고객의 소리를 접수·처리·완료로 관리합니다. 상담 등에서 받은 건은 직접 입력하세요.</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={openNew}>+ VOC 추가</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{error.includes("voc") || error.includes("relation") ? " — supabase/migrations/023_voc.sql 를 먼저 적용하세요." : ""}</div>}

      <div className="prod-range-tabs" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        {(["전체", ...VOC_STATUSES] as const).map((s) => (
          <button key={s} className={`prod-range-tab ${tab === s ? "is-active" : ""}`} onClick={() => setTab(s)}>
            {s} <span style={{ opacity: 0.6 }}>{counts[s] || 0}</span>
          </button>
        ))}
        <input className="b2b-input" placeholder="내용·고객·상품 검색" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200, marginLeft: "auto" }} />
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : shown.length === 0 ? (
        <div className="b2b-empty"><div className="b2b-empty-icon">📭</div>{rows.length === 0 ? "아직 등록된 VOC가 없습니다. '+ VOC 추가'로 시작하세요." : "조건에 맞는 VOC가 없습니다."}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr>
              <th>접수일</th><th>경로</th><th>고객</th><th>유형</th><th>내용</th><th>담당자</th><th className="num">손해금액</th><th>상태</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => openEdit(r)} style={{ cursor: "pointer" }}>
                  <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(5)}</td>
                  <td>{r.source}</td>
                  <td>{r.customer || "-"}</td>
                  <td>{r.category}</td>
                  <td style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.content}</td>
                  <td>{r.assignee || "-"}</td>
                  <td className="num">{r.loss_amount ? r.loss_amount.toLocaleString() : "-"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      value={r.status}
                      onChange={(e) => changeStatus(r, e.target.value)}
                      className="b2b-input"
                      style={{ padding: "4px 8px", fontSize: 13, width: "auto", background: VOC_STATUS_COLOR[r.status].bg, color: VOC_STATUS_COLOR[r.status].fg, fontWeight: 700, border: "none", borderRadius: 8 }}
                    >
                      {VOC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <div className="b2b-modal-backdrop" onClick={() => setEdit(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">{edit.id ? "VOC 수정" : "VOC 추가 (직접 입력)"}</span>
              <button className="b2b-modal-close" onClick={() => setEdit(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">접수일</span>
                  <input className="b2b-input" type="date" value={edit.received_at} onChange={(e) => setF("received_at", e.target.value)} /></label>
                <label className="b2b-field"><span className="b2b-field-label">수집 경로</span>
                  <select className="b2b-input" value={edit.source} onChange={(e) => setF("source", e.target.value)}>{VOC_SOURCES.map((s) => <option key={s}>{s}</option>)}</select></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">고객 (이름/연락처)</span>
                  <input className="b2b-input" value={edit.customer} onChange={(e) => setF("customer", e.target.value)} placeholder="선택" /></label>
                <label className="b2b-field"><span className="b2b-field-label">채널</span>
                  <input className="b2b-input" value={edit.channel} onChange={(e) => setF("channel", e.target.value)} placeholder="전화·카톡·이메일…" /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">관련 상품</span>
                  <input className="b2b-input" value={edit.product} onChange={(e) => setF("product", e.target.value)} placeholder="선택" /></label>
                <label className="b2b-field"><span className="b2b-field-label">유형</span>
                  <select className="b2b-input" value={edit.category} onChange={(e) => setF("category", e.target.value)}>{VOC_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
              </div>
              <label className="b2b-field"><span className="b2b-field-label">내용 <span className="req">*</span></span>
                <textarea className="b2b-textarea" rows={3} value={edit.content} onChange={(e) => setF("content", e.target.value)} placeholder="고객이 말한 내용" /></label>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">담당자</span>
                  <input className="b2b-input" value={edit.assignee} onChange={(e) => setF("assignee", e.target.value)} placeholder="선택" /></label>
                <label className="b2b-field"><span className="b2b-field-label">손해/보상 금액 (원)</span>
                  <input className="b2b-input" type="number" value={edit.loss_amount} onChange={(e) => setF("loss_amount", e.target.value)} placeholder="0" /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">상태</span>
                  <select className="b2b-input" value={edit.status} onChange={(e) => setF("status", e.target.value)}>{VOC_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
                <div className="b2b-field" />
              </div>
              <label className="b2b-field"><span className="b2b-field-label">처리 내용/메모</span>
                <textarea className="b2b-textarea" rows={2} value={edit.resolution} onChange={(e) => setF("resolution", e.target.value)} placeholder="어떻게 처리했는지" /></label>
            </div>
            <div className="b2b-modal-foot">
              {edit.id ? <button className="b2b-btn-secondary" onClick={remove} disabled={saving} style={{ color: "#c92a2a" }}>삭제</button> : <span />}
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setEdit(null)}>취소</button>
                <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : "저장"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
