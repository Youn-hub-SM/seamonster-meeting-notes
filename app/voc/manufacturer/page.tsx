"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { type Voc } from "@/app/lib/voc";
import { buildManufacturerReport } from "@/app/lib/voc-manufacturer";
import { Donut } from "@/app/components/charts";

const THIS_MONTH = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7); // KST YYYY-MM
const won = (n: number) => n.toLocaleString();

export default function VocManufacturerPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [month, setMonth] = useState(THIS_MONTH());
  const [recipient, setRecipient] = useState("");

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

  const report = useMemo(() => buildManufacturerReport(rows, month), [rows, month]);
  const { items, byProduct, byCategory, photos, summary } = report;
  const [y, mm] = month.split("-");
  const exportUrl = `/api/voc/manufacturer/export?month=${month}${recipient ? `&recipient=${encodeURIComponent(recipient)}` : ""}`;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div>
          <h1 className="b2b-page-title">제조사 공유자료</h1>
          <p className="b2b-page-subtitle">매월 <strong>제조사 귀책</strong> 클레임을 제품별로 모아 청구 가능 손해액·증빙 사진과 함께 한 번에 만듭니다. 엑셀·PDF로 바로 받으세요.</p>
        </div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href={exportUrl}>⬇ 엑셀 다운로드</a>
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || items.length === 0}>🖨 인쇄 / PDF</button>
        </div>
      </header>

      {error && <div className="b2b-error no-print">{error}</div>}

      <div className="no-print" style={{ marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>대상 월
          <input className="b2b-input" type="month" value={month} max={THIS_MONTH()} onChange={(e) => setMonth(e.target.value)} style={{ width: "auto" }} /></label>
        <input className="b2b-input" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="수신처(제조사명) — 선택" style={{ width: 220 }} />
        <span className="sm-faint" style={{ fontSize: 12 }}>범위 = 손해 귀책 ‘제조사’ 클레임. 귀책은 <Link href="/voc/loss" className="change-link">손해금액 산정</Link>에서 보정.</span>
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : (
        <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "32px 34px", maxWidth: 900, boxShadow: "var(--sm-shadow-card)" }}>
          {/* 문서 헤더 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div>
              <h2 style={{ fontSize: 23, fontWeight: 800, marginTop: 4 }}>{y}년 {mm}월 제조사 VOC 공유자료</h2>
            </div>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>
              <div>작성일 {new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)}</div>
              <div>대상 · 제조사 귀책 클레임</div>
              {recipient && <div>수신 · {recipient}</div>}
            </div>
          </div>

          {items.length === 0 ? (
            <div className="b2b-empty">{y}년 {mm}월에 제조사 귀책 클레임이 없습니다.</div>
          ) : (
            <>
              {/* 요약 */}
              <div style={{ display: "flex", gap: 28, alignItems: "center", flexWrap: "wrap", marginBottom: 22 }}>
                {byCategory.length > 0 && <Donut data={byCategory} center={String(summary.count)} centerSub="건" size={120} />}
                <div className="sm-col" style={{ gap: 14, flex: 1, minWidth: 260 }}>
                  <div style={{ display: "flex", gap: 30, flexWrap: "wrap" }}>
                    <Stat label="제조사 귀책 건수" value={`${summary.count}건`} />
                    <Stat label="청구 가능 손해액" value={`${won(summary.claimable)}원`} accent="var(--sm-danger)" />
                    <Stat label="대상 제품" value={`${summary.productCount}종`} />
                  </div>
                  {byCategory.length > 0 && (
                    <div className="sm-row-wrap" style={{ gap: 6 }}>
                      {byCategory.map(([c, n]) => (
                        <span key={c} className="b2b-feed-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{c} {n}건</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 안내문 */}
              <div style={{ background: "var(--sm-bg-subtle)", borderRadius: 8, padding: "14px 16px", marginBottom: 22, lineHeight: 1.7, fontSize: 14 }}>
                {y}년 {mm}월 한 달간 제조사 귀책으로 분류된 클레임이 <strong>{summary.count}건</strong> 접수되어
                총 <strong style={{ color: "var(--sm-danger)" }}>{won(summary.claimable)}원</strong>의 손해가 발생했습니다.
                제품별 발생 현황과 증빙은 아래와 같으며, 동일 문제 재발 방지를 위한 생산·품질 점검을 요청드립니다.
              </div>

              {/* 제품별 집계 */}
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 8px" }}>제품별 집계</h3>
              <table className="b2b-table" style={{ marginBottom: 20 }}>
                <thead><tr><th>제품</th><th className="num">건수</th><th>주요 유형</th><th className="num">청구 손해액(원)</th></tr></thead>
                <tbody>
                  {byProduct.map((p) => (
                    <tr key={p.product}>
                      <td>{p.product}</td>
                      <td className="num">{p.count}</td>
                      <td>{p.categories.map(([c, n]) => `${c} ${n}`).join(" · ")}</td>
                      <td className="num">{p.claimable ? won(p.claimable) : "-"}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 800, background: "var(--sm-bg-subtle)" }}>
                    <td>합계</td><td className="num">{summary.count}</td><td /><td className="num">{won(summary.claimable)}</td>
                  </tr>
                </tbody>
              </table>

              {/* 상세 내역 */}
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 8px" }}>접수 상세</h3>
              <table className="b2b-table" style={{ marginBottom: 8 }}>
                <thead><tr><th>접수일</th><th>제품</th><th>생산일</th><th>유형</th><th>내용</th><th>원인</th><th className="num">손해(원)</th></tr></thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(2)}</td>
                      <td style={{ maxWidth: 140 }}>{r.product || "-"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.production_date?.slice(2) || "-"}</td>
                      <td>{r.category}</td>
                      <td style={{ maxWidth: 260 }}>{r.content}</td>
                      <td style={{ maxWidth: 180 }}>{r.cause || "-"}</td>
                      <td className="num">{r.loss_amount ? won(r.loss_amount) : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* 증빙 사진 */}
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
        기간 단위 개선요청서는 <Link href="/voc/reports" className="change-link">개선요청서</Link>, 전체 통계는 <Link href="/voc/stats" className="change-link">통계·보고서</Link>에서.
      </p>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: accent || "var(--sm-black)" }}>{value}</div>
    </div>
  );
}
