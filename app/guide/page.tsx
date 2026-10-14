"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { GUIDE, GUIDE_UPDATED } from "@/app/lib/guide-data";
import { matchesGuideEntry as matches } from "@/app/lib/guide-search";

// 사용 가이드 — 전 기능의 사용 단계. 검색은 메뉴명·설명·단계·검색어 전체를 훑는다.
//  데이터는 app/lib/guide-data.ts 하나 — 기능이 바뀌면 그 커밋에서 같이 고친다(CLAUDE.md 규칙).
//  ?q= 는 홈 '가이드 검색'(2026-10-14 D4)·전역 검색(Ctrl+K)이 넘기는 검색어 — 검색칸 초기값으로만 쓴다(useSearchParams 는 Suspense 경계 필요, 로그인 화면과 같은 구조).
//  매처(초성·영문자판)는 app/lib/guide-search.ts — 전역 검색 '가이드' 묶음과 같은 규칙을 쓴다.

export default function GuidePage() {
  return (
    <Suspense fallback={<div className="b2b-loading">불러오는 중...</div>}>
      <GuideInner />
    </Suspense>
  );
}

function GuideInner() {
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") || "");
  const query = q.trim(); // 소문자화는 공용 매처가 한다 — 미리 낮추면 시프트 자모(ㄲㅆ)를 잃는다

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
        placeholder="검색"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        style={{ width: "100%", marginBottom: 6, fontSize: 13, padding: "11px 14px" }}
      />
      {query && (
        <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 10px" }}>
          {hitCount === 0 ? "결과 없음" : `${hitCount}개 항목`}
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
                  <summary style={{ padding: "10px 4px", cursor: "pointer", fontSize: 13 }}>
                    <strong style={{ color: "var(--sm-dark)" }}>{e.label}</strong>
                    <span style={{ marginLeft: 8, fontSize: 12, color: "var(--sm-text-mid)" }}>{e.what}</span>
                  </summary>
                  <div style={{ padding: "0 4px 12px 22px" }}>
                    <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9, color: "var(--sm-text-mid)" }}>
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
