"use client";

// AI 에이전트 — 에이전트마다 보고서가 쌓이는 화면.
//  위 탭 = 에이전트, 실행 줄 = 버전 고르기 + [업무 요청], 예약 줄 = 매주 n요일 n시까지 초안 작성, 아래 = 보고서 목록(최신순).
//  보고서 한 장의 흐름: 작성 중 → 결재 대기 → 담당자가 [결재](초안 그대로) 또는 [피드백 보내기](에이전트가 고친 수정본) → 실제 요청서 작성.
//  에이전트·버전 목록은 app/lib/agents/registry.ts — 새 에이전트·새 버전은 거기 한 줄이면 이 화면에 나타난다.
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { AGENTS, agentOf, latestVersion, nextTargetLabel, DEFAULT_SCHEDULE, WEEKDAYS, type AgentMeta, type AgentReport, type AgentSchedule, type DraftItem } from "@/app/lib/agents/registry";
import { qty, dateTime, dateShort } from "@/app/lib/format";
import { Md } from "./Md";
import { IdeasSection, AdMaterials } from "./AdCopy";

const POLL_MS = 5000;              // 에이전트가 일하는 중인 보고서가 있을 때만 그 한 장을 다시 읽는다
const TICK_LATE_MS = 2 * 3600_000; // 예약 신호(매시 45분)가 이보다 오래 안 왔으면 알린다

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
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"" | "approve" | "feedback" | "remove">("");
  const [err, setErr] = useState("");

  const isIdeas = agent.kind === "ideas";                        // 소재 목록 — 결재·요청서 없음
  const running = r.status === "running";
  const revising = running && !!r.facts?.revising;
  const failed = r.status === "error";
  const closed = !isIdeas && r.status === "done" && r.applied != null;  // 요청서로 작성됐거나 요청 없이 닫힘
  const waiting = !isIdeas && r.status === "done" && r.applied == null; // 결재 대기
  const stage = r.facts?.stage;                                   // 단계형 에이전트의 진행
  const stageText = running && agent.stages && stage ? `${Math.min(stage.done + 1, stage.total)}/${stage.total} 단계 · ${agent.stages[Math.min(stage.done, agent.stages.length - 1)]} 중입니다.` : "";
  const items = r.draft.filter((d) => d.product_id && d.qty > 0);
  const firstBySku = useMemo(() => new Map((r.facts?.first_draft || []).map((d) => [d.sku, d.qty])), [r.facts?.first_draft]);
  const revised = !!r.facts?.first_draft && !revising;           // 피드백을 반영한 수정본을 보고 있다
  const hasTrend = r.draft.some((d) => d.out7 !== undefined);    // v3~ 순수 도매 출고 추이
  const hasRetail = r.draft.some((d) => d.retail_spare != null); // v1·v2 보고서에만 있던 소매 여유

  const approve = async () => {
    setErr("");
    if (!(await confirm({ title: "초안 결재", body: `품목 ${items.length}종이 ${agent.output}로 작성되고 팀즈에 알립니다.`, action: "결재", danger: false }))) return;
    setBusy("approve");
    try {
      const j = await (await fetch(`/api/agents/reports/${r.id}/apply`, { method: "POST" })).json();
      if (!j.ok) throw new Error(j.error);
      onChange(j.report);
      toast.success(`요청서 ${j.request_no || ""}로 작성했습니다`);
    } catch (e) { setErr(e instanceof Error ? e.message : "요청서를 작성하지 못했습니다."); }
    finally { setBusy(""); }
  };
  const sendFeedback = async () => {
    setErr("");
    if (!feedback.trim()) { setErr("피드백을 입력하세요."); return; }
    if (!(await confirm({ title: "피드백 보내기", body: `에이전트가 피드백대로 고친 수정본이 바로 ${agent.output}로 작성됩니다.`, action: "피드백 보내기", danger: false }))) return;
    setBusy("feedback");
    try {
      const j = await (await fetch(`/api/agents/reports/${r.id}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback }) })).json();
      if (!j.ok) throw new Error(j.error);
      setFeedback("");
      onChange(j.report);
    } catch (e) { setErr(e instanceof Error ? e.message : "피드백을 보내지 못했습니다."); }
    finally { setBusy(""); }
  };
  const remove = async () => {
    if (!(await confirm({ title: "보고서 삭제", body: "이 보고서가 지워집니다. 되돌릴 수 없습니다.", action: "보고서 삭제" }))) return;
    setBusy("remove");
    try {
      const j = await (await fetch(`/api/agents/reports/${r.id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error);
      onRemove(r.id);
    } catch (e) { toast.error(e instanceof Error ? e.message : "보고서를 지우지 못했습니다."); setBusy(""); }
  };

  const canRemove = !running && !r.request_id && (failed || isAdmin);
  return (
    <article className="ag-card">
      <button type="button" className="ag-card-head" onClick={onToggle} aria-expanded={open}>
        <div className="ag-meta">
          <span className="ag-meta-time">{dateTime(r.created_at)}</span>
          <Pill tone="muted">{r.version}</Pill>
          {r.created_by && <span>{r.created_by}</span>}
          {running && <Pill tone="muted">{revising ? "피드백 반영 중" : "작성 중"}</Pill>}
          {failed && <Pill tone="danger">실패</Pill>}
          {waiting && <Pill tone="muted">결재 대기</Pill>}
          {isIdeas && r.status === "done" && <Pill tone="success">소재 {qty(r.ideas.length)}건</Pill>}
          {closed && (r.request_no || r.request_id ? <Pill tone="success">요청서 {r.request_no || "작성"}</Pill> : <Pill tone="muted">요청 없음</Pill>)}
          <span className="ag-meta-fold">{open ? "접기" : "펼치기"}</span>
        </div>
        <div className={`ag-summary ${running || failed ? "is-muted" : ""}`}>
          {isIdeas && revising ? "피드백을 반영해 목록을 다시 쓰고 있습니다. 보통 2~4분 걸립니다."
            : isIdeas && running ? `${stageText || "작성을 시작했습니다."} 전체 4~8분 걸립니다.`
            : revising ? "피드백을 반영해 요청서를 작성하고 있습니다. 보통 1~3분 걸립니다."
            : running ? "초안을 작성하고 있습니다. 보통 1~3분 걸립니다."
            : failed ? (r.error || "작성하지 못했습니다.") : (r.summary || "요약 없음")}
        </div>
      </button>

      {open && !running && (
        <div className="ag-body">
          {r.instruction && <div className="ag-note"><strong>덧붙인 말</strong> {r.instruction}</div>}
          {r.feedback && <div className="ag-note"><strong>피드백{r.feedback_by ? ` ${r.feedback_by}` : ""}</strong> {r.feedback}</div>}
          {!!r.facts?.warnings?.length && <div className="sm-warn"><ul>{r.facts.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}

          {isIdeas && r.status === "done" && <IdeasSection r={r} onChange={onChange} />}

          {!isIdeas && r.status === "done" && (
            <section>
              <div className="ag-sec-title">{revised ? "수정본" : "초안"}</div>
              {r.facts?.next_arrival && r.facts.due_date && (
                <div className="ag-note" style={{ marginBottom: "var(--sm-space-2)" }}>입고 예정 {dateShort(r.facts.due_date)} · 다음 요청분 입고 {dateShort(r.facts.next_arrival)}까지 {qty(r.facts.horizon_days ?? 0)}일분 기준</div>
              )}
              {r.draft.length === 0 ? <div className="b2b-empty">요청할 품목이 없습니다.</div> : (
                <div className="b2b-table-wrap">
                  <table className="b2b-table ag-table">
                    <thead>
                      <tr>
                        <th>품목</th><th className="num">도매 재고</th><th className="num">하루 출고</th><th className="num">버티는 날</th>
                        {hasTrend && <><th className="num">최근 7일</th><th className="num">최근 30일</th></>}
                        <th className="num">이미 요청</th>{hasRetail && <th className="num">소매 여유</th>}<th className="num">수식 권장</th><th className="num">요청 수량</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.draft.map((d: DraftItem) => {
                        const before = revised ? firstBySku.get(d.sku) : undefined;
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
                              {hasTrend && <><td className="num">{num(d.out7)}</td><td className="num">{num(d.out30)}</td></>}
                              <td className="num">{num(d.open_req)}</td>
                              {hasRetail && <td className="num">{num(d.retail_spare)}</td>}
                              <td className="num">{num(d.formula)}</td>
                              <td className="num ag-qty">
                                {num(d.qty)}
                                {revised && before !== d.qty && <span className="ag-changed">{before == null ? "추가" : `초안 ${num(before)}`}</span>}
                              </td>
                            </tr>
                            <tr className="ag-reason-row"><td colSpan={7 + (hasTrend ? 2 : 0) + (hasRetail ? 1 : 0)}>{d.reason}</td></tr>
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {closed && (r.request_id || r.request_no ? (
                <div className="sm-success" style={{ marginTop: "var(--sm-space-3)" }}>
                  {r.feedback ? "피드백을 반영해 " : ""}요청서 {r.request_no || ""}로 작성했습니다{r.applied_by ? ` (${r.feedback ? "피드백" : "결재"} ${r.applied_by})` : ""}.{" "}
                  <Link href="/production/request" className="sm-link">생산 요청 열기</Link>
                </div>
              ) : (
                <div className="sm-warn" style={{ marginTop: "var(--sm-space-3)" }}>요청할 품목이 없어 요청서를 작성하지 않았습니다.</div>
              ))}

              {waiting && (
                <div className="ag-review">
                  {r.facts?.revise_error && <div className="b2b-error">{r.facts.revise_error}</div>}
                  {err && <div className="b2b-error">{err}</div>}
                  <textarea className="b2b-input" value={feedback} onChange={(e) => setFeedback(e.target.value)} aria-label="에이전트에게 보낼 피드백" maxLength={2000}
                    placeholder="예: 대구순살은 200개로 줄이고 삼치순살 100개 추가" />
                  <div className="ag-review-actions">
                    <button type="button" className="b2b-btn-primary" onClick={approve} disabled={!!busy || items.length === 0}>{busy === "approve" ? "작성하는 중" : "결재"}</button>
                    <button type="button" className="b2b-btn-secondary" onClick={sendFeedback} disabled={!!busy}>{busy === "feedback" ? "보내는 중" : "피드백 보내기"}</button>
                  </div>
                </div>
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

          <div className="ag-foot">
            {r.facts?.scheduled && <span>예약 작성</span>}
            {r.model && <span>{r.model}</span>}
            {r.est_usd != null && <span>${r.est_usd.toFixed(2)}</span>}
            {r.usage?.elapsed_ms != null && <span>{secs(r.usage.elapsed_ms)}</span>}
            {r.usage?.tool_calls != null && <span>조회 {r.usage.tool_calls}회</span>}
            {canRemove && <button type="button" className="b2b-link-btn ag-foot-right" onClick={remove} disabled={busy === "remove"}>보고서 삭제</button>}
          </div>
        </div>
      )}
    </article>
  );
}

// 예약 줄 — 매주 n요일 n시까지 초안 작성. 저장해야 반영된다.
function ScheduleRow({ agentId, noun }: { agentId: string; noun: string }) {
  const toast = useToast();
  const [saved, setSaved] = useState<AgentSchedule | null>(null);
  const [draft, setDraft] = useState<AgentSchedule>(DEFAULT_SCHEDULE);
  const [lastTick, setLastTick] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let alive = true;
    setSaved(null);
    fetch(`/api/agents/schedule?agent=${encodeURIComponent(agentId)}`, { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!alive || !j.ok) return;
      setSaved(j.schedule); setDraft(j.schedule); setLastTick(j.lastTick); setNow(Date.now());
    }).catch(() => {});
    return () => { alive = false; };
  }, [agentId]);

  const save = async () => {
    setSaving(true);
    try {
      const j = await (await fetch("/api/agents/schedule", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: agentId, ...draft }) })).json();
      if (!j.ok) throw new Error(j.error);
      setSaved(j.schedule); setDraft(j.schedule); setNow(Date.now());
      toast.success("예약을 저장했습니다");
    } catch (e) { toast.error(e instanceof Error ? e.message : "예약을 저장하지 못했습니다."); }
    finally { setSaving(false); }
  };

  if (!saved) return null;
  const dirty = draft.on !== saved.on || draft.weekday !== saved.weekday || draft.hour !== saved.hour;
  const tickLate = saved.on && (!lastTick || now - Date.parse(lastTick) > TICK_LATE_MS);
  return (
    <>
      <div className="ag-sched">
        <span className="ag-sched-label">예약</span>
        <div className="sm-tabs" role="group" aria-label="예약 켜기">
          <button type="button" className={`sm-tab ${draft.on ? "is-active" : ""}`} aria-pressed={draft.on} onClick={() => setDraft((d) => ({ ...d, on: true }))}>켜짐</button>
          <button type="button" className={`sm-tab ${!draft.on ? "is-active" : ""}`} aria-pressed={!draft.on} onClick={() => setDraft((d) => ({ ...d, on: false }))}>꺼짐</button>
        </div>
        <span>매주</span>
        <select className="b2b-input ag-sched-select" value={draft.weekday} aria-label="작성 요일" onChange={(e) => setDraft((d) => ({ ...d, weekday: Number(e.target.value) }))}>
          {WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}요일</option>)}
        </select>
        <select className="b2b-input ag-sched-select" value={draft.hour} aria-label="작성 시각" onChange={(e) => setDraft((d) => ({ ...d, hour: Number(e.target.value) }))}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}시</option>)}
        </select>
        <span>까지 {noun} 작성</span>
        <button type="button" className="b2b-btn-secondary" onClick={save} disabled={saving || !dirty}>예약 저장</button>
        {saved.on && !dirty && <span className="ag-sched-next">다음 {noun} {nextTargetLabel(saved, now)}</span>}
      </div>
      {tickLate && <div className="sm-warn" style={{ marginTop: "var(--sm-space-3)" }}>예약 신호가 오지 않습니다. 운영 배포 뒤 supabase/migrations/165_agent_tick.sql 을 적용하세요.</div>}
    </>
  );
}

