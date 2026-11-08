"use client";

// 살펴보기 — 메시지 하나씩 고르며 지표를 보는 대시보드(2026-11-09, 대표 "한 화면에서 드롭다운으로 한 메시지씩 — 이 메시지 성과는 어땠는지 봅시다").
//  위: [이전] 드롭다운(단계별 묶음) [다음] · 오른쪽 [드로어에서 고치기]. 아래: 메시지 요약 카드(메타 + 본문) → KPI 4 → 주간 클릭률·주간 발송과 클릭 차트 → 요일별 클릭·주별 표 → A/B(utm_term) 표.
//  데이터: /api/crm/message-stats?id= (12주 이력 그 메시지 줄 + 전체 줄 + GA 날짜·term). 메시지 본문·메타는 페이지가 이미 가진 목록에서.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ComboBarLine, BarList, TrendChart } from "@/app/components/charts";
import { crmTags, statusKey, triggerText, type CrmMessage } from "@/app/lib/crm";
import { isTrackedUrl } from "@/app/lib/utm-rules";
import { qty, wonText } from "@/app/lib/format";
import type { Labels } from "./types";

type HistoryRow = { id: string; title: string; customer: string; medium: string; campaign: string; targetCtr: number | null; sentBasis: "solapi" | "manual" | "estimate" | "none"; sent: (number | null)[]; sessions: (number | null)[]; purchases: (number | null)[]; revenue: (number | null)[]; ctr: (number | null)[] };
type Resp = { ok: boolean; error?: string; weeks: string[]; row: HistoryRow | null; total: { sent: number[]; sessions: (number | null)[]; ctr: (number | null)[] }; note: string; daily: { date: string; sessions: number; purchases: number; revenue: number }[]; weekday: number[]; byTerm: { term: string; sessions: number; purchases: number; revenue: number }[] };

const SEL_KEY = "crm.msg";
const fmtDate = (iso: string) => iso.slice(5).replace("-", "/");
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const DOW = ["월", "화", "수", "목", "금", "토", "일"];
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const hasAny = (xs: (number | null)[]) => xs.some((x) => x != null);
const diffPoint = (cur: number | null | undefined, prev: number | null | undefined): string => (cur == null || prev == null ? "" : `${cur >= prev ? "+" : ""}${(Math.round((cur - prev) * 10) / 10).toFixed(1)}%p`);
const tone = (cur: number | null, base: number | null) => (cur == null || base == null ? undefined : cur >= base ? "var(--sm-success)" : "var(--sm-danger)");
const SENT_BASIS: Record<HistoryRow["sentBasis"], string> = { solapi: "솔라피 실제", manual: "직접 입력", estimate: "추정(매출 원장 대상자)", none: "발송 수 없음" };

