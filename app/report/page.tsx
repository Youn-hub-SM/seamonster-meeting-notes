"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Chart = { type: "bar" | "line" | "pie" | "none"; x?: string; series?: string[]; note?: string };
type Looker = { mode: "query" | "view" | "na"; sql?: string; note?: string };
type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
type Plan = { understood: string; sql: string; explanation: string; chart?: Chart; looker: Looker; caveats: string[]; usage?: Usage };
type Row = Record<string, unknown>;
type Turn = { q: string; sql: string };
type Saved = { id: string; name: string; question: string; sql: string; chart: Chart; looker: Looker; createdAt: string; createdBy?: string | null };

function fmt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(v);
}
function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function extractVars(sql: string): string[] {
  return [...new Set([...sql.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1].trim()))];
}
function fillVars(sql: string, values: Record<string, string>): string {
  let out = sql;
  for (const v of extractVars(sql)) out = out.replace(new RegExp(`\\{\\{\\s*${esc(v)}\\s*\\}\\}`, "g"), values[v] ?? "");
  return out;
}

// 질문 조립 도우미 — 칸을 클릭하면 자연스러운 질문 문장이 만들어져 질문칸에 채워짐.
const COMPOSER_FACETS = [
  { key: "period", label: "기간", opts: ["오늘", "이번 주", "이번 달", "지난 달", "최근 7일", "최근 30일", "올해", "작년"] },
  { key: "dim", label: "무엇을 기준으로", opts: ["채널별", "상품별", "상품군별", "고객별", "지역별", "월별"] },
  { key: "metric", label: "지표", opts: ["매출", "판매수량", "주문수", "객단가", "신규·재구매 고객수", "재구매율", "재고 현황"] },
  { key: "scope", label: "범위·정렬", opts: ["상위 10개", "상위 20개", "많은 순", "적은 순", "전체"] },
] as const;
const COMPOSE_ORDER = ["period", "dim", "metric", "scope"] as const;

function QuestionComposer({ disabled, onCompose }: { disabled: boolean; onCompose: (text: string) => void }) {
  const [open, setOpen] = useState(true);
  const [pick, setPick] = useState<Record<string, string>>({});
  const compose = (p: Record<string, string>) => COMPOSE_ORDER.map((k) => p[k]).filter(Boolean).join(" ");
  function toggle(key: string, opt: string) {
    const next = { ...pick };
    if (next[key] === opt) delete next[key]; else next[key] = opt;
    setPick(next);
    onCompose(compose(next));
  }
  function reset() { setPick({}); onCompose(""); }
  return (
    <div className="rp-compose">
      <button className="rp-compose-head" onClick={() => setOpen((v) => !v)}>
        <span>{open ? "▾" : "▸"} 질문 만들기 도우미</span>
        <span className="rp-compose-hint">칸을 눌러 조합하면 아래 질문칸에 자동으로 채워집니다. 직접 고쳐 써도 돼요.</span>
      </button>
      {open && (
        <div className="rp-compose-body">
          {COMPOSER_FACETS.map((f) => (
            <div key={f.key} className="rp-compose-row">
              <span className="rp-compose-label">{f.label}</span>
              <div className="rp-compose-chips">
                {f.opts.map((o) => (
                  <button key={o} type="button" className={`rp-chip ${pick[f.key] === o ? "is-active" : ""}`} disabled={disabled} onClick={() => toggle(f.key, o)}>{o}</button>
                ))}
              </div>
            </div>
          ))}
          {Object.keys(pick).length > 0 && <button className="b2b-link-btn" style={{ fontSize: 13 }} onClick={reset}>선택 초기화</button>}
        </div>
      )}
    </div>
  );
}

