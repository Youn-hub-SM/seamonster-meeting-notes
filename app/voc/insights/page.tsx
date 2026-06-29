"use client";

import { useState } from "react";

type Insight = {
  summary: string;
  patterns: { title: string; count: number; detail: string }[];
  rootCauses: { cause: string; detail: string }[];
  improvements: { action: string; effort: string; impact: string }[];
  riskAlerts: string[];
};

const EFFORT_COLOR: Record<string, string> = {
  낮음: "var(--sm-success)", 중간: "var(--sm-warning)", 높음: "var(--sm-danger)",
};

export default function VocInsightsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [insight, setInsight] = useState<Insight | null>(null);
  const [meta, setMeta] = useState<{ analyzed: number } | null>(null);

  async function run() {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/voc/insights", { method: "POST" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setInsight(j.insight);
      setMeta({ analyzed: j.analyzed });
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setLoading(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">VOC AI 인사이트</h1>
          <p className="b2b-page-subtitle">접수된 클레임을 AI가 읽고 반복 패턴·근본 원인·개선책을 뽑아줍니다.</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={run} disabled={loading}>{loading ? "분석 중..." : insight ? "다시 분석" : "AI 분석 실행"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {loading ? (
        <div className="b2b-card"><div className="b2b-empty" style={{ padding: "40px 20px" }}><div className="b2b-empty-icon">🧠</div>클레임을 분석하는 중입니다… (최대 1분)</div></div>
      ) : !insight ? (
        <div className="b2b-card">
          <div className="b2b-empty" style={{ padding: "48px 20px", textAlign: "center" }}>
            <div className="b2b-empty-icon">💡</div>
            <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 15 }}>아직 분석 결과가 없습니다</div>
            <div className="sm-muted" style={{ maxWidth: 520, margin: "0 auto", lineHeight: 1.65 }}>
              위의 <strong>AI 분석 실행</strong> 버튼을 누르면 최근 클레임을 모아 반복 패턴과 개선책을 정리해 드립니다.
            </div>
          </div>
        </div>
      ) : (
        <div className="sm-col" style={{ gap: 14 }}>
          {meta && <div className="sm-faint" style={{ fontSize: 12 }}>최근 {meta.analyzed}건 기준 분석</div>}

          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">📋 종합 진단</span></div>
            <p style={{ lineHeight: 1.7, fontSize: 14 }}>{insight.summary}</p>
          </section>

          {insight.riskAlerts?.length > 0 && (
            <section className="b2b-card" style={{ borderColor: "var(--sm-danger-border)", background: "var(--sm-danger-bg)" }}>
              <div className="b2b-card-head"><span className="b2b-card-title" style={{ color: "var(--sm-danger)" }}>⚠ 즉시 대응 필요</span></div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 14 }}>
                {insight.riskAlerts.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </section>
          )}

          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">🔁 반복 패턴</span></div>
              <div className="sm-col" style={{ gap: 10 }}>
                {(insight.patterns || []).map((p, i) => (
                  <div key={i} className="sm-col" style={{ gap: 2 }}>
                    <div className="sm-between"><strong style={{ fontSize: 14 }}>{p.title}</strong><span className="b2b-feed-pill" style={{ background: "var(--sm-info-bg)", color: "var(--sm-info)" }}>{p.count}건</span></div>
                    <div className="sm-muted" style={{ fontSize: 13 }}>{p.detail}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">🎯 근본 원인</span></div>
              <div className="sm-col" style={{ gap: 10 }}>
                {(insight.rootCauses || []).map((c, i) => (
                  <div key={i} className="sm-col" style={{ gap: 2 }}>
                    <strong style={{ fontSize: 14 }}>{c.cause}</strong>
                    <div className="sm-muted" style={{ fontSize: 13 }}>{c.detail}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">✅ 개선 제안</span></div>
            <div className="sm-col" style={{ gap: 12 }}>
              {(insight.improvements || []).map((m, i) => (
                <div key={i} className="sm-row" style={{ gap: 10, alignItems: "flex-start" }}>
                  <span className="b2b-feed-pill" style={{ background: "var(--sm-bg-subtle)", color: EFFORT_COLOR[m.effort] || "var(--sm-text-mid)", flexShrink: 0 }}>{m.effort || "—"}</span>
                  <div className="sm-col" style={{ gap: 2 }}>
                    <strong style={{ fontSize: 14 }}>{m.action}</strong>
                    <div className="sm-muted" style={{ fontSize: 13 }}>{m.impact}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
