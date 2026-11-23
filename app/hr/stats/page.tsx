"use client";

// 통계 — 끝 달을 포함한 12개월: 인건비(확정한 달) · 근무 시간 · 인원 · 연차.
//  새로 저장하는 것은 없다. 서버가 월 급여·근무대장·인사대장·연차 발생 건을 읽어 더한 값을 보여 준다(app/lib/hr-stats.ts).
//  차트는 공용 프리미티브(app/components/charts.tsx)만 쓴다.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BarList, ChartLegend, PIE_COLORS, PieCard, StackedBar, TrendChart, moneyCompact } from "@/app/components/charts";
import { numText, todayKst } from "@/app/lib/hr";
import { hoursText, isMonth, shiftMonth } from "@/app/lib/hr-work";
import { dayText } from "@/app/lib/hr-leave";
import { monthLabel, type CostAgg, type StatsBundle } from "@/app/lib/hr-stats";
import { HrApiError, errText, hrApi } from "../api";

const won = (n: number) => numText(n);
const laborCost = (a: CostAgg) => a.pay_total + a.employer;
// 순위 막대의 이름표(사번은 쓰지 않는다 — 2026-11-23 대표)
const who = (p: { name: string }) => p.name;

export default function HrStatsPage() {
  return (
    <Suspense fallback={<div className="b2b-container"><div className="b2b-loading">불러오는 중...</div></div>}>
      <StatsMain />
    </Suspense>
  );
}

