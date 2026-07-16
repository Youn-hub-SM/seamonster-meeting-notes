"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VOC_CATEGORIES, VOC_CAT_STATUSES, VOC_CAT_STATUS_COLOR, VOC_BUYER_TYPES, VOC_COMP_TYPES, VOC_COMP_MANUAL, VOC_FAULTS, suggestFault, computeVocLoss, type Voc, type VocCategoryRow, type VocCatStatus } from "@/app/lib/voc";
import { Combobox } from "@/app/b2b/orders/Combobox";
import { type VocImportRow } from "@/app/lib/voc-xlsx";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST

type Form = {
  id?: string;
  received_at: string; customer: string; buyer_type: string;
  purchase_date: string; production_date: string; purchase_place: string; product: string;
  category: string; content: string; resolution: string; cause: string;
  status: string; improvement: string; customer_note: string;
  comp_type: string; comp_qty: string; fault: string; loss_amount: string; photos: string[];
};
const emptyForm = (): Form => ({
  received_at: TODAY(), customer: "", buyer_type: "",
  purchase_date: "", production_date: "", purchase_place: "", product: "",
  category: "배송", content: "", resolution: "", cause: "",
  status: "접수", improvement: "", customer_note: "",
  comp_type: "없음", comp_qty: "1", fault: suggestFault("배송"), loss_amount: "", photos: [],
});

