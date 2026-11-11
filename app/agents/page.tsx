"use client";

// AI 에이전트 — 에이전트마다 보고서가 쌓이는 화면.
//  위 탭 = 에이전트, 실행 줄 = 버전 고르기 + 덧붙일 말 + [보고서 작성], 아래 = 보고서 목록(최신순, 버전 탭으로 거르기).
//  에이전트·버전 목록은 app/lib/agents/registry.ts — 새 에이전트·새 버전은 거기 한 줄이면 이 화면에 나타난다.
//  에이전트는 요청서를 만들지 못한다. 보고서의 제안 수량을 사람이 확인·수정해 [도매 생산 요청서 만들기]를 눌러야 요청서가 생긴다.
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { AGENTS, agentOf, latestVersion, type AgentMeta, type AgentReport, type DraftItem } from "@/app/lib/agents/registry";
import { qty, dateTime } from "@/app/lib/format";

const POLL_MS = 5000; // '작성 중'인 보고서가 있을 때만 그 한 장을 다시 읽는다

// 본문 마크다운 — 에이전트 지침이 '## 제목 · - 목록 · **굵게**' 만 쓰게 돼 있다
const bold = (t: string, k: string): ReactNode[] => t.split(/\*\*(.+?)\*\*/g).map((seg, i) => (i % 2 ? <strong key={`${k}-${i}`}>{seg}</strong> : seg));
function Md({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = (k: number) => { if (list.length) { out.push(<ul key={`u${k}`}>{list.map((l, i) => <li key={i}>{bold(l, `l${k}-${i}`)}</li>)}</ul>); list = []; } };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) { list.push(line.replace(/^[-*]\s+/, "")); return; }
    flush(i);
    if (!line) return;
    if (/^#{1,4}\s+/.test(line)) out.push(<h3 key={i}>{line.replace(/^#{1,4}\s+/, "")}</h3>);
    else out.push(<p key={i}>{bold(line, `p${i}`)}</p>);
  });
  flush(-1);
  return <div className="ag-md">{out}</div>;
}