function StatsMain() {
  const router = useRouter();
  const params = useSearchParams();
  const qEnd = params.get("end") || "";
  const end = isMonth(qEnd) ? qEnd : todayKst().slice(0, 7);
  const qWp = params.get("workplace") || "";
  const qAff = params.get("affiliation") || "";

  const [b, setB] = useState<StatsBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      setB(await hrApi<StatsBundle>(`/api/hr/stats?end=${end}${qWp ? `&workplace=${qWp}` : ""}${qAff ? `&affiliation=${encodeURIComponent(qAff)}` : ""}`));
    } catch (err) {
      if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "통계를 불러오지 못했습니다."));
    }
    setLoading(false);
  }, [end, qWp, qAff]);
  useEffect(() => { load(); }, [load]);

  // 사업장을 바꾸면 소속은 푼다(소속 이름이 사업장마다 다르다)
  const go = (m: string, w?: string, a?: string) => {
    const wid = w ?? qWp;
    const aff = a ?? (w === undefined ? qAff : "");
    router.push(`/hr/stats?end=${m}${wid ? `&workplace=${wid}` : ""}${aff ? `&affiliation=${encodeURIComponent(aff)}` : ""}`);
  };

  const v = useMemo(() => {
    if (!b) return null;
    const labels = b.months.map(monthLabel);
    const cost = b.cost;
    const confirmed = (cost || []).filter((c) => c.confirmed);
    const last = confirmed[confirmed.length - 1] || null;
    const yearCost = confirmed.reduce((t, c) => t + laborCost(c.confirmed as CostAgg), 0);
    const pick = (f: (a: CostAgg) => number) => (cost || []).map((c) => (c.confirmed ? f(c.confirmed) : 0));
    const costSeries = [
      { key: "기본급", values: pick((a) => a.base) },
      { key: "주휴수당", values: pick((a) => a.weekly) },
      { key: "연장·야간·휴일 수당", values: pick((a) => a.premium) },
      { key: "연차·유급 휴일", values: pick((a) => a.paid_leave) },
      { key: "그 밖의 지급", values: pick((a) => a.extra) },
      { key: "회사 부담 4대보험", values: pick((a) => a.employer) },
    ];
    const h = b.hours.byMonth;
    const hourSeries = [
      { key: "일반 근무", values: h.map((x) => Math.max(0, Math.round((x.worked - x.overtime - x.holiday) * 100) / 100)) },
      { key: "연장", values: h.map((x) => x.overtime) },
      { key: "휴일 근무", values: h.map((x) => x.holiday) },
    ];
    const hoursTotal = h.reduce((t, x) => t + x.worked, 0);
    return { labels, cost, confirmed, last, yearCost, costSeries, h, hourSeries, hoursTotal };
  }, [b]);

  const range = b ? `${b.months[0]} ~ ${b.end}` : "";

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">통계</h1>
          {b && <p className="b2b-page-subtitle">{range}</p>}
        </div>
      </header>

      <div className="hr-filters">
        <button type="button" className="b2b-btn-secondary" onClick={() => go(shiftMonth(end, -1))}>이전 달</button>
        <input type="month" className="b2b-input hr-month" value={end} aria-label="끝 달" onChange={(e) => { if (isMonth(e.target.value)) go(e.target.value); }} />
        <button type="button" className="b2b-btn-secondary" onClick={() => go(shiftMonth(end, 1))}>다음 달</button>
        {b && b.workplaces.length > 1 && (
          <select className="b2b-input" value={b.workplace_id} onChange={(e) => go(end, e.target.value)} aria-label="사업장">
            <option value="">모든 사업장</option>
            {b.workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {b && b.affiliations.length > 0 && (
          <select className="b2b-input" value={b.affiliation} onChange={(e) => go(end, undefined, e.target.value)} aria-label="소속">
            <option value="">모든 소속</option>
            {b.affiliations.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>

      {error && <div className="b2b-error" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : error || !b || !v ? null : (
        <>
          {/* ── 인건비 ── */}
          <section className="hr-stats-sec">
            <h2>인건비</h2>
            {!v.cost ? (
              <div className="sm-warn">급여 표가 아직 없습니다. supabase/migrations/hr/003_payroll.sql 을 적용하면 보입니다.</div>
            ) : (
              <>
                <p className="hr-rule">지급 합계 + 회사 부담 4대보험. 급여를 확정한 달만 더합니다. 작성 중인 달은 표에 흐리게 보입니다.</p>
                {v.last?.confirmed ? (
                  <div className="hr-tiles">
                    {([
                      [`${monthLabel(v.last.month)} 인건비`, won(laborCost(v.last.confirmed)), `${v.last.confirmed.people}명`],
                      [`${monthLabel(v.last.month)} 지급 합계`, won(v.last.confirmed.pay_total), `실수령 ${won(v.last.confirmed.net_pay)}`],
                      [`${monthLabel(v.last.month)} 회사 부담`, won(v.last.confirmed.employer), "4대보험"],
                      ["1인당 지급", won(v.last.confirmed.people ? v.last.confirmed.pay_total / v.last.confirmed.people : 0), `${monthLabel(v.last.month)} 평균`],
                      ["기간 합계", won(v.yearCost), `확정한 ${v.confirmed.length}개 달`],
                    ] as const).map(([label, value, hint]) => (
                      <div key={label} className="b2b-stat-card">
                        <div className="b2b-stat-card-label">{label}</div>
                        <div className="b2b-stat-card-value">{value}</div>
                        <div className="b2b-stat-card-hint">{hint}</div>
                      </div>
                    ))}
                  </div>
                ) : <div className="b2b-empty">이 기간에 확정한 급여가 없습니다.</div>}
                {v.confirmed.length > 0 && (
                  <div className="b2b-card hr-stats-card">
                    <div className="b2b-card-head"><span className="b2b-card-title">달별 인건비 구성</span></div>
                    <StackedBar periods={v.labels} series={v.costSeries} fmtAxis={moneyCompact} unit="원" />
                    <ChartLegend items={v.costSeries.map((s, i) => [s.key, PIE_COLORS[i % PIE_COLORS.length]])} />
                  </div>
                )}
                {/* 소속별 인건비 — 기간 안의 확정한 달을 더한 것. 소속을 쓰지 않거나 소속 하나를 골랐으면 나오지 않는다 */}
                {b.costByAff && b.costByAff.length > 0 && (() => {
                  const all = b.costByAff.reduce((t, a) => t + a.pay_total + a.employer, 0);
                  return (
                    <div className="b2b-card hr-stats-card">
                      <div className="b2b-card-head"><span className="b2b-card-title">소속별 인건비 · 확정한 {v.confirmed.length}개 달 합계</span></div>
                      <div className="b2b-table-wrap">
                        <table className="b2b-table hr-table">
                          <thead><tr><th>소속</th><th className="num">인원</th><th className="num">지급 합계</th><th className="num">회사 부담</th><th className="num">인건비</th><th className="num">비중</th></tr></thead>
                          <tbody>
                            {b.costByAff.map((a) => (
                              <tr key={a.name || "-"}>
                                <td>{a.name || <span className="sm-faint">소속 없음</span>}</td>
                                <td className="num">{a.people}명</td>
                                <td className="num">{won(a.pay_total)}</td>
                                <td className="num">{won(a.employer)}</td>
                                <td className="num"><strong>{won(a.pay_total + a.employer)}</strong></td>
                                <td className="num">{all > 0 ? `${Math.round(((a.pay_total + a.employer) / all) * 1000) / 10}%` : ""}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}
                {v.cost.some((c) => c.confirmed || c.draft) && (
                  <div className="b2b-table-wrap">
                    <table className="b2b-table hr-table hr-stats-table">
                      <thead><tr><th>달</th>{v.cost.map((c) => <th key={c.month} className="num">{monthLabel(c.month)}</th>)}</tr></thead>
                      <tbody>
                        <tr><td>상태</td>{v.cost.map((c) => <td key={c.month} className="num">{c.confirmed ? "확정" : c.draft ? <span className="sm-faint">작성 중</span> : ""}</td>)}</tr>
                        {([
                          ["인원", (a: CostAgg) => `${a.people}`],
                          ["지급 합계", (a: CostAgg) => won(a.pay_total)],
                          ["공제 합계", (a: CostAgg) => won(a.deduct_total)],
                          ["실수령", (a: CostAgg) => won(a.net_pay)],
                          ["회사 부담", (a: CostAgg) => won(a.employer)],
                          ["인건비", (a: CostAgg) => won(laborCost(a))],
                        ] as const).map(([label, f]) => (
                          <tr key={label} className={label === "인건비" ? "hr-pay-sum" : ""}>
                            <td>{label}</td>
                            {v.cost!.map((c) => <td key={c.month} className={`num ${c.confirmed ? "" : "sm-faint"}`}>{c.confirmed ? f(c.confirmed) : c.draft ? f(c.draft) : ""}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>

          {/* ── 근무 시간 ── */}
          <section className="hr-stats-sec">
            <h2>근무 시간</h2>
            {v.hoursTotal <= 0 ? <div className="b2b-empty">이 기간에 근무대장 기록이 없습니다.</div> : (
              <>
                <p className="hr-rule">근무대장에서 계산한 시간. 연장·휴일 근무는 근무 시간 안에 들어 있고, 야간과 주휴는 따로 셉니다.</p>
                <div className="hr-stats-grid">
                  <div className="b2b-card hr-stats-card">
                    <div className="b2b-card-head"><span className="b2b-card-title">달별 근무 시간</span></div>
                    <StackedBar periods={v.labels} series={v.hourSeries} unit="시간" />
                    <ChartLegend items={v.hourSeries.map((s, i) => [s.key, PIE_COLORS[i % PIE_COLORS.length]])} />
                  </div>
                  <BarList title="연장 시간이 많은 직원" caption="이 기간 합계" sorted fmt={(n) => `${hoursText(n)}시간`} empty="연장 근무가 없습니다"
                    data={b.hours.byPerson.filter((p) => p.overtime > 0).sort((x, y) => y.overtime - x.overtime).slice(0, 10).map((p) => [who(p), p.overtime] as [string, number])} />
                </div>
                <div className="b2b-table-wrap">
                  <table className="b2b-table hr-table hr-stats-table">
                    <thead><tr><th>달</th>{v.h.map((x) => <th key={x.month} className="num">{monthLabel(x.month)}</th>)}</tr></thead>
                    <tbody>
                      {([
                        ["근무 인원", (x: (typeof v.h)[number]) => (x.people ? `${x.people}` : "")],
                        ["근무 시간", (x: (typeof v.h)[number]) => (x.worked ? hoursText(x.worked) : "")],
                        ["연장", (x: (typeof v.h)[number]) => (x.worked ? hoursText(x.overtime) : "")],
                        ["야간", (x: (typeof v.h)[number]) => (x.worked ? hoursText(x.night) : "")],
                        ["휴일 근무", (x: (typeof v.h)[number]) => (x.worked ? hoursText(x.holiday) : "")],
                        ["주휴", (x: (typeof v.h)[number]) => (x.worked ? hoursText(x.weekly) : "")],
                        ["1인당 근무 시간", (x: (typeof v.h)[number]) => (x.people ? hoursText(Math.round((x.worked / x.people) * 10) / 10) : "")],
                        ["결근(일)", (x: (typeof v.h)[number]) => (x.absentDays ? `${x.absentDays}` : x.worked ? "0" : "")],
                      ] as const).map(([label, f]) => (
                        <tr key={label}><td>{label}</td>{v.h.map((x) => <td key={x.month} className="num">{f(x)}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          {/* ── 인원 ── */}
          <section className="hr-stats-sec">
            <h2>인원</h2>
            {b.people.byMonth.every((p) => p.active === 0 && p.hired === 0 && p.left === 0) ? <div className="b2b-empty">이 기간에 재직한 직원이 없습니다.</div> : (
              <>
                <p className="hr-rule">재직 = 그 달 말일(진행 중인 달은 오늘)에 재직한 사람 수. 아래 구성은 {monthLabel(b.end)} 재직자 {b.people.mix.active}명 기준입니다.</p>
                <div className="b2b-card hr-stats-card">
                  <div className="b2b-card-head"><span className="b2b-card-title">달별 재직 인원</span></div>
                  <TrendChart data={b.people.byMonth.map((p) => ({ label: monthLabel(p.month), value: p.active, tip: `${p.month} · 재직 ${p.active}명 · 입사 ${p.hired} · 퇴사 ${p.left}` }))} />
                </div>
                <div className="b2b-table-wrap">
                  <table className="b2b-table hr-table hr-stats-table">
                    <thead><tr><th>달</th>{b.people.byMonth.map((p) => <th key={p.month} className="num">{monthLabel(p.month)}</th>)}</tr></thead>
                    <tbody>
                      <tr><td>재직</td>{b.people.byMonth.map((p) => <td key={p.month} className="num">{p.active || ""}</td>)}</tr>
                      <tr><td>입사</td>{b.people.byMonth.map((p) => <td key={p.month} className="num">{p.hired || ""}</td>)}</tr>
                      <tr><td>퇴사</td>{b.people.byMonth.map((p) => <td key={p.month} className="num">{p.left || ""}</td>)}</tr>
                    </tbody>
                  </table>
                </div>
                {b.people.mix.active > 0 && (
                  <div className="hr-stats-grid is-three">
                    <PieCard title="고용 형태" data={b.people.mix.empType} fmt={(n) => `${n}명`} />
                    <PieCard title="급여 형태" data={b.people.mix.payType} fmt={(n) => `${n}명`} />
                    <PieCard title="근속" data={b.people.mix.tenure} fmt={(n) => `${n}명`} />
                  </div>
                )}
              </>
            )}
          </section>

          {/* ── 연차 ── */}
          <section className="hr-stats-sec">
            <h2>연차</h2>
            {!b.leave ? (
              <div className="sm-warn">연차 표가 아직 없습니다. supabase/migrations/hr/004_leave.sql 을 적용하면 보입니다.</div>
            ) : b.leave.people === 0 ? <div className="b2b-empty">발생한 연차가 없습니다. 연차 화면을 한 번 열면 오늘까지 생긴 연차가 들어옵니다.</div> : (
              <>
                <p className="hr-rule">오늘({b.today}) 기준, 재직자의 지금 쓸 수 있는 연차. 곧 소멸은 60일 안에 끝나는 연차의 남은 일수입니다.</p>
                <div className="hr-tiles">
                  {([
                    ["대상", `${b.leave.people}명`, ""],
                    ["발생", `${dayText(b.leave.granted)}일`, ""],
                    ["사용", `${dayText(b.leave.used)}일`, b.leave.granted > 0 ? `사용률 ${Math.round((b.leave.used / b.leave.granted) * 100)}%` : ""],
                    ["잔여", `${dayText(b.leave.left)}일`, b.leave.people ? `1인당 ${dayText(Math.round((b.leave.left / b.leave.people) * 10) / 10)}일` : ""],
                    ["곧 소멸", `${dayText(b.leave.expiring)}일`, "60일 안"],
                  ] as const).map(([label, value, hint]) => (
                    <div key={label} className="b2b-stat-card">
                      <div className="b2b-stat-card-label">{label}</div>
                      <div className="b2b-stat-card-value">{value}</div>
                      {hint && <div className="b2b-stat-card-hint">{hint}</div>}
                    </div>
                  ))}
                </div>
                <div className="hr-stats-grid">
                  <div className="b2b-card hr-stats-card">
                    <div className="b2b-card-head"><span className="b2b-card-title">달별 연차 사용(일)</span></div>
                    <TrendChart data={v.h.map((x) => ({ label: monthLabel(x.month), value: x.leaveDays, tip: `${x.month} · ${dayText(x.leaveDays)}일` }))} />
                  </div>
                  <BarList title="잔여 연차가 많은 직원" caption="오늘 기준" sorted fmt={(n) => `${dayText(n)}일`} empty="남은 연차가 없습니다"
                    data={b.leave.byPerson.filter((p) => p.left > 0).sort((x, y) => y.left - x.left).slice(0, 10).map((p) => [who(p), p.left] as [string, number])} />
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