export default function VocPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 보기: 유형별 현황판(기본) / 전체 목록. 건별 상태 관리는 제거 — 개선 추적은 유형 단위(개선 작업은 Flow).
  const [view, setView] = useState<"현황판" | "목록">("현황판");
  const [month, setMonth] = useState(() => TODAY().slice(0, 7)); // 현황판 기준 월(YYYY-MM)
  const [cats, setCats] = useState<VocCategoryRow[]>([]);
  const [catManaged, setCatManaged] = useState(true); // false = 072 미적용(읽기 전용 8종)
  const [expandedCat, setExpandedCat] = useState<string | null>(null);
  const [catModal, setCatModal] = useState(false);
  const catBusy = useRef<Set<string>>(new Set()); // 유형 상태 변경 in-flight(연타 방지)
  const [search, setSearch] = useState("");
  // 컬럼 필터 (유형·상품·구매처·구매자·접수일 범위)
  const [fCategory, setFCategory] = useState("");
  const [fProduct, setFProduct] = useState("");
  const [fPlace, setFPlace] = useState("");
  const [fBuyer, setFBuyer] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [edit, setEdit] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [flowBusy, setFlowBusy] = useState("");   // flow 등록 중인 VOC id
  const [uploading, setUploading] = useState(false);
  // 엑셀 일괄 등록
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<{ summary: { valid: number; errors: number }; rows: VocImportRow[]; errors: { line: number; msg: string }[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [j, cj] = await Promise.all([
        (await fetch("/api/voc", { cache: "no-store" })).json(),
        (await fetch("/api/voc/categories", { cache: "no-store" })).json().catch(() => ({ ok: false })),
      ]);
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
      if (cj.ok) { setCats(cj.categories || []); setCatManaged(cj.managed !== false); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 오류");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // 유형별 개선 상태 변경 — '개선완료' 전환 시 서버가 resolved_at 기록(월말 결산 축)
  async function changeCatStatus(cat: VocCategoryRow, status: VocCatStatus) {
    if (cat.status === status || catBusy.current.has(cat.id)) return;
    catBusy.current.add(cat.id);
    setError("");
    setCats((cs) => cs.map((c) => (c.id === cat.id ? { ...c, status } : c)));
    try {
      const res = await fetch("/api/voc/categories", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cat.id, status }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "변경 실패");
      if (j.category) setCats((cs) => cs.map((c) => (c.id === cat.id ? j.category : c)));
    } catch (e) { setError(e instanceof Error ? e.message : "변경 실패"); await load(); }
    finally { catBusy.current.delete(cat.id); }
  }

  // 공용 상품 마스터(자동완성 + 손해금액 자동계산 단가)
  const [products, setProducts] = useState<{ id: string; name: string; sku: string | null; spec: string | null; cost_price: number | null; volume_kg: number | null }[]>([]);
  const nowMonth = new Date(Date.now() + 9 * 3600_000).getMonth() + 1; // KST 현재월(계절 판정)
  useEffect(() => {
    fetch("/api/products", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) setProducts(j.products || []); }).catch(() => {});
  }, []);

  // 보상유형·수량·상품 변경 시 손해금액 자동계산
  //  없음 → 0, 추가보상·부분환불 → 직접입력 유지, 그 외 → 마스터 단가 기준(매칭 안되면 직접입력 유지)
  useEffect(() => {
    setEdit((f) => {
      if (!f) return f;
      if (f.comp_type === "없음") return f.loss_amount === "0" ? f : { ...f, loss_amount: "0" };
      if (VOC_COMP_MANUAL.has(f.comp_type)) return f;
      const p = products.find((x) => x.name === f.product);
      if (!p) return f; // 마스터에 없는 상품 → 단가 미확인, 직접입력 유지
      const r = computeVocLoss({ compType: f.comp_type, qty: Number(f.comp_qty), costPrice: Number(p.cost_price) || 0, volumeKg: Number(p.volume_kg) || 0, receivedAt: f.received_at, fallbackMonth: nowMonth });
      const s = String(r.amount);
      return f.loss_amount === s ? f : { ...f, loss_amount: s };
    });
  }, [edit?.comp_type, edit?.comp_qty, edit?.product, edit?.received_at, products, nowMonth]);

  // 필터 드롭다운 옵션 (데이터에 등장한 값)
  const productOpts = useMemo(() => [...new Set(rows.map((r) => r.product).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "ko")), [rows]);
  const placeOpts = useMemo(() => [...new Set(rows.map((r) => r.purchase_place).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "ko")), [rows]);

  // 모든 필터를 적용한 베이스(전체 목록 뷰). 날짜 필터는 접수일(received_at) 기준 — 월별 파악 전제.
  const base = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !(`${r.content} ${r.customer || ""} ${r.product || ""}`.toLowerCase().includes(q))) return false;
      if (fCategory && r.category !== fCategory) return false;
      if (fProduct && r.product !== fProduct) return false;
      if (fPlace && r.purchase_place !== fPlace) return false;
      if (fBuyer && r.buyer_type !== fBuyer) return false;
      if (fFrom && (r.received_at || "") < fFrom) return false;
      if (fTo && (r.received_at || "") > fTo) return false;
      return true;
    });
  }, [rows, search, fCategory, fProduct, fPlace, fBuyer, fFrom, fTo]);

  const shown = base;

  // 유형별 현황판 데이터 — 선택 월 발생 건수 + 전체 누적. 마스터에 없는 유형(과거 데이터)도 표시.
  const board = useMemo(() => {
    const inMonth = rows.filter((r) => (r.received_at || "").startsWith(month));
    const names = new Set<string>([...cats.filter((c) => c.active).map((c) => c.name), ...rows.map((r) => r.category)]);
    return [...names].map((name) => {
      const cat = cats.find((c) => c.name === name) || null;
      return {
        name, cat,
        monthRows: inMonth.filter((r) => r.category === name),
        totalCount: rows.filter((r) => r.category === name).length,
      };
    }).sort((a, b) => (b.monthRows.length - a.monthRows.length) || ((a.cat?.sort ?? 99) - (b.cat?.sort ?? 99)) || a.name.localeCompare(b.name, "ko"));
  }, [rows, cats, month]);

  const hasFilter = !!(search || fCategory || fProduct || fPlace || fBuyer || fFrom || fTo);
  const resetFilters = () => { setSearch(""); setFCategory(""); setFProduct(""); setFPlace(""); setFBuyer(""); setFFrom(""); setFTo(""); };

  function openNew() { setEdit(emptyForm()); }
  function openEdit(r: Voc) {
    setEdit({
      id: r.id, received_at: r.received_at, customer: r.customer || "", buyer_type: r.buyer_type || "",
      purchase_date: r.purchase_date || "", production_date: r.production_date || "", purchase_place: r.purchase_place || "", product: r.product || "",
      category: r.category, content: r.content, resolution: r.resolution || "", cause: r.cause || "",
      status: r.status, improvement: r.improvement || "", customer_note: r.customer_note || "",
      comp_type: r.comp_type || "없음", comp_qty: String(r.comp_qty ?? 1), fault: r.fault || suggestFault(r.category), loss_amount: r.loss_amount ? String(r.loss_amount) : "", photos: r.photos || [],
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

  // flow(플로우)에 업무로 등록 — 클릭 1회. 성공 시 '등록됨' 표시(중복 방지).
  async function registerFlow(r: Voc) {
    if (r.flow_task_at) { setError("이미 flow에 등록된 VOC입니다."); return; }
    if (flowBusy) { setError("다른 VOC의 flow 등록이 진행 중입니다. 잠시 후 다시 시도하세요."); return; }
    if (!window.confirm(`이 VOC를 flow에 업무로 등록할까요?\n제목: [VOC/${r.category}] ${r.product || "상품미상"} - ${r.customer || "고객"}`)) return;
    setFlowBusy(r.id); setError("");
    try {
      const res = await fetch("/api/voc/flow-task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "flow 등록 실패");
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, flow_task_at: j.flow_task_at, flow_task_id: j.flow_task_id, flow_project_id: j.flow_project_id } : x)));
    } catch (e) { setError(e instanceof Error ? e.message : "flow 등록 실패"); }
    setFlowBusy("");
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

  async function handleVocFile(file: File) {
    setImporting(true); setError("");
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch("/api/voc/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setPreview(j as NonNullable<typeof preview>);
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setImporting(false);
  }
  async function applyVocImport() {
    if (!preview) return;
    setApplying(true); setError("");
    try {
      const res = await fetch("/api/voc/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: preview.rows }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "등록 실패");
      setPreview(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "등록 실패"); }
    setApplying(false);
  }

  // 손해금액 계산 근거 안내문
  const matched = edit ? products.find((p) => p.name === edit.product) : undefined;
  const isManualType = edit ? VOC_COMP_MANUAL.has(edit.comp_type) : false;
  let lossHint = "";
  if (edit) {
    if (edit.comp_type === "없음") lossHint = "보상 없음 → 0원";
    else if (isManualType) lossHint = "직접 입력 유형 (자동계산 없음)";
    else if (!matched) lossHint = "상품 단가 미확인 (마스터에 없는 상품) → 직접 입력";
    else {
      const cost = Number(matched.cost_price) || 0;
      const qn = Math.max(1, Number(edit.comp_qty) || 1);
      const r = computeVocLoss({ compType: edit.comp_type, qty: qn, costPrice: cost, volumeKg: Number(matched.volume_kg) || 0, receivedAt: edit.received_at, fallbackMonth: nowMonth });
      lossHint = r.shipping > 0
        ? `원가 ${cost.toLocaleString()}×${qn} + 배송 ${r.shipping.toLocaleString()}(${r.boxes}박스) = ${r.amount.toLocaleString()}원 (자동)`
        : `원가 ${cost.toLocaleString()}×${qn} = ${r.productCost.toLocaleString()}원 · 배송원가 제외(부피 미입력)`;
    }
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">VOC 처리</h1>
        </div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href="/api/voc/template" title="VOC 일괄 등록 엑셀 양식">엑셀 양식</a>
          <label className="b2b-btn-secondary" style={{ cursor: importing ? "default" : "pointer" }}>
            {importing ? "분석 중…" : "엑셀 업로드"}
            <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVocFile(f); e.target.value = ""; }} />
          </label>
          <button className="b2b-btn-primary" onClick={openNew}>+ VOC 추가</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("voc") || error.includes("relation")) ? " — supabase/migrations/023_voc.sql 를 먼저 적용하세요." : ""}</div>}

      <div className="sm-tabbar" style={{ marginBottom: 10 }}>
        <button className={`sm-tab ${view === "현황판" ? "is-active" : ""}`} onClick={() => setView("현황판")}>유형별 현황판</button>
        <button className={`sm-tab ${view === "목록" ? "is-active" : ""}`} onClick={() => setView("목록")}>
          전체 목록<span className="sm-tab-count">{rows.length}</span>
        </button>
        {view === "목록" && <input className="b2b-input sm-tab-search" placeholder="내용·고객·상품 검색" value={search} onChange={(e) => setSearch(e.target.value)} />}
      </div>

      {/* ───── 유형별 현황판 — 이번 달 유형별 발생 + 유형 개선 상태(개선 작업은 Flow) ───── */}
      {view === "현황판" && (
        <>
          <div className="sm-row" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>기준 월
              <input className="b2b-input" type="month" value={month} max={TODAY().slice(0, 7)} onChange={(e) => { setMonth(e.target.value); setExpandedCat(null); }} style={{ width: "auto" }} /></label>
            <span className="sm-faint" style={{ fontSize: 12 }}>발생 {board.reduce((s, b) => s + b.monthRows.length, 0)}건 · 유형 상태는 여기서, 개선 작업은 Flow 에서</span>
            <button className="b2b-btn-secondary" style={{ marginLeft: "auto" }} onClick={() => setCatModal(true)}>유형 관리</button>
          </div>

          {loading ? (
            <div className="b2b-loading">불러오는 중...</div>
          ) : (
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead>
                  <tr>
                    <th style={{ width: 1 }}></th>
                    <th>유형</th>
                    <th className="num">{month.slice(5)}월 발생</th>
                    <th className="num">전체 누적</th>
                    <th className="b2b-col-status" style={{ width: 130, minWidth: 130 }}>개선 상태</th>
                    <th className="b2b-col-date">최근 개선완료</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((b) => (
                    <BoardRow key={b.name} b={b} expanded={expandedCat === b.name} managed={catManaged}
                      onToggle={() => setExpandedCat(expandedCat === b.name ? null : b.name)}
                      onStatus={(s) => b.cat && changeCatStatus(b.cat, s)}
                      onOpen={openEdit} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!catManaged && <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>유형 상태·편집을 쓰려면 supabase/migrations/072_voc_categories.sql 을 적용하세요. (적용 전에는 기본 8종 읽기 전용)</p>}
        </>
      )}

      {/* ───── 전체 목록 ───── */}
      {view === "목록" && (
      <>
      {/* 컬럼 필터 — 유형·상품·구매처·구매자·접수일 */}
      <div className="sm-row" style={{ marginBottom: 12, gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select className="b2b-input" value={fCategory} onChange={(e) => setFCategory(e.target.value)} style={{ width: "auto" }} aria-label="유형 필터">
          <option value="">유형 전체</option>
          {(cats.length ? cats.map((c) => c.name) : [...VOC_CATEGORIES]).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="b2b-input" value={fProduct} onChange={(e) => setFProduct(e.target.value)} style={{ width: "auto", maxWidth: 200 }} aria-label="상품 필터">
          <option value="">상품 전체</option>
          {productOpts.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="b2b-input" value={fPlace} onChange={(e) => setFPlace(e.target.value)} style={{ width: "auto" }} aria-label="구매처 필터">
          <option value="">구매처 전체</option>
          {placeOpts.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="b2b-input" value={fBuyer} onChange={(e) => setFBuyer(e.target.value)} style={{ width: "auto" }} aria-label="구매자 구분 필터">
          <option value="">구매자 전체</option>
          {VOC_BUYER_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <label className="sm-row" style={{ gap: 4, fontSize: 12, color: "var(--sm-text-mid)" }}>접수일
          <input className="b2b-input" type="date" value={fFrom} max={fTo || undefined} onChange={(e) => setFFrom(e.target.value)} style={{ width: "auto" }} aria-label="접수일 시작" />
          <span className="sm-faint">~</span>
          <input className="b2b-input" type="date" value={fTo} min={fFrom || undefined} onChange={(e) => setFTo(e.target.value)} style={{ width: "auto" }} aria-label="접수일 끝" /></label>
        {hasFilter && <button className="b2b-link-btn" onClick={resetFilters} style={{ color: "var(--sm-text-light)", fontSize: 13 }}>필터 초기화 ✕</button>}
        <span className="sm-faint" style={{ fontSize: 12, marginLeft: "auto" }}>{shown.length}건</span>
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : shown.length === 0 ? (
        <div className="b2b-empty">{rows.length === 0 ? "아직 등록된 VOC가 없습니다. '+ VOC 추가'로 시작하세요." : "조건에 맞는 VOC가 없습니다."}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr>
              <th>접수일</th><th>구매채널</th><th>고객명</th><th>구매</th><th>구매일</th><th>구매상품</th><th>유형</th><th>특이사항</th><th>상세내용</th><th>처리내용</th><th>flow</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => openEdit(r)} style={{ cursor: "pointer" }}>
                  <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(5)}</td>
                  <td>{r.purchase_place || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.customer || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.buyer_type || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.purchase_date?.slice(5) || "-"}</td>
                  <td style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.product || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.category}</td>
                  <td style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.customer_note || ""}>{r.customer_note || "-"}</td>
                  <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.content}>{r.content}</td>
                  <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.resolution || ""}>{r.resolution || "-"}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                    {r.flow_task_at ? (
                      <span title={`flow 등록됨 · ${r.flow_task_at.slice(0, 10)}`} style={{ fontSize: 11, fontWeight: 800, color: "var(--sm-success)" }}>✓ flow</span>
                    ) : (
                      <button className="b2b-link-btn" onClick={() => registerFlow(r)} disabled={flowBusy === r.id}
                        title="flow(플로우)에 업무로 등록" style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-info)" }}>
                        {flowBusy === r.id ? "등록중…" : "→ flow"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}

      {preview && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">엑셀 업로드 — 미리보기</span>
              <button className="b2b-modal-close" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                <span>등록 가능 <strong style={{ color: "var(--sm-success)" }}>{preview.summary.valid}</strong>건</span>
                {preview.summary.errors > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.summary.errors}건(제외)</span>}
              </div>
              {preview.summary.valid === 0 && <div className="b2b-empty" style={{ padding: 20 }}>등록할 행이 없습니다. 양식을 확인하세요.</div>}
              {preview.rows.length > 0 && (
                <div className="b2b-table-wrap" style={{ maxHeight: 340, overflow: "auto", marginBottom: 12 }}>
                  <table className="b2b-table">
                    <thead><tr><th>접수일</th><th>유형</th><th>고객</th><th>상품</th><th>상세내용</th><th>단계</th></tr></thead>
                    <tbody>
                      {preview.rows.slice(0, 200).map((r, i) => (
                        <tr key={i}>
                          <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(5)}</td>
                          <td>{r.category}</td>
                          <td style={{ whiteSpace: "nowrap" }}>{r.customer || "-"}</td>
                          <td style={{ maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.product || "-"}</td>
                          <td style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.content}>{r.content}</td>
                          <td>{r.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.rows.length > 200 && <p className="sm-faint" style={{ fontSize: 12, padding: "6px 2px" }}>…외 {preview.rows.length - 200}건(전체 등록됩니다)</p>}
                </div>
              )}
              {preview.errors.length > 0 && (
                <section>
                  <div className="b2b-field-label" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>오류 ({preview.errors.length}) — 해당 행 제외</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--sm-danger)", maxHeight: 140, overflow: "auto" }}>
                    {preview.errors.map((e, i) => <li key={i}>{e.line}행: {e.msg}</li>)}
                  </ul>
                </section>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setPreview(null)} disabled={applying}>취소</button>
                <button className="b2b-btn-primary" onClick={applyVocImport} disabled={applying || preview.summary.valid === 0}>{applying ? "등록 중…" : `${preview.summary.valid}건 등록`}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {edit && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">{edit.id ? "VOC 수정" : "VOC 추가 (직접 입력)"}</span>
              <button className="b2b-modal-close" onClick={() => setEdit(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">접수일</span>
                  <input className="b2b-input" type="date" required value={edit.received_at} onChange={(e) => setF("received_at", e.target.value)} /></label>
                <label className="b2b-field"><span className="b2b-field-label">구매자 구분</span>
                  <select className="b2b-input" value={edit.buyer_type} onChange={(e) => setF("buyer_type", e.target.value)}>
                    <option value="">선택 안 함</option>
                    {VOC_BUYER_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select></label>
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
                  <Combobox value={edit.product}
                    options={products.map((p) => ({ id: p.id, label: p.name, sub: p.sku || p.spec || undefined }))}
                    onSelect={(o) => setF("product", o.label)} onType={(t) => setF("product", t)}
                    allowFreeText placeholder="상품 마스터에서 선택 또는 직접 입력" ariaLabel="구매상품" /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">제품 생산일</span>
                  <input className="b2b-input" type="date" value={edit.production_date} onChange={(e) => setF("production_date", e.target.value)} /></label>
                <label className="b2b-field"><span className="b2b-field-label">보상유형</span>
                  <select className="b2b-input" value={edit.comp_type} onChange={(e) => setF("comp_type", e.target.value)}>
                    {VOC_COMP_TYPES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">보상 수량</span>
                  <input className="b2b-input" type="number" min={1} value={edit.comp_qty}
                    disabled={edit.comp_type === "없음" || isManualType}
                    onChange={(e) => setF("comp_qty", e.target.value)} /></label>
                <label className="b2b-field"><span className="b2b-field-label">손해/보상 금액 (원)</span>
                  <input className="b2b-input" type="number" min={0} value={edit.loss_amount} onChange={(e) => setF("loss_amount", e.target.value)} placeholder="0" /></label>
              </div>
              {lossHint && <p className="sm-faint" style={{ fontSize: 12, margin: "-4px 0 4px" }}>{lossHint}</p>}
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">클레임 유형</span>
                  <select className="b2b-input" value={edit.category}
                    onChange={(e) => { const v = e.target.value; const cf = cats.find((c) => c.name === v)?.fault; setEdit((f) => (f ? { ...f, category: v, fault: cf || suggestFault(v) } : f)); }}>
                    {(cats.length ? cats.filter((c) => c.active || c.name === edit.category).map((c) => c.name) : [...VOC_CATEGORIES]).map((c) => <option key={c}>{c}</option>)}
                    {cats.length > 0 && !cats.some((c) => c.name === edit.category) && <option value={edit.category}>{edit.category}</option>}
                  </select></label>
                <label className="b2b-field"><span className="b2b-field-label">손해 귀책 <span className="sm-faint" style={{ fontWeight: 400 }}>· 정산 분리용</span></span>
                  <select className="b2b-input" value={edit.fault} onChange={(e) => setF("fault", e.target.value)}>{VOC_FAULTS.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
              </div>
              <p className="sm-faint" style={{ fontSize: 12, margin: "-4px 0 8px" }}>제조사 = 청구 가능 · 물류/자사 = 자사 부담 · 개선 진행 상태는 유형별 현황판에서 관리합니다</p>
              <label className="b2b-field"><span className="b2b-field-label">상세내용 <span className="req">*</span></span>
                <textarea className="b2b-textarea" rows={3} value={edit.content} onChange={(e) => setF("content", e.target.value)} placeholder="고객이 말한 내용" /></label>
              <label className="b2b-field"><span className="b2b-field-label">원인</span>
                <textarea className="b2b-textarea" rows={2} value={edit.cause} onChange={(e) => setF("cause", e.target.value)} placeholder="왜 발생했는지 (분석)" /></label>
              <label className="b2b-field"><span className="b2b-field-label">처리내용</span>
                <textarea className="b2b-textarea" rows={2} value={edit.resolution} onChange={(e) => setF("resolution", e.target.value)} placeholder="어떻게 처리했는지" /></label>
              <label className="b2b-field"><span className="b2b-field-label">개선 필요사항</span>
                <textarea className="b2b-textarea" rows={2} value={edit.improvement} onChange={(e) => setF("improvement", e.target.value)} placeholder="재발 방지를 위해 바꿔야 할 것" /></label>
              <label className="b2b-field"><span className="b2b-field-label">고객 특이사항</span>
                <textarea className="b2b-textarea" rows={2} value={edit.customer_note} onChange={(e) => setF("customer_note", e.target.value)} placeholder="VIP·과거 클레임 이력·연락 시 주의할 점 등" /></label>
              <div className="b2b-field">
                <span className="b2b-field-label">사진 첨부 <span className="sm-faint" style={{ fontWeight: 400 }}>· 개선요청서에 자동 첨부됩니다</span></span>
                <div className="sm-row-wrap" style={{ gap: 8 }}>
                  {edit.photos.map((url) => (
                    <div key={url} style={{ position: "relative" }}>
                      <img src={url} alt="첨부" style={{ width: 74, height: 74, objectFit: "cover", borderRadius: 8, border: "1px solid var(--sm-border)" }} />
                      <button type="button" onClick={() => removePhoto(url)} aria-label="사진 삭제"
                        style={{ position: "absolute", top: -7, right: -7, width: 21, height: 21, borderRadius: "50%", border: "2px solid var(--sm-white)", background: "var(--sm-danger)", color: "var(--sm-white)", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}>✕</button>
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
              <div className="sm-row" style={{ gap: 8, alignItems: "center" }}>
                {edit.id ? <button className="b2b-btn-danger" onClick={remove} disabled={saving}>삭제</button> : <span />}
                {edit.id && (() => {
                  const er = rows.find((r) => r.id === edit.id);
                  return er?.flow_task_at
                    ? <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-success)", alignSelf: "center" }}>flow 등록됨 ✓</span>
                    : <button className="b2b-btn-secondary" onClick={() => er && registerFlow(er)} disabled={!er || flowBusy === edit.id}>{flowBusy === edit.id ? "flow 등록중…" : "flow에 업무 등록"}</button>;
                })()}
              </div>
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setEdit(null)}>취소</button>
                <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : "저장"}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {catModal && <CatModal cats={cats} managed={catManaged} onClose={() => setCatModal(false)} onChanged={load} />}
    </div>
  );
}

// 유형별 현황판 한 줄 — 클릭하면 그 유형의 이번 달 VOC 가 아래로 펼쳐짐(발주관리 확장행과 동일 패턴).
function BoardRow({ b, expanded, managed, onToggle, onStatus, onOpen }: {
  b: { name: string; cat: VocCategoryRow | null; monthRows: Voc[]; totalCount: number };
  expanded: boolean; managed: boolean;
  onToggle: () => void;
  onStatus: (s: VocCatStatus) => void;
  onOpen: (r: Voc) => void;
}) {
  const st = b.cat?.status ?? "관찰";
  const sc = VOC_CAT_STATUS_COLOR[st];
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }} className={expanded ? "is-parent" : ""}>
        <td style={{ padding: "8px", color: "var(--sm-text-light)" }}>{expanded ? "▾" : "▸"}</td>
        <td style={{ fontWeight: 700 }}>{b.name}{b.cat && !b.cat.active ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>(비활성)</span> : null}</td>
        <td className="num" style={{ fontWeight: 700 }}>{b.monthRows.length > 0 ? `${b.monthRows.length}건` : <span className="sm-faint">-</span>}</td>
        <td className="num sm-faint">{b.totalCount}건</td>
        <td className="b2b-col-status" onClick={(e) => e.stopPropagation()}>
          {b.cat && managed ? (
            <select className="b2b-status-select" value={st} onChange={(e) => onStatus(e.target.value as VocCatStatus)}
              style={{ background: sc.bg, color: sc.fg, maxWidth: "none", width: "100%", minWidth: 110 }}>
              {VOC_CAT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : (
            <span className="b2b-status-pill" style={{ background: sc.bg, color: sc.fg }}>{st}</span>
          )}
        </td>
        <td className="b2b-col-date" style={{ whiteSpace: "nowrap" }}>{b.cat?.resolved_at ? b.cat.resolved_at.slice(0, 10) : "-"}</td>
      </tr>
      {expanded && (
        <tr className="b2b-child-row">
          <td></td>
          <td colSpan={5} style={{ padding: "8px 18px 14px" }}>
            {b.monthRows.length === 0 ? (
              <p className="sm-faint" style={{ fontSize: 13, margin: "6px 0" }}>이 달에 접수된 건이 없습니다.</p>
            ) : (
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead><tr><th>접수일</th><th>고객</th><th>상품</th><th>상세내용</th><th>처리내용</th><th>flow</th></tr></thead>
                  <tbody>
                    {b.monthRows.map((r) => (
                      <tr key={r.id} onClick={() => onOpen(r)} style={{ cursor: "pointer" }}>
                        <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(5)}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.customer || "-"}</td>
                        <td style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.product || "-"}</td>
                        <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.content}>{r.content}</td>
                        <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.resolution || ""}>{r.resolution || "-"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.flow_task_at ? <span style={{ fontSize: 11, fontWeight: 800, color: "var(--sm-success)" }}>✓</span> : <span className="sm-faint">-</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// 유형 추가/편집 모달 — 이름·귀책 기본값·정렬·활성. 이름 변경 시 기존 VOC 도 함께 갱신(서버).
function CatModal({ cats, managed, onClose, onChanged }: { cats: VocCategoryRow[]; managed: boolean; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<{ id?: string; name: string; fault: string; sort: string; active: boolean } | null>(null);

  async function saveDraft() {
    if (!draft || !draft.name.trim()) { setErr("유형 이름을 입력하세요."); return; }
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/voc/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, sort: Number(draft.sort) || 0 }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setDraft(null);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "저장 오류"); }
    setBusy(false);
  }
  async function removeCat(c: VocCategoryRow) {
    if (!confirm(`'${c.name}' 유형을 삭제할까요? (사용 중이면 삭제 대신 비활성 처리됩니다)`)) return;
    setBusy(true); setErr("");
    try {
      const j = await (await fetch(`/api/voc/categories?id=${c.id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "삭제 실패");
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "삭제 오류"); }
    setBusy(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">문제 유형 관리</h2><button className="b2b-modal-close" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body">
          {!managed && <div className="b2b-error" style={{ marginBottom: 10 }}>072_voc_categories.sql 마이그레이션을 적용해야 유형을 편집할 수 있습니다.</div>}
          {err && <div className="b2b-error" style={{ marginBottom: 10 }}>{err}</div>}
          <div className="b2b-table-wrap" style={{ marginBottom: 12 }}>
            <table className="b2b-table">
              <thead><tr><th>유형</th><th>귀책 기본값</th><th className="num">정렬</th><th>활성</th><th></th></tr></thead>
              <tbody>
                {cats.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td>{c.fault}</td>
                    <td className="num">{c.sort}</td>
                    <td>{c.active ? "활성" : <span className="sm-faint">비활성</span>}</td>
                    <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                      <button className="b2b-link-btn" disabled={busy || !managed} onClick={() => setDraft({ id: c.id, name: c.name, fault: c.fault, sort: String(c.sort), active: c.active })}>수정</button>
                      <button className="b2b-link-btn" style={{ color: "var(--sm-danger)", marginLeft: 8 }} disabled={busy || !managed} onClick={() => removeCat(c)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {draft ? (
            <div className="sm-row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>이름</span>
                <input className="b2b-input" style={{ width: 140 }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
              <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>귀책 기본값</span>
                <select className="b2b-input" value={draft.fault} onChange={(e) => setDraft({ ...draft, fault: e.target.value })}>
                  {VOC_FAULTS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select></label>
              <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>정렬</span>
                <input className="b2b-input" type="number" style={{ width: 70 }} value={draft.sort} onChange={(e) => setDraft({ ...draft, sort: e.target.value })} /></label>
              <label className="sm-row" style={{ gap: 5, fontSize: 13, paddingBottom: 9 }}>
                <input type="checkbox" className="b2b-checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />활성</label>
              <button className="b2b-btn-primary" disabled={busy || !managed} onClick={saveDraft}>{draft.id ? "수정 저장" : "추가"}</button>
              <button className="b2b-btn-secondary" disabled={busy} onClick={() => setDraft(null)}>취소</button>
            </div>
          ) : (
            <button className="b2b-btn-secondary" disabled={!managed} onClick={() => setDraft({ name: "", fault: "미분류", sort: String(cats.length + 1), active: true })}>+ 유형 추가</button>
          )}
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 10 }}>이름을 바꾸면 기존 VOC 의 유형도 함께 바뀝니다. 삭제는 사용 중이면 비활성(새 등록에서만 숨김)으로 처리됩니다.</p>
        </div>
        <div className="b2b-modal-foot"><span /><div className="b2b-modal-foot-right"><button className="b2b-btn-secondary" onClick={onClose}>닫기</button></div></div>
      </div>
    </div>
  );
}
