"use client";

import { useEffect, useState } from "react";
import { PROFIT_COLS, type ProfitRow } from "@/app/lib/sales-profit";

type Unmatched = { sku_code: string; line_count: number; qty_sum: number; amount_sum: number; channels: string };
type Result = { ok: boolean; error?: string; from: string; to: string; rows: ProfitRow[]; totals: ProfitRow; unmatched: Unmatched[]; unmatched_amount: number };

const won = (n: number) => `${Math.round(Number(n) || 0).toLocaleString()}원`;
const fmt = (r: ProfitRow, key: keyof ProfitRow, money?: boolean, pct?: boolean) =>
  key === "channel" ? String(r[key]) : pct ? `${Number(r[key]).toFixed(2)}%` : money ? won(Number(r[key])) : Number(r[key]).toLocaleString();

export default function SalesProfitPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"" | "calc">("");
  const [err, setErr] = useState("");

  async function calc(f = from, t = to) {
    setBusy("calc"); setErr("");
    try {
      const q = f && t ? `?from=${f}&to=${t}` : "";
      const r = await fetch(`/api/sales/profit${q}`);
      const j: Result = await r.json();
      if (!j.ok) { setErr(j.error || "계산 실패"); setRes(null); }
      else { setRes(j); setFrom(j.from); setTo(j.to); }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }
  useEffect(() => { calc(); /* 최초: 최신 달 자동 */ /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  function exportXlsx() {
    if (!res) return;
    window.open(`/api/sales/profit/export?from=${res.from}&to=${res.to}`, "_blank");
  }
  function exportUnmatchedTemplate() {
    if (!res) return;
    window.open(`/api/sales/profit/unmatched-template?from=${res.from}&to=${res.to}`, "_blank");
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">채널별 매출·이익</h1>
          <p className="b2b-page-subtitle">기간 매출(Supabase)에 원가·중량·택배보냉비·채널수수료를 적용해 채널별 매출총이익을 계산합니다. <strong>원가(제조+포장재)·중량은 상품마스터(products) 기준</strong>.</p>
        </div>
      </header>

      <section className="b2b-card">
        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label className="sm-faint" style={{ fontSize: 13 }}>기간</label>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="b2b-input" style={{ width: 160 }} />
          <span className="sm-faint">~</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="b2b-input" style={{ width: 160 }} />
          <button className="b2b-btn-primary" onClick={() => calc()} disabled={busy !== ""}>{busy === "calc" ? "계산 중…" : "계산"}</button>
          {res && <button className="b2b-btn-secondary" onClick={exportXlsx} disabled={busy !== ""}>엑셀 추출</button>}
          <a className="b2b-btn-secondary" href="/b2b/products" target="_blank" rel="noreferrer" style={{ marginLeft: "auto" }}>상품마스터 열기 ↗</a>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>
          원가=상품마스터 <code>cost_price</code>(제조원가+포장재), 중량=<code>volume_kg</code>. 수수료율(스마트스토어10·쿠팡12·카페244·토스12·톡스토어12%)·배송비매출(주문당 4,000원)·택배포장 표는 파이썬 값 그대로. 상품마스터에 원가·부피가 없는 SKU는 아래 <strong>미매칭</strong>으로 표시됩니다.
        </p>
      </section>

      {err && <p style={{ color: "var(--sm-danger)", marginTop: 12, whiteSpace: "pre-wrap" }}>⚠️ {err}</p>}

      {res && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">채널별 요약 · {res.from} ~ {res.to}</span></div>
          <div style={{ overflowX: "auto" }}>
            <table className="b2b-table" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
              <thead><tr>{PROFIT_COLS.map((c) => <th key={c.key} style={{ textAlign: c.key === "channel" ? "left" : "right" }}>{c.label}</th>)}</tr></thead>
              <tbody>
                {res.rows.map((r) => (
                  <tr key={r.channel}>
                    {PROFIT_COLS.map((c) => (
                      <td key={c.key} style={{ textAlign: c.key === "channel" ? "left" : "right", fontWeight: c.key === "channel" ? 700 : 400, color: c.key === "margin_pct" ? (Number(r.margin_pct) >= 0 ? "var(--sm-success)" : "var(--sm-danger)") : undefined }}>
                        {fmt(r, c.key, c.money, c.pct)}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr style={{ borderTop: "2px solid var(--sm-border)", fontWeight: 800, background: "var(--sm-surface-2,#f7fafb)" }}>
                  {PROFIT_COLS.map((c) => (
                    <td key={c.key} style={{ textAlign: c.key === "channel" ? "left" : "right" }}>{fmt(res.totals, c.key, c.money, c.pct)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {res && res.unmatched.length > 0 && (
        <section className="b2b-card" style={{ marginTop: 12, borderColor: "var(--sm-warning)" }}>
          <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span className="b2b-card-title" style={{ color: "var(--sm-warning)" }}>미매칭 SKU {res.unmatched.length}개 · 금액 {won(res.unmatched_amount)}</span>
            <button className="b2b-btn-secondary" onClick={exportUnmatchedTemplate} disabled={busy !== ""}>미매칭 목록 엑셀</button>
          </div>
          <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>상품마스터에 <strong>원가(cost_price) 또는 부피(volume_kg)가 없는</strong> SKU입니다(원가 0·중량 0으로 계산됨). <a href="/b2b/products" target="_blank" rel="noreferrer" style={{ color: "var(--sm-orange)" }}>상품마스터</a>에서 이 코드들의 원가·부피를 채우면 매칭됩니다(원가표 CSV 임포트로 일괄 입력 가능). 엑셀은 채울 목록 참고용입니다.</p>
          <div style={{ overflowX: "auto", maxHeight: 320 }}>
            <table className="b2b-table" style={{ fontSize: 12.5 }}>
              <thead><tr><th>관리코드</th><th style={{ textAlign: "right" }}>라인수</th><th style={{ textAlign: "right" }}>수량합</th><th style={{ textAlign: "right" }}>결제금액합</th><th>판매처</th></tr></thead>
              <tbody>
                {res.unmatched.map((u) => (
                  <tr key={u.sku_code}><td style={{ fontFamily: "monospace" }}>{u.sku_code}</td><td style={{ textAlign: "right" }}>{u.line_count}</td><td style={{ textAlign: "right" }}>{u.qty_sum.toLocaleString()}</td><td style={{ textAlign: "right" }}>{won(u.amount_sum)}</td><td className="sm-faint">{u.channels}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
