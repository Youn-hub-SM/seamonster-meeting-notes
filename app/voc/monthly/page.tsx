"use client";

import { useEffect, useMemo, useState } from "react";
import { VOC_CAT_STATUS_COLOR, type Voc, type VocCategoryRow } from "@/app/lib/voc";

// VOC 월말 결산 — 월 선택 → 유형별 발생(접수일 기준)·전월 대비·손해금액 + 이번 달 개선완료 유형.
//  발생 = voc.received_at, 개선 = voc_categories.resolved_at 기준이라 과거 월 수치가 소급 변동하지 않는다(결산 문서용).
//  인쇄/PDF: 기존 .voc-print / .no-print 인프라 재사용.

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const won = (n: number) => Math.round(n).toLocaleString();

function prevMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function VocMonthlyPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [cats, setCats] = useState<VocCategoryRow[]>([]);
  const [month, setMonth] = useState(() => TODAY().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true); setError("");
      try {
        const [j, cj] = await Promise.all([
          (await fetch("/api/voc", { cache: "no-store" })).json(),
          (await fetch("/api/voc/categories", { cache: "no-store" })).json().catch(() => ({ ok: false })),
        ]);
        if (!j.ok) throw new Error(j.error || "조회 실패");
        setRows(j.rows || []);
        if (cj.ok) setCats(cj.categories || []);
      } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
      setLoading(false);
    })();
  }, []);

  const data = useMemo(() => {
    const pm = prevMonth(month);
    const cur = rows.filter((r) => (r.received_at || "").startsWith(month));
    const prev = rows.filter((r) => (r.received_at || "").startsWith(pm));
    const names = new Set<string>([...cats.map((c) => c.name), ...cur.map((r) => r.category), ...prev.map((r) => r.category)]);
    const byType = [...names].map((name) => {
      const c = cur.filter((r) => r.category === name);
      const p = prev.filter((r) => r.category === name);
      const cat = cats.find((x) => x.name === name) || null;
      return {
        name, cat,
        count: c.length,
        prevCount: p.length,
        loss: c.reduce((s, r) => s + (Number(r.loss_amount) || 0), 0),
        resolvedThisMonth: !!cat?.resolved_at && cat.resolved_at.startsWith(month),
      };
    }).filter((t) => t.count > 0 || t.prevCount > 0 || t.resolvedThisMonth)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
    return {
      pm, byType,
      total: cur.length,
      prevTotal: prev.length,
      loss: cur.reduce((s, r) => s + (Number(r.loss_amount) || 0), 0),
      prevLoss: prev.reduce((s, r) => s + (Number(r.loss_amount) || 0), 0),
      resolvedTypes: byType.filter((t) => t.resolvedThisMonth),
    };
  }, [rows, cats, month]);

  const [y, mm] = month.split("-");
  const diff = data.total - data.prevTotal;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div>
          <h1 className="b2b-page-title">VOC 월말 결산</h1>
          <p className="b2b-page-subtitle">유형별 발생(접수일 기준)과 개선완료 처리(유형 단위)를 한 달 단위로 결산합니다. 과거 월 수치는 소급 변동하지 않습니다.</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || data.total === 0}>인쇄 / PDF</button>
        </div>
      </header>

      {error && <div className="b2b-error no-print">{error}</div>}

      <section className="b2b-card no-print" style={{ marginBottom: 16 }}>
        <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>대상 월
          <input className="b2b-input" type="month" value={month} max={TODAY().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} style={{ width: "auto" }} /></label>
      </section>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : (
        <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "28px 30px", maxWidth: 900, boxShadow: "var(--sm-shadow-card)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 18 }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div>
              <h2 style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{y}년 {mm}월 VOC 결산</h2>
            </div>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>
              총 발생
              <div style={{ fontSize: 24, fontWeight: 800, color: "var(--sm-black)", marginTop: 2 }}>
                {data.total}건
                <span style={{ fontSize: 13, fontWeight: 600, marginLeft: 8, color: diff > 0 ? "var(--sm-danger)" : diff < 0 ? "var(--sm-success)" : "var(--sm-text-mid)" }}>
                  전월 대비 {diff > 0 ? `+${diff}` : diff}건
                </span>
              </div>
            </div>
          </div>

          {/* 요약 */}
          <div className="b2b-table-wrap" style={{ marginBottom: 22 }}>
          <table className="b2b-table">
            <thead><tr><th>구분</th><th className="num">{data.pm.slice(5)}월(전월)</th><th className="num">{mm}월(당월)</th><th className="num">증감</th></tr></thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 700 }}>발생 건수</td>
                <td className="num">{data.prevTotal}건</td>
                <td className="num" style={{ fontWeight: 700 }}>{data.total}건</td>
                <td className="num" style={{ color: diff > 0 ? "var(--sm-danger)" : diff < 0 ? "var(--sm-success)" : "var(--sm-text-mid)" }}>{diff > 0 ? `+${diff}` : diff}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 700 }}>손해금액</td>
                <td className="num b2b-money">{won(data.prevLoss)}원</td>
                <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(data.loss)}원</td>
                <td className="num b2b-money" style={{ color: data.loss - data.prevLoss > 0 ? "var(--sm-danger)" : "var(--sm-success)" }}>{won(data.loss - data.prevLoss)}원</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 700 }}>개선완료 처리 유형</td>
                <td className="num sm-faint">-</td>
                <td className="num" style={{ fontWeight: 700 }}>{data.resolvedTypes.length}개{data.resolvedTypes.length > 0 ? ` (${data.resolvedTypes.map((t) => t.name).join(", ")})` : ""}</td>
                <td className="num" />
              </tr>
            </tbody>
          </table>
          </div>

          {/* 유형별 표 */}
          <strong style={{ fontSize: 14, display: "block", marginBottom: 6 }}>유형별 발생 · 개선 현황</strong>
          <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr><th>유형</th><th className="num">전월 발생</th><th className="num">당월 발생</th><th className="num">증감</th><th className="num">손해금액</th><th>개선 상태</th><th>비고</th></tr></thead>
            <tbody>
              {data.byType.map((t) => {
                const d = t.count - t.prevCount;
                const st = t.cat?.status ?? "관찰";
                const sc = VOC_CAT_STATUS_COLOR[st];
                return (
                  <tr key={t.name}>
                    <td style={{ fontWeight: 700 }}>{t.name}</td>
                    <td className="num">{t.prevCount || "-"}</td>
                    <td className="num" style={{ fontWeight: 700 }}>{t.count || "-"}</td>
                    <td className="num" style={{ color: d > 0 ? "var(--sm-danger)" : d < 0 ? "var(--sm-success)" : "var(--sm-text-mid)" }}>{d > 0 ? `+${d}` : d || "-"}</td>
                    <td className="num b2b-money">{t.loss > 0 ? `${won(t.loss)}원` : "-"}</td>
                    <td><span className="b2b-status-pill" style={{ background: sc.bg, color: sc.fg }}>{st}</span></td>
                    <td style={{ fontSize: 12, color: "var(--sm-success)", fontWeight: 700 }}>{t.resolvedThisMonth ? "이번 달 개선완료" : ""}</td>
                  </tr>
                );
              })}
              <tr style={{ fontWeight: 800, background: "var(--sm-bg-subtle)" }}>
                <td>합계</td>
                <td className="num">{data.prevTotal}</td>
                <td className="num">{data.total}</td>
                <td className="num">{diff > 0 ? `+${diff}` : diff}</td>
                <td className="num b2b-money">{won(data.loss)}원</td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
          </div>
          <p className="sm-faint" style={{ fontSize: 11, marginTop: 12 }}>※ 발생 = 접수일 기준. 개선완료 = 유형 단위 처리(유형별 현황판에서 상태 변경 시 시점 기록). 개선 작업 자체는 Flow 에서 진행.</p>
        </section>
      )}
    </div>
  );
}
