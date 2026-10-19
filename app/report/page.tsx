"use client";

// 데이터 비서(2026-10-19, docs/assistant-plan.md 1차) — 커스텀 리포트를 "무엇이든 묻는" 비서로.
//  질문 → POST /api/report/ask (NDJSON 스트리밍: progress 줄 → done/error) → 답 틀(답/근거/사실·추정/한계/이어서 물어볼 것).
//  저장 리포트(변수 치환·실행)·루커 SQL·루커 적용 가이드는 그대로. 대화는 브라우저 메모리만(최근 3턴을 history 로 보냄).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/app/components/Feedback";
import { qty, qtyText, dateFull } from "@/app/lib/format";

type Chart = { type: "bar" | "line" | "pie" | "none"; x?: string; series?: string[]; note?: string };
type Looker = { mode: "query" | "view" | "na"; sql?: string; note?: string };
type Row = Record<string, unknown>;
type Saved = { id: string; name: string; question: string; sql: string; chart: Chart; looker: Looker; createdAt: string; createdBy?: string | null };

// /api/report/ask 계약(서버는 별도 구현) — 화면은 이 모양만 믿는다
type AskTable = { title: string; sql: string; columns: string[]; rows: Row[]; rowCount: number; truncated: boolean; looker?: Looker };
type QuoteSource = "voc" | "inquiry" | "report" | "manual" | "request" | "activity";
type AskQuote = { source: QuoteSource; date: string; title: string; text: string };
type AskUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; estUsd: number; estNote: string };
type ToolLog = { name: string; label: string; ok: boolean; ms: number };
type AskKind = "answer" | "clarify" | "chat";   // chat = 조사 없는 평문 답(되묻기·확인·설명)
type AskResult = {
  kind?: AskKind;                       // "clarify" = 되물음(answer = 되물은 문장, clarify.options = 선택지)
  clarify?: { question: string; options: string[] };
  answer: string;
  tables: AskTable[];
  quotes: AskQuote[];
  facts: string[]; inferences: string[]; limits: string[]; followups: string[];
  model: string; usage: AskUsage;
  toolLog: ToolLog[];
  elapsedMs?: number;
  downgraded: boolean; timedOut: boolean;
};
type Progress = { name: string; label: string; ms: number };
type Turn = { q: string; result: AskResult };
// 저장 리포트 실행 결과(기존 /api/report/run)
type RunResult = { rep: Saved; sql: string; columns: string[]; rows: Row[] };
// 저장 다이얼로그에 넘길 것 — 표 카드의 질문·SQL·루커
type SaveCtx = { question: string; sql: string; looker?: Looker; chart?: Chart };

