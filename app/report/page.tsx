"use client";

// AI 데이터 비서 — 대화형(2026-10-19 대표 결정 "클로드 웹처럼"). 스레드는 서버(report_threads)에 저장되어 다시 열 수 있다.
//  비서가 글로 말하고(스트리밍), 조사가 필요하면 중간에 도구를 쓰며(도구 칩), run_sql 결과는 그 자리에 표 카드로 끼어든다.
//  개선안(2026-10-19): 1 회사 용어 사전(비서 제안 → [사전에 저장], 용어 사전 표) · 3 저장 리포트 정기 받기(매일·매주·매월 메일) + 표 카드 차트
//  · 5 답마다 데이터 최신일·숫자 대조 배지·[맞아요]/[틀려요] 피드백.
//  표 카드의 [SQL 보기]·[리포트 저장]·[엑셀 내려받기]·루커 SQL, 저장된 리포트(변수 치환·실행), 루커 가이드는 그대로.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { BarList } from "@/app/components/charts";
import { qty, qtyText, dateFull } from "@/app/lib/format";
import LookerGuide from "./LookerGuide";

type Chart = { type: "bar" | "line" | "pie" | "none"; x?: string; series?: string[]; note?: string };
type Looker = { mode: "query" | "view" | "na"; sql?: string; note?: string };
type Row = Record<string, unknown>;
type ScheduleFreq = "daily" | "weekly" | "monthly";
type Schedule = { freq: ScheduleFreq; to: string[]; lastSentOn?: string; setBy?: string | null };
type Saved = { id: string; name: string; question: string; sql: string; chart: Chart; looker: Looker; createdAt: string; createdBy?: string | null; schedule?: Schedule | null };
type Glossary = { id: string; term: string; definition: string; createdBy: string | null; updatedBy: string | null; updatedAt: string };
type AskTable = { title: string; sql: string; columns: string[]; rows: Row[]; rowCount: number; truncated: boolean; looker?: Looker };
// /api/report/chat 계약(chat-assistant.ts) — 화면은 이 모양만 믿는다
type ChatTable = AskTable & { id: string; toolUseId: string };
type Meta = { model: string; estUsd: number; estNote: string; elapsedMs: number; downgraded: boolean; timedOut: boolean; seq: number | null; dataDate: string | null };
type Item =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; live?: boolean; meta?: Meta; fb?: "ok" | "ng" }
  | { role: "tool"; toolUseId: string; name: string; label: string; ok: boolean | null; ms?: number; table?: ChatTable }
  | { role: "term"; toolUseId: string; term: string; definition: string; state?: "saved" | "skipped" };
type Thread = { id: string; title: string; createdBy: string; createdAt: string; updatedAt: string; estUsd: number };
type RunResult = { rep: Saved; sql: string; columns: string[]; rows: Row[] };
type SaveCtx = { question: string; sql: string; looker?: Looker; chart?: Chart };

const TABLE_ROW_LIMIT = 1000;
const RESERVED_VARS = ["시작일", "종료일"];
const SCHEDULE_ENABLED = false; // 정기 받기(개선안 3) — 2026-10-19 대표 "배포 보류, 베타에서도 숨김". 코드는 두고 화면·API·크론을 모두 끈다(report-schedule.ts 와 같은 플래그)
const FREQ_LABEL: Record<ScheduleFreq, string> = { daily: "매일", weekly: "매주 월요일", monthly: "매월 1일" };

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
const unresolvedVars = (sql: string) => extractVars(sql).filter((v) => !RESERVED_VARS.includes(v));
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

