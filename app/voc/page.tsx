"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { VOC_CATEGORIES, VOC_STATUSES, VOC_STATUS_COLOR, type Voc, type VocStatus } from "@/app/lib/voc";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST

type Form = {
  id?: string;
  received_at: string; channel: string; customer: string;
  purchase_date: string; production_date: string; purchase_place: string; product: string;
  category: string; content: string; resolution: string; cause: string;
  status: string; improvement: string; loss_amount: string; photos: string[];
};
const emptyForm = (): Form => ({
  received_at: TODAY(), channel: "", customer: "",
  purchase_date: "", production_date: "", purchase_place: "", product: "",
  category: "배송", content: "", resolution: "", cause: "",
  status: "대기", improvement: "", loss_amount: "", photos: [],
});

export default function VocPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"전체" | VocStatus>("전체");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

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
      id: r.id, received_at: r.received_at, channel: r.channel || "", customer: r.customer || "",
      purchase_date: r.purchase_date || "", production_date: r.production_date || "", purchase_place: r.purchase_place || "", product: r.product || "",
      category: r.category, content: r.content, resolution: r.resolution || "", cause: r.cause || "",
      status: r.status, improvement: r.improvement || "", loss_amount: r.loss_amount ? String(r.loss_amount) : "", photos: r.photos || [],
    });
  }

  async function save() {
    if (!edit) return;
    if (!edit.received_at) { setError("접수일을 입력하세요."); return; }
    if (!edit.content.trim()) { setError("상세내용을 입력하세요."); return; }
    setSaving(true); setError("");
    try {
      const method = edit.id ? "PATCH" : "POST";
      const res = await fetch("/api/voc", {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(edit),
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
    setError("");
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
    setSaving(true); setError("");
    try {
      const res = await fetch(`/api/voc?id=${encodeURIComponent(edit.id)}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "삭제 실패");
      setEdit(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
    setSaving(false);
  }

  const setF = (k: keyof Form, v: string) => setEdit((f) => (f ? { ...f, [k]: v } : f));

  async function uploadPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true); setError("");
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/voc/photo", { method: "POST", body: fd });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || "업로드 실패");
        setEdit((f) => (f ? { ...f, photos: [...f.photos, j.url] } : f));
      }
    } catch (e) { setError(e instanceof Error ? e.message : "사진 업로드 실패"); }
    setUploading(false);
  }
  const removePhoto = (url: string) => setEdit((f) => (f ? { ...f, photos: f.photos.filter((p) => p !== url) } : f));

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">VOC 처리 상태</h1>
          <p className="b2b-page-subtitle">고객의 소리(클레임)를 접수·진행·완료로 관리합니다. 상담 등에서 받은 건은 직접 입력하세요.</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={openNew}>+ VOC 추가</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("voc") || error.includes("relation")) ? " — supabase/migrations/023_voc.sql 를 먼저 적용하세요." : ""}</div>}

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
              <th>접수일</th><th>접수채널</th><th>고객</th><th>구매상품</th><th>유형</th><th>상세내용</th><th>상태</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => openEdit(r)} style={{ cursor: "pointer" }}>
                  <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(5)}</td>
                  <td>{r.channel || "-"}</td>
                  <td>{r.customer || "-"}</td>
                  <td>{r.product || "-"}</td>
                  <td>{r.category}</td>
                  <td style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.content}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      value={r.status}
                      onChange={(e) => changeStatus(r, e.target.value)}
                      className="b2b-input"
                      style={{ padding: "4px 8px", fontSize: 12, width: "auto", background: VOC_STATUS_COLOR[r.status].bg, color: VOC_STATUS_COLOR[r.status].fg, fontWeight: 700, border: "none", borderRadius: 8 }}
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
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">{edit.id ? "VOC 수정" : "VOC 추가 (직접 입력)"}</span>
              <button className="b2b-modal-close" onClick={() => setEdit(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">접수일</span>
                  <input className="b2b-input" type="date" required value={edit.received_at} onChange={(e) => setF("received_at", e.target.value)} /></label>
                <label className="b2b-field"><span className="b2b-field-label">접수채널</span>
                  <input className="b2b-input" value={edit.channel} onChange={(e) => setF("channel", e.target.value)} placeholder="전화·카톡·이메일·리뷰…" /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">고객명</span>
                  <input className="b2b-input" value={edit.customer} onChange={(e) => setF("customer", e.target.value)} placeholder="이름/연락처" /></label>
                <label className="b2b-field"><span className="b2b-field-label">구매일</span>
                  <input className="b2b-input" type="date" value={edit.purchase_date} onChange={(e) => setF("purchase_date", e.target.value)} /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">구매처</span>
                  <input className="b2b-input" value={edit.purchase_place} onChange={(e) => setF("purchase_place", e.target.value)} placeholder="공식몰·쿠팡·네이버…" /></label>
                <label className="b2b-field"><span className="b2b-field-label">구매상품</span>
                  <input className="b2b-input" value={edit.product} onChange={(e) => setF("product", e.target.value)} placeholder="상품명" /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">제품 생산일</span>
                  <input className="b2b-input" type="date" value={edit.production_date} onChange={(e) => setF("production_date", e.target.value)} /></label>
                <label className="b2b-field"><span className="b2b-field-label">손해/보상 금액 (원)</span>
                  <input className="b2b-input" type="number" min={0} value={edit.loss_amount} onChange={(e) => setF("loss_amount", e.target.value)} placeholder="0" /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">클레임 유형</span>
                  <select className="b2b-input" value={edit.category} onChange={(e) => setF("category", e.target.value)}>{VOC_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
                <label className="b2b-field"><span className="b2b-field-label">상태</span>
                  <select className="b2b-input" value={edit.status} onChange={(e) => setF("status", e.target.value)}>{VOC_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
              </div>
              <label className="b2b-field"><span className="b2b-field-label">상세내용 <span className="req">*</span></span>
                <textarea className="b2b-textarea" rows={3} value={edit.content} onChange={(e) => setF("content", e.target.value)} placeholder="고객이 말한 내용" /></label>
              <label className="b2b-field"><span className="b2b-field-label">원인</span>
                <textarea className="b2b-textarea" rows={2} value={edit.cause} onChange={(e) => setF("cause", e.target.value)} placeholder="왜 발생했는지 (분석)" /></label>
              <label className="b2b-field"><span className="b2b-field-label">처리내용</span>
                <textarea className="b2b-textarea" rows={2} value={edit.resolution} onChange={(e) => setF("resolution", e.target.value)} placeholder="어떻게 처리했는지" /></label>
              <label className="b2b-field"><span className="b2b-field-label">개선 필요사항</span>
                <textarea className="b2b-textarea" rows={2} value={edit.improvement} onChange={(e) => setF("improvement", e.target.value)} placeholder="재발 방지를 위해 바꿔야 할 것" /></label>
              <div className="b2b-field">
                <span className="b2b-field-label">사진 첨부 <span className="sm-faint" style={{ fontWeight: 400 }}>· 개선요청서에 자동 첨부됩니다</span></span>
                <div className="sm-row-wrap" style={{ gap: 8 }}>
                  {edit.photos.map((url) => (
                    <div key={url} style={{ position: "relative" }}>
                      <img src={url} alt="첨부" style={{ width: 74, height: 74, objectFit: "cover", borderRadius: 8, border: "1px solid var(--sm-border)" }} />
                      <button type="button" onClick={() => removePhoto(url)} aria-label="사진 삭제"
                        style={{ position: "absolute", top: -7, right: -7, width: 21, height: 21, borderRadius: "50%", border: "2px solid var(--sm-white)", background: "var(--sm-danger)", color: "#fff", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}>✕</button>
                    </div>
                  ))}
                  <label style={{ width: 74, height: 74, borderRadius: 8, border: "1px dashed var(--sm-border)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--sm-text-light)", fontSize: 22, flexShrink: 0 }}>
                    {uploading ? "…" : "+"}
                    <input type="file" accept="image/*" multiple style={{ display: "none" }} disabled={uploading}
                      onChange={(e) => { uploadPhotos(e.target.files); e.target.value = ""; }} />
                  </label>
                </div>
              </div>
            </div>
            <div className="b2b-modal-foot">
              {edit.id ? <button className="b2b-btn-secondary" onClick={remove} disabled={saving} style={{ color: "var(--sm-danger)" }}>삭제</button> : <span />}
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
