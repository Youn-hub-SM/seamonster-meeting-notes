"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { VOC_CATEGORIES, type Voc } from "@/app/lib/voc";
import { Donut } from "@/app/components/charts";

// 제조사 제출용 개선요청서 — 기간(7/14/30일·직접지정) 동안의 클레임·손해를 모아 "이런 일이 있었고 이만큼 손해가 났으니 개선해달라" 형식으로 출력.
type RMode = "7일" | "14일" | "30일" | "custom";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
function presetStart(days: number): string {
  return new Date(Date.now() + 9 * 3600_000 - (days - 1) * 86400_000).toISOString().slice(0, 10);
}

export default function VocRequestPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<RMode>("14일");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [productFilter, setProductFilter] = useState<string>("");
  const [recipient, setRecipient] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/voc", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const products = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.product) s.add(r.product);
    return [...s].sort((a, b) => a.localeCompare(b, "ko"));
  }, [rows]);

  const { from, to } = useMemo(() => {
    if (mode === "custom") return { from: fromDate || "0000-00-00", to: toDate || TODAY() };
    const days = mode === "7일" ? 7 : mode === "14일" ? 14 : 30;
    return { from: presetStart(days), to: TODAY() };
  }, [mode, fromDate, toDate]);
  const items = useMemo(() => {
    return rows
      .filter((r) => { const d = r.received_at || ""; return d >= from && d <= to; })
      .filter((r) => !productFilter || r.product === productFilter)
      .sort((a, b) => (a.received_at || "").localeCompare(b.received_at || ""));
  }, [rows, from, to, productFilter]);

  const summary = useMemo(() => {
    const total = items.length;
    const loss = items.reduce((s, r) => s + (r.loss_amount || 0), 0);
    const byCat = new Map<string, number>();
    for (const r of items) byCat.set(r.category, (byCat.get(r.category) || 0) + 1);
    const cats = VOC_CATEGORIES.map((c) => [c, byCat.get(c) || 0] as [string, number]).filter(([, n]) => n > 0);
    return { total, loss, cats };
  }, [items]);

  // 기간 내 모든 사진(어느 건의 것인지 캡션과 함께)
  const photos = useMemo(() => items.flatMap((r) => (r.photos || []).map((url) => ({ url, label: `${r.received_at?.slice(5)} · ${r.category}` }))), [items]);

  const rangeLabel = mode === "custom" ? "직접지정" : `최근 ${mode}`;
  const periodText = `${from === "0000-00-00" ? "처음" : from} ~ ${to}`;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div>
          <h1 className="b2b-page-title">개선요청서</h1>
          <p className="b2b-page-subtitle">기간 동안의 클레임·손해를 모아 제조사 제출용 개선요청서(사진 포함)로 만들어 인쇄·PDF로 저장합니다.</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || items.length === 0}>🖨 인쇄 / PDF 저장</button>
        </div>
      </header>

      {error && <div className="b2b-error no-print">{error}</div>}

      {/* 컨트롤 */}
      <div className="no-print" style={{ marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div className="sm-tabs" style={{ margin: 0, flexWrap: "wrap" }}>
          {(["7일", "14일", "30일"] as RMode[]).map((m) => (
            <button key={m} className={`sm-tab ${mode === m ? "is-active" : ""}`} onClick={() => setMode(m)}>{`최근 ${m}`}</button>
          ))}
          <button className={`sm-tab ${mode === "custom" ? "is-active" : ""}`} onClick={() => setMode("custom")}>직접지정</button>
        </div>
        {mode === "custom" && (
          <span className="sm-row" style={{ gap: 6 }}>
            <input className="b2b-input" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} style={{ width: "auto" }} />
            <span className="sm-faint">~</span>
            <input className="b2b-input" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} style={{ width: "auto" }} />
          </span>
        )}
        <select className="b2b-input" value={productFilter} onChange={(e) => setProductFilter(e.target.value)} style={{ width: "auto" }}>
          <option value="">전체 제품</option>
          {products.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input className="b2b-input" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="수신처(제조사명) — 선택" style={{ width: 220 }} />
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : (
        <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "32px 34px", maxWidth: 900, boxShadow: "var(--sm-shadow-card)" }}>
          {/* 문서 헤더 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div>
              <h2 style={{ fontSize: 24, fontWeight: 800, marginTop: 4 }}>개선요청서</h2>
            </div>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>
              <div>작성일 {TODAY()}</div>
              <div>대상 기간 · {rangeLabel}</div>
              {recipient && <div>수신 · {recipient}</div>}
              {productFilter && <div>대상 제품 · {productFilter}</div>}
            </div>
          </div>

          {items.length === 0 ? (
            <div className="b2b-empty">해당 기간에 접수된 클레임이 없습니다.</div>
          ) : (
            <>
              {/* 요약 통계 — 유형별 접수 도넛 + 지표 */}
              <div style={{ display: "flex", gap: 28, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
                {summary.cats.length > 0 && (
                  <Donut data={summary.cats} center={String(summary.total)} centerSub="건" size={116} />
                )}
                <div className="sm-col" style={{ gap: 14, flex: 1, minWidth: 240 }}>
                  <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                    <Stat label="접수 건수" value={`${summary.total}건`} />
                    <Stat label="총 손해/보상" value={`${summary.loss.toLocaleString()}원`} accent="var(--sm-danger)" />
                    <Stat label="대상 기간" value={periodText} small />
                  </div>
                  {summary.cats.length > 0 && (
                    <div className="sm-row-wrap" style={{ gap: 6 }}>
                      {summary.cats.map(([c, n]) => (
                        <span key={c} className="b2b-feed-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{c} {n}건</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 요청문 */}
              <div style={{ background: "var(--sm-bg-subtle)", borderRadius: 8, padding: "14px 16px", marginBottom: 22, lineHeight: 1.7, fontSize: 14 }}>
                아래와 같이 <strong>{periodText}</strong> 동안 {productFilter ? `‘${productFilter}’ 관련 ` : ""}<strong>{summary.total}건</strong>의 클레임이 접수되어
                총 <strong style={{ color: "var(--sm-danger)" }}>{summary.loss.toLocaleString()}원</strong>의 손해가 발생했습니다.
                동일 문제의 재발 방지를 위해 생산·품질 공정 점검 및 개선을 요청드립니다.
              </div>

              {/* 상세 내역 */}
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 8px" }}>접수 내역</h3>
              <table className="b2b-table" style={{ marginBottom: 8 }}>
                <thead><tr><th>접수일</th><th>제품 생산일</th><th>CS 유형</th><th>내용</th><th className="num">손해(원)</th></tr></thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(2)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.production_date?.slice(2) || "-"}</td>
                      <td>{r.category}</td>
                      <td style={{ maxWidth: 320 }}>{r.content}</td>
                      <td className="num">{r.loss_amount ? r.loss_amount.toLocaleString() : "-"}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 800, background: "var(--sm-bg-subtle)" }}>
                    <td colSpan={4}>합계</td>
                    <td className="num">{summary.loss.toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>

              {/* 사진 — 문서 제일 뒤, A4 2컷/페이지 */}
              {photos.length > 0 && (
                <div className="voc-photos" style={{ marginTop: 24 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>증빙 사진 ({photos.length}장)</h3>
                  {photos.map((p, i) => (
                    <figure key={i} className="voc-photo-fig" style={{ margin: "0 0 16px" }}>
                      <figcaption style={{ fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 4 }}>{p.label}</figcaption>
                      <img src={p.url} alt={p.label} className="voc-photo"
                        style={{ width: "100%", maxHeight: 440, objectFit: "contain", borderRadius: 8, border: "1px solid var(--sm-border)", display: "block", background: "var(--sm-bg-subtle)" }} />
                    </figure>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      <p className="sm-faint no-print" style={{ fontSize: 12, marginTop: 12 }}>
        통계·기간 보고서는 <Link href="/voc/stats" className="change-link">통계·보고서</Link>에서 보고 인쇄할 수 있습니다.
      </p>
    </div>
  );
}

function Stat({ label, value, accent, small }: { label: string; value: string; accent?: string; small?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: small ? 14 : 20, fontWeight: 800, color: accent || "var(--sm-black)" }}>{value}</div>
    </div>
  );
}