// 숫자 대조(개선안 5) — 비서 글의 숫자(세 자리 이상·쉼표 숫자)가 이번 턴 표의 값에 있는지. 날짜·년월일은 뺀다.
function numberCheck(text: string, tables: AskTable[]): { total: number; miss: string[] } {
  if (!tables.length) return { total: 0, miss: [] };
  const cleaned = text.replace(/\d{4}-\d{2}-\d{2}/g, " ").replace(/\d+(?:년|월|일|시|분|회차|차)/g, " ");
  const nums = [...new Set([...cleaned.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{3,}(?:\.\d+)?/g)].map((m) => m[0]))];
  if (!nums.length) return { total: 0, miss: [] };
  const pool = new Set<string>();
  for (const t of tables) for (const r of t.rows) for (const v of Object.values(r)) {
    if (typeof v === "number") { pool.add(String(v)); pool.add(String(Math.round(v))); pool.add(v.toLocaleString("ko-KR")); pool.add(Math.round(v).toLocaleString("ko-KR")); }
    else if (typeof v === "string") { const s = v.replace(/,/g, ""); if (/^-?\d+(\.\d+)?$/.test(s)) { pool.add(s); pool.add(Number(s).toLocaleString("ko-KR")); } }
  }
  const miss = nums.filter((n) => !pool.has(n) && !pool.has(n.replace(/,/g, "")));
  return { total: nums.length, miss };
}