const QUOTE_SOURCE_LABEL: Record<QuoteSource, string> = {
  voc: "VOC", inquiry: "네이버 문의", report: "종합 리포트", manual: "CS 매뉴얼", request: "생산 요청", activity: "변경 기록",
};
const EXAMPLES = [
  "10월 채널별 매출",
  "이번 달 VOC 에서 가장 많은 불만은?",
  "10월 채널별 매출과 톡스토어가 빠진 이유",
];
const TABLE_ROW_LIMIT = 1000;

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
const sec = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}초`;
const usd = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;

/** NDJSON 스트림을 줄 단위로 읽는다 — 마지막 불완전 줄은 버퍼에 남긴다 */
async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (obj: Record<string, unknown>) => void) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const emit = (line: string) => {
    const s = line.trim();
    if (!s) return;
    let obj: unknown;
    try { obj = JSON.parse(s); } catch { return; } // 깨진 줄은 건너뛴다
    if (obj && typeof obj === "object") onLine(obj as Record<string, unknown>);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) { emit(buf.slice(0, idx)); buf = buf.slice(idx + 1); }
  }
  buf += dec.decode();
  emit(buf);
}

/** 표 카드 — 접힌 머리줄 "표 N · 제목 · N행", 펼치면 표 + [SQL 보기] + 루커 SQL. 저장 리포트 실행 결과도 같은 카드(기본 펼침) */
function TableCard({ idx, table, question, defaultOpen, onSave, onExport }: {
  idx?: number; table: AskTable; question: string; defaultOpen?: boolean;
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
        <span>{idx != null ? `표 ${idx} · ` : ""}{table.title} · {qtyText(table.rowCount, "행")}</span>
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

/** 답 틀(기획안 §2-3): 답 → 근거(표·인용) → 사실/추정 → 한계 → 이어서 물어볼 것 → 메타 줄. 비어 있는 섹션은 그리지 않는다 */
function AnswerView({ turn, isAdmin, disabled, onFollowup, onSave, onExport }: {
  turn: Turn; isAdmin: boolean; disabled: boolean;
  onFollowup: (q: string) => void; onSave: (ctx: SaveCtx) => void; onExport: (sql: string, title: string) => void;
}) {
  const r = turn.result;
  const tables = r.tables || [], quotes = r.quotes || [];
  const facts = r.facts || [], inferences = r.inferences || [], limits = r.limits || [], followups = r.followups || [];
  const toolLog = r.toolLog || [];
  const totalMs = r.elapsedMs ?? toolLog.reduce((s, t) => s + (t.ms || 0), 0); // 전체 경과(서버가 주면), 아니면 도구 시간 합
  const [quotesOpen, setQuotesOpen] = useState(true);
  return (
    <div className="rp-answer">
      <p className="rp-answer-text">{r.answer}</p>

      {(tables.length > 0 || quotes.length > 0) && (
        <section className="rp-sec">
          <h3 className="rp-sec-title">근거</h3>
          {tables.map((t, i) => <TableCard key={i} idx={i + 1} table={t} question={turn.q} onSave={onSave} onExport={onExport} />)}
          {quotes.length > 0 && (
            <div className="rp-fold">
              <button type="button" className="rp-fold-head" onClick={() => setQuotesOpen((v) => !v)} aria-expanded={quotesOpen}>
                <span className="rp-fold-chev">{quotesOpen ? "▾" : "▸"}</span>
                <span>인용 {qtyText(quotes.length, "건")}</span>
              </button>
              {quotesOpen && (
                <div className="rp-fold-body rp-quotes">
                  {quotes.map((qt, i) => (
                    <div key={i} className="rp-quote">
                      <div className="rp-quote-meta">{QUOTE_SOURCE_LABEL[qt.source] || qt.source} · {dateFull(qt.date)} · {qt.title}</div>
                      <div className="rp-quote-text">{(qt.text || "").slice(0, 300)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {(facts.length > 0 || inferences.length > 0) && (
        <section className="rp-sec">
          {facts.length > 0 && (
            <>
              <h3 className="rp-sec-title">사실</h3>
              <ul className="rp-list">{facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </>
          )}
          {inferences.length > 0 && (
            <>
              <h3 className="rp-sec-title">추정 <span className="rp-sec-sub">근거가 있는 해석</span></h3>
              <ul className="rp-list">{inferences.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </>
          )}
        </section>
      )}

      {limits.length > 0 && (
        <section className="rp-sec">
          <h3 className="rp-sec-title">한계</h3>
          <ul className="rp-list">{limits.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </section>
      )}

      {followups.length > 0 && (
        <section className="rp-sec">
          <h3 className="rp-sec-title">이어서 물어볼 것</h3>
          <div className="rp-followups">
            {followups.slice(0, 3).map((f, i) => (
              <button key={i} type="button" className="b2b-btn-secondary" disabled={disabled} onClick={() => onFollowup(f)}>{f}</button>
            ))}
          </div>
        </section>
      )}

      {r.downgraded && <div className="sm-warn">이달 비용 상한을 넘어 빠른 모델로 답했습니다</div>}
      {r.timedOut && <div className="sm-warn">시간이 다 돼 조사를 다 하지 못했습니다</div>}
      <div className="rp-meta">
        {r.model} · 조사 {qtyText(toolLog.length, "회")} · {sec(totalMs)}
        {isAdmin && r.usage && <> · 약 {usd(r.usage.estUsd)}{r.usage.estNote ? ` (${r.usage.estNote})` : ""}</>}
      </div>
    </div>
  );
}

// 평문 답(조사 없음) — 되묻기·확인·설명. 비서의 말 그대로 보여 준다.
function ChatView({ text }: { text: string }) {
  return <section className="b2b-card rp-chat"><p className="rp-chat-text">{text}</p></section>;
}

// 되물음 카드 — 비서가 조사 전에 한 가지를 묻는다. 선택지를 누르면 그 글이 답으로 보내지고, 직접 쓰려면 아래 질문칸에 적는다.
//  이미 답한 되물음(마지막 턴이 아님)은 선택지를 잠근다.
function ClarifyView({ result, answered, disabled, onPick }: { result: AskResult; answered: boolean; disabled: boolean; onPick: (text: string) => void }) {
  const options = result.clarify?.options || [];
  return (
    <section className={`b2b-card rp-clarify ${answered ? "is-answered" : ""}`}>
      <p className="rp-clarify-q">{result.answer}</p>
      {options.length > 0 && (
        <div className="rp-clarify-options">
          {options.map((o) => (
            <button key={o} type="button" className="b2b-btn-secondary" disabled={disabled || answered} onClick={() => onPick(o)}>{o}</button>
          ))}
        </div>
      )}
      {!answered && <div className="rp-clarify-hint">선택지에 없으면 아래 질문칸에 적어 보내세요</div>}
    </section>
  );
}

export default function ReportPage() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [qErr, setQErr] = useState(""); // 질문 칸 검증 오류
  const [saveErr, setSaveErr] = useState<{ name?: string; sql?: string }>({}); // 저장 다이얼로그 칸별 오류
  const confirmModal = useConfirm();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [pendingQ, setPendingQ] = useState("");
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveSql, setSaveSql] = useState("");
  const [saveCtx, setSaveCtx] = useState<SaveCtx | null>(null);
  const [varForm, setVarForm] = useState<{ rep: Saved; values: Record<string, string> } | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);      // 저장 리스트 기본 접힘
  const [me, setMe] = useState<string | null>(null);       // 현재 로그인 사용자(저장자 매칭·비용 표시)
  const [savedFilter, setSavedFilter] = useState<"mine" | "all">("mine");
  const isAdmin = me === "현석" || me === "관리자"; // AppSidebar 와 같은 판정

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

  async function ask(question: string) {
    const qq = question.trim();
    if (loading) return;
    if (!qq) { setQErr("질문을 입력하세요"); return; }
    setQErr("");
    const history = turns.slice(-8).map((t) => ({ q: t.q, answer: t.result.answer, kind: t.result.kind || "answer" }));
    setLoading(true); setErr(""); setVarForm(null); setRunResult(null); setProgress([]); setPendingQ(qq);
    try {
      const r = await fetch("/api/report/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: qq, history }) });
      if (!r.ok || !r.body) {
        let msg = `서버 응답 ${r.status}`;
        try { const t = await r.text(); try { const j = JSON.parse(t); msg = j.error || msg; } catch { if (t) msg = t.slice(0, 200); } } catch { /* noop */ }
        throw new Error(msg);
      }
      const got: { result: AskResult | null; error: string } = { result: null, error: "" };
      await readNdjson(r.body, (obj) => {
        if (obj.type === "progress") setProgress((p) => [...p, { name: String(obj.name || ""), label: String(obj.label || obj.name || ""), ms: Number(obj.ms) || 0 }]);
        else if (obj.type === "done") got.result = (obj.result as AskResult) || null;
        else if (obj.type === "error") got.error = String(obj.error || "");
      });
      if (got.error) throw new Error(got.error);
      const result = got.result;
      if (!result || typeof result.answer !== "string") throw new Error("답이 오지 않았습니다");
      setTurns((t) => [...t, { q: qq, result }]);
      setQ("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); setProgress([]); setPendingQ(""); }
  }

  function newThread() { setTurns([]); setErr(""); setVarForm(null); setRunResult(null); setQ(""); setQErr(""); }

  function startSaved(rep: Saved) {
    const vars = extractVars(rep.sql);
    if (vars.length) setVarForm({ rep, values: Object.fromEntries(vars.map((v) => [v, ""])) });
    else runSql(rep, rep.sql);
  }
  async function runSql(rep: Saved, sql: string) {
    if (loading) return;
    setLoading(true); setErr(""); setVarForm(null); setRunResult(null);
    try {
      const r = await fetch("/api/report/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "리포트를 실행하지 못했습니다. SQL 을 확인하세요"); return; }
      setRunResult({ rep, sql, rows: j.rows || [], columns: j.columns || [] });
    } catch (e) { setErr(e instanceof Error ? e.message : "리포트를 실행하지 못했습니다. SQL 을 확인하세요"); }
    finally { setLoading(false); }
  }
  async function delSaved(id: string) {
    await fetch(`/api/report/saved?id=${id}`, { method: "DELETE" }); loadSaved();
  }
  function openSave(ctx: SaveCtx) {
    setSaveErr({}); setSaveCtx(ctx); setSaveName(ctx.question.slice(0, 40)); setSaveSql(ctx.sql); setSaveOpen(true);
  }
  async function doSave() {
    const fe: { name?: string; sql?: string } = {};
    if (!saveName.trim()) fe.name = "이름을 입력하세요";
    if (!saveSql.trim()) fe.sql = "SQL 을 입력하세요";
    setSaveErr(fe);
    if (fe.name || fe.sql) return;
    const r = await fetch("/api/report/saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: saveName.trim(), question: saveCtx?.question || "", sql: saveSql, chart: saveCtx?.chart || { type: "none" }, looker: saveCtx?.looker || { mode: "na" } }) });
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "리포트를 저장하지 못했습니다. 이름과 SQL 을 확인하세요"); return; }
    setSaveOpen(false); loadSaved();
  }

  async function exportXlsx(sql: string, title: string) {
    const r = await fetch("/api/report/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql, title }) });
    if (!r.ok) { setErr("엑셀을 내려받지 못했습니다. 결과를 다시 조회하세요"); return; }
    const blob = await r.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "report.xlsx"; a.click(); URL.revokeObjectURL(url);
  }
  function askFollowup(text: string) { setQ(text); ask(text); }

  const hasAnything = turns.length > 0 || !!runResult || loading || !!err;
  const lastKind = turns.length > 0 ? (turns[turns.length - 1].result.kind || "answer") : "answer";
  const awaitingReply = !loading && lastKind !== "answer"; // 직전 턴이 되물음·평문 → 다음 입력은 그 답(대화 이어가기)

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
                <div key={s.id} className="rp-saved-item" onClick={() => { if (!loading) startSaved(s); }} title="클릭하면 실행">
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

      {/* 빈 상태 — 예시 질문 3개(정량·정성·혼합), 설명문 없음. 질문칸은 대화 아래(채팅 꼴, 2026-10-19) */}
      {!hasAnything && (
        <div className="rp-examples">
          {EXAMPLES.map((ex) => <button key={ex} type="button" className="b2b-btn-secondary" onClick={() => askFollowup(ex)}>{ex}</button>)}
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
            <button className="b2b-btn-primary" disabled={loading} onClick={() => runSql(varForm.rep, fillVars(varForm.rep.sql, varForm.values))}>리포트 실행</button>
            <button className="b2b-btn-secondary" onClick={() => setVarForm(null)}>닫기</button>
          </div>
        </section>
      )}

      {/* 대화 — 이전 답들이 위에 쌓인다 */}
      {turns.length > 0 && (
        <div className="rp-turns">
          {turns.map((t, i) => (
            <div key={i} className="rp-turn">
              <div className="rp-turn-q">{t.q}</div>
              {t.result.kind === "clarify" ? (
                <ClarifyView result={t.result} answered={i < turns.length - 1} disabled={loading} onPick={askFollowup} />
              ) : t.result.kind === "chat" ? (
                <ChatView text={t.result.answer} />
              ) : (
                <AnswerView turn={t} isAdmin={isAdmin} disabled={loading} onFollowup={askFollowup} onSave={openSave} onExport={exportXlsx} />
              )}
            </div>
          ))}
        </div>
      )}

      {err && (
        <div className="b2b-error rp-error">
          <div>답을 만들지 못했습니다. {err}</div>
          <div>질문을 바꿔 다시 물어보세요</div>
        </div>
      )}

      {/* 진행 표시 — 도구 호출마다 한 줄, 스피너 없음 */}
      {loading && pendingQ && (
        <div className="rp-turn">
          <div className="rp-turn-q">{pendingQ}</div>
          <section className="b2b-card rp-progress">
            <div className="b2b-card-head"><span className="b2b-card-title">조사 중</span></div>
            <ul className="rp-progress-list">
              {progress.map((p, i) => <li key={i}>{p.label} · {sec(p.ms)}</li>)}
              {progress.length === 0 && <li>질문을 읽는 중</li>}
            </ul>
          </section>
        </div>
      )}
      {loading && !pendingQ && <div className="b2b-loading">리포트를 실행하는 중...</div>}

      {/* 저장 리포트 실행 결과 — 표 카드(기본 펼침) */}
      {runResult && (
        <div className="rp-turn">
          <TableCard
            table={{ title: runResult.rep.name, sql: runResult.sql, columns: runResult.columns, rows: runResult.rows, rowCount: runResult.rows.length, truncated: runResult.rows.length >= 5000, looker: runResult.rep.looker }}
            question={runResult.rep.question || runResult.rep.name} defaultOpen onSave={openSave} onExport={exportXlsx} />
        </div>
      )}

      {/* 질문 입력 — 대화 아래(채팅 꼴). Enter = 보내기, Shift+Enter = 줄바꿈. 직전 턴이 되물음이면 [답하기] */}
      <div className="rp-composer">
        {awaitingReply && <div className="rp-composer-note">{lastKind === "clarify" ? "위 선택지를 누르거나 여기에 답을 적어 보내세요." : "이어서 답하거나 물어보세요."}</div>}
        <div className="rp-ask">
          <textarea className="b2b-input rp-input" rows={2} value={q} aria-label={awaitingReply ? "되물음에 답" : "질문"}
            placeholder={awaitingReply ? "답을 적어 보내세요. 예: 이번 달" : "예: 10월 채널별 매출과 톡스토어가 빠진 이유"}
            aria-invalid={qErr ? "true" : undefined}
            onChange={(e) => { setQ(e.target.value); if (qErr) setQErr(""); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(q); } }} />
          <div className="rp-ask-actions">
            <button className="b2b-btn-primary" onClick={() => ask(q)} disabled={loading}>{loading ? "조사 중..." : awaitingReply ? "답하기" : "질문하기"}</button>
            {hasAnything && <button className="b2b-btn-secondary" onClick={newThread} disabled={loading}>새 질문</button>}
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

      {/* 루커스튜디오 적용 가이드 (하단 상시 참고) */}
      <section className="rp-guide">
        <button className="rp-guide-head" onClick={() => setGuideOpen((v) => !v)}>
          <span>루커스튜디오(데이터 스튜디오)에 적용하는 법</span>
          <span className="rp-guide-chev">{guideOpen ? "▾" : "▸"}</span>
        </button>
        {guideOpen && (
          <div className="rp-guide-body">
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
                <li>복사한 <code>create view ... ; grant ... to looker_ro;</code> 를 <b>Supabase 대시보드 → SQL Editor</b> 에 붙여넣고 <b>Run</b></li>
                <li>루커스튜디오 → <b>데이터 추가</b> → 아래 접속정보 → <b>테이블 목록에서 새 뷰 선택</b><br /><span className="sm-faint">(이미 데이터소스가 있으면: 데이터소스 편집 → 우측 상단 <b>필드 새로고침</b>)</span></li>
                <li>차트에 연결</li>
              </ol>
            </div>
            <div className="rp-guide-block">
              <div className="rp-guide-title">PostgreSQL 접속정보 (커넥터 최초 연결 시)</div>
              <div className="b2b-table-wrap">
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
              </div>
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
