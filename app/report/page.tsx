"use client";

// 커스텀 리포트 — 대화형(2026-10-19 대표 결정 "클로드 웹처럼"). 스레드는 서버(report_threads)에 저장되어 다시 열 수 있다.
//  비서가 글로 말하고(스트리밍), 조사가 필요하면 중간에 도구를 쓰며(도구 칩), run_sql 결과는 그 자리에 표 카드로 끼어든다.
//  표 카드의 [SQL 보기]·[리포트 저장]·[엑셀 내려받기]·루커 SQL, 저장된 리포트(변수 치환·실행), 루커 가이드는 그대로.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { qty, qtyText, dateFull } from "@/app/lib/format";
import LookerGuide from "./LookerGuide";

type Chart = { type: "bar" | "line" | "pie" | "none"; x?: string; series?: string[]; note?: string };
type Looker = { mode: "query" | "view" | "na"; sql?: string; note?: string };
type Row = Record<string, unknown>;
type Saved = { id: string; name: string; question: string; sql: string; chart: Chart; looker: Looker; createdAt: string; createdBy?: string | null };
type AskTable = { title: string; sql: string; columns: string[]; rows: Row[]; rowCount: number; truncated: boolean; looker?: Looker };
// /api/report/chat 계약(chat-assistant.ts) — 화면은 이 모양만 믿는다
type ChatTable = AskTable & { id: string; toolUseId: string };
type Item =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; live?: boolean; meta?: { model: string; estUsd: number; estNote: string; elapsedMs: number; downgraded: boolean; timedOut: boolean } }
  | { role: "tool"; toolUseId: string; name: string; label: string; ok: boolean | null; ms?: number; table?: ChatTable };
type Thread = { id: string; title: string; createdBy: string; createdAt: string; updatedAt: string; estUsd: number };
type RunResult = { rep: Saved; sql: string; columns: string[]; rows: Row[] };
type SaveCtx = { question: string; sql: string; looker?: Looker; chart?: Chart };

