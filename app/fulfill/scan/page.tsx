"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Batch = { id: string; title: string; created_by: string | null; created_at: string; closed: boolean; invoice_count: number; item_count: number; note: string | null; scanned_count?: number };
type Tally = { key: string; sku: string; name: string; qty: number; unknown: boolean };
type Recent = { invoice_no: string; scanned_at: string; scanned_by: string | null };
type State = { tally: Tally[]; scannedCount: number; totalInvoices: number; totalUnits: number; recent?: Recent[] };

const SEL_KEY = "fulfill_scan_batch";
const fmtTime = (iso: string) => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export default function ScanPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [sel, setSel] = useState<string>("");
  const [detail, setDetail] = useState<(State & { batch: Batch }) | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState("");

  // 업로드
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadInfo, setUploadInfo] = useState<{ invoiceCount: number; itemCount: number; excludedNothing: number; unmatched: string[] } | null>(null);

  // 스캔
  const scanRef = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState("");
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "dup" | "bad"; text: string } | null>(null);

  const loadList = useCallback(async () => {
    setLoadingList(true); setError("");
    try {
      const j = await (await fetch("/api/fulfill/scan/batches", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setBatches(j.batches || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 실패"); }
    setLoadingList(false);
  }, []);

  const loadDetail = useCallback(async (id: string, silent = false) => {
    if (!silent) setError("");
    try {
      const j = await (await fetch(`/api/fulfill/scan/batches/${id}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setDetail({ batch: j.batch, tally: j.tally, scannedCount: j.scannedCount, totalInvoices: j.totalInvoices, totalUnits: j.totalUnits, recent: j.recent });
    } catch (e) { if (!silent) setError(e instanceof Error ? e.message : "조회 실패"); }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  // 저장된 배치 자동 선택(목록 로드 후)
  useEffect(() => {
    if (sel || !batches.length) return;
    const saved = localStorage.getItem(SEL_KEY);
    if (saved && batches.some((b) => b.id === saved)) setSel(saved);
  }, [batches, sel]);

  // 선택 배치 상세 로드 + 다른 기기 스캔 반영용 주기 새로고침
  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    localStorage.setItem(SEL_KEY, sel);
    loadDetail(sel);
    setTimeout(() => scanRef.current?.focus(), 100);
    const t = setInterval(() => loadDetail(sel, true), 12000);
    return () => clearInterval(t);
  }, [sel, loadDetail]);

  async function upload(file: File) {
    setUploading(true); setError(""); setUploadInfo(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (uploadTitle.trim()) fd.append("title", uploadTitle.trim());
      const j = await (await fetch("/api/fulfill/scan/batches", { method: "POST", body: fd })).json();
      if (!j.ok) throw new Error(j.error || "업로드 실패");
      setUploadInfo({ invoiceCount: j.invoiceCount, itemCount: j.itemCount, excludedNothing: j.excludedNothing, unmatched: j.unmatched || [] });
      setUploadTitle("");
      await loadList();
      setSel(j.batch.id); // 새 배치로 이동
    } catch (e) { setError(e instanceof Error ? e.message : "업로드 실패"); }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function doScan() {
    const inv = scan.trim();
    if (!inv || !sel || scanning) return;
    setScanning(true);
    try {
      const j = await (await fetch(`/api/fulfill/scan/batches/${sel}/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_no: inv }) })).json();
      if (!j.ok) throw new Error(j.error || "스캔 실패");
      setDetail((d) => (d ? { ...d, tally: j.tally, scannedCount: j.scannedCount, totalInvoices: j.totalInvoices, totalUnits: j.totalUnits } : d));
      if (!j.known) setMsg({ kind: "bad", text: `미등록 송장번호 · ${inv}` });
      else if (j.alreadyScanned) setMsg({ kind: "dup", text: `이미 스캔한 송장 · ${inv}` });
      else setMsg({ kind: "ok", text: `스캔 완료 · ${inv}` });
    } catch (e) { setMsg({ kind: "bad", text: e instanceof Error ? e.message : "스캔 실패" }); }
    setScan("");
    setScanning(false);
    scanRef.current?.focus();
  }

  async function reset() {
    if (!sel || !confirm("이 배치의 스캔 내역을 모두 초기화할까요? (업로드한 송장 데이터는 유지됩니다)")) return;
    try {
      const j = await (await fetch(`/api/fulfill/scan/batches/${sel}/reset`, { method: "POST" })).json();
      if (!j.ok) throw new Error(j.error || "초기화 실패");
      setDetail((d) => (d ? { ...d, tally: j.tally, scannedCount: j.scannedCount, totalInvoices: j.totalInvoices, totalUnits: j.totalUnits, recent: [] } : d));
      setMsg(null);
      scanRef.current?.focus();
    } catch (e) { setError(e instanceof Error ? e.message : "초기화 실패"); }
  }

  async function removeBatch(id: string) {
    if (!confirm("이 배치를 삭제할까요? 업로드한 송장 데이터와 스캔 내역이 모두 사라집니다.")) return;
    try {
      const j = await (await fetch(`/api/fulfill/scan/batches/${id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "삭제 실패");
      if (sel === id) { setSel(""); localStorage.removeItem(SEL_KEY); }
      await loadList();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
  }

  const pct = detail && detail.totalInvoices ? Math.round((detail.scannedCount / detail.totalInvoices) * 100) : 0;

  return (
    <div className="b2b-container" style={{ maxWidth: 920 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">송장 스캔</h1>
          <p className="b2b-page-subtitle">
            그날 <strong>송장 데이터(송장번호·단품코드·수량)</strong>를 올려 두면, 어느 기기에서든 송장번호를 스캔해 <strong>상품별 필요 수량</strong>을 실시간 집계합니다.
            묶음(세트)은 <Link href="/inventory/bundles">묶음상품</Link> 구성으로 자동 전개하고, 상품명은 <Link href="/b2b/products">상품마스터</Link> 기준입니다.
          </p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{error.includes("057") ? " — supabase/migrations/057_fulfill_scan.sql 를 먼저 적용하세요." : ""}</div>}

      {/* ── 배치 선택 / 업로드 ── */}
      {!sel && (
        <>
          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">새 배치 업로드</span>
              <a href="/api/fulfill/scan/template" className="change-link" style={{ fontSize: 12 }}>양식 다운로드</a>
            </div>
            <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 12px", lineHeight: 1.6 }}>
              엑셀(.xlsx)·CSV 지원. 열 제목에 <strong>송장번호</strong>·<strong>단품코드</strong>(·<strong>주문수량</strong>)가 있으면 자동 인식합니다. 단품코드 NOTHING(정기배송 등)은 제외됩니다.
            </p>
            <div className="sm-row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input className="b2b-input" placeholder="배치 이름(선택 · 예: 7/6 오전)" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} style={{ width: 240, maxWidth: "100%" }} />
              <button className="b2b-btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? "업로드 중…" : "파일 올리기"}</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
            </div>
            {uploadInfo && (
              <div className="prod-sku-ok" style={{ fontSize: 12.5, marginTop: 10 }}>
                ✓ 송장 {uploadInfo.invoiceCount.toLocaleString()}건 · 라인 {uploadInfo.itemCount.toLocaleString()}개 저장{uploadInfo.excludedNothing ? ` · NOTHING ${uploadInfo.excludedNothing} 제외` : ""}
                {uploadInfo.unmatched.length > 0 && <div style={{ color: "var(--sm-danger)", marginTop: 4 }}>미등록 단품코드 {uploadInfo.unmatched.length}개: {uploadInfo.unmatched.slice(0, 15).join(", ")}{uploadInfo.unmatched.length > 15 ? " …" : ""}</div>}
              </div>
            )}
          </section>

          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">배치 목록</span>
              <button className="b2b-btn-secondary" style={{ padding: "5px 10px", fontSize: 12 }} onClick={loadList} disabled={loadingList}>새로고침</button>
            </div>
            {loadingList ? (
              <div className="b2b-loading">불러오는 중…</div>
            ) : batches.length === 0 ? (
              <div className="b2b-empty"><div className="b2b-empty-icon">📦</div>업로드된 배치가 없습니다. 위에서 송장 데이터를 올리세요.</div>
            ) : (
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead><tr><th>배치</th><th className="num">송장</th><th className="num">스캔</th><th>올린이</th><th>올린 시각</th><th></th></tr></thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setSel(b.id)}>
                        <td><strong>{b.title || "(제목 없음)"}</strong></td>
                        <td className="num b2b-money">{b.invoice_count.toLocaleString()}</td>
                        <td className="num b2b-money" style={{ color: (b.scanned_count || 0) ? "var(--sm-success)" : "var(--sm-text-light)" }}>{(b.scanned_count || 0).toLocaleString()}</td>
                        <td className="sm-faint">{b.created_by || "-"}</td>
                        <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{fmtTime(b.created_at)}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="sm-row" style={{ gap: 6 }}>
                            <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setSel(b.id)}>열기</button>
                            <button className="b2b-btn-secondary" style={{ padding: "4px 8px", fontSize: 12, color: "var(--sm-danger)" }} onClick={() => removeBatch(b.id)}>삭제</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {/* ── 스캔 스테이션 ── */}
      {sel && detail && (
        <>
          <div className="sm-between" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button className="b2b-btn-secondary" onClick={() => { setSel(""); localStorage.removeItem(SEL_KEY); setMsg(null); setUploadInfo(null); }}>← 배치 목록</button>
            <span style={{ fontWeight: 700 }}>{detail.batch.title}</span>
            <div className="sm-row" style={{ gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
              <button className="b2b-btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => (window.location.href = `/api/fulfill/scan/batches/${sel}/export`)}>엑셀 내보내기</button>
              <button className="b2b-btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={reset}>스캔 초기화</button>
            </div>
          </div>

          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", marginBottom: 14 }}>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">스캔한 송장</div><div className="b2b-stat-card-value" style={{ color: "var(--sm-success)" }}>{detail.scannedCount.toLocaleString()} <span className="sm-faint" style={{ fontSize: 13, fontWeight: 400 }}>/ {detail.totalInvoices.toLocaleString()}</span></div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">진행률</div><div className="b2b-stat-card-value">{pct}%</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">상품 종류</div><div className="b2b-stat-card-value">{detail.tally.length}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">총 수량</div><div className="b2b-stat-card-value b2b-money">{detail.totalUnits.toLocaleString()}</div></div>
          </div>

          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <label className="b2b-field-label">송장번호 스캔</label>
            <input
              ref={scanRef}
              className="b2b-input"
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doScan(); } }}
              placeholder="바코드를 스캔하거나 송장번호 입력 후 Enter"
              autoFocus
              inputMode="numeric"
              style={{ fontSize: 20, padding: "12px 14px", fontWeight: 700, letterSpacing: 0.5 }}
            />
            {msg && (
              <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 14, fontWeight: 700,
                background: msg.kind === "ok" ? "var(--sm-success-bg)" : msg.kind === "dup" ? "var(--sm-warning-bg)" : "var(--sm-danger-bg)",
                color: msg.kind === "ok" ? "var(--sm-success)" : msg.kind === "dup" ? "var(--sm-warning)" : "var(--sm-danger)" }}>
                {msg.kind === "ok" ? "✓ " : msg.kind === "dup" ? "· " : "✗ "}{msg.text}
              </div>
            )}
          </section>

          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">상품별 집계</span>
              <span className="sm-faint" style={{ fontSize: 12 }}>스캔한 송장 기준 · 묶음 전개 반영</span>
            </div>
            {detail.tally.length === 0 ? (
              <div className="b2b-empty" style={{ padding: 24 }}>아직 스캔된 송장이 없습니다. 위에서 스캔을 시작하세요.</div>
            ) : (
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead><tr><th>상품명</th><th>SKU</th><th className="num">수량</th></tr></thead>
                  <tbody>
                    {detail.tally.map((t) => (
                      <tr key={t.key} style={{ background: t.unknown ? "var(--sm-danger-bg)" : undefined }}>
                        <td><strong>{t.name}</strong></td>
                        <td className="sm-faint">{t.sku || "-"}</td>
                        <td className="num b2b-money" style={{ fontWeight: 800, fontSize: 15 }}>{t.qty.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {detail.tally.some((t) => t.unknown) && <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 8, color: "var(--sm-danger)" }}>⚠️ 빨간 줄 = 상품마스터에 없는 단품코드. <Link href="/b2b/products">상품마스터</Link>에 등록하면 상품명으로 집계됩니다.</p>}
          </section>
        </>
      )}
    </div>
  );
}
