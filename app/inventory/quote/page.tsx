"use client";

import { useCallback, useEffect, useState } from "react";
import type { QuoteItem, QuoteSummary } from "@/app/lib/inventory-quote";
import ReturnModal from "./ReturnModal";

const THIS_MONTH = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
const won = (n: number) => Math.round(n).toLocaleString();

type QuoteResp = { ok: boolean; month: string; items: QuoteItem[]; summary: QuoteSummary; error?: string };

export default function QuotePage() {
  const [ym, setYm] = useState(THIS_MONTH());
  const [rent, setRent] = useState(0);
  const [etc, setEtc] = useState(0);
  const [taxEtc, setTaxEtc] = useState(0);
  const [data, setData] = useState<QuoteResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);

  // 임대료·기타는 매달 고정값에 가까워 브라우저에 기억.
  useEffect(() => {
    const r = Number(localStorage.getItem("inv_quote_rent")); if (r > 0) setRent(r);
    const e = Number(localStorage.getItem("inv_quote_etc")); if (e > 0) setEtc(e);
    const tx = Number(localStorage.getItem("inv_quote_tax_etc")); if (tx > 0) setTaxEtc(tx);
  }, []);
  useEffect(() => { localStorage.setItem("inv_quote_rent", String(rent)); }, [rent]);
  useEffect(() => { localStorage.setItem("inv_quote_etc", String(etc)); }, [etc]);
  useEffect(() => { localStorage.setItem("inv_quote_tax_etc", String(taxEtc)); }, [taxEtc]);

  const load = useCallback(async (m: string, r: number, e: number, tx: number) => {
    setLoading(true); setError("");
    try {
      const j: QuoteResp = await (await fetch(`/api/inventory/quote?month=${m}&rent=${r}&etc=${e}&tax_etc=${tx}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setData(j);
    } catch (err) { setError(err instanceof Error ? err.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { const t = setTimeout(() => load(ym, rent, etc, taxEtc), 250); return () => clearTimeout(t); }, [load, ym, rent, etc, taxEtc]);

  const s = data?.summary;
  const items = data?.items ?? [];
  const [y, mm] = ym.split("-");
  const exportUrl = `/api/inventory/quote/export?month=${ym}&rent=${rent}&etc=${etc}&tax_etc=${taxEtc}`;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div><h1 className="b2b-page-title">월간 매입 결산</h1></div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={() => setReturnOpen(true)}>제조사 반품 입력</button>
          <a className="b2b-btn-secondary" href={exportUrl}>엑셀 다운로드</a>
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || items.length === 0}>인쇄 / PDF</button>
        </div>
      </header>
      {error && <div className="b2b-error no-print">{error}</div>}

      <section className="b2b-card no-print" style={{ marginBottom: 16 }}>
        <div className="sm-row" style={{ gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>대상 월
            <input className="b2b-input" type="month" value={ym} max={THIS_MONTH()} onChange={(e) => setYm(e.target.value)} style={{ width: "auto" }} /></label>
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>임대료(총액·부가세 포함)
            <input className="b2b-input" type="number" min={0} value={rent || ""} onChange={(e) => setRent(Number(e.target.value) || 0)} placeholder="0" style={{ width: 130, textAlign: "right" }} /></label>
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>면세 기타
            <input className="b2b-input" type="number" min={0} value={etc || ""} onChange={(e) => setEtc(Number(e.target.value) || 0)} placeholder="0" style={{ width: 120, textAlign: "right" }} /></label>
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>과세 기타
            <input className="b2b-input" type="number" min={0} value={taxEtc || ""} onChange={(e) => setTaxEtc(Number(e.target.value) || 0)} placeholder="0" style={{ width: 130, textAlign: "right" }} /></label>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>※ 과세는 입고 단가를 공급가액으로 보고 부가세 10%를 더합니다. 임대료·면세/과세 기타는 직접 입력(브라우저에 기억).</p>
      </section>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : items.length === 0 && !s?.rentTotal ? (
        <div className="b2b-empty">{ym} 매입 내역이 없습니다.</div>
      ) : s && (
        <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "28px 30px", maxWidth: 900, boxShadow: "var(--sm-shadow-card)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 18 }}>
            <div><div style={{ fontSize: 15, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div><h2 style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{y}년 {mm}월 매입 결산</h2></div>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>총 입금액<div style={{ fontSize: 24, fontWeight: 800, color: "var(--sm-black)", marginTop: 2 }}>{won(s.deposit)}원</div></div>
          </div>

          {/* 요약 블록 */}
          <div className="b2b-table-wrap" style={{ marginBottom: 22 }}>
          <table className="b2b-table">
            <thead><tr><th>구분</th><th className="num">공급가액</th><th className="num">세액 / 기타</th><th className="num">총액</th></tr></thead>
            <tbody>
              <tr><td style={{ fontWeight: 700 }}>임대료</td><td className="num b2b-money">{won(s.rentSupply)}</td><td className="num b2b-money">{won(s.rentVat)}</td><td className="num b2b-money" style={{ fontWeight: 700 }}>{won(s.rentTotal)}</td></tr>
              <tr><td style={{ fontWeight: 700 }}>면세품목</td><td className="num b2b-money">{won(s.exemptSupply)}</td><td className="num b2b-money">{won(s.exemptEtc)}</td><td className="num b2b-money" style={{ fontWeight: 700 }}>{won(s.exemptTotal)}</td></tr>
              <tr><td style={{ fontWeight: 700 }}>과세품목</td><td className="num b2b-money">{won(s.taxableSupply)}</td><td className="num b2b-money">{won(s.taxableVat)}</td><td className="num b2b-money" style={{ fontWeight: 700 }}>{won(s.taxableTotal)}</td></tr>
              <tr style={{ background: "var(--sm-bg-subtle)" }}><td style={{ fontWeight: 800 }}>총 입금액</td><td className="num" /><td className="num" /><td className="num b2b-money" style={{ fontWeight: 800, fontSize: 15 }}>{won(s.deposit)}</td></tr>
            </tbody>
          </table>
          </div>

          {/* SKU 표 */}
          <div className="sm-between" style={{ marginBottom: 6 }}>
            <strong style={{ fontSize: 15 }}>품목별 매입 ({s.itemCount}종 · {s.totalQty.toLocaleString()}개)</strong>
            {s.totalReturnQty > 0 && (
              <span className="sm-faint" style={{ fontSize: 12 }}>반품 {s.totalReturnQty.toLocaleString()}개 · {won(s.returnAmount)}원 차감</span>
            )}
          </div>
          <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr><th>코드명</th><th>품목명</th><th>규격(g)</th><th>원산지</th><th className="num">매입가</th><th className="num">매입수량</th><th className="num">반품수량</th><th className="num">총 매입금액</th><th>구분</th></tr></thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.product_id}>
                  <td style={{ fontFamily: "var(--sm-mono)", fontSize: 12 }}>{it.sku || "-"}</td>
                  <td>{it.name}</td>
                  <td>{it.spec || "-"}</td>
                  <td>{it.origin || "-"}</td>
                  <td className="num b2b-money">{it.unit_price.toLocaleString()}</td>
                  <td className="num b2b-money">{it.qty.toLocaleString()}</td>
                  <td className="num b2b-money" style={{ color: it.return_qty > 0 ? "var(--sm-danger)" : "var(--sm-text-light)", fontWeight: it.return_qty > 0 ? 700 : 400 }}>
                    {it.return_qty > 0 ? it.return_qty.toLocaleString() : "-"}
                  </td>
                  <td className="num b2b-money" style={{ fontWeight: 700 }}
                    title={[
                      it.return_qty > 0 ? `정산수량 ${it.net_qty.toLocaleString()} (반품 ${it.return_qty.toLocaleString()} 제외)` : "",
                      it.tax_type === "taxable" ? `공급가 ${Math.round(it.amount).toLocaleString()} + VAT` : "",
                    ].filter(Boolean).join(" · ")}>{it.total.toLocaleString()}</td>
                  <td><span className="sm-faint" style={{ fontSize: 12 }}>{it.tax_type === "exempt" ? "면세" : "과세"}</span></td>
                </tr>
              ))}
              <tr style={{ fontWeight: 800, background: "var(--sm-bg-subtle)" }}>
                <td colSpan={4}>합계</td>
                <td className="num" />
                <td className="num">{s.totalQty.toLocaleString()}</td>
                <td className="num" style={{ color: s.totalReturnQty > 0 ? "var(--sm-danger)" : undefined }}>{s.totalReturnQty > 0 ? s.totalReturnQty.toLocaleString() : "-"}</td>
                <td className="num">{s.totalAmount.toLocaleString()}</td>
                <td />
              </tr>
            </tbody>
          </table>
          </div>
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
            ※ 매입가 = 가중평균 매입단가(1원 미만 반올림) — 단가가 여러 번이었으면 매입가 × 수량이 총 매입금액과 몇 원 어긋날 수 있습니다. 금액은 실제 매입액 기준입니다.<br />
            ※ 총 매입금액 = 실제 매입액 − 반품액(반품수량 × 매입가, 반품 단가를 적었으면 그 단가), 과세는 부가세 포함. 합계는 열마다 그 열을 더한 값입니다.<br />
            ※ 반품은 재고를 건드리지 않습니다 — 물건이 실제로 빠지는 처리는 재고목록에서 따로 합니다.
          </p>
        </section>
      )}

      {returnOpen && (
        <ReturnModal
          month={ym}
          onClose={() => setReturnOpen(false)}
          onSaved={() => { setReturnOpen(false); load(ym, rent, etc, taxEtc); }}
        />
      )}
    </div>
  );
}
