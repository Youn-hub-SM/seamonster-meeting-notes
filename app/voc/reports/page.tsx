"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { VOC_CATEGORIES, type Voc } from "@/app/lib/voc";

type Range = "전체" | "올해" | "90일" | "30일";
type Mode = "report" | "request";

function rangeStart(r: Range): string {
  if (r === "전체") return "0000-00-00";
  const now = new Date(Date.now() + 9 * 3600_000);
  if (r === "올해") return `${now.getFullYear()}-01-01`;
  const days = r === "90일" ? 90 : 30;
  return new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 10);
}
const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", borderBottom: "1px solid var(--sm-border)" }}>
      <div style={{ width: 110, flexShrink: 0, padding: "8px 10px", background: "var(--sm-bg-subtle)", fontWeight: 700, fontSize: 13 }}>{label}</div>
      <div style={{ flex: 1, padding: "8px 10px", fontSize: 13, whiteSpace: "pre-wrap", minHeight: 18 }}>{value || "-"}</div>
    </div>
  );
}

export default function VocReportsPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>("report");
  const [range, setRange] = useState<Range>("올해");
  const [pickId, setPickId] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/voc", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
      if (j.rows?.[0]) setPickId(j.rows[0].id);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const reportRows = useMemo(() => {
    const from = rangeStart(range);
    return rows.filter((r) => (r.received_at || "") >= from);
  }, [rows, range]);

  const summary = useMemo(() => {
    const total = reportRows.length;
    const done = reportRows.filter((r) => r.status === "완료").length;
    const loss = reportRows.reduce((s, r) => s + (r.loss_amount || 0), 0);
    const byCat = new Map<string, number>();
    for (const r of reportRows) byCat.set(r.category, (byCat.get(r.category) || 0) + 1);
    const cats = VOC_CATEGORIES.map((c) => [c, byCat.get(c) || 0] as [string, number]).filter(([, n]) => n > 0);
    return { total, done, open: total - done, loss, cats };
  }, [reportRows]);

  const picked = rows.find((r) => r.id === pickId) || null;
  const rangeLabel = range === "전체" ? "전체 기간" : range === "올해" ? "올해" : `최근 ${range}`;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div>
          <h1 className="b2b-page-title">VOC 보고서·요청서</h1>
          <p className="b2b-page-subtitle">기간 보고서 또는 제조사 전달용 개선요청서(사진 포함)를 만들어 인쇄·PDF로 저장합니다.</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || (mode === "request" && !picked)}>🖨 인쇄 / PDF 저장</button>
        </div>
      </header>

      {error && <div className="b2b-error no-print">{error}</div>}

      <div className="prod-range-tabs no-print" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <button className={`prod-range-tab ${mode === "report" ? "is-active" : ""}`} onClick={() => setMode("report")}>기간 보고서</button>
        <button className={`prod-range-tab ${mode === "request" ? "is-active" : ""}`} onClick={() => setMode("request")}>개선요청서</button>
      </div>

      {mode === "report" ? (
        <div className="prod-range-tabs no-print" style={{ marginBottom: 16, flexWrap: "wrap" }}>
          {(["30일", "90일", "올해", "전체"] as Range[]).map((r) => (
            <button key={r} className={`prod-range-tab ${range === r ? "is-active" : ""}`} onClick={() => setRange(r)}>{r === "전체" ? "전체" : `최근 ${r}`}</button>
          ))}
        </div>
      ) : (
        <div className="no-print" style={{ marginBottom: 16 }}>
          <select className="b2b-input" value={pickId} onChange={(e) => setPickId(e.target.value)} style={{ maxWidth: 480 }}>
            {rows.length === 0 && <option value="">등록된 VOC 없음</option>}
            {rows.map((r) => (
              <option key={r.id} value={r.id}>{r.received_at?.slice(5)} · {r.customer || "고객미상"} · {r.category} · {(r.content || "").slice(0, 24)}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : (
        <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "32px 34px", maxWidth: 900, boxShadow: "var(--sm-shadow-card)" }}>
          {/* 공통 문서 헤더 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div>
              <h2 style={{ fontSize: 24, fontWeight: 800, marginTop: 4 }}>{mode === "report" ? "VOC 처리 보고서" : "개선요청서"}</h2>
            </div>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>
              <div>작성일 {TODAY()}</div>
              {mode === "report" && <div>대상 기간 · {rangeLabel}</div>}
            </div>
          </div>

          {mode === "report" ? (
            reportRows.length === 0 ? (
              <div className="b2b-empty">해당 기간에 접수된 VOC가 없습니다.</div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 20 }}>
                  <Stat label="총 접수" value={`${summary.total}건`} />
                  <Stat label="완료" value={`${summary.done}건`} />
                  <Stat label="진행 중" value={`${summary.open}건`} />
                  <Stat label="총 손해/보상" value={`${summary.loss.toLocaleString()}원`} />
                </div>

                <h3 style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 8px" }}>유형별 건수</h3>
                <table className="b2b-table" style={{ marginBottom: 22 }}>
                  <thead><tr><th>클레임 유형</th><th className="num">건수</th><th className="num">비중</th></tr></thead>
                  <tbody>
                    {summary.cats.map(([c, n]) => (
                      <tr key={c}><td>{c}</td><td className="num">{n}</td><td className="num">{Math.round((n / summary.total) * 100)}%</td></tr>
                    ))}
                  </tbody>
                </table>

                <h3 style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 8px" }}>상세 내역</h3>
                <table className="b2b-table">
                  <thead><tr><th>접수일</th><th>채널</th><th>유형</th><th>내용</th><th>처리내용</th><th>상태</th></tr></thead>
                  <tbody>
                    {reportRows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(5)}</td>
                        <td>{r.channel || "-"}</td>
                        <td>{r.category}</td>
                        <td style={{ maxWidth: 240 }}>{r.content}</td>
                        <td style={{ maxWidth: 200 }}>{r.resolution || "-"}</td>
                        <td>{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )
          ) : !picked ? (
            <div className="b2b-empty">요청서로 만들 VOC를 위에서 선택하세요.</div>
          ) : (
            <>
              <div style={{ border: "1px solid var(--sm-border)", borderRadius: 8, overflow: "hidden" }}>
                <Field label="접수일" value={picked.received_at} />
                <Field label="제품 생산일" value={picked.production_date} />
                <Field label="CS 유형" value={picked.category} />
                <Field label="내용" value={picked.content} />
                {picked.product && <Field label="제품" value={picked.product} />}
              </div>
              {picked.photos && picked.photos.length > 0 && (
                <div className="voc-photos" style={{ marginTop: 24 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>첨부 사진 ({picked.photos.length}장)</h3>
                  {picked.photos.map((url, i) => (
                    <img key={i} src={url} alt={`첨부 ${i + 1}`} className="voc-photo"
                      style={{ width: "100%", maxHeight: 440, objectFit: "contain", borderRadius: 8, border: "1px solid var(--sm-border)", marginBottom: 14, display: "block", background: "var(--sm-bg-subtle)" }} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800 }}>{value}</div>
    </div>
  );
}
