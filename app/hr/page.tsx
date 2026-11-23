"use client";

// 첫 화면 — 오늘의 근무 현황 · 세무 일정 · 해야 할 일. 읽기만 하는 화면이고, 줄을 누르면 그 일을 하는 화면으로 간다.
//  계산은 app/lib/hr-home.ts(서버가 같은 함수로 만들어 보낸다). 한 구역이 실패해도 나머지 구역은 보인다.
//  인사대장은 /hr/employees 로 옮겼다(2026-11-23).

import { useEffect, useState } from "react";
import Link from "next/link";
import { WEEKDAYS, numText } from "@/app/lib/hr";
import { weekdayOf } from "@/app/lib/hr-work";
import { HOLIDAY_KIND_LABEL } from "@/app/lib/hr-holidays";
import { mdText, namesText, type HomeBundle, type TodayPerson } from "@/app/lib/hr-home";
import { HrApiError, errText, hrApi } from "./api";

const dayText = (d: string) => `${mdText(d)} (${WEEKDAYS[weekdayOf(d) - 1]})`;
const ddayLabel = (n: number) => (n === 0 ? "오늘" : `D-${n}`);
const who = (p: TodayPerson) => (p.workplace ? `${p.name} · ${p.workplace}` : p.name);

export default function HrHomePage() {
  const [b, setB] = useState<HomeBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try { setB(await hrApi<HomeBundle>("/api/hr/home")); }
      catch (err) { if (!(err instanceof HrApiError && err.status === 401)) setError(errText(err, "첫 화면을 불러오지 못했습니다.")); }
      setLoading(false);
    })();
  }, []);

  const s = b?.status || null;
  const multi = (s?.byWorkplace.length || 0) > 1;
  const tiles: [string, string, string][] = s ? [
    ["재직", `${s.active}명`, multi ? s.byWorkplace.map((w) => `${w.name} ${w.active}`).join(" · ") : ""],
    ["근무 예정", `${s.scheduled}명`, multi ? s.byWorkplace.map((w) => `${w.name} ${w.scheduled}`).join(" · ") : ""],
    ["연차", `${s.onLeave.length}명`, namesText(s.onLeave.map((p) => p.name))],
    ...s.dayOff.map((d): [string, string, string] => [HOLIDAY_KIND_LABEL[d.kind], `${d.people}명`, d.name]),
    ...(s.absent.length > 0 ? [["결근", `${s.absent.length}명`, namesText(s.absent.map((p) => p.name))] as [string, string, string]] : []),
    ...(s.logged > 0 ? [["근무 기록", `${s.logged}명`, "오늘 근무대장"] as [string, string, string]] : []),
  ] : [];

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">{b ? `${Number(b.today.slice(0, 4))}년 ${dayText(b.today)}` : "오늘"}</h1></div>
      </header>

      {error && <div className="b2b-error" role="alert">{error}</div>}
      {loading ? <div className="b2b-loading">불러오는 중...</div> : !b ? null : (
        <>
          <section className="hr-home-sec">
            <h2>오늘의 근무 현황</h2>
            {b.errors.status && <div className="b2b-error" role="alert">{b.errors.status}</div>}
            {s && (
              <>
                <div className="hr-tiles">
                  {tiles.map(([label, value, hint]) => (
                    <div key={`${label}:${hint}`} className="b2b-stat-card">
                      <div className="b2b-stat-card-label">{label}</div>
                      <div className="b2b-stat-card-value">{value}</div>
                      <div className="b2b-stat-card-hint">{hint}</div>
                    </div>
                  ))}
                </div>
                {(s.onLeave.length > 0 || s.absent.length > 0 || s.upcoming.length > 0) && (
                  <div className="hr-home-grid">
                    {(s.onLeave.length > 0 || s.absent.length > 0) && (
                      <div>
                        <h3 className="hr-home-sub">오늘 쉬는 직원</h3>
                        <ul className="hr-home-list">
                          {[...s.onLeave, ...s.absent].map((p) => (
                            <li key={`${p.id}:${p.text}`}><Link href="/hr/leave" prefetch={false} className="hr-home-row is-plain"><span className="hr-home-what"><strong>{who(p)}</strong></span><span className="hr-home-side">{p.text}</span></Link></li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {s.upcoming.length > 0 && (
                      <div>
                        <h3 className="hr-home-sub">7일 안의 연차</h3>
                        <ul className="hr-home-list">
                          {s.upcoming.map((p) => (
                            <li key={`${p.id}:${p.date}`}><Link href="/hr/leave" prefetch={false} className="hr-home-row"><span className="hr-home-when">{dayText(p.date)}</span><span className="hr-home-what"><strong>{who(p)}</strong></span><span className="hr-home-side">{p.text}</span></Link></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </section>

          <div className="hr-home-grid">
            <section className="hr-home-sec">
              <h2>세무 일정</h2>
              {b.errors.tax && <div className="b2b-error" role="alert">{b.errors.tax}</div>}
              {b.tax && (b.tax.length === 0 ? <div className="b2b-empty">가까운 일정이 없습니다.</div> : (
                <ul className="hr-home-list">
                  {b.tax.map((t) => (
                    <li key={t.key}>
                      <Link href={t.href} prefetch={false} className="hr-home-row">
                        <span className="hr-home-when">{dayText(t.date)}<span className={`b2b-status-pill ${t.dday <= 7 ? "hr-pill-bad" : "hr-pill-off"}`}>{ddayLabel(t.dday)}</span></span>
                        <span className="hr-home-what"><strong>{t.title}</strong><span>{t.detail}{t.moved ? " · 휴일이라 다음 영업일" : ""}</span></span>
                        <span className="hr-home-side">{t.amount !== null ? `${numText(t.amount)}원` : ""}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ))}
            </section>

            <section className="hr-home-sec">
              <h2>해야 할 일</h2>
              {b.errors.todos && <div className="b2b-error" role="alert">{b.errors.todos}</div>}
              {b.todos && (b.todos.length === 0 ? <div className="b2b-empty">지금 할 일이 없습니다.</div> : (
                <ul className="hr-home-list">
                  {b.todos.map((t) => (
                    <li key={t.key}>
                      <Link href={t.href} prefetch={false} className="hr-home-row is-plain">
                        <span className="hr-home-what"><strong>{t.text}</strong><span>{t.sub}</span></span>
                        <span className="hr-home-side"><span className={`b2b-status-pill ${t.level === "now" ? "hr-pill-bad" : "hr-pill-off"}`}>{t.level === "now" ? "지금" : "곧"}</span></span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ))}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
