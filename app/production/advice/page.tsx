"use client";

import { useState } from "react";
import Link from "next/link";

type Priority = { sku: string; name: string; urgency: string; qty: number; byWhen: string; reason: string };
type Advice = { summary: string; priorities: Priority[]; notes: string[] };
type Row = {
  sku: string; name: string; stock: number | null; safety: number | null;
  b2bDemand: number; dailySales: number; daysOfCover: number | null; predicted14: number;
};
type VMeta = { computedAt: string; spanDays: number; txCount: number; capped: boolean };

const URG_STYLE: Record<string, { bg: string; fg: string }> = {
  "높음": { bg: "#fce4e4", fg: "#c92a2a" },
  "중간": { bg: "#fff4e0", fg: "#b86e00" },
  "낮음": { bg: "#eef2f6", fg: "#475569" },
};

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return "방금";
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export default function ProductionAdvicePage() {
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [vmeta, setVmeta] = useState<VMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/production/advice", { method: "POST" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "생성 실패");
      setAdvice(j.advice);
      setRows(j.rows || []);
      setVmeta(j.velocity || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "생성 중 오류");
    }
    setLoading(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산 조언</h1>
          <p className="b2b-page-subtitle">
            박스히어로 재고·판매속도 + B2B 확정 발주를 종합해 Claude가 “무엇을 얼마나 언제 만들지”를 짚어줍니다.
          </p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={generate} disabled={loading}>
            {loading ? "분석 중... (최대 1분)" : advice ? "다시 생성" : "생산 조언 생성"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {!advice && !loading && !error && (
        <section className="b2b-card">
          <div className="b2b-empty" style={{ padding: "44px 20px" }}>
            <div className="b2b-empty-icon">🧠</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>생산 조언 생성을 눌러 시작하세요</div>
            <div style={{ color: "var(--sm-text-mid)", lineHeight: 1.6, fontSize: 14 }}>
              최근 출고 추세로 판매속도를 추정하고, 재고·안전재고·확정 발주를 합쳐<br />
              우선순위가 매겨진 생산 권장안을 만들어냅니다.
            </div>
            <div style={{ marginTop: 14, fontSize: 13 }}>
              박스히어로 연동이 필요합니다 → <Link href="/production/settings" className="b2b-link">설정</Link>
            </div>
          </div>
        </section>
      )}

      {loading && <div className="b2b-loading">판매추세 분석 + 생산 조언 생성 중입니다... (최대 1분)</div>}

      {advice && !loading && (
        <>
          <section className="prod-advice-summary">
            <div className="prod-advice-summary-icon">🧠</div>
            <div>{advice.summary}</div>
          </section>

          {vmeta && (
            <p className="prod-note" style={{ marginTop: 8 }}>
              판매속도: 최근 {vmeta.spanDays}일 · 출고 {vmeta.txCount}건 기준 ({fmtAgo(vmeta.computedAt)} 집계)
              {vmeta.capped && " · 일부만 집계(상한)"}
            </p>
          )}

          {advice.priorities && advice.priorities.length > 0 && (
            <div className="prod-prio-list" style={{ marginTop: 14 }}>
              {advice.priorities.map((p, i) => {
                const u = URG_STYLE[p.urgency] || URG_STYLE["낮음"];
                return (
                  <div key={i} className="prod-prio-card">
                    <div className="prod-prio-rank">{i + 1}</div>
                    <div className="prod-prio-body">
                      <div className="prod-prio-top">
                        <span className="prod-prio-name">{p.name}</span>
                        <code className="prod-prio-sku">{p.sku}</code>
                        <span className="prod-prio-urg" style={{ background: u.bg, color: u.fg }}>{p.urgency}</span>
                      </div>
                      <div className="prod-prio-meta">
                        <span className="prod-prio-qty">{Number(p.qty).toLocaleString()}개</span>
                        <span className="prod-prio-when">{p.byWhen}</span>
                      </div>
                      <div className="prod-prio-reason">{p.reason}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {advice.notes && advice.notes.length > 0 && (
            <section className="b2b-card" style={{ marginTop: 16 }}>
              <div className="b2b-card-head"><h2 className="b2b-card-title">참고</h2></div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13.5, color: "var(--sm-text-mid)" }}>
                {advice.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </section>
          )}

          {/* 근거 데이터 */}
          {rows.length > 0 && (
            <section style={{ marginTop: 20 }}>
              <h2 className="b2b-card-title" style={{ marginBottom: 8 }}>근거 데이터</h2>
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead>
                    <tr>
                      <th>SKU</th><th>품목</th>
                      <th className="num">현재고</th><th className="num">안전</th>
                      <th className="num">B2B수요</th><th className="num">일평균출고</th>
                      <th className="num">소진일</th><th className="num">14일예측</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.sku}>
                        <td><code style={{ fontSize: 12 }}>{r.sku}</code></td>
                        <td>{r.name}</td>
                        <td className="num">{r.stock?.toLocaleString() ?? "-"}</td>
                        <td className="num">{r.safety?.toLocaleString() ?? "-"}</td>
                        <td className="num">{r.b2bDemand || "-"}</td>
                        <td className="num">{r.dailySales || "-"}</td>
                        <td className="num">{r.daysOfCover ?? "-"}</td>
                        <td className="num">{r.predicted14 || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
