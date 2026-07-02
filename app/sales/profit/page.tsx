"use client";

import { useEffect, useRef, useState } from "react";
import { PROFIT_COLS, type ProfitRow } from "@/app/lib/sales-profit";

type Unmatched = { sku_code: string; line_count: number; qty_sum: number; amount_sum: number; channels: string };
type Result = { ok: boolean; error?: string; from: string; to: string; rows: ProfitRow[]; totals: ProfitRow; unmatched: Unmatched[]; cost_count: number | null; unmatched_amount: number };

const won = (n: number) => `${Math.round(Number(n) || 0).toLocaleString()}원`;
const fmt = (r: ProfitRow, key: keyof ProfitRow, money?: boolean, pct?: boolean) =>
  key === "channel" ? String(r[key]) : pct ? `${Number(r[key]).toFixed(2)}%` : money ? won(Number(r[key])) : Number(r[key]).toLocaleString();

export default function SalesProfitPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"" | "calc" | "cost">("");
  const [err, setErr] = useState("");
  const [costMsg, setCostMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function uploadCost(file: File) {
    setBusy("cost"); setErr(""); setCostMsg("");
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch("/api/sales/profit/cost-upload", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "업로드 실패");
      setCostMsg(`원가·중량 ${j.upserted.toLocaleString()}개 갱신 (총 ${j.total?.toLocaleString?.() ?? "-"}개)`);
      await calc();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); if (fileRef.current) fileRef.current.value = ""; }
  }

  function exportXlsx() {
    if (!res) return;
    window.open(`/api/sales/profit/export?from=${res.from}&to=${res.to}`, "_blank");
  }

  return (
    <div className="b2b-container" style={{ maxWidth: 1100 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">채널별 매출·이익</h1>
          <p className="b2b-page-subtitle">기간 매출(Supabase)에 원가·중량·택배보냉비·채널수수료를 적용해 채널별 매출총이익을 계산합니다. 원가/중량은 백데이터(관리코드별) 기준.</p>
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
          <label className="b2b-btn-secondary" style={{ cursor: busy ? "default" : "pointer", marginLeft: "auto" }}>
            {busy === "cost" ? "업로드 중…" : "원가·중량 백데이터 업로드"}
            <input ref={fileRef} type="file" accept=".xlsx" style={{ display: "none" }} disabled={busy !== ""} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCost(f); }} />
          </label>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>
          원가·중량 <strong>{res?.cost_count ?? "-"}</strong>개 등록됨. 수수료율(스마트스토어10·쿠팡12·카페244·토스12·톡스토어12%)·배송비매출(주문당 4,000원)·택배포장 표는 파이썬 값 그대로.
          {res?.cost_count === 0 && <span style={{ color: "var(--sm-warning)" }}> · 원가 데이터가 없습니다. 백데이터 xlsx를 먼저 업로드하세요.</span>}
        </p>
        {costMsg && <p style={{ fontSize: 13, color: "var(--sm-success)", marginTop: 4 }}>✓ {costMsg}</p>}
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
          <div className="b2b-card-head"><span className="b2b-card-title" style={{ color: "var(--sm-warning)" }}>미매칭 관리코드 {res.unmatched.length}개 · 금액 {won(res.unmatched_amount)}</span></div>
          <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>원가·중량 백데이터에 없는 코드입니다(원가 0·중량 0으로 계산됨). 백데이터에 추가한 뒤 다시 업로드하면 정확해집니다.</p>
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
    </div>
  );
}
