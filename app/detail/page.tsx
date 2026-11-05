"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { dateTime } from "@/app/lib/format";
import { APPLY_STATUS_COLOR, APPLY_STATUSES, POSITIONS, POSITION_KO, parseProductNos, wrapBlock, type ApplyStatus, type Position, type SetMember } from "@/app/lib/detail-page";

type Source = { id: number; name: string; html: string; position: Position; version: number; updated_by: string | null; updated_at: string; applied_count: number };
type SourceSet = { id: number; name: string; members: number[]; position: Position; updated_by: string | null; updated_at: string };
type Apply = {
  id: number; source_id: number | null; source_version: number | null; product_no: number; product_name: string | null; position: Position;
  status: ApplyStatus; error: string | null; verified: boolean | null; requested_by: string | null; created_at: string; executed_at: string | null;
  command?: string; set_id?: number | null; set_name?: string | null; members?: SetMember[] | null;
};
type StatusTab = "전체" | ApplyStatus;

const EMPTY = { name: "", html: "", position: "append" as Position };
const EMPTY_SET = { name: "", members: [] as number[], position: "append" as Position };

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
  // 조합(161)
  const [sets, setSets] = useState<SourceSet[]>([]);
  const [setsOff, setSetsOff] = useState(false);
  const [selSet, setSelSet] = useState<number | "new">("new");
  const [comboForm, setComboForm] = useState(EMPTY_SET);
  const [comboDirty, setComboDirty] = useState(false);
  const [comboSaving, setComboSaving] = useState(false);
  const [addId, setAddId] = useState("");
  // ④ 쏘기
  const [sendMode, setSendMode] = useState<"source" | "set">("source");
  const [nosText, setNosText] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  // 적용 현황
  const [applies, setApplies] = useState<Apply[]>([]);
  const [fSource, setFSource] = useState<string>("");
  const [fNo, setFNo] = useState("");
  const [fStatus, setFStatus] = useState<StatusTab>("전체");
  const [loadingApplies, setLoadingApplies] = useState(false);

  const selected = useMemo(() => (selId === "new" ? null : sources.find((s) => s.id === selId) || null), [selId, sources]);
  const selectedSet = useMemo(() => (selSet === "new" ? null : sets.find((s) => s.id === selSet) || null), [selSet, sets]);
  const nos = useMemo(() => parseProductNos(nosText), [nosText]);
  const srcName = useCallback((id: number) => sources.find((s) => s.id === id)?.name || `#${id}`, [sources]);

  const loadSources = useCallback(async () => {
    const r = await fetch("/api/detail/sources", { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "소스를 불러오지 못했습니다."); return; }
    setErr("");
    setSources(j.sources || []);
  }, []);

  const loadSets = useCallback(async () => {
    const r = await fetch("/api/detail/sets", { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { setSetsOff(true); return; }
    setSetsOff(!!j.unavailable);
    setSets((j.sets || []).map((s: SourceSet) => ({ ...s, members: (s.members || []).map(Number) })));
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
    loadSets();
    loadApplies("", "");
  }, [loadSources, loadSets, loadApplies]);

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

  // ── ① 소스 ──
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

  async function save() {
    if (!form.name.trim()) { setErr("소스 이름을 입력하세요."); return; }
    if (!form.html.trim()) { setErr("HTML 을 입력하세요."); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/detail/sources", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selId === "new" ? undefined : selId, name: form.name.trim(), html: form.html, position: form.position }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "소스를 저장하지 못했습니다."); return; }
      setErr("");
      setDirty(false);
      await loadSources();
      setSelId(j.source.id);
      toast.success(`소스를 저장했습니다 (v${j.source.version})`);
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
    await loadSets();
    await loadApplies(fSource, fNo);
  }

  // 이 소스가 들어간 상품 전체를 ④ 칸에 채운다(소스·조합으로 들어간 것 모두). 쏘기는 사람이 누른다.
  async function fillAppliedProducts() {
    if (!selected) return;
    const r = await fetch(`/api/detail/applies?applied_for=${selected.id}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { setErr(j.error || "적용 상품을 불러오지 못했습니다."); return; }
    const list: number[] = j.product_nos || [];
    if (list.length === 0) { toast.error("이 소스가 들어간 상품이 없습니다"); return; }
    setSendMode("source");
    setNosText(list.join(", "));
    toast.success(`${list.length}개 상품번호를 채웠습니다. 쏘기를 누르세요`);
  }

  // ── ③ 조합 ──
  async function pickSet(id: number | "new") {
    if (id === selSet) return;
    if (comboDirty && !(await confirm({ title: "저장하지 않은 변경", body: "이 조합에서 바꾼 내용을 저장하지 않았습니다. 이동하면 바꾼 내용은 사라집니다.", action: "버리고 이동" }))) return;
    setSelSet(id);
    setComboDirty(false);
    setErr("");
    if (id === "new") { setComboForm(EMPTY_SET); return; }
    const s = sets.find((x) => x.id === id);
    if (s) setComboForm({ name: s.name, members: [...s.members], position: s.position });
  }

  function moveMember(i: number, dir: -1 | 1) {
    const m = [...comboForm.members];
    const j = i + dir;
    if (j < 0 || j >= m.length) return;
    [m[i], m[j]] = [m[j], m[i]];
    setComboForm({ ...comboForm, members: m }); setComboDirty(true);
  }

  async function saveSet() {
    if (!comboForm.name.trim()) { setErr("조합 이름을 입력하세요."); return; }
    if (comboForm.members.length === 0) { setErr("구성 소스를 하나 이상 고르세요."); return; }
    setComboSaving(true);
    try {
      const r = await fetch("/api/detail/sets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selSet === "new" ? undefined : selSet, name: comboForm.name.trim(), members: comboForm.members, position: comboForm.position }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "조합을 저장하지 못했습니다."); return; }
      setErr("");
      setComboDirty(false);
      await loadSets();
      setSelSet(j.set.id);
      toast.success("조합을 저장했습니다");
    } finally { setComboSaving(false); }
  }

  async function removeSet() {
    if (!selectedSet) return;
    if (!(await confirm({ title: `조합 "${selectedSet.name}" 삭제`, body: "소스와 이미 쏜 상품의 상세설명은 바뀌지 않습니다.", action: "조합 삭제" }))) return;
    const r = await fetch(`/api/detail/sets?id=${selectedSet.id}`, { method: "DELETE" });
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "조합을 삭제하지 못했습니다."); return; }
    toast.success("조합을 삭제했습니다");
    setSelSet("new"); setComboForm(EMPTY_SET); setComboDirty(false);
    await loadSets();
  }

  // ── ④ 쏘기 ──
  const target = sendMode === "set" ? selectedSet : selected;
  const targetDirty = sendMode === "set" ? comboDirty : dirty;
  const sendWhy = !target ? (sendMode === "set" ? "조합을 저장하면 켜집니다" : "소스를 저장하면 켜집니다")
    : targetDirty ? "바꾼 내용을 저장하면 켜집니다"
    : nos.length === 0 ? "상품번호를 넣으면 켜집니다"
    : !isAdmin ? "관리자만 쏠 수 있습니다" : "";

  async function send() {
    if (sendWhy) { setErr(sendWhy.replace("켜집니다", "쏠 수 있습니다").replace("하면", "하세요.").replace("넣으면", "넣으세요.")); return; }
    if (!target) return;
    const isSet = sendMode === "set";
    const label = isSet ? `조합 "${target.name}"` : `"${target.name}" v${(target as Source).version}`;
    const ok = await confirm({
      title: `${label} 을 상품 ${nos.length}개에 쏘기`,
      body: `${POSITION_KO[target.position]} 로 들어갑니다.${isSet ? " 구성 소스가 각각 블록으로 펼쳐지고, 이미 있는 구성 블록은 걷어낸 뒤 조합 순서대로 다시 넣습니다." : ""} 2분 안에 공식몰 상세설명이 바뀝니다.`,
      action: "쏘기", danger: target.position === "replace",
    });
    if (!ok) return;
    setSending(true);
    try {
      const r = await fetch("/api/detail/applies", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isSet ? { set_id: target.id, product_nos: nos } : { source_id: target.id, product_nos: nos }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "쏘지 못했습니다."); return; }
      setErr("");
      toast.success(`${j.queued}건을 쏘았습니다${j.skipped?.length ? ` (이미 대기 중 ${j.skipped.length}건 제외)` : ""}`);
      setNosText("");
      setFSource(isSet ? "" : String(target.id)); setFNo(""); setFStatus("전체");
      await loadApplies(isSet ? "" : String(target.id), "");
    } finally { setSending(false); }
  }

  // ── 적용 현황 ──
  const counts = useMemo(() => {
    const c: Record<StatusTab, number> = { "전체": applies.length, "대기": 0, "실행중": 0, "완료": 0, "실패": 0 };
    for (const a of applies) c[a.status] = (c[a.status] || 0) + 1;
    return c;
  }, [applies]);
  const shown = useMemo(() => (fStatus === "전체" ? applies : applies.filter((a) => a.status === fStatus)), [applies, fStatus]);
  const appliedProducts = useMemo(() => new Set(applies.filter((a) => a.status === "완료").map((a) => a.product_no)).size, [applies]);
  const isStale = (a: Apply): boolean => {
    if (a.status !== "완료") return false;
    if (a.command === "set" && Array.isArray(a.members)) return a.members.some((m) => (sources.find((s) => s.id === m.source_id)?.version ?? m.version) > m.version);
    if (a.source_id) return (sources.find((s) => s.id === a.source_id)?.version ?? a.source_version ?? 0) > (a.source_version ?? 0);
    return false;
  };

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

      <details className="dp-rules">
        <summary>사용 규칙</summary>
        <div className="dp-rules-grid">
          <div>
            <div className="dp-rules-title">넣는 자리</div>
            <ul className="dp-rules-list">
              <li>공통 블록은 기존 맨 앞 또는 기존 맨 뒤로만 쏜다.</li>
              <li>전체 교체는 그 상품의 기존 상세설명을 전부 지운다. 상품 상세를 통째로 새로 쓸 때만 쓴다.</li>
              <li>넣는 자리는 그 상품에 처음 들어갈 때만 쓰인다. 이미 들어간 소스는 원래 자리에서 바뀐다.</li>
            </ul>
          </div>
          <div>
            <div className="dp-rules-title">조합</div>
            <ul className="dp-rules-list">
              <li>조합은 소스를 순서대로 묶은 것이다. 쏘면 소스마다 블록으로 펼쳐 들어간다.</li>
              <li>여러 상품에 같이 들어가는 부분은 하나의 소스로 두고 조합에 넣는다. 그래야 그 소스만 고쳐 다시 쏠 수 있다.</li>
              <li>조합을 다시 쏘면 구성 블록을 걷어내고 조합 순서대로 다시 넣는다. 블록 순서를 바꾸려면 조합을 고쳐 다시 쏜다.</li>
            </ul>
          </div>
          <div>
            <div className="dp-rules-title">다시 쏘기</div>
            <ul className="dp-rules-list">
              <li>같은 소스를 다시 쏘면 상세설명 안의 그 소스 블록만 바뀐다. 다른 소스와 상품 고유 영역은 그대로다.</li>
              <li>소스를 고치면 적용 현황에 구버전이 표시된다. 소스 칸의 '들어간 상품 전체 채우기'로 상품번호를 채우고 쏜다.</li>
            </ul>
          </div>
          <div>
            <div className="dp-rules-title">카페24 편집기</div>
            <ul className="dp-rules-list">
              <li>전송한 상품을 편집기에서 열어 저장해도 소스 블록은 유지된다(2026-11-03 실측).</li>
              <li>소스 블록 안쪽은 편집기에서 고치지 않는다. 다음 전송 때 덮어쓴다.</li>
              <li>블록 바깥의 상품 고유 영역은 편집기에서 고쳐도 전송이 건드리지 않는다.</li>
            </ul>
          </div>
          <div>
            <div className="dp-rules-title">소스 HTML</div>
            <ul className="dp-rules-list">
              <li>텍스트로 쓴다. h2·h3 제목에 상품명이나 그룹명을 넣고, 보관·조리·대상 같은 사실은 한 문장씩 쓴다.</li>
              <li>인라인 style과 script는 넣지 않는다. 꾸밈은 스킨 CSS 클래스로 한다.</li>
              <li>이미지에는 alt를 쓴다. 핵심 텍스트를 숨김 영역에 두지 않는다.</li>
            </ul>
          </div>
          <div>
            <div className="dp-rules-title">반영</div>
            <ul className="dp-rules-list">
              <li>쏘기 뒤 2분 안에 공식몰에 반영된다. 적용 현황의 상태와 마커 확인으로 본다.</li>
              <li>모바일 상세설명을 따로 쓰는 상품은 거기에도 같이 들어간다.</li>
              <li>실패한 건은 오류 칸을 보고 고친 뒤 같은 상품번호로 다시 쏜다.</li>
            </ul>
          </div>
        </div>
      </details>

      <div className="dp-kpis">
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">소스</div>
          <div className="b2b-stat-card-value">{sources.length}</div>
          {!setsOff && <div className="b2b-stat-card-hint">조합 {sets.length}</div>}
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
                {selected && selected.applied_count > 0 && (
                  <button type="button" className="b2b-btn-secondary" onClick={fillAppliedProducts}>들어간 상품 전체 채우기</button>
                )}
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
        <div className="b2b-card-head"><span className="b2b-card-title">③ 조합</span></div>
        {setsOff ? (
          <div className="b2b-empty">조합을 쓰려면 마이그레이션 161 적용이 필요합니다.</div>
        ) : (
          <div className="dp-src-grid">
            <div className="dp-src-list">
              <button type="button" className={`dp-src-item is-new ${selSet === "new" ? "is-active" : ""}`} onClick={() => pickSet("new")}>
                <span className="dp-src-name">+ 새 조합</span>
              </button>
              {sets.map((s) => (
                <button key={s.id} type="button" className={`dp-src-item ${selSet === s.id ? "is-active" : ""}`} onClick={() => pickSet(s.id)}>
                  <span className="dp-src-name">{s.name}</span>
                  <span className="dp-src-meta">
                    <span>{POSITION_KO[s.position]}</span>
                    <span>{s.members.map(srcName).join(" › ")}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="b2b-form-section dp-editor">
              <div className="b2b-form-section-title">{selectedSet ? selectedSet.name : "새 조합"}</div>
              <div className="b2b-field">
                <label className="b2b-field-label" htmlFor="dp-set-name">조합 이름</label>
                <input id="dp-set-name" className="b2b-input" value={comboForm.name} onChange={(e) => { setComboForm({ ...comboForm, name: e.target.value }); setComboDirty(true); }} />
              </div>
              <div className="b2b-field">
                <span className="b2b-field-label">넣는 자리</span>
                <div className="sm-tabs">
                  {POSITIONS.map((p) => (
                    <button key={p} type="button" className={`sm-tab ${comboForm.position === p ? "is-active" : ""}`} onClick={() => { setComboForm({ ...comboForm, position: p }); setComboDirty(true); }}>{POSITION_KO[p]}</button>
                  ))}
                </div>
              </div>
              <div className="b2b-field">
                <span className="b2b-field-label">구성 소스 <span className="opt">(위에서 아래 순서로 들어간다)</span></span>
                {comboForm.members.length === 0 ? (
                  <div className="dp-members-empty">구성 소스가 없습니다.</div>
                ) : (
                  <ol className="dp-members">
                    {comboForm.members.map((id, i) => (
                      <li key={id} className="dp-member">
                        <span className="dp-member-order num">{i + 1}</span>
                        <span className="dp-member-name">{srcName(id)}</span>
                        <span className="dp-member-actions">
                          <button type="button" className="b2b-link-btn" disabled={i === 0} onClick={() => moveMember(i, -1)}>위로</button>
                          <button type="button" className="b2b-link-btn" disabled={i === comboForm.members.length - 1} onClick={() => moveMember(i, 1)}>아래로</button>
                          <button type="button" className="b2b-link-btn" onClick={() => { setComboForm({ ...comboForm, members: comboForm.members.filter((m) => m !== id) }); setComboDirty(true); }}>빼기</button>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="dp-member-add">
                  <select className="b2b-input" value={addId} onChange={(e) => setAddId(e.target.value)} aria-label="추가할 소스">
                    <option value="">소스 고르기</option>
                    {sources.filter((s) => !comboForm.members.includes(s.id)).map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                  </select>
                  <button type="button" className="b2b-btn-secondary" disabled={!addId} onClick={() => { setComboForm({ ...comboForm, members: [...comboForm.members, Number(addId)] }); setAddId(""); setComboDirty(true); }}>소스 추가</button>
                </div>
              </div>
              {selectedSet && (
                <div className="dp-meta">
                  <span>{selectedSet.updated_by || "-"} {dateTime(selectedSet.updated_at)}</span>
                  {comboDirty && <span>저장되지 않은 변경</span>}
                </div>
              )}
              <div className="b2b-form-foot">
                <div className="sm-row sm-gap-2">
                  <button type="button" className="b2b-btn-secondary" disabled={comboSaving} onClick={saveSet}>{comboSaving ? "저장 중" : "변경 저장"}</button>
                </div>
                <div className="b2b-form-foot-right">
                  {selectedSet && isAdmin && <button type="button" className="b2b-btn-danger" onClick={removeSet}>조합 삭제</button>}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="b2b-card dp-section">
        <div className="b2b-card-head">
          <span className="b2b-card-title">④ 적용할 상품</span>
          <div className="sm-tabs">
            <button type="button" className={`sm-tab ${sendMode === "source" ? "is-active" : ""}`} onClick={() => setSendMode("source")}>소스 쏘기</button>
            <button type="button" className={`sm-tab ${sendMode === "set" ? "is-active" : ""}`} disabled={setsOff} onClick={() => setSendMode("set")}>조합 쏘기</button>
          </div>
        </div>
        <div className="dp-send-grid">
          <div className="b2b-form-section">
            <div className="b2b-form-section-title">
              {sendMode === "set" ? (selectedSet ? `조합 · ${selectedSet.name}` : "조합을 고르세요") : (selected ? `소스 · ${selected.name} v${selected.version}` : "소스를 고르세요")}
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label" htmlFor="dp-nos">상품번호 <span className="opt">(쉼표·줄바꿈 구분)</span></label>
              <textarea id="dp-nos" className="b2b-input dp-nos" value={nosText} onChange={(e) => setNosText(e.target.value)} />
            </div>
            <div className="dp-send-foot">
              <button type="button" className="b2b-btn-primary" disabled={sending || !!sendWhy} onClick={send}>
                {sending ? "쏘는 중" : `쏘기${nos.length ? ` (${nos.length})` : ""}`}
              </button>
              {sendWhy && <span className="b2b-btn-why">{sendWhy}</span>}
              {!sendWhy && target && (
                <span className="b2b-btn-why">
                  {POSITION_KO[target.position]}{sendMode === "set" && selectedSet ? ` · ${selectedSet.members.map(srcName).join(" › ")}` : ""}
                </span>
              )}
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
                <tr><th>소스 · 조합</th><th>상품번호</th><th>상품명</th><th>버전</th><th>자리</th><th>상태</th><th>마커 확인</th><th>요청</th><th>실행</th><th>오류</th></tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const c = APPLY_STATUS_COLOR[a.status] || APPLY_STATUS_COLOR["대기"];
                  const stale = isStale(a);
                  const isSet = a.command === "set";
                  return (
                    <tr key={a.id}>
                      <td>
                        {isSet ? (
                          <>
                            <span>조합 · {a.set_name || `#${a.set_id}`}</span>
                            <span className="sm-faint dp-cell-sub">{(a.members || []).map((m) => srcName(m.source_id)).join(" › ")}</span>
                          </>
                        ) : (a.source_id ? srcName(a.source_id) : "-")}
                      </td>
                      <td className="num">{a.product_no}</td>
                      <td>{a.product_name || <span className="sm-faint">-</span>}</td>
                      <td className="num">
                        {isSet ? (a.members || []).map((m) => `v${m.version}`).join("·") : `v${a.source_version ?? "-"}`}
                        {stale && <span className="sm-faint"> 구버전</span>}
                      </td>
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
