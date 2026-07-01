"use client";

import { useState } from "react";
import Link from "next/link";
import OrdersTable from "../OrdersTable";

type ImportRow = { type: "입고" | "출고"; qty: number; product_id: string; product_name: string; unit_amount: number | null; txn_date: string; partner: string | null; memo: string | null };
type Preview = { summary: { valid: number; errors: number }; rows: ImportRow[]; errors: { line: number; msg: string }[] };
const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export default function TradePage() {
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ioType, setIoType] = useState<"입고" | "출고">("입고");
  const [ioDate, setIoDate] = useState(TODAY());
  const [ioPartner, setIoPartner] = useState("");
  const [ioDone, setIoDone] = useState(true); // 즉시 입고/출고처리(기본 체크)

  async function handleFile(file: File) {
    setImporting(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("type", ioType); fd.append("txn_date", ioDate); fd.append("partner", ioPartner);
      const res = await fetch("/api/inventory/txns/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setPreview(j as Preview);
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setImporting(false);
  }
  async function applyImport() {
    if (!preview) return;
    setApplying(true); setError("");
    try {
      const res = await fetch("/api/inventory/txns/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: preview.rows, done: ioDone }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "적용 실패");
      setPreview(null); setReload((n) => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "적용 실패"); }
    setApplying(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">구매 및 판매</h1><p className="b2b-page-subtitle">여러 제품을 한 화면에 담아 기록하거나, <strong>엑셀(SKU·수량·단가)</strong>로 한 번에 올리세요.</p></div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href="/api/inventory/txns/template" title="SKU·수량·단가 엑셀 양식">엑셀 양식</a>
          <Link className="b2b-btn-primary" href="/inventory/trade/new">+ 입고/판매 기록</Link>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* 엑셀 일괄 입력 — 양식에 유형이 없어 업로드 시 구매/판매 선택 */}
      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span className="b2b-card-title" style={{ marginRight: 4 }}>엑셀 일괄 입력</span>
          <div className="sm-tabs">
            <button className={`sm-tab ${ioType === "입고" ? "is-active" : ""}`} onClick={() => setIoType("입고")}>구매(입고)</button>
            <button className={`sm-tab ${ioType === "출고" ? "is-active" : ""}`} onClick={() => setIoType("출고")}>판매(출고)</button>
          </div>
          <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>거래일
            <input className="b2b-input" type="date" value={ioDate} onChange={(e) => setIoDate(e.target.value)} style={{ width: "auto" }} /></label>
          <input className="b2b-input" placeholder={ioType === "입고" ? "매입처(선택)" : "판매처(선택)"} value={ioPartner} onChange={(e) => setIoPartner(e.target.value)} style={{ width: 150 }} />
          <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}><input type="checkbox" checked={ioDone} onChange={(e) => setIoDone(e.target.checked)} /> 즉시 {ioType === "입고" ? "입고" : "출고"}처리</label>
          <label className="b2b-btn-primary" style={{ cursor: importing ? "default" : "pointer", marginLeft: "auto" }}>
            {importing ? "분석 중…" : "엑셀 업로드"}
            <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          </label>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>양식 = <strong>SKU · 수량 · 단가</strong>. 구매/판매를 고르고 업로드 → 미리보기 후 반영. (거래일·거래처는 파일 전체에 적용)</p>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 2 }}>과거 출고 일괄 이관: 엑셀에 <strong>‘날짜’</strong> 열(YYYY-MM-DD, 발주일/거래일도 인식)을 넣으면 행별 날짜로 기록됩니다 → 안전재고(판매속도) 워밍업에 쓰입니다.</p>
      </section>

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">입고·출고 내역 (주문 단위)</span></div>
        <OrdersTable reloadKey={reload} />
      </section>

      {preview && (
        <div className="b2b-modal-backdrop" onClick={() => !applying && setPreview(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">엑셀 업로드 — 미리보기</h2>
              <button className="b2b-modal-close" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                <span>반영 가능 <strong style={{ color: "var(--sm-success)" }}>{preview.summary.valid}</strong>건</span>
                {preview.summary.errors > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.summary.errors}건(제외)</span>}
              </div>
              {preview.summary.valid === 0 && <div className="b2b-empty" style={{ padding: 20 }}>반영할 행이 없습니다.</div>}
              {preview.rows.length > 0 && (
                <div className="b2b-table-wrap" style={{ maxHeight: 320, overflow: "auto", marginBottom: 12 }}>
                  <table className="b2b-table">
                    <thead><tr><th>날짜</th><th>유형</th><th>품목</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th></tr></thead>
                    <tbody>
                      {preview.rows.slice(0, 200).map((r, i) => (
                        <tr key={i}>
                          <td style={{ whiteSpace: "nowrap" }}>{r.txn_date?.slice(5)}</td>
                          <td><span className="b2b-feed-pill" style={{ background: r.type === "입고" ? "var(--sm-success-bg)" : "var(--sm-info-bg)", color: r.type === "입고" ? "var(--sm-success)" : "var(--sm-info)", fontWeight: 700 }}>{r.type}</span></td>
                          <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.product_name}</td>
                          <td className="num b2b-money" style={{ color: r.qty >= 0 ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 700 }}>{r.qty > 0 ? "+" : ""}{r.qty.toLocaleString()}</td>
                          <td className="num b2b-money">{r.unit_amount ? r.unit_amount.toLocaleString() : "-"}</td>
                          <td>{r.partner || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.rows.length > 200 && <p className="sm-faint" style={{ fontSize: 12, padding: "6px 2px" }}>…외 {preview.rows.length - 200}건(전체 반영됩니다)</p>}
                </div>
              )}
              {preview.errors.length > 0 && (
                <section>
                  <div className="b2b-field-label" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>오류 ({preview.errors.length}) — 해당 행은 제외</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--sm-danger)", maxHeight: 140, overflow: "auto" }}>
                    {preview.errors.map((e, i) => <li key={i}>{e.line}행: {e.msg}</li>)}
                  </ul>
                </section>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setPreview(null)} disabled={applying}>취소</button>
                <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.summary.valid === 0}>{applying ? "반영 중…" : `${preview.summary.valid}건 반영`}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
