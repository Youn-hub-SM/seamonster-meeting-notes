"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { SurveyResponse } from "@/app/lib/surveys";

type View = "목록" | "분석";
type Insight = {
  summary: string; sentiment: string;
  highlights: { point: string; detail: string }[];
  improvements: { point: string; detail: string }[];
  quotes: string[];
};

export default function VocSurveysPage() {
  const [rows, setRows] = useState<SurveyResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("목록");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<SurveyResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [insight, setInsight] = useState<Insight | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/voc/surveys", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${r.summary || ""} ${r.respondent || ""} ${r.form_name || ""}`.toLowerCase().includes(q));
  }, [rows, search]);

  // 질문별 답변 분포(쉼표·줄바꿈으로 복수응답 분리해 집계)
  const questions = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, Map<string, number>>();
    for (const r of rows) for (const a of r.answers || []) {
      const label = a.label || "(질문 없음)";
      if (!map.has(label)) { map.set(label, new Map()); order.push(label); }
      const m = map.get(label)!;
      const tokens = String(a.value || "").split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
      for (const t of (tokens.length ? tokens : ["(무응답)"])) m.set(t, (m.get(t) || 0) + 1);
    }
    return order.map((label) => ({ label, dist: [...map.get(label)!.entries()].sort((a, b) => b[1] - a[1]) }));
  }, [rows]);

  async function runAi() {
    setAiLoading(true); setError("");
    try {
      const res = await fetch("/api/voc/surveys/insights", { method: "POST" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setInsight(j.insight);
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setAiLoading(false);
  }

  async function remove(r: SurveyResponse) {
    if (!window.confirm("이 응답을 삭제할까요?")) return;
    try {
      const res = await fetch(`/api/voc/surveys?id=${encodeURIComponent(r.id)}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "삭제 실패");
      setDetail(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설문 응답 수집</h1>
          <p className="b2b-page-subtitle">Tally 등 설문 응답을 모으고 분석합니다. (불만 클레임은 <Link href="/voc" className="sm-link">처리 상태</Link>)</p>
        </div>
        <div className="b2b-page-actions">
          <Link href="/voc/settings" className="b2b-btn-secondary">연동 설정</Link>
          <button className="b2b-btn-primary" onClick={load} disabled={loading}>새로고침</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("survey") || error.includes("relation")) ? " — supabase/migrations/025_survey_responses.sql 를 먼저 적용하세요." : ""}</div>}

      <div className="sm-tabbar" style={{ marginBottom: 12 }}>
        {(["목록", "분석"] as View[]).map((v) => (
          <button key={v} className={`sm-tab ${view === v ? "is-active" : ""}`} onClick={() => setView(v)}>{v}</button>
        ))}
        <span className="sm-faint" style={{ fontSize: 13, alignSelf: "center" }}>총 {rows.length}건</span>
        {view === "목록" && <input className="b2b-input sm-tab-search" placeholder="검색" value={search} onChange={(e) => setSearch(e.target.value)} />}
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div className="b2b-empty">아직 수집된 응답이 없습니다. <Link href="/voc/settings" className="sm-link">연동 설정</Link>에서 가져오세요.</div>
      ) : view === "목록" ? (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr><th>제출일</th><th>응답자</th><th>폼</th><th>응답 요약</th><th className="num">사진</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => setDetail(r)} style={{ cursor: "pointer" }}>
                  <td style={{ whiteSpace: "nowrap" }}>{(r.submitted_at || r.created_at)?.slice(0, 10)}</td>
                  <td>{r.respondent || "-"}</td>
                  <td>{r.form_name || r.form_id || "-"}</td>
                  <td style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.summary || "-"}</td>
                  <td className="num">{r.photos?.length || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {/* AI 요약 */}
          <section className="b2b-card">
            <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="b2b-card-title">AI 요약</span>
              <button className="b2b-btn-primary" onClick={runAi} disabled={aiLoading} style={{ padding: "6px 14px" }}>{aiLoading ? "분석 중…" : insight ? "다시 분석" : "AI 분석 실행"}</button>
            </div>
            {!insight ? (
              <p className="sm-muted" style={{ fontSize: 13 }}>버튼을 누르면 자유서술 답변까지 읽어 만족 요인·개선점·인용을 정리합니다.</p>
            ) : (
              <div className="sm-col" style={{ gap: 12 }}>
                <p style={{ fontSize: 14, lineHeight: 1.7 }}>{insight.summary} {insight.sentiment && <span className="sm-faint">· {insight.sentiment}</span>}</p>
                <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
                  <div><div className="b2b-field-label" style={{ marginBottom: 6 }}>만족 요인</div><ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: 13 }}>{(insight.highlights || []).map((h, i) => <li key={i}><strong>{h.point}</strong> — {h.detail}</li>)}</ul></div>
                  <div><div className="b2b-field-label" style={{ marginBottom: 6 }}>개선점</div><ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: 13 }}>{(insight.improvements || []).map((h, i) => <li key={i}><strong>{h.point}</strong> — {h.detail}</li>)}</ul></div>
                </div>
                {insight.quotes?.length > 0 && (
                  <div><div className="b2b-field-label" style={{ marginBottom: 6 }}>인용</div>
                    <div className="sm-col" style={{ gap: 6 }}>{insight.quotes.map((q, i) => <div key={i} style={{ fontSize: 13, padding: "8px 12px", background: "var(--sm-bg-subtle)", borderRadius: 8, borderLeft: "3px solid var(--sm-orange)" }}>“{q}”</div>)}</div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 질문별 분포 */}
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginTop: 14 }}>
            {questions.map((q) => {
              const max = Math.max(...q.dist.map((d) => d[1]), 1);
              return (
                <section key={q.label} className="b2b-card">
                  <div className="b2b-card-head"><span className="b2b-card-title" style={{ fontSize: 14 }}>{q.label}</span></div>
                  <div className="sm-col" style={{ gap: 7 }}>
                    {q.dist.slice(0, 12).map(([val, n]) => (
                      <div key={val} className="sm-col" style={{ gap: 3 }}>
                        <div className="sm-between" style={{ fontSize: 13, gap: 8 }}>
                          <span className="sm-ellipsis" style={{ maxWidth: "78%" }}>{val}</span>
                          <span style={{ whiteSpace: "nowrap" }}><strong>{n}</strong> <span className="sm-faint">{Math.round((n / rows.length) * 100)}%</span></span>
                        </div>
                        <div style={{ height: 6, borderRadius: 4, background: "var(--sm-bg-subtle)", overflow: "hidden" }}><div style={{ height: "100%", width: `${Math.round((n / max) * 100)}%`, background: "var(--sm-orange)", borderRadius: 4 }} /></div>
                      </div>
                    ))}
                    {q.dist.length > 12 && <span className="sm-faint" style={{ fontSize: 12 }}>외 {q.dist.length - 12}종</span>}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}

      {detail && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">설문 응답 · {(detail.submitted_at || detail.created_at)?.slice(0, 10)}</span>
              <button className="b2b-modal-close" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>{detail.form_name || detail.form_id || "설문"} · 응답자 {detail.respondent || "미상"}</div>
              <div style={{ border: "1px solid var(--sm-border)", borderRadius: 8, overflow: "hidden" }}>
                {(detail.answers || []).map((a, i) => (
                  <div key={i} style={{ display: "flex", borderBottom: "1px solid var(--sm-border)" }}>
                    <div style={{ width: 150, flexShrink: 0, padding: "8px 10px", background: "var(--sm-bg-subtle)", fontWeight: 700, fontSize: 13 }}>{a.label || "-"}</div>
                    <div style={{ flex: 1, padding: "8px 10px", fontSize: 13, whiteSpace: "pre-wrap" }}>{a.value || "-"}</div>
                  </div>
                ))}
              </div>
              {detail.photos?.length > 0 && (
                <div className="sm-col" style={{ gap: 8, marginTop: 12 }}>
                  <span className="b2b-field-label">첨부 사진 ({detail.photos.length})</span>
                  <div className="sm-row-wrap" style={{ gap: 8 }}>
                    {detail.photos.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noreferrer"><img src={url} alt="첨부" style={{ width: 90, height: 90, objectFit: "cover", borderRadius: 8, border: "1px solid var(--sm-border)" }} /></a>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="b2b-modal-foot">
              <button className="b2b-btn-danger" onClick={() => remove(detail)}>삭제</button>
              <div className="b2b-modal-foot-right"><button className="b2b-btn-secondary" onClick={() => setDetail(null)}>닫기</button></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
