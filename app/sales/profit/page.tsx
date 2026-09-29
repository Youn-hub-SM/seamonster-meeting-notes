"use client";

import { useEffect, useState } from "react";
import { PROFIT_COLS, type ProfitRow, type ChannelConfig } from "@/app/lib/sales-profit";
import { won as fmtWon } from "@/app/lib/format";

type Unmatched = { sku_code: string; line_count: number; qty_sum: number; amount_sum: number; channels: string };
type Result = { ok: boolean; error?: string; from: string; to: string; rows: ProfitRow[]; totals: ProfitRow; unmatched: Unmatched[]; unmatched_amount: number };

const won = (n: number) => `${fmtWon(n)}원`;
const fmt = (r: ProfitRow, key: keyof ProfitRow, money?: boolean, pct?: boolean) =>
  key === "channel" ? String(r[key]) : pct ? `${Number(r[key]).toFixed(2)}%` : money ? won(Number(r[key])) : Number(r[key]).toLocaleString();

export default function SalesProfitPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"" | "calc">("");
  const [err, setErr] = useState("");
  // 채널 설정
  const [showCfg, setShowCfg] = useState(false);
  const [cfg, setCfg] = useState<ChannelConfig[]>([]);
  const [deletedCh, setDeletedCh] = useState<string[]>([]);
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgMsg, setCfgMsg] = useState("");

  const [cfgLoadErr, setCfgLoadErr] = useState(false); // 설정 로드 실패 — '설정 없음'으로 오인해 재입력·덮어쓰기 방지
  function loadConfig() {
    fetch("/api/sales/profit/config").then((r) => r.json()).then((j) => { if (j.ok) { setCfg(j.rows); setDeletedCh([]); setCfgLoadErr(false); } else setCfgLoadErr(true); }).catch(() => setCfgLoadErr(true));
  }
  useEffect(() => { loadConfig(); }, []);
  const setCfgField = (i: number, k: keyof ChannelConfig, v: string | number) =>
    setCfg((c) => c.map((row, idx) => (idx === i ? { ...row, [k]: v } : row)));
  function addChannel() { setCfg((c) => [...c, { channel: "", fee_rate: 0, ship_mode: "actual", ship_fee: 4000, ship_free_over: 0, ship_free_over_sub: 0, revenue_adjust: 0 }]); }
  function delChannel(i: number) { setCfg((c) => { const row = c[i]; if (row.channel) setDeletedCh((d) => [...d, row.channel]); return c.filter((_, idx) => idx !== i); }); }
  async function saveConfig() {
    if (cfgLoadErr) { setErr("채널 설정을 불러오지 못한 상태라 저장할 수 없습니다 — 새로고침해 주세요."); return; }
    setSavingCfg(true); setCfgMsg(""); setErr("");
    try {
      const rows = cfg.map((r) => ({ ...r, fee_rate: Number(r.fee_rate) || 0, ship_fee: Number(r.ship_fee) || 0, ship_free_over: Number(r.ship_free_over) || 0 }));
      const r = await fetch("/api/sales/profit/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, deleted: deletedCh }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setCfgMsg("저장됨 · 재계산합니다");
      loadConfig();
      await calc();
    } catch (e) { setErr((e as Error).message); }
    finally { setSavingCfg(false); }
  }

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
        </div>
      </header>

      <section className="b2b-card">
        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label className="sm-faint" style={{ fontSize: 15 }}>기간</label>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="b2b-input" style={{ width: 160 }} />
          <span className="sm-faint">~</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="b2b-input" style={{ width: 160 }} />
          <button className="b2b-btn-primary" onClick={() => calc()} disabled={busy !== ""}>{busy === "calc" ? "계산 중..." : "계산"}</button>
          {res && <button className="b2b-btn-secondary" onClick={exportXlsx} disabled={busy !== ""}>엑셀 추출</button>}
          <button className="b2b-btn-secondary" onClick={() => setShowCfg((v) => !v)}>채널 설정 · 계산 기준 {showCfg ? "▲" : "▼"}</button>
          <a className="b2b-btn-secondary" href="/b2b/products" target="_blank" rel="noreferrer" style={{ marginLeft: "auto" }}>상품마스터 열기 ↗</a>
        </div>
      </section>

      {showCfg && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span className="b2b-card-title">채널 설정 · 계산 기준</span>
            <div className="sm-row" style={{ gap: 8 }}>
              <button className="b2b-btn-secondary" onClick={addChannel}>+ 채널 추가</button>
              <button className="b2b-btn-primary" onClick={saveConfig} disabled={savingCfg}>{savingCfg ? "저장 중..." : "저장 + 재계산"}</button>
            </div>
          </div>
          <div className="sm-faint" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 12 }}>
            <div>총매출 = 결제금액(매출 보정율 차감) + 배송비매출 · 매출총이익 = 총매출 − 상품원가(묶음은 구성품 합) − 판매수수료(미설정 채널 0%) − 택배보냉비(같은 주문자·주문일 = 1건)</div>
            <div>매출 보정율은 할인 미반영 채널(카페24 등)만 입력 — 네이버·쿠팡·톡스토어는 할인 반영 금액</div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="b2b-table" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
              <thead><tr><th>판매처</th><th style={{ textAlign: "right" }}>판매수수료율(%)</th><th style={{ textAlign: "right" }}>매출 보정율(%)</th><th></th></tr></thead>
              <tbody>
                {cfg.map((row, i) => (
                  <tr key={i}>
                    <td><input className="b2b-input" value={row.channel} onChange={(e) => setCfgField(i, "channel", e.target.value)} placeholder="판매처명" style={{ width: 160 }} /></td>
                    <td style={{ textAlign: "right" }}><input className="b2b-input" type="number" step="0.1" min={0} value={Number((row.fee_rate * 100).toFixed(2))} onChange={(e) => setCfgField(i, "fee_rate", (Number(e.target.value) || 0) / 100)} style={{ width: 90, textAlign: "right" }} /></td>
                    <td style={{ textAlign: "right" }}><input className="b2b-input" type="number" step="0.1" min={0} value={Number((row.revenue_adjust * 100).toFixed(2))} onChange={(e) => setCfgField(i, "revenue_adjust", (Number(e.target.value) || 0) / 100)} style={{ width: 90, textAlign: "right" }} title="총결제금액에서 차감(할인 미반영 보정). 예: 카페24 5.5" /></td>
                    <td style={{ textAlign: "right" }}><button className="b2b-link-btn" onClick={() => delChannel(i)} style={{ color: "var(--sm-danger)", fontSize: 12 }}>삭제</button></td>
                  </tr>
                ))}
                {cfg.length === 0 && <tr><td colSpan={4} className="sm-faint" style={{ padding: 12 }}>{cfgLoadErr ? "채널 설정을 불러오지 못했습니다 — 새로고침해 주세요. (재입력하면 기존 설정을 덮어쓸 수 있습니다)" : "설정이 없습니다."}</td></tr>}
              </tbody>
            </table>
          </div>
          {cfgMsg && <p style={{ fontSize: 15, color: "var(--sm-success)", marginTop: 6 }}>✓ {cfgMsg}</p>}
        </section>
      )}

      {err && <p style={{ color: "var(--sm-danger)", marginTop: 12, whiteSpace: "pre-wrap" }}>{err}</p>}

      {res && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">채널별 요약 · {res.from} ~ {res.to}</span></div>
          <div style={{ overflowX: "auto" }}>
            <table className="b2b-table" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
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
                <tr style={{ borderTop: "2px solid var(--sm-border)", fontWeight: 800, background: "var(--sm-bg-subtle)" }}>
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
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span className="b2b-card-title" style={{ color: "var(--sm-warning)" }}>미매칭 SKU {res.unmatched.length}개 · 금액 {won(res.unmatched_amount)}</span>
            <button className="b2b-btn-secondary" onClick={exportUnmatchedTemplate} disabled={busy !== ""}>미매칭 목록 엑셀</button>
          </div>
          <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>원가 0·중량 0으로 계산됨</p>
          <div style={{ overflowX: "auto", maxHeight: 320 }}>
            <table className="b2b-table" style={{ fontSize: 12 }}>
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