export default function MessageView({ msgs, labels, onOpen }: { msgs: CrmMessage[]; labels: Labels; onOpen: (m: CrmMessage) => void }) {
  // 드롭다운 순서 = 목록과 같게(단계 번호 → 단계 이름 → 정렬 순서)
  const ordered = useMemo(() => [...msgs].sort((a, b) => a.stage_num - b.stage_num || (a.stage || "").localeCompare(b.stage || "", "ko") || a.sort_order - b.sort_order || a.title.localeCompare(b.title, "ko")), [msgs]);
  const groups = useMemo(() => { const g = new Map<string, CrmMessage[]>(); for (const m of ordered) { const k = m.stage || "(미분류)"; if (!g.has(k)) g.set(k, []); g.get(k)!.push(m); } return [...g.entries()]; }, [ordered]);
  const [sel, setSel] = useState<string>("");
  useEffect(() => { try { const v = localStorage.getItem(SEL_KEY); if (v) setSel(v); } catch { /* 저장 안 됨 */ } }, []);
  const idx = ordered.findIndex((m) => m.id === sel);
  const cur = idx >= 0 ? ordered[idx] : ordered[0];
  const curIdx = idx >= 0 ? idx : 0;
  const pick = (id: string) => { setSel(id); try { localStorage.setItem(SEL_KEY, id); } catch { /* 무시 */ } };

  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(async (id: string) => {
    setLoading(true); setErr("");
    try {
      const j = (await fetch(`/api/crm/message-stats?id=${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => r.json())) as Resp;
      if (!j.ok) throw new Error(j.error || "성과를 불러오지 못했습니다. 다른 메시지를 고르거나 잠시 뒤 다시 시도하세요");
      setData(j);
    } catch (e) { setData(null); setErr(e instanceof Error ? e.message : "성과를 불러오지 못했습니다"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (cur?.id) load(cur.id); }, [cur?.id, load]);

  const v = useMemo(() => {
    if (!data || !data.row) return null;
    const r = data.row, n = data.weeks.length, L = n - 1;
    const sentTotal = sum(r.sent), sessTotal = sum(r.sessions);
    const avgCtr = hasAny(r.sessions) && sentTotal ? Math.round((sessTotal / sentTotal) * 1000) / 10 : null;
    const allSent = sum(data.total.sent), allSess = sum(data.total.sessions);
    const allAvgCtr = hasAny(data.total.sessions) && allSent ? Math.round((allSess / allSent) * 1000) / 10 : null;
    const known = r.ctr.map((c, i) => ({ c, i })).filter((x) => x.c != null) as { c: number; i: number }[];
    const best = known.length ? known.reduce((a, b) => (b.c > a.c ? b : a)) : null;
    const worst = known.length ? known.reduce((a, b) => (b.c < a.c ? b : a)) : null;
    const hitWeeks = r.targetCtr != null ? known.filter((x) => x.c >= (r.targetCtr as number)).length : null;
    const ctrChart = data.weeks.map((w, i) => ({ label: fmtDate(w), value: Math.round((r.ctr[i] ?? 0) * 10), tip: `${fmtDate(w)} 주 · 클릭률 ${r.ctr[i] == null ? "-" : `${r.ctr[i]}%`} · 발송 ${r.sent[i] == null ? "-" : qty(r.sent[i])} · 클릭 ${r.sessions[i] == null ? "-" : qty(r.sessions[i])}` }));
    const weekday: [string, number][] = DOW.map((d, i) => [d, data.weekday[i] || 0]);
    return { r, n, L, sentTotal, sessTotal, avgCtr, allAvgCtr, best, worst, hitWeeks, ctrChart, weekday, purchases: sum(r.purchases), revenue: sum(r.revenue), hasGa: hasAny(r.sessions) };
  }, [data]);

  if (!cur) return <div className="b2b-empty">메시지가 없습니다.</div>;
  const urls = cur.links?.urls?.length ? cur.links.urls : cur.links?.url ? [cur.links.url] : [];
  const tracked = urls.filter(isTrackedUrl).length;
  const tags = crmTags(cur.tags);
  const period = cur.start_date || cur.end_date ? `${cur.start_date ? md(cur.start_date) : ""}~${cur.end_date ? md(cur.end_date) : ""}` : "";
  const st = statusKey(cur.status);
  const trig = triggerText({ trigger: cur.trigger, offset_days: cur.offset_days });
  const campaign = (cur.links?.utm_campaign || "").trim();

  return (
    <div>
      <div className="crm-perf-bar">
        <button className="b2b-btn-secondary" onClick={() => pick(ordered[curIdx - 1].id)} disabled={curIdx <= 0}>이전 메시지</button>
        <select className="b2b-select crm-msg-select" value={cur.id} onChange={(e) => pick(e.target.value)} aria-label="메시지 선택">
          {groups.map(([stage, list]) => (
            <optgroup key={stage} label={stage}>{list.map((m) => <option key={m.id} value={m.id}>{m.title || "(제목 없음)"}{statusKey(m.status) === "inactive" ? " · 비활성" : ""}</option>)}</optgroup>
          ))}
        </select>
        <button className="b2b-btn-secondary" onClick={() => pick(ordered[curIdx + 1].id)} disabled={curIdx >= ordered.length - 1}>다음 메시지</button>
        <span className="crm-group-count num">{curIdx + 1} / {ordered.length}</span>
        <span className="crm-bar-spacer" />
        <button className="b2b-btn-secondary" onClick={() => onOpen(cur)}>드로어에서 고치기</button>
      </div>

      <section className="b2b-card crm-perf-sec crm-msg-card">
        <div className="crm-msg-meta">
          <h2 className="crm-msg-title">{cur.title || "(제목 없음)"}</h2>
          <div className="crm-msg-badges">
            {cur.customer && <span className="b2b-status-pill">{labels.cust(cur.customer)}</span>}
            {cur.channel && <span className="b2b-status-pill">{labels.ch(cur.channel)}</span>}
            {cur.msg_type && <span className="b2b-status-pill">{labels.type(cur.msg_type)}</span>}
            <span className="b2b-status-pill">{st === "active" ? "활성" : "비활성"}</span>
            {tags.map((t) => <span key={t} className="crm-tag">{t}</span>)}
          </div>
          <dl className="crm-msg-dl">
            <dt>단계</dt><dd>{cur.stage_num ? `${cur.stage_num}. ` : ""}{cur.stage || "-"}{cur.sub ? ` · ${cur.sub}` : ""}</dd>
            <dt>트리거</dt><dd>{trig || "-"}{cur.offset_note && <span className="crm-sub">{cur.offset_note}</span>}</dd>
            {(cur.timing || period) && <><dt>발송 시점</dt><dd>{[cur.timing, period].filter(Boolean).join(" · ")}</dd></>}
            <dt>UTM</dt><dd>{campaign ? <>{campaign}{cur.utm_medium ? ` · ${cur.utm_medium}` : ""}{cur.links?.utm_term ? ` · ${cur.links.utm_term}` : ""}</> : <span className="sm-faint">캠페인 없음 · 클릭을 셀 수 없다</span>}</dd>
            <dt>링크</dt><dd>{urls.length ? <>{qty(urls.length)}개{tracked < urls.length ? ` · 추적 ${qty(tracked)}` : ""}</> : <span className="sm-faint">없음</span>}</dd>
            <dt>목표 클릭률</dt><dd>{cur.target_ctr != null ? `${cur.target_ctr}%` : <span className="sm-faint">없음</span>}</dd>
            {v && <><dt>발송 수 기준</dt><dd>{SENT_BASIS[v.r.sentBasis]}</dd></>}
          </dl>
        </div>
        <div className={`crm-msg-box crm-msg-preview${cur.msg ? "" : " is-empty"}`}>{cur.msg || "(본문 없음)"}</div>
      </section>

      {err && <div className="b2b-error">{err}</div>}
      {!campaign ? (
        <div className="b2b-empty">UTM 캠페인이 없는 메시지라 클릭·구매를 셀 수 없습니다. 드로어에서 UTM 캠페인을 넣으면 다음 날부터 GA 수치가 쌓입니다.</div>
      ) : loading && !data ? <div className="b2b-loading">불러오는 중...</div> : v && (
        <>
          <div className="crm-kpis">
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">이 주 클릭률</div><div className="b2b-stat-card-value" style={{ color: tone(v.r.ctr[v.L], v.r.targetCtr) }}>{v.r.ctr[v.L] == null ? "-" : `${v.r.ctr[v.L]}%`}</div><div className="b2b-stat-card-hint">{[v.r.ctr[v.L - 1] != null ? `전주 ${v.r.ctr[v.L - 1]}% ${diffPoint(v.r.ctr[v.L], v.r.ctr[v.L - 1])}` : "", v.r.targetCtr != null ? `목표 ${v.r.targetCtr}%` : ""].filter(Boolean).join(" · ") || `발송 ${v.r.sent[v.L] == null ? "-" : qty(v.r.sent[v.L])} · 클릭 ${v.r.sessions[v.L] == null ? "-" : qty(v.r.sessions[v.L])}`}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">12주 평균 클릭률</div><div className="b2b-stat-card-value" style={{ color: tone(v.avgCtr, v.allAvgCtr) }}>{v.avgCtr == null ? "-" : `${v.avgCtr}%`}</div><div className="b2b-stat-card-hint">{v.allAvgCtr != null ? `전체 메시지 평균 ${v.allAvgCtr}% ${diffPoint(v.avgCtr, v.allAvgCtr)}` : "전체 평균 없음"}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">12주 발송 · 클릭</div><div className="b2b-stat-card-value">{hasAny(v.r.sent) ? qty(v.sentTotal) : "-"}</div><div className="b2b-stat-card-hint">{v.hasGa ? `클릭 ${qty(v.sessTotal)}` : "GA 연동 없음"}{v.hitWeeks != null ? ` · 목표 달성 ${qty(v.hitWeeks)}주` : ""}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">12주 구매 · 매출</div><div className="b2b-stat-card-value">{v.hasGa ? qty(v.purchases) : "-"}</div><div className="b2b-stat-card-hint">{v.hasGa ? wonText(v.revenue) : ""}{v.best && v.worst && v.best.i !== v.worst.i ? ` · 최고 ${fmtDate(data!.weeks[v.best.i])} ${v.best.c}% · 최저 ${fmtDate(data!.weeks[v.worst.i])} ${v.worst.c}%` : ""}</div></div>
          </div>

          <div className="crm-perf-grid">
            <section className="b2b-card crm-perf-sec">
              <div className="b2b-card-head"><span className="b2b-card-title">주간 클릭률</span><span className="b2b-field-hint">{v.r.targetCtr != null ? `목표 ${v.r.targetCtr}%` : "최근 12주"}</span></div>
              {v.hasGa ? <TrendChart data={v.ctrChart} fmtAxis={(n) => `${n / 10}%`} /> : <div className="b2b-empty">GA 연동 없음</div>}
            </section>
            <section className="b2b-card crm-perf-sec">
              <div className="b2b-card-head"><span className="b2b-card-title">주간 발송과 클릭</span><span className="b2b-field-hint">막대 = 발송 · 선 = 클릭(GA 세션)</span></div>
              {hasAny(v.r.sent) || v.hasGa ? (
                <ComboBarLine periods={data!.weeks.map(fmtDate)} barSeries={[{ key: "발송", values: v.r.sent.map((x) => x ?? 0) }]} barColors={["var(--sm-orange)"]} lineValues={v.r.sessions} lineLabel="클릭" lineFmt={(n) => qty(n)} lineUnit="회" barUnit="건" />
              ) : <div className="b2b-empty">발송·클릭 수가 없습니다.</div>}
            </section>
          </div>

          <div className="crm-perf-grid">
            <BarList title="요일별 클릭" caption="최근 12주 GA 세션 합 · 언제 눌리는지" data={v.weekday} fmt={(n) => qty(n)} empty="클릭이 없습니다" />
            <section className="b2b-card crm-perf-sec">
              <div className="b2b-card-head"><span className="b2b-card-title">주별</span><span className="b2b-field-hint">최근 12주 · 아래가 이 주</span></div>
              <div className="b2b-table-wrap"><table className="b2b-table">
                <thead><tr><th>주</th><th className="num">발송</th><th className="num">클릭</th><th className="num">클릭률</th><th className="num">구매</th><th className="num">매출</th></tr></thead>
                <tbody>{data!.weeks.map((w, i) => (
                  <tr key={w} className={i === v.L ? "crm-hist-total" : undefined}>
                    <td className="crm-cell-nowrap">{fmtDate(w)}{i === v.L ? " 이 주" : ""}</td>
                    <td className="num">{v.r.sent[i] == null ? "-" : qty(v.r.sent[i])}</td>
                    <td className="num">{v.r.sessions[i] == null ? "-" : qty(v.r.sessions[i])}</td>
                    <td className="num" style={{ color: tone(v.r.ctr[i], v.r.targetCtr), fontWeight: tone(v.r.ctr[i], v.r.targetCtr) ? 600 : undefined }}>{v.r.ctr[i] == null ? "-" : `${v.r.ctr[i]}%`}</td>
                    <td className="num">{v.r.purchases[i] == null ? "-" : qty(v.r.purchases[i])}</td>
                    <td className="num">{v.r.revenue[i] == null ? "-" : wonText(v.r.revenue[i])}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </section>
          </div>

          {data!.byTerm.length >= 2 && (
            <section className="b2b-card crm-perf-sec">
              <div className="b2b-card-head"><span className="b2b-card-title">A/B(utm_term)별</span><span className="b2b-field-hint">같은 캠페인 안에서 term 으로 나눈 12주 합 · 발송은 나눠 셀 수 없어 세션 비중으로</span></div>
              <div className="b2b-table-wrap"><table className="b2b-table">
                <thead><tr><th>term</th><th className="num">클릭</th><th className="num">비중</th><th className="num">구매</th><th className="num">구매전환율</th><th className="num">매출</th></tr></thead>
                <tbody>{data!.byTerm.map((t) => { const all = data!.byTerm.reduce((s, x) => s + x.sessions, 0); return (
                  <tr key={t.term} className={cur.links?.utm_term && t.term === cur.links.utm_term ? "crm-hist-total" : undefined}>
                    <td>{t.term}{cur.links?.utm_term && t.term === cur.links.utm_term ? <span className="crm-sub">이 메시지</span> : null}</td>
                    <td className="num">{qty(t.sessions)}</td>
                    <td className="num">{all ? `${Math.round((t.sessions / all) * 100)}%` : "-"}</td>
                    <td className="num">{qty(t.purchases)}</td>
                    <td className="num">{t.sessions ? `${((t.purchases / t.sessions) * 100).toFixed(1)}%` : "-"}</td>
                    <td className="num">{wonText(t.revenue)}</td>
                  </tr>
                ); })}</tbody>
              </table></div>
            </section>
          )}
          {data?.note && <p className="b2b-field-hint is-below">{data.note}</p>}
          {loading && <div className="b2b-loading">불러오는 중...</div>}
          {!v.hasGa && !hasAny(v.r.sent) ? null : <p className="b2b-field-hint is-below">클릭 = GA 에서 이 캠페인으로 들어온 세션(어제까지 확정) · 발송 = {SENT_BASIS[v.r.sentBasis]}</p>}
        </>
      )}
    </div>
  );
}
