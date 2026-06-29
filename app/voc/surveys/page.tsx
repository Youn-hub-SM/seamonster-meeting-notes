"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { SurveyResponse } from "@/app/lib/surveys";

export default function VocSurveysPage() {
  const [rows, setRows] = useState<SurveyResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<SurveyResponse | null>(null);

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

  async function remove(r: SurveyResponse) {
    if (!window.confirm("이 응답을 삭제할까요?")) return;
    try {
      const res = await fetch(`/api/voc/surveys?id=${encodeURIComponent(r.id)}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "삭제 실패");
      setView(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설문 응답 수집</h1>
          <p className="b2b-page-subtitle">Tally 등 설문 폼 응답을 모읍니다. (불만 클레임은 <Link href="/voc" className="change-link">처리 상태</Link>에서 별도 관리)</p>
        </div>
        <div className="b2b-page-actions">
          <Link href="/voc/settings" className="b2b-btn-secondary">연동 설정</Link>
          <button className="b2b-btn-primary" onClick={load} disabled={loading}>새로고침</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("survey") || error.includes("relation")) ? " — supabase/migrations/025_survey_responses.sql 를 먼저 적용하세요." : ""}</div>}

      <div className="prod-range-tabs" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <span className="sm-faint" style={{ fontSize: 13, alignSelf: "center" }}>총 {rows.length}건</span>
        <input className="b2b-input" placeholder="응답·응답자·폼 검색" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220, marginLeft: "auto" }} />
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : shown.length === 0 ? (
        <div className="b2b-empty"><div className="b2b-empty-icon">📋</div>{rows.length === 0 ? <>아직 수집된 응답이 없습니다. <Link href="/voc/settings" className="change-link">연동 설정</Link>에서 Tally를 연결하고 가져오세요.</> : "조건에 맞는 응답이 없습니다."}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr><th>제출일</th><th>응답자</th><th>폼</th><th>응답 요약</th><th className="num">사진</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => setView(r)} style={{ cursor: "pointer" }}>
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
      )}

      {view && (
        <div className="b2b-modal-backdrop" onClick={() => setView(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">설문 응답 · {(view.submitted_at || view.created_at)?.slice(0, 10)}</span>
              <button className="b2b-modal-close" onClick={() => setView(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>{view.form_name || view.form_id || "설문"} · 응답자 {view.respondent || "미상"}</div>
              <div style={{ border: "1px solid var(--sm-border)", borderRadius: 8, overflow: "hidden" }}>
                {(view.answers || []).map((a, i) => (
                  <div key={i} style={{ display: "flex", borderBottom: "1px solid var(--sm-border)" }}>
                    <div style={{ width: 150, flexShrink: 0, padding: "8px 10px", background: "var(--sm-bg-subtle)", fontWeight: 700, fontSize: 13 }}>{a.label || "-"}</div>
                    <div style={{ flex: 1, padding: "8px 10px", fontSize: 13, whiteSpace: "pre-wrap" }}>{a.value || "-"}</div>
                  </div>
                ))}
              </div>
              {view.photos?.length > 0 && (
                <div className="sm-col" style={{ gap: 8, marginTop: 12 }}>
                  <span className="b2b-field-label">첨부 사진 ({view.photos.length})</span>
                  <div className="sm-row-wrap" style={{ gap: 8 }}>
                    {view.photos.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noreferrer"><img src={url} alt="첨부" style={{ width: 90, height: 90, objectFit: "cover", borderRadius: 8, border: "1px solid var(--sm-border)" }} /></a>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="b2b-modal-foot">
              <button className="b2b-btn-secondary" onClick={() => remove(view)} style={{ color: "var(--sm-danger)" }}>삭제</button>
              <div className="b2b-modal-foot-right"><button className="b2b-btn-secondary" onClick={() => setView(null)}>닫기</button></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