export default function ReportPage() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveSql, setSaveSql] = useState("");
  const [varForm, setVarForm] = useState<{ rep: Saved; values: Record<string, string> } | null>(null);
  const [corrected, setCorrected] = useState(0);
  const [savedOpen, setSavedOpen] = useState(false);      // 저장 리스트 기본 접힘
  const [me, setMe] = useState<string | null>(null);       // 현재 로그인 사용자(저장자 매칭)
  const [savedFilter, setSavedFilter] = useState<"mine" | "all">("mine");

  const loadSaved = useCallback(async () => {
    try { const j = await (await fetch("/api/report/saved", { cache: "no-store" })).json(); if (j.ok) setSaved(j.reports || []); } catch { /* noop */ }
  }, []);
  useEffect(() => { loadSaved(); }, [loadSaved]);
  useEffect(() => { (async () => { try { const j = await (await fetch("/api/b2b/auth", { cache: "no-store" })).json(); if (j.ok) setMe(j.name); } catch { /* noop */ } })(); }, []);

  // 저장자 필터 — 기본 '내 저장'(로그인 사용자와 createdBy 일치). me 없으면 전체.
  const filteredSaved = useMemo(
    () => (savedFilter === "all" || !me ? saved : saved.filter((s) => s.createdBy === me)),
    [saved, savedFilter, me],
  );

  async function ask(question: string, fresh = false) {
    const qq = question.trim();
    if (!qq || loading) return;
    const hist = fresh ? [] : turns;
    setLoading(true); setErr(""); setVarForm(null); setPlan(null); setRows([]); setCols([]); setShowSql(false); setCorrected(0);
    try {
      const r = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: qq, history: hist }) });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "실패"); if (j.plan) setPlan(j.plan); setCorrected(j.corrected || 0); return; }
      setPlan(j.plan); setRows(j.rows || []); setCols(j.columns || []); setCorrected(j.corrected || 0);
      setTurns([...hist, { q: qq, sql: j.plan.sql }]); setQ("");
    } catch (e) { setErr(e instanceof Error ? e.message : "오류"); }
    finally { setLoading(false); }
  }

  function newThread() { setTurns([]); setPlan(null); setRows([]); setCols([]); setErr(""); setVarForm(null); setQ(""); }

  function startSaved(rep: Saved) {
    const vars = extractVars(rep.sql);
    if (vars.length) setVarForm({ rep, values: Object.fromEntries(vars.map((v) => [v, ""])) });
    else runSql(rep, rep.sql);
  }
  async function runSql(rep: Saved, sql: string) {
    if (loading) return;
    setLoading(true); setErr(""); setVarForm(null); setPlan(null); setRows([]); setCols([]); setShowSql(false); setCorrected(0);
    try {
      const r = await fetch("/api/report/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "실패"); return; }
      setPlan({ understood: rep.name, sql, explanation: "", chart: rep.chart, looker: rep.looker, caveats: [] });
      setRows(j.rows || []); setCols(j.columns || []); setTurns([{ q: rep.name, sql }]);
    } catch (e) { setErr(e instanceof Error ? e.message : "오류"); }
    finally { setLoading(false); }
  }
  async function delSaved(id: string) {
    await fetch(`/api/report/saved?id=${id}`, { method: "DELETE" }); loadSaved();
  }
  async function doSave() {
    if (!saveName.trim()) return;
    const r = await fetch("/api/report/saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: saveName.trim(), question: plan?.understood || "", sql: saveSql, chart: plan?.chart, looker: plan?.looker }) });
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "저장 실패"); return; }
    setSaveOpen(false); loadSaved();
  }

  async function exportXlsx() {
    if (!plan) return;
    const r = await fetch("/api/report/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: plan.sql, title: plan.understood }) });
    if (!r.ok) { setErr("엑셀 내보내기 실패"); return; }
    const blob = await r.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "report.xlsx"; a.click(); URL.revokeObjectURL(url);
  }
  function copy(text: string, tag: string) { navigator.clipboard?.writeText(text).then(() => { setCopied(tag); setTimeout(() => setCopied(""), 1500); }); }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">커스텀 리포트</h1>
        </div>
      </header>

      {/* 저장된 리포트 — 기본 접힘, 펼치면 한 줄에 하나씩 전문 표시 */}
      {saved.length > 0 && (
        <div className="rp-saved-box">
          <div className="rp-saved-bar">
            <button className="rp-saved-toggle" onClick={() => setSavedOpen((v) => !v)}>
              <span className="rp-saved-chev">{savedOpen ? "▾" : "▸"}</span>
              저장된 리포트 <span className="rp-saved-count">{filteredSaved.length}개{savedFilter === "mine" && me ? " · 내 저장" : ""}</span>
            </button>
            {savedOpen && me && (
              <div className="sm-tabs">
                <button className={`sm-tab ${savedFilter === "mine" ? "is-active" : ""}`} onClick={() => setSavedFilter("mine")}>내 저장</button>
                <button className={`sm-tab ${savedFilter === "all" ? "is-active" : ""}`} onClick={() => setSavedFilter("all")}>전체</button>
              </div>
            )}
          </div>
          {savedOpen && (filteredSaved.length === 0 ? (
            <div className="b2b-empty" style={{ padding: 16 }}>{savedFilter === "mine" ? "내가 저장한 리포트가 없습니다. ‘전체’로 바꿔보세요." : "저장된 리포트가 없습니다."}</div>
          ) : (
            <div className="rp-saved-list">
              {filteredSaved.map((s) => (
                <div key={s.id} className="rp-saved-item" onClick={() => { if (!loading) startSaved(s); }} title="클릭하면 실행">
                  <span className="rp-saved-name">{s.name}{extractVars(s.sql).length ? <span className="rp-saved-var">변수</span> : null}</span>
                  {s.question && <div className="rp-saved-q">{s.question}</div>}
                  <div className="rp-saved-meta">
                    <span>저장: {s.createdBy || "—"}</span>
                    <span>·</span>
                    <span>{s.createdAt.slice(0, 10)}</span>
                    <button className="rp-saved-del2" onClick={(e) => { e.stopPropagation(); delSaved(s.id); }}>삭제</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* 이어지는 대화 표시 */}
      {turns.length > 0 && (
        <div className="rp-thread">
          <span>이어지는 대화</span>
          {turns.map((t, i) => <span key={i} className="rp-thread-q">{t.q}</span>)}
        </div>
      )}

      <QuestionComposer disabled={loading} onCompose={setQ} />

      <div className="rp-ask">
        <textarea className="b2b-input rp-input" rows={2} value={q}
          placeholder={turns.length ? "이어서: 도매만 빼줘 / 월별로 바꿔줘 / 상위 20개로" : "질문을 한국어로 적어주세요. 예: 이번 달 채널별 매출 상위 10개"}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(q); }} />
        <div className="rp-ask-actions">
          <button className="b2b-btn-primary" onClick={() => ask(q)} disabled={loading || !q.trim()}>
            {loading ? "분석 중…" : turns.length ? "이어서 질문" : "조회"}
            <span className="rp-kbd">Ctrl+Enter</span>
          </button>
          {turns.length > 0 && (
            <button className="b2b-btn-secondary" onClick={newThread} disabled={loading}>새 질문 시작</button>
          )}
        </div>
      </div>

      {/* 저장 리포트 변수 입력 */}
      {varForm && (
        <section className="b2b-card" style={{ marginBottom: 14 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">▶ {varForm.rep.name} <span className="sm-faint" style={{ fontWeight: 400, fontSize: 13 }}>· 값을 채우고 실행</span></span></div>
          <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            {Object.keys(varForm.values).map((v) => (
              <label key={v} className="sm-col" style={{ gap: 3, fontSize: 13 }}>
                <span style={{ fontWeight: 600, color: "var(--sm-dark)" }}>{v}</span>
                <input className="b2b-input" style={{ width: 150 }} value={varForm.values[v]} onChange={(e) => setVarForm({ rep: varForm.rep, values: { ...varForm.values, [v]: e.target.value } })} placeholder={`${v} 값`} />
              </label>
            ))}
            <button className="b2b-btn-primary" disabled={loading} onClick={() => runSql(varForm.rep, fillVars(varForm.rep.sql, varForm.values))}>실행</button>
            <button className="b2b-btn-secondary" onClick={() => setVarForm(null)}>취소</button>
          </div>
        </section>
      )}

      {err && <div className="b2b-error" style={{ marginBottom: 12 }}>{err}</div>}
      {loading && <div className="b2b-loading">데이터를 조회하는 중…</div>}

      {plan && (
        <div className="sm-col" style={{ gap: 14 }}>
          <div className="rp-understood">{plan.understood}</div>
          {corrected > 0 && <div className="sm-faint" style={{ fontSize: 13, color: "var(--sm-info)", marginTop: -8 }}>SQL 오류를 자동 교정({corrected}회)해 실행했어요.</div>}
          {plan.usage && (
            <div className="sm-faint" style={{ fontSize: 13, marginTop: -8 }}>
              토큰 · 입력 {(plan.usage.input + plan.usage.cacheRead + plan.usage.cacheWrite).toLocaleString()}
              {plan.usage.cacheRead > 0 ? ` (캐시적중 ${plan.usage.cacheRead.toLocaleString()})` : plan.usage.cacheWrite > 0 ? ` (캐시저장 ${plan.usage.cacheWrite.toLocaleString()})` : ""}
              {" · 출력 "}{plan.usage.output.toLocaleString()}
            </div>
          )}

          {!err && (
            <section className="b2b-card">
              <div className="b2b-card-head">
                <span className="b2b-card-title">결과 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 13 }}>{rows.length}행{rows.length >= 5000 ? " (5,000행 제한)" : ""}</span></span>
                <div className="sm-row" style={{ gap: 6 }}>
                  <button className="b2b-btn-secondary" style={{ padding: "4px 10px" }} onClick={() => { setSaveName(plan.understood?.slice(0, 40) || ""); setSaveSql(plan.sql); setSaveOpen(true); }}>저장</button>
                  <button className="b2b-btn-secondary" style={{ padding: "4px 10px" }} onClick={exportXlsx} disabled={!rows.length}>엑셀</button>
                </div>
              </div>
              {rows.length === 0 ? <div className="b2b-empty">결과가 없습니다.</div> : (
                <div className="b2b-table-wrap" style={{ maxHeight: 480, overflow: "auto" }}>
                  <table className="b2b-table">
                    <thead><tr>{cols.map((c) => <th key={c} className={typeof rows[0][c] === "number" ? "num" : ""}>{c}</th>)}</tr></thead>
                    <tbody>
                      {rows.slice(0, 500).map((r, i) => (
                        <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === "number" ? "num b2b-money" : ""}>{fmt(r[c])}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > 500 && <div className="sm-faint" style={{ fontSize: 13, padding: 6 }}>표는 500행까지 표시 · 전체는 엑셀로</div>}
                </div>
              )}
              {plan.explanation && <p className="sm-faint" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.6 }}>· {plan.explanation}</p>}
              {plan.caveats?.length > 0 && <ul className="rp-caveats">{plan.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            </section>
          )}

          {plan.looker && plan.looker.mode !== "na" && plan.looker.sql && (
            <section className="b2b-card">
              <div className="b2b-card-head">
                <span className="b2b-card-title">루커스튜디오용 SQL <span className="sm-faint" style={{ fontWeight: 400, fontSize: 13 }}>{plan.looker.mode === "view" ? "· 뷰 생성(SQL Editor 적용 후 사용)" : "· 커스텀 쿼리로 붙여넣기"}</span></span>
                <button className="b2b-btn-secondary" style={{ padding: "4px 10px" }} onClick={() => copy(plan.looker.sql || "", "looker")}>{copied === "looker" ? "복사됨 ✓" : "복사"}</button>
              </div>
              {plan.looker.note && <p className="sm-faint" style={{ fontSize: 13, marginBottom: 8 }}>{plan.looker.note}</p>}
              <pre className="rp-sql">{plan.looker.sql}</pre>
            </section>
          )}

          <div>
            <button className="b2b-link-btn" style={{ fontSize: 13 }} onClick={() => setShowSql((v) => !v)}>{showSql ? "▾ 생성된 조회 SQL 숨기기" : "▸ 생성된 조회 SQL 보기"}</button>
            {showSql && (
              <div className="sm-col" style={{ gap: 4, marginTop: 6 }}>
                <div className="sm-row" style={{ justifyContent: "flex-end" }}><button className="b2b-link-btn" style={{ fontSize: 13 }} onClick={() => copy(plan.sql, "sql")}>{copied === "sql" ? "복사됨 ✓" : "SQL 복사"}</button></div>
                <pre className="rp-sql">{plan.sql}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 저장 다이얼로그 */}
      {saveOpen && (
        <div className="rp-modal-bg" onClick={() => setSaveOpen(false)}>
          <div className="rp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-card-head"><span className="b2b-card-title">리포트 저장</span></div>
            <label className="sm-col" style={{ gap: 4, marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>이름</span>
              <input className="b2b-input" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="예: 월별 채널 매출" />
            </label>
            <label className="sm-col" style={{ gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>SQL <span className="sm-faint" style={{ fontWeight: 400 }}>— 값을 <code>{"{{이름}}"}</code> 으로 바꾸면 재사용 때 그 값만 입력받습니다 (예: <code>order_month = {"{{월}}"}</code>)</span></span>
              <textarea className="b2b-input" style={{ minHeight: 120, fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 13 }} value={saveSql} onChange={(e) => setSaveSql(e.target.value)} />
            </label>
            <div className="sm-row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="b2b-btn-secondary" onClick={() => setSaveOpen(false)}>취소</button>
              <button className="b2b-btn-primary" onClick={doSave} disabled={!saveName.trim() || !saveSql.trim()}>저장</button>
            </div>
          </div>
        </div>
      )}

      {/* 루커스튜디오 적용 가이드 (하단 상시 참고) */}
      <section className="rp-guide">
        <button className="rp-guide-head" onClick={() => setGuideOpen((v) => !v)}>
          <span>루커스튜디오(데이터 스튜디오)에 적용하는 법</span>
          <span className="rp-guide-chev">{guideOpen ? "▾" : "▸"}</span>
        </button>
        {guideOpen && (
          <div className="rp-guide-body">
            <p className="rp-guide-lead">위 <b>「루커스튜디오용 SQL」</b>은 두 종류로 나와요. 카드에 <b>커스텀 쿼리</b>라고 적혀 있으면 A, <b>뷰 생성</b>이면 B를 따르세요.</p>
            <div className="rp-guide-block">
              <div className="rp-guide-title">A. 커스텀 쿼리 <span className="rp-guide-tag ok">Supabase 작업 불필요</span></div>
              <ol className="rp-guide-steps">
                <li>루커스튜디오 보고서 → <b>데이터 추가</b> → <b>PostgreSQL</b> 커넥터 (이미 연결돼 있으면 그 데이터소스 선택)</li>
                <li>접속정보 입력 후 <b>맞춤 쿼리(CUSTOM QUERY)</b> 선택</li>
                <li>복사한 <b>SELECT</b> 문을 붙여넣기 → <b>추가</b></li>
                <li>차트에 필드를 연결하면 끝</li>
              </ol>
            </div>
            <div className="rp-guide-block">
              <div className="rp-guide-title">B. 뷰 생성 <span className="rp-guide-tag warn">Supabase에 1회 적용 필요</span></div>
              <ol className="rp-guide-steps">
                <li>복사한 <code>create view … ; grant … to looker_ro;</code> 를 <b>Supabase 대시보드 → SQL Editor</b> 에 붙여넣고 <b>Run</b></li>
                <li>루커스튜디오 → <b>데이터 추가</b> → 아래 접속정보 → <b>테이블 목록에서 새 뷰 선택</b><br /><span className="sm-faint">(이미 데이터소스가 있으면: 데이터소스 편집 → 우측 상단 <b>필드 새로고침</b>)</span></li>
                <li>차트에 연결</li>
              </ol>
              <p className="rp-guide-note">루커는 읽기전용 <code>looker_ro</code> 계정이라 <b>뷰를 스스로 못 만들어요.</b> 그래서 새 데이터가 필요하면 이렇게 한 번만 Supabase에 만들어줘야 합니다.</p>
            </div>
            <div className="rp-guide-block">
              <div className="rp-guide-title">PostgreSQL 접속정보 (커넥터 최초 연결 시)</div>
              <table className="rp-guide-conn">
                <tbody>
                  <tr><td>호스트</td><td><code>aws-1-ap-northeast-2.pooler.supabase.com</code></td></tr>
                  <tr><td>포트</td><td><code>5432</code></td></tr>
                  <tr><td>데이터베이스</td><td><code>postgres</code></td></tr>
                  <tr><td>사용자</td><td><code>looker_ro.uwbkejkztuhzcesrffzq</code> <span className="sm-faint">(반드시 role.projectref)</span></td></tr>
                  <tr><td>비밀번호</td><td>설정하신 looker_ro 비밀번호</td></tr>
                  <tr><td>SSL</td><td>사용 (Enable SSL)</td></tr>
                </tbody>
              </table>
              <p className="sm-faint" style={{ fontSize: 13, marginTop: 6 }}>* 이미 매출 대시보드를 만들며 연결해둔 그 데이터소스와 <b>같은 접속정보</b>입니다. 새로 연결할 때만 필요해요.</p>
            </div>
            <div className="rp-guide-block">
              <div className="rp-guide-title">자주 겪는 것</div>
              <ul className="rp-guide-tips">
                <li><b>날짜가 안 맞아요</b> → 보고서/데이터소스 타임존을 <b>(GMT+9) 서울</b>로 설정</li>
                <li><b>바뀐 데이터가 안 보여요</b> → 데이터소스 <b>새로고침</b> (기본 캐시 12시간)</li>
                <li><b>새 컬럼/뷰가 안 떠요</b> → 데이터소스 편집에서 <b>필드 새로고침</b></li>
                <li><b>팀원도 보게 하려면</b> → 데이터소스를 <b>소유자 자격증명</b>으로 공유</li>
              </ul>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