/** 표 카드 — 접힌 머리줄 "제목 · N행", 펼치면 표 + [차트] + [SQL 보기] + 루커 SQL. 저장 리포트 실행 결과도 같은 카드(기본 펼침) */
function TableCard({ table, question, defaultOpen, onSave, onExport }: {
  table: AskTable; question: string; defaultOpen?: boolean;
  onSave: (ctx: SaveCtx) => void; onExport: (sql: string, title: string) => void;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [showSql, setShowSql] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [copied, setCopied] = useState("");
  const copy = (text: string, tag: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(tag); setTimeout(() => setCopied(""), 1500); }); };
  const rows = table.rows || [];
  const cols = table.columns || [];
  const isNum = (c: string) => typeof rows[0]?.[c] === "number";
  const looker = table.looker;
  // 차트(개선안 3) — 첫 열이 글자·날짜이고 숫자 열이 있는 2~40행 표만. 첫 숫자 열을 막대로.
  const labelCol = cols.find((c) => !isNum(c));
  const numCol = cols.find((c) => isNum(c));
  const chartable = rows.length >= 2 && rows.length <= 40 && !!labelCol && !!numCol;
  const chartData = useMemo<[string, number][]>(() => (chartable ? rows.map((r) => [fmt(r[labelCol!]), Number(r[numCol!]) || 0]) : []), [chartable, rows, labelCol, numCol]);
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
            {chartable && <button type="button" className="b2b-link-btn" onClick={() => setShowChart((v) => !v)}>{showChart ? "차트 닫기" : "차트 보기"}</button>}
            <button type="button" className="b2b-link-btn" onClick={() => setShowSql((v) => !v)}>{showSql ? "SQL 닫기" : "SQL 보기"}</button>
          </div>
          {showChart && chartable && <div className="rp-chart"><BarList title={`${numCol} — ${labelCol}별`} data={chartData} fmt={(n) => n.toLocaleString("ko-KR")} /></div>}
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
  // 모델 선택(2026-10-19 대표: "쉬운 계산도 Fable 은 좀 늦다") — "" = AI 설정의 기본 모델. 브라우저에 기억(per-viewer 편의)
  const [modelKey, setModelKey] = useState<"" | "fable" | "opus" | "sonnet">("");
  useEffect(() => { try { const v = localStorage.getItem("rp_model"); if (v === "fable" || v === "opus" || v === "sonnet") setModelKey(v); } catch { /* 저장소 없음 */ } }, []);
  function pickModel(v: string) { const k = v === "fable" || v === "opus" || v === "sonnet" ? v : ""; setModelKey(k); try { if (k) localStorage.setItem("rp_model", k); else localStorage.removeItem("rp_model"); } catch { /* noop */ } }
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
  // 정기 받기(개선안 3)
  const [schedFor, setSchedFor] = useState<Saved | null>(null);
  const [schedFreq, setSchedFreq] = useState<ScheduleFreq>("weekly");
  const [schedTo, setSchedTo] = useState("");
  const [schedErr, setSchedErr] = useState("");
  const [schedBusy, setSchedBusy] = useState("");
  // 용어 사전(개선안 1)
  const [glossary, setGlossary] = useState<Glossary[]>([]);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [gEdit, setGEdit] = useState<{ id: string; term: string; definition: string } | null>(null);
  const [gNew, setGNew] = useState({ term: "", definition: "" });
  const [gErr, setGErr] = useState("");
  // 피드백(개선안 5)
  const [fbNoteFor, setFbNoteFor] = useState<number | null>(null);
  const [fbNote, setFbNote] = useState("");
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
  const loadGlossary = useCallback(async () => {
    try { const j = await (await fetch("/api/report/glossary", { cache: "no-store" })).json(); if (j.ok) setGlossary(j.terms || []); } catch { /* noop */ }
  }, []);
  useEffect(() => { loadSaved(); loadThreads(); loadGlossary(); }, [loadSaved, loadThreads, loadGlossary]);
  useEffect(() => { (async () => { try { const j = await (await fetch("/api/b2b/auth", { cache: "no-store" })).json(); if (j.ok) setMe(j.name); } catch { /* noop */ } })(); }, []);
  // 대화 박스 안에서만 맨 아래로(페이지 전체를 움직이지 않는다). 글자가 흘러올 때도 따라간다.
  const threadRef = useRef<HTMLDivElement>(null);
  const lastText = items.length ? (items[items.length - 1] as { text?: string }).text : "";
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [items.length, loading, lastText]);

  const filteredSaved = useMemo(
    () => (savedFilter === "all" || !me ? saved : saved.filter((s) => s.createdBy === me)),
    [saved, savedFilter, me],
  );
  const lastUserText = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (it.role === "user") return it.text; } return ""; }, [items]);

  function newThread() { if (loading) return; setThreadId(null); setItems([]); setErr(""); setVarForm(null); setRunResult(null); setQ(""); setQErr(""); setFbNoteFor(null); }

  async function openThread(id: string) {
    if (loading) return;
    setBusy(true); setErr(""); setVarForm(null); setRunResult(null); setFbNoteFor(null);
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

  // 한 턴 — 스레드가 없으면 먼저 만든다. 글자는 흘러오고, 도구 칩·표 카드·용어 제안은 그 자리에 끼어든다.
  async function send(text: string) {
    const tt = text.trim();
    if (loading || busy) return;
    if (!tt) { setQErr("메시지를 입력하세요"); return; }
    setQErr(""); setErr(""); setVarForm(null); setRunResult(null); setFbNoteFor(null);
    setLoading(true);
    let id = threadId;
    const unlive = (it: Item[]) => it.map((x) => (x.role === "assistant" && x.live ? { ...x, live: false } : x));
    try {
      if (!id) {
        const j = await (await fetch("/api/report/chat/threads", { method: "POST" })).json();
        if (!j.ok) throw new Error(j.error || "새 대화를 만들지 못했습니다");
        id = j.thread.id as string; setThreadId(id);
      }
      setItems((it) => [...it, { role: "user", text: tt }]);
      setQ("");
      const r = await fetch(`/api/report/chat/threads/${id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: tt, model: modelKey || undefined }) });
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
            if (idx < 0) return [...unlive(it), { role: "tool", toolUseId, name: String(obj.name || ""), label: String(obj.label || ""), ok: null }];
            const cur = it[idx];
            if (cur.role !== "tool") return it;
            return [...it.slice(0, idx), { ...cur, ok: status === "ok" ? true : status === "fail" ? false : cur.ok, ms: typeof obj.ms === "number" ? obj.ms : cur.ms }, ...it.slice(idx + 1)];
          });
        } else if (type === "table") {
          const table = obj.table as ChatTable;
          setItems((it) => it.map((x) => (x.role === "tool" && x.toolUseId === table.toolUseId ? { ...x, table } : x)));
        } else if (type === "term") {
          setItems((it) => [...unlive(it), { role: "term", toolUseId: String(obj.toolUseId || ""), term: String(obj.term || ""), definition: String(obj.definition || "") }]);
        } else if (type === "done") {
          const usage = (obj.usage || {}) as { estUsd?: number; estNote?: string };
          setItems((it) => {
            const idx = [...it].reverse().findIndex((x) => x.role === "assistant");
            if (idx < 0) return it;
            const i = it.length - 1 - idx;
            const cur = it[i];
            if (cur.role !== "assistant") return it;
            const meta: Meta = { model: String(obj.model || ""), estUsd: Number(usage.estUsd) || 0, estNote: String(usage.estNote || ""), elapsedMs: Number(obj.elapsedMs) || 0, downgraded: !!obj.downgraded, timedOut: !!obj.timedOut, seq: typeof obj.seq === "number" ? obj.seq : null, dataDate: typeof obj.dataDate === "string" ? obj.dataDate : null };
            return [...it.slice(0, i), { ...cur, live: false, meta }, ...it.slice(i + 1)];
          });
        } else if (type === "error") errText = String(obj.error || "");
      });
      if (errText) throw new Error(errText);
      loadThreads();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setItems((it) => unlive(it));
    }
  }

  // ── 용어 사전 ──
  async function saveTerm(term: string, definition: string, id?: string): Promise<boolean> {
    setGErr("");
    const r = await fetch("/api/report/glossary", { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, term, definition }) });
    const j = await r.json();
    if (!j.ok) { setGErr(j.error || "용어를 저장하지 못했습니다"); toast.error(j.error || "용어를 저장하지 못했습니다"); return false; }
    toast.success(`'${term}'을 용어 사전에 저장했습니다`);
    loadGlossary();
    return true;
  }
  async function acceptTerm(it: Extract<Item, { role: "term" }>) {
    if (await saveTerm(it.term, it.definition)) setItems((list) => list.map((x) => (x.role === "term" && x.toolUseId === it.toolUseId ? { ...x, state: "saved" } : x)));
  }
  async function deleteTerm(g: Glossary) {
    if (!(await confirmModal({ title: `'${g.term}' 용어 지우기`, body: "다음 대화부터 비서가 이 용어를 다시 묻게 됩니다.", action: "용어 지우기" }))) return;
    const j = await (await fetch(`/api/report/glossary?id=${g.id}`, { method: "DELETE" })).json();
    if (!j.ok) { toast.error(j.error || "용어를 지우지 못했습니다"); return; }
    toast.success("용어를 지웠습니다"); loadGlossary();
  }

  // ── 피드백 ──
  async function sendFeedback(i: number, ok: boolean, note?: string) {
    const it = items[i];
    if (!it || it.role !== "assistant" || !threadId) return;
    const j = await (await fetch("/api/report/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId, seq: it.meta?.seq ?? null, ok, note: note || "" }) })).json();
    if (!j.ok) { toast.error(j.error || "피드백을 남기지 못했습니다"); return; }
    setItems((list) => list.map((x, k) => (k === i && x.role === "assistant" ? { ...x, fb: ok ? "ok" : "ng" } : x)));
    setFbNoteFor(null); setFbNote("");
    toast.success("피드백을 남겼습니다");
  }

  // ── 정기 받기 ──
  function openSchedule(rep: Saved) {
    const extra = unresolvedVars(rep.sql);
    if (extra.length) { toast.error(`값을 자동으로 채울 수 없는 변수가 있어 예약할 수 없습니다: ${extra.join(", ")}. {{시작일}}·{{종료일}}만 자동으로 채워집니다`); return; }
    setSchedFor(rep); setSchedFreq(rep.schedule?.freq || "weekly"); setSchedTo((rep.schedule?.to || []).join(", ")); setSchedErr("");
  }
  async function saveSchedule(clear = false) {
    if (!schedFor) return;
    setSchedBusy("save"); setSchedErr("");
    try {
      const to = schedTo.split(",").map((s) => s.trim()).filter(Boolean);
      const j = await (await fetch("/api/report/saved", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: schedFor.id, schedule: clear ? null : { freq: schedFreq, to } }) })).json();
      if (!j.ok) throw new Error(j.error || "정기 발송 설정 실패");
      toast.success(clear ? "정기 발송을 해제했습니다" : `${FREQ_LABEL[schedFreq]} 아침에 받도록 설정했습니다`);
      setSchedFor(null); loadSaved();
    } catch (e) { setSchedErr(e instanceof Error ? e.message : String(e)); }
    finally { setSchedBusy(""); }
  }
  async function sendScheduleNow() {
    if (!schedFor) return;
    setSchedBusy("send"); setSchedErr("");
    try {
      const j = await (await fetch("/api/report/saved", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: schedFor.id, sendNow: true }) })).json();
      if (!j.ok) throw new Error(j.error || "발송 실패");
      toast.success(`메일을 보냈습니다: ${(j.result?.to || []).join(", ")}`);
    } catch (e) { setSchedErr(e instanceof Error ? e.message : String(e)); }
    finally { setSchedBusy(""); }
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
  // 비서 답 i 의 '이번 턴' 표 — 직전 사용자 메시지 뒤의 표 카드들(숫자 대조용)
  const turnTables = (i: number): AskTable[] => {
    let start = 0;
    for (let k = i - 1; k >= 0; k--) if (items[k].role === "user") { start = k; break; }
    const out: AskTable[] = [];
    for (let k = start; k < items.length; k++) { const x = items[k]; if (k > i && x.role === "user") break; if (x.role === "tool" && x.table) out.push(x.table); }
    return out;
  };

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">AI 데이터 비서</h1></div>
      </header>

      {pendingMsg && <div className="b2b-error">{pendingMsg}</div>}

      {/* 저장된 리포트 — 기본 접힘. [정기 받기] 로 매일·매주·매월 메일 */}
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
                  <span className="rp-saved-name">
                    {s.name}{extractVars(s.sql).length ? <span className="rp-saved-var">변수</span> : null}
                    {SCHEDULE_ENABLED && s.schedule && <span className="rp-badge rp-sched">{FREQ_LABEL[s.schedule.freq]}{s.schedule.lastSentOn ? ` · 마지막 ${s.schedule.lastSentOn}` : ""}</span>}
                  </span>
                  {s.question && <div className="rp-saved-q">{s.question}</div>}
                  <div className="rp-saved-meta">
                    <span>저장: {s.createdBy || "—"}</span>
                    <span>·</span>
                    <span>{dateFull(s.createdAt)}</span>
                    {SCHEDULE_ENABLED && <button className="rp-saved-del2" onClick={(e) => { e.stopPropagation(); openSchedule(s); }}>{s.schedule ? "정기 받기 바꾸기" : "정기 받기"}</button>}
                    <button className="rp-saved-del2" onClick={async (e) => { e.stopPropagation(); if (await confirmModal({ title: `'${s.name}' 저장 리포트 삭제`, body: `저장한 질문과 SQL이 지워집니다.${SCHEDULE_ENABLED ? " 정기 발송도 함께 멈춥니다." : ""} 되돌릴 수 없습니다.`, action: "리포트 삭제" })) delSaved(s.id); }}>삭제</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* 저장된 대화 — 저장된 리포트와 같은 접이식 UI(2026-10-19 대표). 내 스레드 최근순, 클릭하면 이어서 */}
      <div className="rp-saved-box">
        <div className="rp-saved-bar">
          <button className="rp-saved-toggle" onClick={() => setThreadsOpen((v) => !v)}>
            <span className="rp-saved-chev">{threadsOpen ? "▾" : "▸"}</span>
            저장된 대화{threads.length > 0 ? ` ${qty(threads.length)}` : ""}
          </button>
        </div>
        {threadsOpen && (threads.length === 0 ? (
          <div className="b2b-empty">저장된 대화가 없습니다. 아래에 질문을 보내면 대화가 저장됩니다.</div>
        ) : (
          <div className="rp-saved-list">
            {threads.map((t) => (
              <div key={t.id} className={`rp-saved-item ${t.id === threadId ? "is-active" : ""}`} onClick={() => { if (!loading) openThread(t.id); }} title="클릭하면 이어서">
                <span className="rp-saved-name">{t.title}</span>
                <div className="rp-saved-meta">
                  <span>{dateFull(t.updatedAt)}</span>
                  {isAdmin && t.createdBy !== me && <><span>·</span><span>{t.createdBy}</span></>}
                  <button className="rp-saved-del2" onClick={(e) => { e.stopPropagation(); deleteThread(t); }}>지우기</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

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

      {/* 대화 — 사용자 글은 오른쪽 말풍선, 비서 글은 왼쪽 평문, 도구 칩·표 카드·용어 제안은 그 자리에 */}
      {items.length > 0 && (
        <div className="rp-thread" ref={threadRef}>
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
            if (it.role === "term") {
              return (
                <div key={it.toolUseId} className="rp-msg rp-msg-ai">
                  <section className="b2b-card rp-term">
                    <div className="rp-term-head">용어 사전에 넣을까요?</div>
                    <div className="rp-term-body"><b>{it.term}</b> = {it.definition}</div>
                    <div className="rp-term-actions">
                      {it.state === "saved" ? <span className="rp-term-done">사전에 저장했습니다. 다음 대화부터 묻지 않습니다</span>
                        : it.state === "skipped" ? <span className="rp-term-done">저장하지 않았습니다</span>
                        : <>
                          <button className="b2b-btn-primary" onClick={() => acceptTerm(it)}>사전에 저장</button>
                          <button className="b2b-btn-secondary" onClick={() => setItems((list) => list.map((x) => (x.role === "term" && x.toolUseId === it.toolUseId ? { ...x, state: "skipped" } : x)))}>이번만</button>
                        </>}
                    </div>
                  </section>
                </div>
              );
            }
            const check = it.meta ? numberCheck(it.text, turnTables(i)) : null;
            return (
              <div key={i} className="rp-msg rp-msg-ai">
                <p className="rp-chat-text">{it.text}{it.live && <span className="rp-cursor" aria-hidden="true">▍</span>}</p>
                {it.meta && (
                  <>
                    <div className="rp-meta">
                      {it.meta.downgraded && <span className="rp-meta-warn">이달 비용 상한을 넘어 빠른 모델로 답했습니다 · </span>}
                      {it.meta.timedOut && <span className="rp-meta-warn">시간이 다 돼 조사를 다 하지 못했습니다 · </span>}
                      {it.meta.dataDate && <>데이터 {it.meta.dataDate}까지 · </>}
                      {check && check.total > 0 && (check.miss.length === 0
                        ? <><span className="rp-badge">숫자 대조 {qty(check.total)}개 일치</span> · </>
                        : <><span className="rp-badge is-warn" title={check.miss.join(", ")}>표에 없는 숫자 {qty(check.miss.length)}개: {check.miss.slice(0, 4).join(", ")}{check.miss.length > 4 ? " …" : ""}</span> · </>)}
                      {it.meta.model} · {sec(it.meta.elapsedMs)}
                      {isAdmin && <> · 약 {usd(it.meta.estUsd)}{it.meta.estNote ? ` (${it.meta.estNote})` : ""}</>}
                    </div>
                    <div className="rp-fb">
                      {it.fb ? <span className="rp-fb-done">{it.fb === "ok" ? "맞아요로 남겼습니다" : "틀려요로 남겼습니다"}</span> : fbNoteFor === i ? (
                        <div className="rp-fb-note">
                          <input className="b2b-input" placeholder="어디가 틀렸나요? (선택)" value={fbNote} onChange={(e) => setFbNote(e.target.value)} aria-label="틀린 이유"
                            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); sendFeedback(i, false, fbNote); } }} />
                          <button className="b2b-btn-secondary" onClick={() => sendFeedback(i, false, fbNote)}>보내기</button>
                          <button className="b2b-link-btn" onClick={() => { setFbNoteFor(null); setFbNote(""); }}>그만두기</button>
                        </div>
                      ) : (
                        <>
                          <button className="b2b-link-btn" onClick={() => sendFeedback(i, true)}>맞아요</button>
                          <button className="b2b-link-btn" onClick={() => { setFbNoteFor(i); setFbNote(""); }}>틀려요</button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {loading && !items.some((x) => x.role === "assistant" && x.live) && <div className="rp-msg rp-msg-ai"><p className="rp-chat-text rp-thinking">읽는 중</p></div>}
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
          <textarea className="b2b-input rp-input" rows={3} value={q} aria-label="메시지"
            placeholder="원하는 정보를 입력해 주세요"
            aria-invalid={qErr ? "true" : undefined}
            onChange={(e) => { setQ(e.target.value); if (qErr) setQErr(""); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(q); } }} />
          <div className="rp-ask-actions">
            <button className="b2b-btn-primary" onClick={() => send(q)} disabled={loading || busy}>{loading ? "답하는 중..." : "보내기"}</button>
            <button className="b2b-btn-secondary" onClick={newThread} disabled={loading || !hasAnything}>새 대화</button>
            <select className="b2b-select rp-model" value={modelKey} onChange={(e) => pickModel(e.target.value)} disabled={loading} aria-label="AI 모델" title="이 대화에 쓸 모델. 쉬운 조회는 빠른 모델이 낫습니다">
              <option value="">모델: 기본(설정)</option>
              <option value="fable">Fable 5.1 · 정밀</option>
              <option value="opus">Opus 5.5 · 빠름</option>
              <option value="sonnet">Sonnet 5.5 · 가장 빠름</option>
            </select>
          </div>
        </div>
        {qErr && <div className="b2b-field-error">{qErr}</div>}
      </div>

      {/* 정기 받기 설정 */}
      {SCHEDULE_ENABLED && schedFor && (
        <div className="rp-modal-bg" onClick={() => setSchedFor(null)}>
          <div className="rp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-card-head"><span className="b2b-card-title">정기 받기 — {schedFor.name}</span></div>
            {schedErr && <div className="b2b-error">{schedErr}</div>}
            <label className="sm-col rp-save-field">
              <span className="b2b-field-label">주기</span>
              <select className="b2b-select" value={schedFreq} onChange={(e) => setSchedFreq(e.target.value as ScheduleFreq)} aria-label="주기">
                <option value="daily">매일 아침 (어제 하루)</option>
                <option value="weekly">매주 월요일 아침 (지난주 월~일)</option>
                <option value="monthly">매월 1일 아침 (지난달)</option>
              </select>
            </label>
            <label className="sm-col rp-save-field">
              <span className="b2b-field-label">받는 사람 <span className="opt">쉼표로 여러 명, 비우면 기본 수신자</span></span>
              <input className="b2b-input" value={schedTo} onChange={(e) => setSchedTo(e.target.value)} placeholder="ceo@seamonster.kr, sales@seamonster.kr" aria-label="받는 사람" />
            </label>
            <p className="sm-faint" style={{ fontSize: 12, margin: "8px 0 0" }}>
              SQL 의 {"{{시작일}}"}·{"{{종료일}}"}은 주기에 맞춰 자동으로 채워집니다{extractVars(schedFor.sql).length ? ` (이 리포트: ${extractVars(schedFor.sql).join(", ")})` : " (이 리포트는 변수 없음 — SQL 에 적힌 기간 그대로)"}. 발송은 아침 6시 무렵입니다.
            </p>
            <div className="rp-modal-foot">
              {schedFor.schedule && <button className="b2b-btn-secondary" onClick={() => saveSchedule(true)} disabled={!!schedBusy}>해제</button>}
              {schedFor.schedule && <button className="b2b-btn-secondary" onClick={sendScheduleNow} disabled={!!schedBusy}>{schedBusy === "send" ? "보내는 중..." : "지금 한 번 보내기"}</button>}
              <button className="b2b-btn-secondary" onClick={() => setSchedFor(null)} disabled={!!schedBusy}>그만두기</button>
              <button className="b2b-btn-primary" onClick={() => saveSchedule(false)} disabled={!!schedBusy}>{schedBusy === "save" ? "저장 중..." : "정기 받기 저장"}</button>
            </div>
          </div>
        </div>
      )}

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
              <span className="b2b-field-label">SQL<span className="req">*</span> <span className="opt"><code>{"{{이름}}"}</code> = 실행 때 입력받는 값{SCHEDULE_ENABLED && <>, <code>{"{{시작일}}"}</code>·<code>{"{{종료일}}"}</code> = 정기 받기 때 자동</>}</span></span>
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

      {/* 회사 용어 사전 — 루커 가이드 아래, 같은 접이식 UI(2026-10-19 대표). 누구나 추가·수정·삭제, 누가 했는지 남는다 */}
      <section className="rp-guide">
        <button className="rp-guide-head" onClick={() => setGlossaryOpen((v) => !v)}>
          <span>회사 용어 사전{glossary.length > 0 ? ` (${glossary.length})` : ""} — 비서가 묻지 않고 쓸 정의</span>
          <span className="rp-guide-chev">{glossaryOpen ? "▾" : "▸"}</span>
        </button>
        {glossaryOpen && (
          <div className="rp-guide-body">
            {gErr && <div className="b2b-error">{gErr}</div>}
            {glossary.length === 0 ? <div className="b2b-empty">아직 정한 용어가 없습니다. 대화에서 비서가 제안하면 [사전에 저장]을 누르거나 아래에 직접 적으세요.</div> : (
              <div className="b2b-table-wrap">
                <table className="b2b-table rp-glossary-table">
                  <thead><tr><th style={{ width: 180 }}>용어</th><th>정의 · 판별 기준</th><th style={{ width: 150 }}>고친 사람</th><th style={{ width: 120 }}></th></tr></thead>
                  <tbody>
                    {glossary.map((g) => gEdit?.id === g.id ? (
                      <tr key={g.id}>
                        <td><input className="b2b-input" value={gEdit.term} onChange={(e) => setGEdit({ ...gEdit, term: e.target.value })} aria-label="용어" /></td>
                        <td><input className="b2b-input" value={gEdit.definition} onChange={(e) => setGEdit({ ...gEdit, definition: e.target.value })} aria-label="정의" /></td>
                        <td>{g.updatedBy || g.createdBy || "—"}</td>
                        <td>
                          <button className="b2b-link-btn" onClick={async () => { if (await saveTerm(gEdit.term, gEdit.definition, g.id)) setGEdit(null); }}>저장</button>
                          <button className="b2b-link-btn" onClick={() => setGEdit(null)}>그만두기</button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={g.id}>
                        <td><b>{g.term}</b></td>
                        <td className="rp-glossary-def">{g.definition}</td>
                        <td>{g.updatedBy || g.createdBy || "—"} <span className="sm-faint">{String(g.updatedAt).slice(0, 10)}</span></td>
                        <td>
                          <button className="b2b-link-btn" onClick={() => setGEdit({ id: g.id, term: g.term, definition: g.definition })}>고치기</button>
                          <button className="b2b-link-btn" onClick={() => deleteTerm(g)}>지우기</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="rp-glossary-add">
              <input className="b2b-input" placeholder="용어 (예: 합배송)" value={gNew.term} onChange={(e) => setGNew({ ...gNew, term: e.target.value })} aria-label="새 용어" />
              <input className="b2b-input" placeholder="정의 · 판별 기준 (예: 한 주문번호에 상품 2줄 이상인 주문)" value={gNew.definition} onChange={(e) => setGNew({ ...gNew, definition: e.target.value })} aria-label="새 정의" />
              <button className="b2b-btn-secondary" onClick={async () => { if (await saveTerm(gNew.term, gNew.definition)) setGNew({ term: "", definition: "" }); }}>용어 추가</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