const Pill = ({ tone, children }: { tone: "muted" | "danger" | "success"; children: ReactNode }) => {
  const c = tone === "danger" ? { background: "var(--sm-danger-bg)", color: "var(--sm-danger)" }
    : tone === "success" ? { background: "var(--sm-success-bg)", color: "var(--sm-success)" }
    : { background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" };
  return <span className="b2b-status-pill" style={c}>{children}</span>;
};
const num = (v: number | null | undefined) => (v == null ? "-" : qty(v));
const secs = (ms: number | undefined) => (ms == null ? "" : ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초` : `${Math.round(ms / 1000)}초`);

type CardProps = {
  r: AgentReport; agent: AgentMeta; open: boolean; isAdmin: boolean;
  onToggle: () => void; onChange: (r: AgentReport) => void; onRemove: (id: string) => void;
};
function ReportCard({ r, agent, open, isAdmin, onToggle, onChange, onRemove }: CardProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [qtys, setQtys] = useState<Record<string, string>>(() => Object.fromEntries(r.draft.map((d) => [d.sku, String(d.qty)])));
  const [due, setDue] = useState(r.facts?.due_date || "");
  const [feedback, setFeedback] = useState(r.feedback || "");
  const [busy, setBusy] = useState<"" | "apply" | "feedback" | "remove">("");
  const [err, setErr] = useState("");
  // 작성 중이던 보고서가 끝나 제안이 들어오면 입력값을 그 수량으로 맞춘다
  const draftKey = r.draft.map((d) => `${d.sku}:${d.qty}`).join("|");
  useEffect(() => {
    setQtys(Object.fromEntries(r.draft.map((d) => [d.sku, String(d.qty)])));
    setDue(r.facts?.due_date || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  useEffect(() => { setFeedback(r.feedback || ""); }, [r.feedback]);

  const picked = r.draft.filter((d) => d.product_id && (Number(qtys[d.sku]) || 0) > 0);
  const appliedBySku = useMemo(() => new Map((r.applied || []).map((a) => [a.sku, a])), [r.applied]);
  const kept = r.applied ? r.applied.filter((a) => a.draft_qty != null && a.draft_qty === a.qty).length : 0;

  const apply = async () => {
    setErr("");
    if (!picked.length) { setErr("요청할 품목의 수량을 1개 이상 입력하세요."); return; }
    if (!(await confirm({ title: `${agent.output} 만들기`, body: `품목 ${picked.length}종을 '확정 필요' 상태의 요청서로 만들고 팀즈에 알립니다.`, action: "요청서 만들기", danger: false }))) return;
    setBusy("apply");
    try {
      const j = await (await fetch(`/api/agents/reports/${r.id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: picked.map((d) => ({ sku: d.sku, qty: Number(qtys[d.sku]) })), due_date: due || undefined }) })).json();
      if (!j.ok) throw new Error(j.error);
      onChange(j.report);
      toast.success(`요청서 ${j.request_no || ""}를 만들었습니다`);
    } catch (e) { setErr(e instanceof Error ? e.message : "요청서를 만들지 못했습니다."); }
    finally { setBusy(""); }
  };
  const saveFeedback = async () => {
    setBusy("feedback");
    try {
      const j = await (await fetch(`/api/agents/reports/${r.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback }) })).json();
      if (!j.ok) throw new Error(j.error);
      onChange(j.report);
      toast.success("평가를 저장했습니다");
    } catch (e) { toast.error(e instanceof Error ? e.message : "평가를 저장하지 못했습니다."); }
    finally { setBusy(""); }
  };
  const remove = async () => {
    if (!(await confirm({ title: "보고서 삭제", body: "이 보고서와 평가가 지워집니다. 되돌릴 수 없습니다.", action: "보고서 삭제" }))) return;
    setBusy("remove");
    try {
      const j = await (await fetch(`/api/agents/reports/${r.id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error);
      onRemove(r.id);
    } catch (e) { toast.error(e instanceof Error ? e.message : "보고서를 지우지 못했습니다."); setBusy(""); }
  };

  const running = r.status === "running";
  const failed = r.status === "error";
  const canRemove = !running && !r.request_id && (failed || isAdmin);
  return (
    <article className="ag-card">
      <button type="button" className="ag-card-head" onClick={onToggle} aria-expanded={open}>
        <div className="ag-meta">
          <span className="ag-meta-time">{dateTime(r.created_at)}</span>
          <Pill tone="muted">{r.version}</Pill>
          {r.created_by && <span>{r.created_by}</span>}
          {running && <Pill tone="muted">작성 중</Pill>}
          {failed && <Pill tone="danger">실패</Pill>}
          {r.status === "done" && (r.request_id || r.request_no
            ? <Pill tone="success">요청서 {r.request_no || "만듦"}</Pill>
            : <Pill tone="muted">제안 {r.draft.length}종</Pill>)}
          {r.feedback && <Pill tone="muted">평가 있음</Pill>}
          <span className="ag-meta-fold">{open ? "접기" : "펼치기"}</span>
        </div>
        <div className={`ag-summary ${running || failed ? "is-muted" : ""}`}>
          {running ? "보고서를 작성하고 있습니다. 보통 1~3분 걸립니다." : failed ? (r.error || "작성하지 못했습니다.") : (r.summary || "요약 없음")}
        </div>
      </button>

      {open && !running && (
        <div className="ag-body">
          {r.instruction && <div className="ag-note"><strong>덧붙인 말</strong> {r.instruction}</div>}
          {!!r.facts?.warnings?.length && <div className="sm-warn"><ul>{r.facts.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}

          {r.status === "done" && (
            <section>
              <div className="ag-sec-title">제안 품목</div>
              {r.draft.length === 0 ? <div className="b2b-empty">제안한 품목이 없습니다.</div> : (
                <>
                  <div className="b2b-table-wrap">
                    <table className="b2b-table ag-table">
                      <thead>
                        <tr>
                          <th>품목</th><th className="num">도매 재고</th><th className="num">하루 출고</th><th className="num">버티는 날</th>
                          <th className="num">이미 요청</th><th className="num">소매 여유</th><th className="num">수식 권장</th><th className="num">제안</th>
                          <th className="num">{r.applied ? "확정" : "요청 수량"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.draft.map((d: DraftItem) => {
                          const a = appliedBySku.get(d.sku);
                          return (
                            <Fragment key={d.sku}>
                            <tr className="ag-item-row">
                              <td className="ag-item">
                                <span className="ag-item-name">{d.name}{d.spec ? ` · ${d.spec}` : ""}</span>{d.urgent && <> <Pill tone="danger">급함</Pill></>}
                                <span className="ag-item-sku">{d.sku}</span>
                              </td>
                              <td className="num">{num(d.wholesale_stock)}</td>
                              <td className="num">{num(d.daily_out)}</td>
                              <td className="num">{d.days_left == null ? "-" : `${qty(d.days_left)}일`}</td>
                              <td className="num">{num(d.open_req)}</td>
                              <td className="num">{num(d.retail_spare)}</td>
                              <td className="num">{num(d.formula)}</td>
                              <td className="num">{num(d.qty)}</td>
                              <td className="num">
                                {r.applied
                                  ? (a ? <>{num(a.qty)}{a.qty !== d.qty && <span className="ag-changed">수정됨</span>}</> : <span className="sm-muted">제외</span>)
                                  : <input className="b2b-input ag-qty" inputMode="decimal" value={qtys[d.sku] ?? ""} aria-label={`${d.name} 요청 수량`} disabled={!d.product_id}
                                      onChange={(e) => setQtys((m) => ({ ...m, [d.sku]: e.target.value.replace(/[^0-9.]/g, "") }))} />}
                              </td>
                            </tr>
                            <tr className="ag-reason-row"><td colSpan={9}>{d.reason}</td></tr>
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {r.applied ? (
                    <div className="sm-success" style={{ marginTop: "var(--sm-space-3)" }}>
                      요청서 {r.request_no || ""}로 만들었습니다. 제안 {r.draft.length}종 중 {kept}종을 그대로 확정했습니다.{" "}
                      <Link href="/production/request" className="sm-link">생산 요청 열기</Link>
                    </div>
                  ) : (
                    <>
                      {err && <div className="b2b-error" style={{ marginTop: "var(--sm-space-3)" }}>{err}</div>}
                      <div className="ag-apply">
                        <label className="b2b-field-label" htmlFor={`due-${r.id}`}>생산마감일</label>
                        <input id={`due-${r.id}`} type="date" className="b2b-input ag-apply-due" value={due} onChange={(e) => setDue(e.target.value)} />
                        <button type="button" className="b2b-btn-primary" onClick={apply} disabled={busy === "apply"}>{busy === "apply" ? "만드는 중" : `${agent.output} 만들기`}</button>
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
          )}

          {r.body_md && <section><div className="ag-sec-title">보고서</div><Md text={r.body_md} /></section>}

          {r.tool_log.length > 0 && (
            <details className="ag-tools">
              <summary>에이전트가 직접 조회한 것 {r.tool_log.length}건</summary>
              <ol>{r.tool_log.map((t, i) => <li key={i}>{t.title}{!t.ok && " (실패)"}{t.sql && <pre>{t.sql}</pre>}</li>)}</ol>
            </details>
          )}

          {r.status === "done" && (
            <section>
              <div className="ag-sec-title">평가</div>
              <div className="ag-feedback">
                <textarea className="b2b-input" value={feedback} onChange={(e) => setFeedback(e.target.value)} aria-label="보고서 평가" placeholder="예: 연어는 격주로만 요청. 대구순살 수량은 절반이 맞음" maxLength={2000} />
                <button type="button" className="b2b-btn-secondary" onClick={saveFeedback} disabled={busy === "feedback" || feedback.trim() === (r.feedback || "")}>평가 저장</button>
              </div>
            </section>
          )}

          <div className="ag-foot">
            {r.model && <span>{r.model}</span>}
            {r.est_usd != null && <span>${r.est_usd.toFixed(2)}</span>}
            {r.usage?.elapsed_ms != null && <span>{secs(r.usage.elapsed_ms)}</span>}
            {r.usage?.tool_calls != null && <span>조회 {r.usage.tool_calls}회</span>}
            {r.feedback_by && <span>평가 {r.feedback_by}</span>}
            {canRemove && <button type="button" className="b2b-link-btn ag-foot-right" onClick={remove} disabled={busy === "remove"}>보고서 삭제</button>}
          </div>
        </div>
      )}
    </article>
  );
}

export default function AgentsPage() {
  const toast = useToast();
  const [agentId, setAgentId] = useState(AGENTS[0].id);
  const agent = agentOf(agentId) ?? AGENTS[0];
  const [version, setVersion] = useState(latestVersion(agent).id);
  const [instruction, setInstruction] = useState("");
  const [reports, setReports] = useState<AgentReport[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [more, setMore] = useState(false);
  const [filter, setFilter] = useState("전체");
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const reqSeq = useRef(0);

  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" }).then((r) => r.json())
      .then((j) => setIsAdmin(!!j.ok && (j.name === "현석" || j.name === "관리자"))).catch(() => {});
  }, []);

  const load = useCallback(async (id: string) => {
    const seq = ++reqSeq.current;
    setLoading(true); setError("");
    try {
      const j = await (await fetch(`/api/agents/reports?agent=${encodeURIComponent(id)}`, { cache: "no-store" })).json();
      if (seq !== reqSeq.current) return;
      if (!j.ok) throw new Error(j.error);
      setReports(j.reports); setCounts(j.counts || {}); setMore(!!j.more); setPending(j.pending || "");
      setOpenId((cur) => cur ?? j.reports[0]?.id ?? null); // 처음엔 가장 최근 보고서를 펼쳐 둔다
    } catch (e) { if (seq === reqSeq.current) setError(e instanceof Error ? e.message : "보고서를 불러오지 못했습니다."); }
    finally { if (seq === reqSeq.current) setLoading(false); }
  }, []);

  useEffect(() => {
    setVersion(latestVersion(agentOf(agentId) ?? AGENTS[0]).id);
    setFilter("전체"); setOpenId(null); setReports([]);
    load(agentId);
  }, [agentId, load]);

  // '작성 중'인 보고서만 5초마다 다시 읽는다(끝나면 멈춘다)
  const runningIds = reports.filter((r) => r.status === "running").map((r) => r.id).join(",");
  useEffect(() => {
    if (!runningIds) return;
    const t = setInterval(async () => {
      for (const id of runningIds.split(",")) {
        try {
          const j = await (await fetch(`/api/agents/reports/${id}`, { cache: "no-store" })).json();
          if (j.ok && j.report.status !== "running") {
            setReports((list) => list.map((x) => (x.id === id ? j.report : x)));
            if (j.report.status === "done") setOpenId(id);
          }
        } catch { /* 다음 차례에 다시 */ }
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [runningIds]);

  const start = async () => {
    setStarting(true); setError("");
    try {
      const j = await (await fetch("/api/agents/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: agentId, version, instruction }) })).json();
      if (!j.ok) throw new Error(j.error);
      const now = new Date().toISOString();
      const placeholder: AgentReport = {
        id: j.id, agent: agentId, version, status: "running", instruction: instruction.trim() || null, summary: null, body_md: null, draft: [], facts: null, tool_log: [],
        model: null, usage: null, est_usd: null, error: null, created_by: null, created_at: now, finished_at: null,
        request_id: null, request_no: null, applied: null, applied_by: null, applied_at: null, feedback: null, feedback_by: null, feedback_at: null,
      };
      setReports((list) => [placeholder, ...list]);
      setCounts((c) => ({ ...c, [version]: (c[version] || 0) + 1 }));
      setInstruction(""); setFilter("전체");
    } catch (e) { toast.error(e instanceof Error ? e.message : "보고서 작성을 시작하지 못했습니다."); }
    finally { setStarting(false); }
  };

  const loadMore = async () => {
    const last = reports[reports.length - 1];
    if (!last) return;
    try {
      const j = await (await fetch(`/api/agents/reports?agent=${encodeURIComponent(agentId)}&before=${encodeURIComponent(last.created_at)}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      setReports((list) => [...list, ...j.reports]); setMore(!!j.more);
    } catch (e) { toast.error(e instanceof Error ? e.message : "보고서를 불러오지 못했습니다."); }
  };

  const runnable = agent.versions.filter((v) => !v.retired);
  const latest = latestVersion(agent).id;
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const shown = filter === "전체" ? reports : reports.filter((r) => r.version === filter);
  const busyRun = starting || !!runningIds;

  return (
    <div className="b2b-container">
      <div className="b2b-page-head">
        <h1 className="b2b-page-title">AI 에이전트</h1>
      </div>

      <div className="sm-tabs" role="tablist" aria-label="에이전트">
        {AGENTS.map((a) => (
          <button key={a.id} type="button" role="tab" aria-selected={a.id === agentId} className={`sm-tab ${a.id === agentId ? "is-active" : ""}`} onClick={() => setAgentId(a.id)}>{a.name}</button>
        ))}
      </div>

      {pending && <div className="sm-warn" style={{ marginTop: "var(--sm-space-4)" }}>{pending}</div>}
      {error && <div className="b2b-error" style={{ marginTop: "var(--sm-space-4)" }}>{error}</div>}

      <section className="b2b-form-section" style={{ marginTop: "var(--sm-space-4)" }}>
        <div className="ag-run">
          <select className="b2b-input ag-run-version" value={version} onChange={(e) => setVersion(e.target.value)} aria-label="에이전트 버전">
            {runnable.map((v) => <option key={v.id} value={v.id}>{v.id}{v.id === latest ? " (최신)" : ""}</option>)}
          </select>
          <input className="b2b-input ag-run-note" value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={1000}
            aria-label="에이전트에게 덧붙일 말" placeholder="예: 다음 주 화요일 A마트 대구순살 300개 발주 예정" onKeyDown={(e) => { if (e.key === "Enter" && !busyRun && !pending) start(); }} />
          <button type="button" className="b2b-btn-primary" onClick={start} disabled={busyRun || !!pending}>{runningIds ? "작성 중" : starting ? "시작하는 중" : "보고서 작성"}</button>
        </div>
        <details className="ag-versions">
          <summary>버전 기록 {agent.versions.length}개</summary>
          {agent.versions.map((v) => (
            <div key={v.id} className="ag-version">
              <div className="ag-version-id">{v.id}{v.retired ? " (종료)" : ""}<span className="ag-version-date">{v.date} · 보고서 {qty(counts[v.id] || 0)}장</span></div>
              <ul>{v.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          ))}
        </details>
      </section>

      {agent.versions.length > 1 && (
        <div className="sm-tabs ag-filter" role="tablist" aria-label="버전으로 거르기">
          <button type="button" className={`sm-tab ${filter === "전체" ? "is-active" : ""}`} onClick={() => setFilter("전체")}>전체<span className="sm-tab-count">{qty(total)}</span></button>
          {agent.versions.map((v) => (
            <button key={v.id} type="button" className={`sm-tab ${filter === v.id ? "is-active" : ""}`} onClick={() => setFilter(v.id)}>{v.id}<span className="sm-tab-count">{qty(counts[v.id] || 0)}</span></button>
          ))}
        </div>
      )}

      <div style={{ marginTop: agent.versions.length > 1 ? 0 : "var(--sm-space-5)" }}>
        {loading ? <div className="b2b-loading">불러오는 중...</div>
          : shown.length === 0 ? <div className="b2b-empty">{filter === "전체" ? "작성된 보고서가 없습니다." : `${filter} 보고서가 없습니다.`}</div>
          : shown.map((r) => (
            <ReportCard key={r.id} r={r} agent={agent} isAdmin={isAdmin} open={openId === r.id}
              onToggle={() => setOpenId((cur) => (cur === r.id ? null : r.id))}
              onChange={(nr) => setReports((list) => list.map((x) => (x.id === nr.id ? nr : x)))}
              onRemove={(id) => { setReports((list) => list.filter((x) => x.id !== id)); setCounts((c) => ({ ...c, [r.version]: Math.max(0, (c[r.version] || 0) - 1) })); }} />
          ))}
        {more && !loading && <div className="ag-more"><button type="button" className="b2b-btn-secondary" onClick={loadMore}>이전 보고서 더 보기</button></div>}
      </div>
    </div>
  );
}
