"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { dateTime } from "@/app/lib/format";
import { APPLY_STATUS_COLOR, POSITIONS, POSITION_KO, parseProductNos, wrapBlock, type ApplyStatus, type Position } from "@/app/lib/detail-page";

type Source = { id: number; name: string; html: string; position: Position; version: number; updated_by: string | null; updated_at: string; applied_count: number };
type Apply = {
  id: number; source_id: number; source_version: number; product_no: number; product_name: string | null; position: Position;
  status: ApplyStatus; error: string | null; verified: boolean | null; requested_by: string | null; created_at: string; executed_at: string | null;
};

const EMPTY = { name: "", html: "", position: "append" as Position };

// 미리보기 문서 — 스크립트는 실행하지 않는다(sandbox). 공식몰 스킨 CSS 는 없으므로 구조·텍스트 확인용.
function previewDoc(html: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;padding:16px;font-family:Pretendard,-apple-system,"Malgun Gothic",sans-serif;font-size:14px;line-height:1.6;color:#222;word-break:keep-all}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ddd;padding:6px 8px}</style>
</head><body>${html}</body></html>`;
}

export default function DetailSendPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [isAdmin, setIsAdmin] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [selId, setSelId] = useState<number | "new">("new");
  const [form, setForm] = useState(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState<{ html: string; mobile: boolean } | null>(null);
  const [nosText, setNosText] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [applies, setApplies] = useState<Apply[]>([]);
  const [fSource, setFSource] = useState<string>("");
  const [fNo, setFNo] = useState("");
  const [loadingApplies, setLoadingApplies] = useState(false);

  const selected = useMemo(() => (selId === "new" ? null : sources.find((s) => s.id === selId) || null), [selId, sources]);
  const nos = useMemo(() => parseProductNos(nosText), [nosText]);

  const loadSources = useCallback(async () => {
    const r = await fetch("/api/detail/sources", { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "소스 조회 실패"); return; }
    setErr("");
    setSources(j.sources || []);
  }, []);

  const loadApplies = useCallback(async (sourceId: string, productNo: string) => {
    setLoadingApplies(true);
    try {
      const q = new URLSearchParams();
      if (sourceId) q.set("source_id", sourceId);
      if (/^\d+$/.test(productNo.trim())) q.set("product_no", productNo.trim());
      const r = await fetch(`/api/detail/applies?${q.toString()}`, { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "적용 기록 조회 실패"); return; }
      setApplies(j.applies || []);
    } finally { setLoadingApplies(false); }
  }, []);

  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" }).then((r) => r.json())
      .then((j) => setIsAdmin(!!j.ok && (j.name === "현석" || j.name === "관리자"))).catch(() => {});
    loadSources();
    loadApplies("", "");
  }, [loadSources, loadApplies]);

  // 상품번호 입력이 바뀌면 카탈로그 상품명 조회(입력 멈춘 뒤 400ms)
  useEffect(() => {
    if (nos.length === 0) { setNames({}); return; }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/detail/applies?names=${nos.join(",")}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (j.ok) setNames(j.names || {});
    }, 400);
    return () => clearTimeout(t);
  }, [nos]);

  function pick(id: number | "new") {
    if (dirty && !window.confirm("저장하지 않은 수정이 있습니다. 버리고 이동할까요?")) return;
    setSelId(id);
    setPreview(null);
    setDirty(false);
    if (id === "new") { setForm(EMPTY); return; }
    const s = sources.find((x) => x.id === id);
    if (s) setForm({ name: s.name, html: s.html, position: s.position });
  }

  async function save() {
    if (!form.name.trim()) { setErr("소스 이름을 입력하세요."); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/detail/sources", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selId === "new" ? undefined : selId, name: form.name.trim(), html: form.html, position: form.position }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "저장 실패"); return; }
      setErr("");
      setDirty(false);
      await loadSources();
      setSelId(j.source.id);
      toast.success(`저장했습니다 (v${j.source.version})`);
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!selected) return;
    if (!(await confirm({ title: `소스 "${selected.name}" 삭제`, body: "적용 기록도 함께 지워집니다. 이미 쏜 상품의 상세설명은 바뀌지 않습니다.", action: "소스 삭제" }))) return;
    const r = await fetch(`/api/detail/sources?id=${selected.id}`, { method: "DELETE" });
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "삭제 실패"); return; }
    toast.success("삭제했습니다");
    setSelId("new"); setForm(EMPTY); setDirty(false);
    await loadSources();
    await loadApplies(fSource, fNo);
  }

  async function send() {
    if (!selected) return;
    if (dirty) { setErr("먼저 저장하세요."); return; }
    if (nos.length === 0) { setErr("상품번호를 입력하세요."); return; }
    const ok = await confirm({
      title: `"${selected.name}" v${selected.version} 을 상품 ${nos.length}개에 쏘기`,
      body: `${POSITION_KO[selected.position]} 로 들어갑니다. 중계 실행기가 실행하면 공식몰 상세설명이 바뀝니다.`,
      action: "쏘기", danger: selected.position === "replace",
    });
    if (!ok) return;
    setSending(true);
    try {
      const r = await fetch("/api/detail/applies", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: selected.id, product_nos: nos }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "전송 요청 실패"); return; }
      setErr("");
      toast.success(`${j.queued}건 대기열에 넣었습니다${j.skipped?.length ? ` (이미 대기 중 ${j.skipped.length}건 제외)` : ""}`);
      setFSource(String(selected.id)); setFNo("");
      await loadApplies(String(selected.id), "");
    } finally { setSending(false); }
  }

  const srcName = (id: number) => sources.find((s) => s.id === id)?.name || `#${id}`;

  return (
    <div className="b2b-container">
      <div className="b2b-page-head">
        <h1 className="b2b-page-title">상세페이지 전송</h1>
        <p className="b2b-page-subtitle">소스 블록은 주석 마커로 감싸 들어가며, 같은 소스를 다시 쏘면 그 자리만 바뀝니다.</p>
      </div>

      {err && <div className="b2b-error">{err}</div>}

      <div className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">소스</span></div>
        <div className="dp-src-list">
          <button type="button" className={`sm-tab ${selId === "new" ? "is-active" : ""}`} onClick={() => pick("new")}>+ 새 소스</button>
          {sources.map((s) => (
            <button key={s.id} type="button" className={`sm-tab ${selId === s.id ? "is-active" : ""}`} onClick={() => pick(s.id)}>
              {s.name}<span className="sm-tab-count">v{s.version} · {s.applied_count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dp-grid">
        <div className="b2b-form-section">
          <div className="b2b-form-section-title">1. HTML 입력</div>
          <div className="b2b-field">
            <label className="b2b-field-label">소스 이름</label>
            <input className="b2b-input" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setDirty(true); }} />
          </div>
          <div className="b2b-field">
            <label className="b2b-field-label">넣는 자리</label>
            <div className="sm-tabs">
              {POSITIONS.map((p) => (
                <button key={p} type="button" className={`sm-tab ${form.position === p ? "is-active" : ""}`} onClick={() => { setForm({ ...form, position: p }); setDirty(true); }}>{POSITION_KO[p]}</button>
              ))}
            </div>
          </div>
          <div className="b2b-field">
            <label className="b2b-field-label">HTML</label>
            <textarea className="b2b-input dp-code" spellCheck={false} value={form.html} onChange={(e) => { setForm({ ...form, html: e.target.value }); setDirty(true); }} />
          </div>
          {selected && (
            <div className="dp-meta">
              <span>v{selected.version}</span>
              <span>{selected.updated_by || "-"} · {dateTime(selected.updated_at)}</span>
              <span>적용 완료 {selected.applied_count}개</span>
            </div>
          )}
          <div className="b2b-form-foot">
            <button type="button" className="b2b-btn-primary" disabled={saving} onClick={save}>{saving ? "저장 중" : "저장"}</button>
            <button type="button" className="b2b-btn-secondary" onClick={() => setPreview({ html: form.html, mobile: false })}>2. 변환해 보기</button>
            {selected && isAdmin && <button type="button" className="b2b-btn-danger" onClick={remove}>삭제</button>}
          </div>
        </div>

        <div className="b2b-form-section">
          <div className="b2b-form-section-title">2. 미리보기</div>
          {preview ? (
            <>
              <div className="sm-tabs">
                <button type="button" className={`sm-tab ${!preview.mobile ? "is-active" : ""}`} onClick={() => setPreview({ ...preview, mobile: false })}>PC</button>
                <button type="button" className={`sm-tab ${preview.mobile ? "is-active" : ""}`} onClick={() => setPreview({ ...preview, mobile: true })}>모바일</button>
              </div>
              <div className="dp-preview-wrap">
                <iframe title="미리보기" className={`dp-preview ${preview.mobile ? "is-mobile" : ""}`} sandbox="" srcDoc={previewDoc(preview.html)} />
              </div>
              <div className="dp-meta"><span>스크립트는 실행하지 않음 · 공식몰 스킨 CSS 미적용</span></div>
              <details>
                <summary className="sm-faint">실제로 들어가는 HTML(마커 포함)</summary>
                <textarea className="b2b-input dp-code" readOnly value={wrapBlock(selected?.id ?? 0, preview.html)} />
              </details>
            </>
          ) : (
            <div className="b2b-empty">아직 변환하지 않았습니다.</div>
          )}
        </div>
      </div>

      <div className="b2b-form-section">
        <div className="b2b-form-section-title">3. 적용할 상품번호</div>
        <div className="b2b-field">
          <label className="b2b-field-label">상품번호 <span className="opt">(쉼표·줄바꿈 구분)</span></label>
          <textarea className="b2b-input dp-nos" value={nosText} onChange={(e) => setNosText(e.target.value)} />
        </div>
        {nos.length > 0 && (
          <div className="b2b-table-wrap">
            <table className="b2b-table is-responsive">
              <thead><tr><th>상품번호</th><th>상품명</th></tr></thead>
              <tbody>
                {nos.map((n) => (
                  <tr key={n}>
                    <td className="num" data-label="상품번호">{n}</td>
                    <td data-label="상품명">{names[String(n)] || <span className="sm-faint">카탈로그에 없음</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="b2b-form-foot">
          <button type="button" className="b2b-btn-primary" disabled={!selected || dirty || nos.length === 0 || sending || !isAdmin} onClick={send}>
            {sending ? "요청 중" : `4. 쏘기${nos.length ? ` (${nos.length})` : ""}`}
          </button>
          {!isAdmin && <span className="sm-faint">관리자만 쏠 수 있습니다</span>}
          {selected && dirty && <span className="sm-faint">저장 후 쏠 수 있습니다</span>}
          {!selected && <span className="sm-faint">소스를 먼저 저장하세요</span>}
        </div>
      </div>

      <div className="b2b-card">
        <div className="b2b-card-head">
          <span className="b2b-card-title">적용 현황</span>
          <div className="b2b-page-actions">
            <button type="button" className="b2b-btn-secondary" disabled={loadingApplies} onClick={() => loadApplies(fSource, fNo)}>새로고침</button>
          </div>
        </div>
        <div className="dp-filters">
          <div className="b2b-field">
            <label className="b2b-field-label">소스</label>
            <select className="b2b-input" value={fSource} onChange={(e) => { setFSource(e.target.value); loadApplies(e.target.value, fNo); }}>
              <option value="">전체</option>
              {sources.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
            </select>
          </div>
          <div className="b2b-field">
            <label className="b2b-field-label">상품번호</label>
            <input className="b2b-input" value={fNo} inputMode="numeric" onChange={(e) => setFNo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") loadApplies(fSource, fNo); }} />
          </div>
          <button type="button" className="b2b-btn-secondary" onClick={() => loadApplies(fSource, fNo)}>조회</button>
        </div>
        {loadingApplies ? (
          <div className="b2b-loading">불러오는 중</div>
        ) : applies.length === 0 ? (
          <div className="b2b-empty">적용 기록이 없습니다.</div>
        ) : (
          <div className="b2b-table-wrap is-sticky-head">
            <table className="b2b-table is-responsive">
              <thead>
                <tr><th>소스</th><th>상품번호</th><th>상품명</th><th>버전</th><th>자리</th><th>상태</th><th>마커 확인</th><th>요청</th><th>실행</th><th>오류</th></tr>
              </thead>
              <tbody>
                {applies.map((a) => {
                  const c = APPLY_STATUS_COLOR[a.status] || APPLY_STATUS_COLOR["대기"];
                  const stale = a.status === "완료" && (sources.find((s) => s.id === a.source_id)?.version ?? a.source_version) > a.source_version;
                  return (
                    <tr key={a.id}>
                      <td data-label="소스">{srcName(a.source_id)}</td>
                      <td className="num" data-label="상품번호">{a.product_no}</td>
                      <td data-label="상품명">{a.product_name || <span className="sm-faint">-</span>}</td>
                      <td className="num" data-label="버전">v{a.source_version}{stale && <span className="sm-faint"> (구버전)</span>}</td>
                      <td data-label="자리">{POSITION_KO[a.position] || a.position}</td>
                      <td data-label="상태"><span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{a.status}</span></td>
                      <td data-label="마커 확인">{a.verified === true ? "확인" : a.verified === false ? <span className="sm-faint">미확인</span> : "-"}</td>
                      <td data-label="요청">{a.requested_by || "-"} · {dateTime(a.created_at)}</td>
                      <td data-label="실행">{a.executed_at ? dateTime(a.executed_at) : "-"}</td>
                      <td data-label="오류" className="dp-err-cell">{a.error || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
