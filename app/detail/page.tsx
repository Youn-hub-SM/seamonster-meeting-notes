"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { dateTime } from "@/app/lib/format";
import { APPLY_STATUS_COLOR, APPLY_STATUSES, POSITIONS, POSITION_KO, parseProductNos, wrapBlock, type ApplyStatus, type Position } from "@/app/lib/detail-page";

type Source = { id: number; name: string; html: string; position: Position; version: number; updated_by: string | null; updated_at: string; applied_count: number };
type Apply = {
  id: number; source_id: number; source_version: number; product_no: number; product_name: string | null; position: Position;
  status: ApplyStatus; error: string | null; verified: boolean | null; requested_by: string | null; created_at: string; executed_at: string | null;
};
type StatusTab = "전체" | ApplyStatus;

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
  const [fStatus, setFStatus] = useState<StatusTab>("전체");
  const [loadingApplies, setLoadingApplies] = useState(false);

  const selected = useMemo(() => (selId === "new" ? null : sources.find((s) => s.id === selId) || null), [selId, sources]);
  const nos = useMemo(() => parseProductNos(nosText), [nosText]);

  const loadSources = useCallback(async () => {
    const r = await fetch("/api/detail/sources", { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "소스를 불러오지 못했습니다."); return; }
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
      if (!j.ok) { setErr(j.error || "적용 기록을 불러오지 못했습니다."); return; }
      setApplies(j.applies || []);
    } finally { setLoadingApplies(false); }
  }, []);

  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" }).then((r) => r.json())
      .then((j) => setIsAdmin(!!j.ok && (j.name === "현석" || j.name === "관리자"))).catch(() => {});
    loadSources();
    loadApplies("", "");
  }, [loadSources, loadApplies]);

  // 상품번호 입력이 멈추면 카탈로그 상품명 조회(400ms)
  useEffect(() => {
    if (nos.length === 0) { setNames({}); return; }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/detail/applies?names=${nos.join(",")}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (j.ok) setNames(j.names || {});
    }, 400);
    return () => clearTimeout(t);
  }, [nos]);

  // 상품번호 필터는 입력이 멈추면 바로 조회
  useEffect(() => {
    const t = setTimeout(() => { loadApplies(fSource, fNo); }, 400);
    return () => clearTimeout(t);
  }, [fSource, fNo, loadApplies]);

  async function pick(id: number | "new") {
    if (id === selId) return;
    if (dirty && !(await confirm({ title: "저장하지 않은 변경", body: "이 소스에서 바꾼 내용을 저장하지 않았습니다. 이동하면 바꾼 내용은 사라집니다.", action: "버리고 이동" }))) return;
    setSelId(id);
    setPreview(null);
    setDirty(false);
    setErr("");
    if (id === "new") { setForm(EMPTY); return; }
    const s = sources.find((x) => x.id === id);
    if (s) setForm({ name: s.name, html: s.html, position: s.position });
  }

  async function save(): Promise<Source | null> {
    if (!form.name.trim()) { setErr("소스 이름을 입력하세요."); return null; }
    if (!form.html.trim()) { setErr("HTML 을 입력하세요."); return null; }
    setSaving(true);
    try {
      const r = await fetch("/api/detail/sources", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selId === "new" ? undefined : selId, name: form.name.trim(), html: form.html, position: form.position }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "소스를 저장하지 못했습니다."); return null; }
      setErr("");
      setDirty(false);
      await loadSources();
      setSelId(j.source.id);
      toast.success(`소스를 저장했습니다 (v${j.source.version})`);
      return j.source as Source;
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!selected) return;
    if (!(await confirm({ title: `소스 "${selected.name}" 삭제`, body: "적용 기록도 함께 지워집니다. 이미 쏜 상품의 상세설명은 바뀌지 않습니다.", action: "소스 삭제" }))) return;
    const r = await fetch(`/api/detail/sources?id=${selected.id}`, { method: "DELETE" });
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "소스를 삭제하지 못했습니다."); return; }
    toast.success("소스를 삭제했습니다");
    setSelId("new"); setForm(EMPTY); setDirty(false); setPreview(null);
    await loadSources();
    await loadApplies(fSource, fNo);
  }

  async function send() {
    if (!selected) { setErr("소스를 먼저 저장하세요."); return; }
    if (dirty) { setErr("바꾼 내용을 먼저 저장하세요."); return; }
    if (nos.length === 0) { setErr("상품번호를 입력하세요."); return; }
    if (!isAdmin) { setErr("관리자만 쏠 수 있습니다."); return; }
    const ok = await confirm({
      title: `"${selected.name}" v${selected.version} 을 상품 ${nos.length}개에 쏘기`,
      body: `${POSITION_KO[selected.position]} 로 들어갑니다. 2분 안에 공식몰 상세설명이 바뀝니다.`,
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
      if (!j.ok) { setErr(j.error || "쏘지 못했습니다."); return; }
      setErr("");
      toast.success(`${j.queued}건을 쏘았습니다${j.skipped?.length ? ` (이미 대기 중 ${j.skipped.length}건 제외)` : ""}`);
      setNosText("");
      setFSource(String(selected.id)); setFNo(""); setFStatus("전체");
      await loadApplies(String(selected.id), "");
    } finally { setSending(false); }
  }

  const srcName = (id: number) => sources.find((s) => s.id === id)?.name || `#${id}`;
  const counts = useMemo(() => {
    const c: Record<StatusTab, number> = { "전체": applies.length, "대기": 0, "실행중": 0, "완료": 0, "실패": 0 };
    for (const a of applies) c[a.status] = (c[a.status] || 0) + 1;
    return c;
  }, [applies]);
  const shown = useMemo(() => (fStatus === "전체" ? applies : applies.filter((a) => a.status === fStatus)), [applies, fStatus]);
  const appliedProducts = useMemo(() => new Set(applies.filter((a) => a.status === "완료").map((a) => a.product_no)).size, [applies]);
  const sendWhy = !selected ? "소스를 저장하면 켜집니다" : dirty ? "바꾼 내용을 저장하면 켜집니다" : nos.length === 0 ? "상품번호를 넣으면 켜집니다" : !isAdmin ? "관리자만 쏠 수 있습니다" : "";

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">상세페이지 전송</h1>
          <p className="b2b-page-subtitle">같은 소스를 다시 쏘면 상세설명 안의 그 소스 자리만 바뀝니다.</p>
        </div>
        <div className="b2b-page-actions">
          <button type="button" className="b2b-btn-secondary" onClick={() => pick("new")}>새 소스 만들기</button>
        </div>
      </header>

      {err && <div className="b2b-error">{err}</div>}

      <div className="dp-kpis">
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">소스</div>
          <div className="b2b-stat-card-value">{sources.length}</div>
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">적용된 상품</div>
          <div className="b2b-stat-card-value">{appliedProducts}</div>
          <div className="b2b-stat-card-hint">최근 기록 기준</div>
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">대기·실행중</div>
          <div className="b2b-stat-card-value">{counts["대기"] + counts["실행중"]}</div>
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">실패</div>
          <div className="b2b-stat-card-value" style={counts["실패"] ? { color: "var(--sm-danger)" } : undefined}>{counts["실패"]}</div>
        </div>
      </div>

      <section className="b2b-card dp-section">
        <div className="b2b-card-head"><span className="b2b-card-title">① HTML 소스</span></div>
        <div className="dp-src-grid">
          <div className="dp-src-list">
            <button type="button" className={`dp-src-item is-new ${selId === "new" ? "is-active" : ""}`} onClick={() => pick("new")}>
              <span className="dp-src-name">+ 새 소스</span>
            </button>
            {sources.map((s) => (
              <button key={s.id} type="button" className={`dp-src-item ${selId === s.id ? "is-active" : ""}`} onClick={() => pick(s.id)}>
                <span className="dp-src-name">{s.name}</span>
                <span className="dp-src-meta">
                  <span className="num">v{s.version}</span>
                  <span>{POSITION_KO[s.position]}</span>
                  <span className="num">적용 {s.applied_count}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="b2b-form-section dp-editor">
            <div className="b2b-form-section-title">{selected ? selected.name : "새 소스"}</div>
            <div className="b2b-field">
              <label className="b2b-field-label" htmlFor="dp-name">소스 이름</label>
              <input id="dp-name" className="b2b-input" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setDirty(true); }} />
            </div>
            <div className="b2b-field">
              <span className="b2b-field-label">넣는 자리</span>
              <div className="sm-tabs">
                {POSITIONS.map((p) => (
                  <button key={p} type="button" className={`sm-tab ${form.position === p ? "is-active" : ""}`} onClick={() => { setForm({ ...form, position: p }); setDirty(true); }}>{POSITION_KO[p]}</button>
                ))}
              </div>
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label" htmlFor="dp-html">HTML</label>
              <textarea id="dp-html" className="b2b-input dp-code" spellCheck={false} value={form.html} onChange={(e) => { setForm({ ...form, html: e.target.value }); setDirty(true); }} />
            </div>
            {selected && (
              <div className="dp-meta">
                <span>v{selected.version}</span>
                <span>{selected.updated_by || "-"} {dateTime(selected.updated_at)}</span>
                <span>적용 완료 {selected.applied_count}개</span>
                {dirty && <span>저장되지 않은 변경</span>}
              </div>
            )}
            <div className="b2b-form-foot">
              <div className="sm-row sm-gap-2">
                <button type="button" className="b2b-btn-secondary" disabled={saving} onClick={save}>{saving ? "저장 중" : "변경 저장"}</button>
                <button type="button" className="b2b-btn-secondary" onClick={() => setPreview({ html: form.html, mobile: false })}>변환해 보기</button>
              </div>
              <div className="b2b-form-foot-right">
                {selected && isAdmin && <button type="button" className="b2b-btn-danger" onClick={remove}>소스 삭제</button>}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="b2b-card dp-section">
        <div className="b2b-card-head">
          <span className="b2b-card-title">② 미리보기</span>
          {preview && (
            <div className="sm-tabs">
              <button type="button" className={`sm-tab ${!preview.mobile ? "is-active" : ""}`} onClick={() => setPreview({ ...preview, mobile: false })}>PC</button>
              <button type="button" className={`sm-tab ${preview.mobile ? "is-active" : ""}`} onClick={() => setPreview({ ...preview, mobile: true })}>모바일</button>
            </div>
          )}
        </div>
        {preview ? (
          <div style={{ paddingTop: "var(--sm-space-4)" }}>
            <div className="dp-preview-wrap">
              <iframe title="미리보기" className={`dp-preview ${preview.mobile ? "is-mobile" : ""}`} sandbox="" srcDoc={previewDoc(preview.html)} />
            </div>
            <div className="dp-meta" style={{ marginTop: "var(--sm-space-2)" }}><span>스크립트 미실행 · 공식몰 스킨 CSS 미적용</span></div>
            <details className="dp-preview-raw">
              <summary>실제로 들어가는 HTML (마커 포함)</summary>
              <textarea className="b2b-input dp-code is-readonly" readOnly value={wrapBlock(selected?.id ?? 0, preview.html)} />
            </details>
          </div>
        ) : (
          <div className="b2b-empty">
            미리보기가 없습니다.
            <div className="b2b-empty-action">
              <button type="button" className="b2b-btn-secondary" onClick={() => setPreview({ html: form.html, mobile: false })}>변환해 보기</button>
            </div>
          </div>
        )}
      </section>

      <section className="b2b-card dp-section">
        <div className="b2b-card-head"><span className="b2b-card-title">③ 적용할 상품</span></div>
        <div className="dp-send-grid">
          <div className="b2b-form-section">
            <div className="b2b-form-section-title">상품번호</div>
            <div className="b2b-field">
              <label className="b2b-field-label" htmlFor="dp-nos">상품번호 <span className="opt">(쉼표·줄바꿈 구분)</span></label>
              <textarea id="dp-nos" className="b2b-input dp-nos" value={nosText} onChange={(e) => setNosText(e.target.value)} />
            </div>
            <div className="dp-send-foot">
              <button type="button" className="b2b-btn-primary" disabled={sending || !!sendWhy} onClick={send}>
                {sending ? "쏘는 중" : `쏘기${nos.length ? ` (${nos.length})` : ""}`}
              </button>
              {sendWhy && <span className="b2b-btn-why">{sendWhy}</span>}
              {!sendWhy && selected && <span className="b2b-btn-why">{selected.name} v{selected.version} · {POSITION_KO[selected.position]}</span>}
            </div>
          </div>
          <div>
            {nos.length === 0 ? (
              <div className="b2b-empty">입력한 상품이 없습니다.</div>
            ) : (
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
          </div>
        </div>
      </section>

      <section className="b2b-card dp-section">
        <div className="b2b-card-head">
          <span className="b2b-card-title">적용 현황</span>
          <div className="b2b-page-actions">
            <button type="button" className="b2b-btn-secondary" disabled={loadingApplies} onClick={() => loadApplies(fSource, fNo)}>다시 불러오기</button>
          </div>
        </div>
        <div className="sm-tabbar" style={{ marginTop: "var(--sm-space-4)" }}>
          {(["전체", ...APPLY_STATUSES] as StatusTab[]).map((s) => (
            <button key={s} type="button" className={`sm-tab ${fStatus === s ? "is-active" : ""}`} onClick={() => setFStatus(s)}>
              {s}<span className="sm-tab-count">{counts[s]}</span>
            </button>
          ))}
          <select className="b2b-input dp-filter-select" value={fSource} onChange={(e) => setFSource(e.target.value)} aria-label="소스">
            <option value="">모든 소스</option>
            {sources.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
          </select>
          <input className="b2b-input sm-tab-search" value={fNo} inputMode="numeric" placeholder="상품번호" aria-label="상품번호" onChange={(e) => setFNo(e.target.value)} />
        </div>
        {loadingApplies ? (
          <div className="b2b-loading">불러오는 중</div>
        ) : shown.length === 0 ? (
          <div className="b2b-empty">
            {applies.length === 0 ? "적용 기록이 없습니다." : "조건에 맞는 기록이 없습니다."}
            {applies.length > 0 && (
              <div className="b2b-empty-action">
                <button type="button" className="b2b-btn-secondary" onClick={() => { setFStatus("전체"); setFSource(""); setFNo(""); }}>조건 지우기</button>
              </div>
            )}
          </div>
        ) : (
          <div className="b2b-table-wrap is-sticky-head">
            <table className="b2b-table">
              <thead>
                <tr><th>소스</th><th>상품번호</th><th>상품명</th><th>버전</th><th>자리</th><th>상태</th><th>마커 확인</th><th>요청</th><th>실행</th><th>오류</th></tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const c = APPLY_STATUS_COLOR[a.status] || APPLY_STATUS_COLOR["대기"];
                  const stale = a.status === "완료" && (sources.find((s) => s.id === a.source_id)?.version ?? a.source_version) > a.source_version;
                  return (
                    <tr key={a.id}>
                      <td>{srcName(a.source_id)}</td>
                      <td className="num">{a.product_no}</td>
                      <td>{a.product_name || <span className="sm-faint">-</span>}</td>
                      <td className="num">v{a.source_version}{stale && <span className="sm-faint"> 구버전</span>}</td>
                      <td className="sm-nowrap">{POSITION_KO[a.position] || a.position}</td>
                      <td><span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{a.status}</span></td>
                      <td>{a.verified === true ? "확인" : a.verified === false ? <span className="sm-faint">미확인</span> : <span className="sm-faint">-</span>}</td>
                      <td className="sm-nowrap">{a.requested_by || "-"} {dateTime(a.created_at)}</td>
                      <td className="sm-nowrap">{a.executed_at ? dateTime(a.executed_at) : <span className="sm-faint">-</span>}</td>
                      <td className="dp-err-cell">{a.error || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