const EXAMPLES = [
  "10월 채널별 매출",
  "이번 달 VOC 에서 가장 많은 불만은?",
  "10월 채널별 매출과 톡스토어가 빠진 이유",
];
const TABLE_ROW_LIMIT = 1000;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v.toLocaleString("ko-KR");
  return String(v);
}
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}초`;
const usd = (v: number) => `$${v.toFixed(2)}`;
function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function extractVars(sql: string): string[] {
  return [...new Set([...sql.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))];
}
function fillVars(sql: string, values: Record<string, string>): string {
  let out = sql;
  for (const [k, v] of Object.entries(values)) out = out.replace(new RegExp(`\\{\\{\\s*${esc(k)}\\s*\\}\\}`, "g"), v);
  return out;
}
async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (obj: Record<string, unknown>) => void) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!l) continue;
      try { onLine(JSON.parse(l)); } catch { /* 깨진 줄은 건너뛴다 */ }
    }
  }
  const rest = buf.trim();
  if (rest) { try { onLine(JSON.parse(rest)); } catch { /* noop */ } }
}

/** 표 카드 — 접힌 머리줄 "제목 · N행", 펼치면 표 + [SQL 보기] + 루커 SQL. 저장 리포트 실행 결과도 같은 카드(기본 펼침) */
function TableCard({ table, question, defaultOpen, onSave, onExport }: {
  table: AskTable; question: string; defaultOpen?: boolean;
  onSave: (ctx: SaveCtx) => void; onExport: (sql: string, title: string) => void;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState("");
  const copy = (text: string, tag: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(tag); setTimeout(() => setCopied(""), 1500); }); };
  const rows = table.rows || [];
  const cols = table.columns || [];
  const isNum = (c: string) => typeof rows[0]?.[c] === "number";
  const looker = table.looker;
  return (
    <div className="rp-fold">
      <button type="button" className="rp-fold-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="rp-fold-chev">{open ? "▾" : "▸"}</span>
        <span>{table.title} · {qtyText(table.rowCount, "행")}</span>
      </button>
      {open && (
        <div className="rp-fold-body">
          <div className="rp-fold-actions">
            <button type="button" className="b2b-btn-secondary" onClick={() => onSave({ question, sql: table.sql, looker, chart: { type: "none" } })}>리포트 저장</button>
            <button type="button" className="b2b-btn-secondary" onClick={() => onExport(table.sql, table.title)} disabled={!rows.length}>엑셀 내려받기</button>
            <button type="button" className="b2b-link-btn" onClick={() => setShowSql((v) => !v)}>{showSql ? "SQL 닫기" : "SQL 보기"}</button>
          </div>
          {rows.length === 0 ? <div className="b2b-empty">조회 결과가 없습니다.</div> : (
            <div className="b2b-table-wrap rp-table-wrap">
              <table className="b2b-table">
                <thead><tr>{cols.map((c) => <th key={c} className={isNum(c) ? "num" : ""}>{c}</th>)}</tr></thead>
                <tbody>
                  {rows.slice(0, TABLE_ROW_LIMIT).map((r, i) => (
                    <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === "number" ? "num b2b-money" : ""}>{fmt(r[c])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {(rows.length > TABLE_ROW_LIMIT || table.truncated) && (
                <div className="rp-table-note">표는 {qty(Math.min(rows.length, TABLE_ROW_LIMIT))}행까지 표시, 전체는 [엑셀 내려받기]로</div>
              )}
            </div>
          )}
          {showSql && (
            <div className="rp-sql-box">
              <div className="rp-sql-bar"><button type="button" className="b2b-link-btn" onClick={() => copy(table.sql, "sql")}>{copied === "sql" ? "복사됨" : "SQL 복사"}</button></div>
              <pre className="rp-sql">{table.sql}</pre>
            </div>
          )}
          {looker && looker.mode !== "na" && looker.sql && (
            <section className="b2b-card rp-looker">
              <div className="b2b-card-head">
                <span className="b2b-card-title">루커스튜디오용 SQL <span className="rp-card-sub">{looker.mode === "view" ? "· 뷰 생성(SQL Editor 적용 후 사용)" : "· 커스텀 쿼리"}</span></span>
                <button type="button" className="b2b-btn-secondary" onClick={() => copy(looker.sql || "", "looker")}>{copied === "looker" ? "복사됨" : "루커 SQL 복사"}</button>
              </div>
              {looker.note && <p className="rp-looker-note">{looker.note}</p>}
              <pre className="rp-sql">{looker.sql}</pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

const TOOL_NAME: Record<string, string> = { run_sql: "조회", schema: "스키마", search_text: "글 검색", read_report: "리포트 읽기" };

export default function ReportPage() {
  const toast = useToast();
  const confirmModal = useConfirm();
  const [q, setQ] = useState("");
  const [qErr, setQErr] = useState("");
  const [loading, setLoading] = useState(false);       // 비서가 답하는 중(스트리밍)
  const [busy, setBusy] = useState(false);             // 대화 열기·저장 리포트 실행
  const [err, setErr] = useState("");
  const [pendingMsg, setPendingMsg] = useState("");    // 139 미적용 안내
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedFilter, setSavedFilter] = useState<"mine" | "all">("mine");
  const [varForm, setVarForm] = useState<{ rep: Saved; values: Record<string, string> } | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveSql, setSaveSql] = useState("");
  const [saveCtx, setSaveCtx] = useState<SaveCtx | null>(null);
  const [saveErr, setSaveErr] = useState<{ name?: string; sql?: string }>({});
  const endRef = useRef<HTMLDivElement>(null);
  const isAdmin = me === "현석" || me === "관리자"; // AppSidebar 와 같은 판정

  const loadSaved = useCallback(async () => {
    try { const j = await (await fetch("/api/report/saved", { cache: "no-store" })).json(); if (j.ok) setSaved(j.reports || []); } catch { /* noop */ }
  }, []);
  const loadThreads = useCallback(async () => {
    try {
      const r = await fetch("/api/report/chat/threads", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setThreads(j.threads || []);
      else if (j.pending_migration) setPendingMsg(j.error);
    } catch { /* noop */ }
  }, []);
  useEffect(() => { loadSaved(); loadThreads(); }, [loadSaved, loadThreads]);
  useEffect(() => { (async () => { try { const j = await (await fetch("/api/b2b/auth", { cache: "no-store" })).json(); if (j.ok) setMe(j.name); } catch { /* noop */ } })(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [items.length, loading]);

  const filteredSaved = useMemo(
    () => (savedFilter === "all" || !me ? saved : saved.filter((s) => s.createdBy === me)),
    [saved, savedFilter, me],
  );
  const lastUserText = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (it.role === "user") return it.text; } return ""; }, [items]);

  function newThread() { if (loading) return; setThreadId(null); setItems([]); setErr(""); setVarForm(null); setRunResult(null); setQ(""); setQErr(""); }

  async function openThread(id: string) {
    if (loading) return;
    setBusy(true); setErr(""); setVarForm(null); setRunResult(null);
    try {
      const j = await (await fetch(`/api/report/chat/threads/${id}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "대화를 불러오지 못했습니다");
      setThreadId(id); setItems(j.items || []); setThreadsOpen(false);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function deleteThread(t: Thread) {
    if (!(await confirmModal({ title: `'${t.title}' 대화 지우기`, body: "목록에서 사라집니다. 저장한 리포트는 남습니다.", action: "대화 지우기" }))) return;
    const j = await (await fetch(`/api/report/chat/threads/${t.id}`, { method: "DELETE" })).json();
    if (!j.ok) { toast.error(j.error || "대화를 지우지 못했습니다"); return; }
    if (threadId === t.id) newThread();
    toast.success("대화를 지웠습니다");
    loadThreads();
  }

  // 한 턴 — 스레드가 없으면 먼저 만든다. 글자는 흘러오고, 도구 칩·표 카드는 그 자리에 끼어든다.
  async function send(text: string) {
    const tt = text.trim();
    if (loading || busy) return;
    if (!tt) { setQErr("메시지를 입력하세요"); return; }
    setQErr(""); setErr(""); setVarForm(null); setRunResult(null);
    setLoading(true);
    let id = threadId;
    try {
      if (!id) {
        const j = await (await fetch("/api/report/chat/threads", { method: "POST" })).json();
        if (!j.ok) throw new Error(j.error || "새 대화를 만들지 못했습니다");
        id = j.thread.id as string; setThreadId(id);
      }
      setItems((it) => [...it, { role: "user", text: tt }]);
      setQ("");
      const r = await fetch(`/api/report/chat/threads/${id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: tt }) });
      if (!r.ok || !r.body) {
        let msg = `서버 응답 ${r.status}`;
        try { const t = await r.text(); try { const j = JSON.parse(t); msg = j.error || msg; } catch { if (t) msg = t.slice(0, 200); } } catch { /* noop */ }
        throw new Error(msg);
      }
      let errText = "";
      await readNdjson(r.body, (obj) => {
        const type = String(obj.type || "");
        if (type === "text") {
          const delta = String(obj.delta || "");
          setItems((it) => {
            const last = it[it.length - 1];
            if (last && last.role === "assistant" && last.live) return [...it.slice(0, -1), { ...last, text: last.text + delta }];
            return [...it, { role: "assistant", text: delta, live: true }];
          });
        } else if (type === "tool") {
          const toolUseId = String(obj.toolUseId || ""), status = String(obj.status || "");
          setItems((it) => {
            const idx = it.findIndex((x) => x.role === "tool" && x.toolUseId === toolUseId);
            if (idx < 0) return [...it.map((x) => (x.role === "assistant" && x.live ? { ...x, live: false } : x)), { role: "tool", toolUseId, name: String(obj.name || ""), label: String(obj.label || ""), ok: null }];
            const cur = it[idx];
            if (cur.role !== "tool") return it;
            return [...it.slice(0, idx), { ...cur, ok: status === "ok" ? true : status === "fail" ? false : cur.ok, ms: typeof obj.ms === "number" ? obj.ms : cur.ms }, ...it.slice(idx + 1)];
          });
        } else if (type === "table") {
          const table = obj.table as ChatTable;
          setItems((it) => it.map((x) => (x.role === "tool" && x.toolUseId === table.toolUseId ? { ...x, table } : x)));
        } else if (type === "done") {
          const usage = (obj.usage || {}) as { estUsd?: number; estNote?: string };
          setItems((it) => {
            const idx = [...it].reverse().findIndex((x) => x.role === "assistant");
            if (idx < 0) return it;
            const i = it.length - 1 - idx;
            const cur = it[i];
            if (cur.role !== "assistant") return it;
            return [...it.slice(0, i), { ...cur, live: false, meta: { model: String(obj.model || ""), estUsd: Number(usage.estUsd) || 0, estNote: String(usage.estNote || ""), elapsedMs: Number(obj.elapsedMs) || 0, downgraded: !!obj.downgraded, timedOut: !!obj.timedOut } }, ...it.slice(i + 1)];
          });
        } else if (type === "error") errText = String(obj.error || "");
      });
      if (errText) throw new Error(errText);
      loadThreads();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setItems((it) => it.map((x) => (x.role === "assistant" && x.live ? { ...x, live: false } : x)));
    }
  }

  // ── 저장 리포트(변수 치환·실행)·저장·엑셀 — 종전 그대로 ──
  function startSaved(rep: Saved) {
    const vars = extractVars(rep.sql);
    if (vars.length) { setVarForm({ rep, values: Object.fromEntries(vars.map((v) => [v, ""])) }); setRunResult(null); return; }
    runSql(rep, rep.sql);
  }
  async function runSql(rep: Saved, sql: string) {
    setBusy(true); setErr(""); setRunResult(null);
    try {
      const r = await fetch("/api/report/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "실행 실패");
      setRunResult({ rep, sql, columns: j.columns || [], rows: j.rows || [] }); setVarForm(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function delSaved(id: string) {
    await fetch(`/api/report/saved?id=${id}`, { method: "DELETE" }); loadSaved();
  }
  function openSave(ctx: SaveCtx) {
    setSaveCtx(ctx); setSaveName(""); setSaveSql(ctx.sql); setSaveErr({}); setSaveOpen(true);
  }
  async function doSave() {
    const errs: { name?: string; sql?: string } = {};
    if (!saveName.trim()) errs.name = "이름을 입력하세요";
    if (!saveSql.trim()) errs.sql = "SQL을 입력하세요";
    setSaveErr(errs);
    if (errs.name || errs.sql) return;
    const r = await fetch("/api/report/saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: saveName.trim(), question: saveCtx?.question || "", sql: saveSql, chart: saveCtx?.chart || { type: "none" }, looker: saveCtx?.looker || { mode: "na" } }) });
    const j = await r.json();
    if (!j.ok) { setSaveErr({ sql: j.error || "저장하지 못했습니다" }); return; }
    setSaveOpen(false); toast.success("리포트를 저장했습니다"); loadSaved();
  }
  async function exportXlsx(sql: string, title: string) {
    const r = await fetch("/api/report/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql, title }) });
    if (!r.ok) { toast.error("엑셀을 만들지 못했습니다"); return; }
    const blob = await r.blob();
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${title || "report"}.xlsx`; a.click(); URL.revokeObjectURL(a.href);
  }

  const hasAnything = items.length > 0 || !!runResult || loading || !!err;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">커스텀 리포트</h1></div>
        <div className="sm-row" style={{ gap: 8 }}>
          {threads.length > 0 && <button className="b2b-btn-secondary" onClick={() => setThreadsOpen((v) => !v)} disabled={loading}>{threadsOpen ? "대화 목록 닫기" : `대화 목록 ${qty(threads.length)}`}</button>}
          {hasAnything && <button className="b2b-btn-secondary" onClick={newThread} disabled={loading}>새 대화</button>}
        </div>
      </header>

      {pendingMsg && <div className="b2b-error">{pendingMsg}</div>}

      {/* 대화 목록 — 내 스레드 최근순, 클릭하면 이어서 */}
      {threadsOpen && (
        <div className="rp-saved-box">
          <div className="rp-saved-list">
            {threads.map((t) => (
              <div key={t.id} className={`rp-saved-item ${t.id === threadId ? "is-active" : ""}`} onClick={() => openThread(t.id)} title="클릭하면 이어서">
                <span className="rp-saved-name">{t.title}</span>
                <div className="rp-saved-meta">
                  <span>{dateFull(t.updatedAt)}</span>
                  {isAdmin && t.createdBy !== me && <><span>·</span><span>{t.createdBy}</span></>}
                  <button className="rp-saved-del2" onClick={(e) => { e.stopPropagation(); deleteThread(t); }}>지우기</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 저장된 리포트 — 기본 접힘 */}
      {saved.length > 0 && (
        <div className="rp-saved-box">
          <div className="rp-saved-bar">
            <button className="rp-saved-toggle" onClick={() => setSavedOpen((v) => !v)}>
              <span className="rp-saved-chev">{savedOpen ? "▾" : "▸"}</span>
              저장된 리포트
            </button>
            {savedOpen && me && (
              <div className="sm-tabs">
                <button className={`sm-tab ${savedFilter === "mine" ? "is-active" : ""}`} onClick={() => setSavedFilter("mine")}>내 저장</button>
                <button className={`sm-tab ${savedFilter === "all" ? "is-active" : ""}`} onClick={() => setSavedFilter("all")}>전체</button>
              </div>
            )}
          </div>
          {savedOpen && (filteredSaved.length === 0 ? (
            <div className="b2b-empty">{savedFilter === "mine" ? "내가 저장한 리포트가 없습니다." : "저장된 리포트가 없습니다."}</div>
          ) : (
            <div className="rp-saved-list">
              {filteredSaved.map((s) => (
                <div key={s.id} className="rp-saved-item" onClick={() => { if (!loading && !busy) startSaved(s); }} title="클릭하면 실행">
                  <span className="rp-saved-name">{s.name}{extractVars(s.sql).length ? <span className="rp-saved-var">변수</span> : null}</span>
                  {s.question && <div className="rp-saved-q">{s.question}</div>}
                  <div className="rp-saved-meta">
                    <span>저장: {s.createdBy || "—"}</span>
                    <span>·</span>
                    <span>{dateFull(s.createdAt)}</span>
                    <button className="rp-saved-del2" onClick={async (e) => { e.stopPropagation(); if (await confirmModal({ title: `'${s.name}' 저장 리포트 삭제`, body: "저장한 질문과 SQL이 지워집니다. 되돌릴 수 없습니다.", action: "리포트 삭제" })) delSaved(s.id); }}>삭제</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* 저장 리포트 변수 입력 */}
      {varForm && (
        <section className="b2b-card rp-varform">
          <div className="b2b-card-head"><span className="b2b-card-title">▶ {varForm.rep.name}</span></div>
          <div className="rp-varform-row">
            {Object.keys(varForm.values).map((v) => (
              <label key={v} className="sm-col rp-varform-field">
                <span className="b2b-field-label">{v}</span>
                <input className="b2b-input" value={varForm.values[v]} onChange={(e) => setVarForm({ rep: varForm.rep, values: { ...varForm.values, [v]: e.target.value } })} aria-label={`${v} 값`} />
              </label>
            ))}
            <button className="b2b-btn-primary" disabled={busy} onClick={() => runSql(varForm.rep, fillVars(varForm.rep.sql, varForm.values))}>리포트 실행</button>
            <button className="b2b-btn-secondary" onClick={() => setVarForm(null)}>닫기</button>
          </div>
        </section>
      )}

      {/* 저장 리포트 실행 결과 — 표 카드(기본 펼침) */}
      {runResult && (
        <div className="rp-turn">
          <TableCard
            table={{ title: runResult.rep.name, sql: runResult.sql, columns: runResult.columns, rows: runResult.rows, rowCount: runResult.rows.length, truncated: runResult.rows.length >= 5000, looker: runResult.rep.looker }}
            question={runResult.rep.question || runResult.rep.name} defaultOpen onSave={openSave} onExport={exportXlsx} />
        </div>
      )}

      {/* 빈 상태 — 예시 3개(정량·정성·혼합) */}
      {!hasAnything && !busy && (
        <div className="rp-examples">
          {EXAMPLES.map((ex) => <button key={ex} type="button" className="b2b-btn-secondary" onClick={() => send(ex)}>{ex}</button>)}
        </div>
      )}

      {/* 대화 — 사용자 글은 오른쪽 말풍선, 비서 글은 왼쪽 평문, 도구 칩과 표 카드는 그 자리에 */}
      {items.length > 0 && (
        <div className="rp-thread">
          {items.map((it, i) => {
            if (it.role === "user") return <div key={i} className="rp-msg rp-msg-user"><div className="rp-bubble">{it.text}</div></div>;
            if (it.role === "tool") {
              return (
                <div key={it.toolUseId} className="rp-msg rp-msg-tool">
                  <div className={`rp-tool-chip ${it.ok === false ? "is-fail" : it.ok === true ? "is-ok" : "is-run"}`}>
                    <span className="rp-tool-kind">{TOOL_NAME[it.name] || it.name}</span>
                    <span>{it.label}</span>
                    <span className="rp-tool-state">{it.ok === null ? "진행 중" : it.ok ? (it.ms != null ? sec(it.ms) : "완료") : "실패"}</span>
                  </div>
                  {it.table && <TableCard table={it.table} question={lastUserText} defaultOpen={it.table.rowCount <= 12} onSave={openSave} onExport={exportXlsx} />}
                </div>
              );
            }
            return (
              <div key={i} className="rp-msg rp-msg-ai">
                <p className="rp-chat-text">{it.text}{it.live && <span className="rp-cursor" aria-hidden="true">▍</span>}</p>
                {it.meta && (
                  <div className="rp-meta">
                    {it.meta.downgraded && <span className="rp-meta-warn">이달 비용 상한을 넘어 빠른 모델로 답했습니다 · </span>}
                    {it.meta.timedOut && <span className="rp-meta-warn">시간이 다 돼 조사를 다 하지 못했습니다 · </span>}
                    {it.meta.model} · {sec(it.meta.elapsedMs)}
                    {isAdmin && <> · 약 {usd(it.meta.estUsd)}{it.meta.estNote ? ` (${it.meta.estNote})` : ""}</>}
                  </div>
                )}
              </div>
            );
          })}
          {loading && !items.some((x) => x.role === "assistant" && x.live) && <div className="rp-msg rp-msg-ai"><p className="rp-chat-text rp-thinking">읽는 중</p></div>}
          <div ref={endRef} />
        </div>
      )}
      {busy && !runResult && <div className="b2b-loading">불러오는 중...</div>}

      {err && (
        <div className="b2b-error rp-error">
          <div>{err}</div>
          <div>다시 보내거나 질문을 바꿔 보세요</div>
        </div>
      )}

      {/* 입력 — 대화 아래. Enter = 보내기, Shift+Enter = 줄바꿈 */}
      <div className="rp-composer">
        <div className="rp-ask">
          <textarea className="b2b-input rp-input" rows={2} value={q} aria-label="메시지"
            placeholder={items.length ? "이어서 답하거나 물어보세요" : "예: 10월 채널별 매출과 톡스토어가 빠진 이유"}
            aria-invalid={qErr ? "true" : undefined}
            onChange={(e) => { setQ(e.target.value); if (qErr) setQErr(""); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(q); } }} />
          <div className="rp-ask-actions">
            <button className="b2b-btn-primary" onClick={() => send(q)} disabled={loading || busy}>{loading ? "답하는 중..." : "보내기"}</button>
          </div>
        </div>
        {qErr && <div className="b2b-field-error">{qErr}</div>}
      </div>

      {/* 저장 다이얼로그 */}
      {saveOpen && (
        <div className="rp-modal-bg" onClick={() => setSaveOpen(false)}>
          <div className="rp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-card-head"><span className="b2b-card-title">리포트 저장</span></div>
            {(saveErr.name || saveErr.sql) && (
              <div className="b2b-error">
                {saveErr.name && saveErr.sql ? <ul><li>{saveErr.name}</li><li>{saveErr.sql}</li></ul> : (saveErr.name || saveErr.sql)}
              </div>
            )}
            <label className="sm-col rp-save-field">
              <span className="b2b-field-label">이름<span className="req">*</span></span>
              <input className="b2b-input" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="예: 월별 채널 매출" aria-invalid={saveErr.name ? "true" : undefined} />
              {saveErr.name && <span className="b2b-field-error">{saveErr.name}</span>}
            </label>
            <label className="sm-col rp-save-field">
              <span className="b2b-field-label">SQL<span className="req">*</span> <span className="opt"><code>{"{{이름}}"}</code> = 실행 때 입력받는 값</span></span>
              <textarea className="b2b-input rp-save-sql" value={saveSql} onChange={(e) => setSaveSql(e.target.value)} aria-invalid={saveErr.sql ? "true" : undefined} />
              {saveErr.sql && <span className="b2b-field-error">{saveErr.sql}</span>}
            </label>
            <div className="rp-modal-foot">
              <button className="b2b-btn-secondary" onClick={() => setSaveOpen(false)}>그만두기</button>
              <button className="b2b-btn-primary" onClick={doSave}>리포트 저장</button>
            </div>
          </div>
        </div>
      )}

      <LookerGuide />
    </div>
  );
}
