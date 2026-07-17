"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { GUIDE, GUIDE_UPDATED, type GuideEntry } from "@/app/lib/guide-data";

// 사용 가이드 — 전 기능의 사용 단계. 검색은 메뉴명·설명·단계·검색어 전체를 훑는다.
//  데이터는 app/lib/guide-data.ts 하나 — 기능이 바뀌면 그 커밋에서 같이 고친다(CLAUDE.md 규칙).

function matches(e: GuideEntry, q: string): boolean {
  const hay = [e.label, e.what, ...e.steps, ...(e.tips || []), ...(e.keywords || [])].join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export default function GuidePage() {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const view = useMemo(() => {
    if (!query) return GUIDE;
    return GUIDE.map((cat) => ({
      ...cat,
      tools: cat.tools
        .map((t) => ({ ...t, entries: t.entries.filter((e) => matches(e, query)) }))
        .filter((t) => t.entries.length > 0),
    })).filter((cat) => cat.tools.length > 0);
  }, [query]);

  const hitCount = useMemo(
    () => (query ? view.reduce((s, c) => s + c.tools.reduce((s2, t) => s2 + t.entries.length, 0), 0) : 0),
    [view, query]
  );

  return (
    <div className="b2b-container" style={{ maxWidth: 860 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">사용 가이드</h1>
          <p className="b2b-page-subtitle">마지막 갱신 {GUIDE_UPDATED}</p>
        </div>
      </header>

      <input
        type="search"
        className="b2b-input"
        placeholder="검색 — 예: 재고 조정, 발주 등록, 매출 업로드"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        style={{ width: "100%", marginBottom: 6, fontSize: 14, padding: "11px 14px" }}
      />
      {query && (
        <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 10px" }}>
          {hitCount === 0 ? "결과 없음 — 다른 말로 검색해 보세요." : `${hitCount}개 항목`}
        </p>
      )}

      {view.map((cat) => (
        <section key={cat.category} style={{ marginTop: 18 }}>
          <h2 style={{ fontSize: 13, fontWeight: 800, color: "var(--sm-text-mid)", margin: "0 0 8px 2px", letterSpacing: 0.3 }}>{cat.category}</h2>
          {cat.tools.map((t) => (
            <div key={t.tool} className="b2b-card" style={{ marginBottom: 10 }}>
              <div className="b2b-card-head"><span className="b2b-card-title">{t.tool}</span></div>
              {t.entries.map((e, i) => (
                <details key={e.href + e.label} open={!!query} style={{ borderTop: i > 0 ? "1px solid var(--sm-border)" : "none" }}>
                  <summary style={{ padding: "10px 4px", cursor: "pointer", fontSize: 13.5 }}>
                    <strong style={{ color: "var(--sm-text)" }}>{e.label}</strong>
                    <span style={{ marginLeft: 8, fontSize: 12.5, color: "var(--sm-text-mid)" }}>{e.what}</span>
                  </summary>
                  <div style={{ padding: "0 4px 12px 22px" }}>
                    <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9, color: "var(--sm-text)" }}>
                      {e.steps.map((s, j) => <li key={j}>{s}</li>)}
                    </ol>
                    {(e.tips || []).length > 0 && (
                      <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, lineHeight: 1.8, color: "var(--sm-warning)" }}>
                        {e.tips!.map((tip, j) => <li key={j}>{tip}</li>)}
                      </ul>
                    )}
                    <Link href={e.href} className="sm-link" style={{ display: "inline-block", marginTop: 8, fontSize: 12 }}>화면 열기 →</Link>
                  </div>
                </details>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