export default function AgentsPage() {
  const toast = useToast();
  const [agentId, setAgentId] = useState(AGENTS[0].id);
  const agent = agentOf(agentId) ?? AGENTS[0];
  const [version, setVersion] = useState(latestVersion(agent).id);
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

  // 에이전트가 일하는 중(작성·피드백 반영)인 보고서만 5초마다 다시 읽는다(끝나면 멈춘다)
  const runningIds = reports.filter((r) => r.status === "running").map((r) => r.id).join(",");
  useEffect(() => {
    if (!runningIds) return;
    const t = setInterval(async () => {
      for (const id of runningIds.split(",")) {
        try {
          const j = await (await fetch(`/api/agents/reports/${id}`, { cache: "no-store" })).json();
          if (!j.ok) continue;
          if (j.report.status !== "running") {
            setReports((list) => list.map((x) => (x.id === id ? j.report : x)));
            if (j.report.status === "done") setOpenId(id);
          } else {
            // 단계형 에이전트 — 단계가 넘어가면 '작성 중' 문구를 바꾼다
            setReports((list) => list.map((x) => (x.id === id && x.facts?.stage?.done !== j.report.facts?.stage?.done ? j.report : x)));
          }
        } catch { /* 다음 차례에 다시 */ }
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [runningIds]);

  const start = async () => {
    setStarting(true); setError("");
    try {
      const j = await (await fetch("/api/agents/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: agentId, version }) })).json();
      if (!j.ok) throw new Error(j.error);
      const now = new Date().toISOString();
      const placeholder: AgentReport = {
        id: j.id, agent: agentId, version, status: "running", instruction: null, summary: null, body_md: null, draft: [], ideas: [], facts: null, tool_log: [],
        model: null, usage: null, est_usd: null, error: null, created_by: null, created_at: now, finished_at: null,
        request_id: null, request_no: null, applied: null, applied_by: null, applied_at: null, feedback: null, feedback_by: null, feedback_at: null,
      };
      setReports((list) => [placeholder, ...list]);
      setCounts((c) => ({ ...c, [version]: (c[version] || 0) + 1 }));
      setFilter("전체");
    } catch (e) { toast.error(e instanceof Error ? e.message : "업무를 요청하지 못했습니다."); }
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
          <button type="button" className="b2b-btn-primary" onClick={start} disabled={busyRun || !!pending}>{runningIds ? "작업 중" : starting ? "요청하는 중" : "업무 요청"}</button>
        </div>
        {!pending && <ScheduleRow agentId={agentId} noun={agent.kind === "ideas" ? "목록" : "초안"} />}
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

      {agent.kind === "ideas" && <AdMaterials key={agentId} />}

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
