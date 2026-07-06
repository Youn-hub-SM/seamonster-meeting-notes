"use client";

import { useState } from "react";
import Link from "next/link";
import type { MarginResult, MarginResultItem } from "@/app/lib/margin-calc";

const won = (n: number) => `${Math.round(Number(n) || 0).toLocaleString()}원`;

const EXAMPLES = [
  "대구순살 1kg을 20% 할인가로 쿠팡에서 판매하면 이익률이 어때?",
  "연어순살 100g을 스마트스토어에서 12,900원에 팔 때 순이익은?",
  "농어순살 1kg 도매가로 팔면 마진이 얼마나 남아?",
];

export default function MarginCalcPage() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState<MarginResult | null>(null);

  async function run(question?: string) {
    const text = (question ?? q).trim();
    if (!text) return;
    setQ(text); setLoading(true); setError(""); setRes(null);
    try {
      const r = await fetch("/api/sales/margin-calc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "분석 실패");
      setRes(j.result as MarginResult);
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setLoading(false);
  }

  return (
    <div className="b2b-container" style={{ maxWidth: 860 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">이익률 계산기 <span className="mc-ai">AI</span></h1>
          <p className="b2b-page-subtitle">상품·채널·판매가(할인)를 말로 물어보면, <strong>원가표·채널 수수료·배송/세무 정책</strong>을 근거로 <strong>순이익과 이익률</strong>을 계산하고 판매 전략을 제언합니다. 원가·정책은 <Link href="/b2b/products">상품 마스터</Link>·<Link href="/sales/profit">채널별 이익 설정</Link>을 따릅니다.</p>
        </div>
      </header>

      <section className="b2b-card">
        <textarea
          className="b2b-input" rows={3}
          placeholder="예: 대구순살 1kg을 20% 할인가로 쿠팡에서 판매하면 이익률이 어때?"
          value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); }}
          style={{ width: "100%", resize: "vertical", fontSize: 14, lineHeight: 1.6 }}
        />
        <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
          <button className="b2b-btn-primary" onClick={() => run()} disabled={loading || !q.trim()}>{loading ? "분석 중…" : "분석하기"}</button>
          <span className="sm-faint" style={{ fontSize: 12 }}>⌘/Ctrl + Enter</span>
        </div>
        <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 12 }}>
          <span className="sm-faint" style={{ fontSize: 12 }}>예시:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex} className="mc-example" onClick={() => run(ex)} disabled={loading}>{ex}</button>
          ))}
        </div>
      </section>

      {error && <div className="b2b-error" style={{ marginTop: 12 }}>{error}</div>}

      {loading && (
        <div className="b2b-card" style={{ marginTop: 16, textAlign: "center", padding: "28px 16px" }}>
          <div className="b2b-loading">원가표·정책을 근거로 계산 중… (최고급 모델, 10~20초)</div>
        </div>
      )}

      {res && !loading && (
        <div className="sm-col" style={{ gap: 16, marginTop: 16 }}>
          <div className="sm-faint" style={{ fontSize: 13 }}>🧾 {res.scenario}{res.product ? <> · 상품: <strong>{res.product}</strong></> : null}</div>

          {res.results.map((r, i) => <ResultCard key={i} r={r} />)}

          {res.strategy && (
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">💡 판매 전략 제언</span></div>
              <div style={{ fontSize: 13.5, lineHeight: 1.75, whiteSpace: "pre-wrap", color: "var(--sm-text-mid)" }}>{res.strategy.replace(/\*\*/g, "")}</div>
            </section>
          )}

          {res.assumptions?.length > 0 && (
            <div className="sm-faint" style={{ fontSize: 12, lineHeight: 1.7 }}>
              <strong>⚠️ 가정·주의</strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{res.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </div>
          )}

          <p className="sm-faint" style={{ fontSize: 11.5 }}>※ 원가·수수료·배송정책 데이터를 근거로 한 추정입니다. 실제 정산과 차이가 있을 수 있어요.</p>
        </div>
      )}

      <style>{`
        .mc-ai { font-size: 11px; font-weight: 700; color: var(--sm-orange); border: 1px solid var(--sm-orange-border); background: var(--sm-orange-light); border-radius: 6px; padding: 1px 7px; vertical-align: middle; margin-left: 4px; }
        .mc-example { font-size: 12px; color: var(--sm-navy); background: var(--sm-bg); border: 1px solid var(--sm-border); border-radius: 999px; padding: 5px 12px; cursor: pointer; }
        .mc-example:hover { border-color: var(--sm-orange); color: var(--sm-orange); }
      `}</style>
    </div>
  );
}

function ResultCard({ r }: { r: MarginResultItem }) {
  const positive = r.netProfit >= 0;
  const emph = positive ? "var(--sm-orange)" : "var(--sm-danger)";
  return (
    <section className="b2b-card">
      <div className="b2b-card-head"><span className="b2b-card-title">{r.label}</span></div>

      {/* 강조: 순이익 · 이익률 */}
      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
        <div className="b2b-stat-card" style={{ borderColor: emph, background: "var(--sm-orange-light)" }}>
          <div className="b2b-stat-card-label">순이익</div>
          <div className="b2b-stat-card-value" style={{ color: emph }}>{won(r.netProfit)}</div>
        </div>
        <div className="b2b-stat-card" style={{ borderColor: emph, background: "var(--sm-orange-light)" }}>
          <div className="b2b-stat-card-label">이익률</div>
          <div className="b2b-stat-card-value" style={{ color: emph }}>{(Number(r.marginPct) || 0).toFixed(1)}%</div>
        </div>
      </div>

      {/* 투명한 계산 근거 */}
      <div className="b2b-table-wrap">
        <table className="b2b-table" style={{ fontSize: 13 }}>
          <tbody>
            <tr>
              <td><strong>매출액</strong> <span className="sm-faint" style={{ fontSize: 11 }}>(고객 결제가)</span></td>
              <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(r.revenue)}</td>
            </tr>
            {r.supplyValue > 0 && r.supplyValue !== r.revenue && (
              <tr>
                <td className="sm-faint">└ 공급가액 <span style={{ fontSize: 11 }}>(부가세 차감)</span></td>
                <td className="num b2b-money sm-faint">{won(r.supplyValue)}</td>
              </tr>
            )}
            {r.expenses.map((e, i) => (
              <tr key={i}>
                <td style={{ color: "var(--sm-text-mid)" }}>− {e.label}{e.note ? <span className="sm-faint" style={{ fontSize: 11 }}> · {e.note}</span> : null}</td>
                <td className="num b2b-money" style={{ color: "var(--sm-danger)" }}>−{won(e.amount)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid var(--sm-border)" }}>
              <td><strong>순이익</strong></td>
              <td className="num b2b-money" style={{ fontWeight: 800, color: emph }}>{won(r.netProfit)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {r.taxNote && <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>🧾 {r.taxNote}</p>}
    </section>
  );
}
