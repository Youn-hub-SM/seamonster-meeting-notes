"use client";

import { useState } from "react";
import Link from "next/link";
import OrdersTable from "../OrdersTable";
import { ChannelPicker } from "../ChannelTabs";
import { INV_TYPE_COLOR, type InvChannel } from "@/app/lib/inventory";

type ImportRow = { type: "입고" | "출고"; qty: number; product_id: string; product_name: string; unit_amount: number | null; txn_date: string; partner: string | null; memo: string | null };
type Preview = { summary: { valid: number; errors: number; merged?: number }; rows: ImportRow[]; errors: { line: number; msg: string }[] };
const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export default function TradePage() {
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false); // 업로드 설정 모달
  const [ioType, setIoType] = useState<"입고" | "출고">("출고"); // 기본 출고
  const [ioChannel, setIoChannel] = useState<InvChannel>("소매");
  const [ioDate, setIoDate] = useState(TODAY());
  const [ioPartner, setIoPartner] = useState("");
  const [ioDone, setIoDone] = useState(true); // 즉시 입고/출고처리(기본 체크)

  function openUpload() { setError(""); setIoDate(TODAY()); setUploadOpen(true); } // 열 때 거래일은 오늘로 리셋

  async function handleFile(file: File) {
    setImporting(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("type", ioType); fd.append("txn_date", ioDate); fd.append("partner", ioPartner);
      const res = await fetch("/api/inventory/txns/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setPreview(j as Preview);
      setUploadOpen(false); // 분석 성공 → 설정 모달 닫고 미리보기로
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setImporting(false);
  }
  async function applyImport() {
    if (!preview) return;
    setApplying(true); setError("");
    try {
      const res = await fetch("/api/inventory/txns/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: preview.rows, done: ioDone, channel: ioChannel }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "적용 실패");
      setPreview(null); setReload((n) => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "적용 실패"); }
    setApplying(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">구매 및 판매</h1><p className="b2b-page-subtitle">여러 제품을 한 화면에 담아 기록하거나, <strong>엑셀</strong>로 한 번에 올리세요. 엑셀 업로드는 유형·채널·거래일을 고른 뒤 파일을 첨부합니다.</p></div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={openUpload}>엑셀 업로드</button>
          <Link className="b2b-btn-primary" href="/inventory/trade/new">+ 입고/판매 기록</Link>
        </div>
      </header>

      {error && !uploadOpen && !preview && <div className="b2b-error">{error}</div>}

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">입고·출고 내역 (주문 단위)</span></div>
        <OrdersTable reloadKey={reload} />
      </section>

      {/* 엑셀 업로드 설정 → 파일 첨부 */}
      {uploadOpen && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">엑셀 일괄 업로드</h2>
              <button className="b2b-modal-close" onClick={() => setUploadOpen(false)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="b2b-field">
                <label className="b2b-field-label">① 유형</label>
                <div className="sm-tabs" style={{ margin: 0 }}>
                  <button className={`sm-tab ${ioType === "출고" ? "is-active" : ""}`} onClick={() => setIoType("출고")}>판매(출고)</button>
                  <button className={`sm-tab ${ioType === "입고" ? "is-active" : ""}`} onClick={() => setIoType("입고")}>구매(입고)</button>
                </div>
              </div>

              <div className="b2b-field" style={{ marginTop: 12 }}>
                <label className="b2b-field-label">② 채널 <span className="sm-faint" style={{ fontWeight: 400 }}>(선택 · 기본 소매)</span></label>
                <ChannelPicker value={ioChannel} onChange={setIoChannel} />
              </div>

              <div className="b2b-field-row" style={{ marginTop: 12 }}>
                <div className="b2b-field">
                  <label className="b2b-field-label">③ 거래일 <span className="sm-faint" style={{ fontWeight: 400 }}>(선택 · 기본 오늘)</span></label>
                  <input className="b2b-input" type="date" value={ioDate} onChange={(e) => setIoDate(e.target.value)} />
                </div>
                <div className="b2b-field">
                  <label className="b2b-field-label">{ioType === "입고" ? "매입처" : "판매처"} <span className="sm-faint" style={{ fontWeight: 400 }}>(선택)</span></label>
                  <input className="b2b-input" placeholder="선택" value={ioPartner} onChange={(e) => setIoPartner(e.target.value)} />
                </div>
              </div>

              <label className="sm-row" style={{ gap: 7, marginTop: 12, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={ioDone} onChange={(e) => setIoDone(e.target.checked)} /> 즉시 {ioType === "입고" ? "입고" : "출고"}처리 <span className="sm-faint" style={{ fontSize: 12 }}>(해제 시 ‘대기’)</span>
              </label>

              <p className="sm-faint" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
                {ioType === "입고"
                  ? <>양식 = <strong>SKU · 수량 · 단가</strong></>
                  : <>양식 = <strong>수량 · (무시) · SKU</strong> (외부 출고 파일 그대로 · 가운데 열 무시)</>}
                {" · "}<a href={`/api/inventory/txns/template?type=${ioType}`} className="sm-link">양식 다운로드</a>
                <br />거래일·거래처·채널은 파일 전체에 적용됩니다.
              </p>

              {error && <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div>}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setUploadOpen(false)} disabled={importing}>취소</button>
                <label className="b2b-btn-primary" style={{ cursor: importing ? "default" : "pointer" }}>
                  {importing ? "분석 중…" : "④ 엑셀 첨부"}
                  <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">엑셀 업로드 — 미리보기</h2>
              <button className="b2b-modal-close" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                <span>반영 가능 <strong style={{ color: "var(--sm-success)" }}>{preview.summary.valid}</strong>건</span>
                {!!preview.summary.merged && <span className="sm-faint">중복 SKU {preview.summary.merged}건 합산됨</span>}
                {preview.summary.errors > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.summary.errors}건(제외)</span>}
              </div>
              {preview.summary.valid === 0 && <div className="b2b-empty" style={{ padding: 20 }}>반영할 행이 없습니다.</div>}
              {preview.rows.length > 0 && (
                <div className="b2b-table-wrap" style={{ maxHeight: 320, overflow: "auto", marginBottom: 12 }}>
                  <table className="b2b-table">
                    <thead><tr><th>날짜</th><th>유형</th><th>품목</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th></tr></thead>
                    <tbody>
                      {preview.rows.slice(0, 200).map((r, i) => { const c = INV_TYPE_COLOR[r.type]; return (
                        <tr key={i}>
                          <td style={{ whiteSpace: "nowrap" }}>{r.txn_date?.slice(5)}</td>
                          <td><span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{r.type}</span></td>
                          <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.product_name}</td>
                          <td className="num b2b-money" style={{ color: c.fg, fontWeight: 700 }}>{r.qty > 0 ? "+" : ""}{r.qty.toLocaleString()}</td>
                          <td className="num b2b-money">{r.unit_amount ? r.unit_amount.toLocaleString() : "-"}</td>
                          <td>{r.partner || "-"}</td>
                        </tr>
                      ); })}
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
