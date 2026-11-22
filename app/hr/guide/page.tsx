"use client";

// 사용 가이드 — 급여·연차 창을 쓰는 순서. 내용은 app/hr/guide-data.ts 한 곳에 있다.
//  업무도우미의 사용 가이드와 따로다(이 창은 그쪽 메뉴·검색·가이드에 올리지 않는다).

import { useMemo, useState } from "react";
import Link from "next/link";
import { HR_GUIDE, HR_GUIDE_UPDATED, type HrGuideEntry } from "../guide-data";

const hit = (e: HrGuideEntry, q: string) =>
  [e.label, e.what, ...e.steps, ...(e.tips || []), ...(e.keywords || [])].some((t) => t.toLowerCase().includes(q));

export default function HrGuidePage() {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const [allOpen, setAllOpen] = useState(false);

  const view = useMemo(() => {
    if (!query) return HR_GUIDE;
    return HR_GUIDE.map((g) => ({ ...g, entries: g.entries.filter((e) => hit(e, query)) })).filter((g) => g.entries.length > 0);
  }, [query]);
  const count = view.reduce((t, g) => t + g.entries.length, 0);

  return (
    <div className="b2b-container hr-guide">
      {/* 인쇄는 A4 세로, 모든 항목을 편 채로 */}
      <style>{`@media print { @page { size: A4 portrait; margin: 14mm; } }`}</style>

      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">사용 가이드</h1>
          <p className="b2b-page-subtitle">마지막 갱신 {HR_GUIDE_UPDATED}</p>
        </div>
        <div className="b2b-page-actions hr-noprint">
          <button type="button" className="b2b-btn-secondary" onClick={() => setAllOpen((v) => !v)}>{allOpen ? "모두 접기" : "모두 펴기"}</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => { setAllOpen(true); setTimeout(() => window.print(), 200); }}>가이드 인쇄</button>
        </div>
      </header>

      <input type="search" className="b2b-input hr-guide-search hr-noprint" placeholder="검색" aria-label="가이드 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      {query && <p className="hr-guide-count hr-noprint">{count === 0 ? "결과 없음" : `${count}개 항목`}</p>}

      {view.map((g) => (
        <section key={g.group} className="hr-guide-group">
          <h2>{g.group}</h2>
          <div className="hr-guide-card">
            {g.entries.map((e) => (
              // 검색 중이거나 [모두 펴기]면 편 채로 다시 그린다(key 가 바뀌면 사용자가 접어 둔 것도 따라 바뀐다)
              <details key={`${e.label}:${allOpen || !!query}`} open={allOpen || !!query}>
                <summary><strong>{e.label}</strong></summary>
                <div className="hr-guide-body">
                  <ol>{e.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                  {(e.tips || []).length > 0 && <ul>{e.tips!.map((t, i) => <li key={i}>{t}</li>)}</ul>}
                  {e.href && <Link href={e.href} prefetch={false} className="sm-link hr-noprint">화면 열기</Link>}
                </div>
              </details>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
