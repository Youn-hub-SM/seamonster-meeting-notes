"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Tally = { key: string; sku: string; name: string; qty: number; unknown: boolean };
type State = { tally: Tally[]; scannedCount: number; totalInvoices: number; totalUnits: number };

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export default function ScanPage() {
  const [st, setSt] = useState<State | null>(null);
  const [error, setError] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState("");
  const [pending, setPending] = useState(0); // 처리 대기 중인 스캔 수
  const [msg, setMsg] = useState<{ kind: "ok" | "dup" | "bad"; text: string } | null>(null);
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);

  const loadState = useCallback(async (silent = false) => {
    if (!silent) setError("");
    try {
      const j = await (await fetch("/api/fulfill/scan/state", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setSt({ tally: j.tally, scannedCount: j.scannedCount, totalInvoices: j.totalInvoices, totalUnits: j.totalUnits });
    } catch (e) { if (!silent) setError(e instanceof Error ? e.message : "조회 실패"); }
  }, []);

  useEffect(() => {
    loadState();
    setTimeout(() => scanRef.current?.focus(), 100);
    // 업로더가 추가한 데이터 반영. 단, 스캔 처리 중엔 건너뜀(진행 중 집계 덮어쓰기 방지).
    const t = setInterval(() => { if (!processingRef.current && queueRef.current.length === 0) loadState(true); }, 8000);
    return () => clearInterval(t);
  }, [loadState]);

  // 입력은 즉시 비우고 다음 스캔을 받음. 실제 처리(서버 왕복)는 백그라운드 큐에서 순차 진행 → 스캔이 안 밀림.
  function submitScan() {
    const inv = scan.trim();
    if (!inv) return;
    setScan("");
    queueRef.current.push(inv);
    setPending(queueRef.current.length);
    scanRef.current?.focus();
    pump();
  }
  async function pump() {
    if (processingRef.current) return;
    processingRef.current = true;
    while (queueRef.current.length) {
      const inv = queueRef.current[0];
      try {
        const j = await (await fetch("/api/fulfill/scan/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_no: inv }) })).json();
        if (!j.ok) throw new Error(j.error || "스캔 실패");
        if (!j.known) setMsg({ kind: "bad", text: `미등록 송장번호 · ${inv}` });
        else {
          setSt((s) => ({ tally: j.tally, scannedCount: j.scannedCount, totalUnits: j.totalUnits, totalInvoices: s?.totalInvoices ?? 0 }));
          setMsg(j.alreadyScanned ? { kind: "dup", text: `이미 스캔한 송장 · ${inv}` } : { kind: "ok", text: `스캔 완료 · ${inv}` });
        }
      } catch (e) { setMsg({ kind: "bad", text: e instanceof Error ? e.message : "스캔 실패" }); }
      queueRef.current.shift();
      setPending(queueRef.current.length);
    }
    processingRef.current = false;
  }

  // 스캔 초기화 — 인쇄 후 다음 라운드를 위해 자주 누르므로 확인창 없이 즉시(업로드 데이터는 유지).
  async function reset() {
    try {
      queueRef.current = []; setPending(0); // 대기 중 스캔도 취소(깨끗한 새 라운드)
      const j = await (await fetch("/api/fulfill/scan/reset", { method: "POST" })).json();
      if (!j.ok) throw new Error(j.error || "초기화 실패");
      setSt({ tally: j.tally, scannedCount: j.scannedCount, totalInvoices: j.totalInvoices, totalUnits: j.totalUnits });
      setMsg({ kind: "ok", text: "초기화 완료 · 새로 스캔하세요" });
      scanRef.current?.focus();
    } catch (e) { setError(e instanceof Error ? e.message : "초기화 실패"); }
  }

  // 피킹 리스트 인쇄 — 품목명·수량만. 현재 스캔한 만큼의 상품별 수량.
  function printTally() {
    if (!st || !st.tally.length) return;
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const rows = st.tally.map((t) => `<tr><td>${esc(t.name)}</td><td class="q">${t.qty.toLocaleString()}</td></tr>`).join("");
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>피킹 리스트</title>`
      + `<style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,'Malgun Gothic',sans-serif;margin:22px;color:#111}`
      + `h1{font-size:19px;margin:0 0 3px}.meta{color:#666;font-size:12px;margin-bottom:14px}`
      + `table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #d0d0d0;padding:10px 6px;text-align:left}`
      + `th{font-size:12px;color:#666}td{font-size:17px}th.q,td.q{text-align:right;width:90px}td.q{font-weight:800;font-size:21px}`
      + `tfoot td{font-weight:800;border-top:2px solid #333;border-bottom:none;font-size:17px}`
      + `@media print{body{margin:6mm}}</style></head><body>`
      + `<h1>피킹 리스트</h1>`
      + `<div class="meta">출력 ${ts} · 스캔 ${st.scannedCount}건</div>`
      + `<table><thead><tr><th>품목명</th><th class="q">수량</th></tr></thead><tbody>${rows}</tbody>`
      + `<tfoot><tr><td>합계</td><td class="q">${st.totalUnits.toLocaleString()}</td></tr></tfoot></table>`
      + `<script>window.onload=function(){setTimeout(function(){window.print()},80)}</script></body></html>`;
    const w = window.open("", "_blank", "width=560,height=880");
    if (!w) { alert("팝업이 차단되었습니다. 팝업을 허용한 뒤 다시 인쇄하세요."); return; }
    w.document.write(html);
    w.document.close();
  }

  // 단축키: F2=인쇄, F4=초기화. 바코드 스캐너는 F키를 보내지 않아 스캔 입력과 충돌하지 않음.
  const actRef = useRef<{ print: () => void; reset: () => void }>({ print: () => {}, reset: () => {} });
  actRef.current = { print: printTally, reset };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); actRef.current.print(); }
      else if (e.key === "F4") { e.preventDefault(); actRef.current.reset(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="b2b-container" style={{ maxWidth: 760 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">송장 스캔</h1>
        </div>
        <div className="b2b-page-actions"><Link className="b2b-btn-secondary" href="/fulfill/scan/upload">송장 업로드</Link></div>
      </header>

      {error && <div className="b2b-error">{error}{error.includes("057") ? " — supabase/migrations/057_fulfill_scan.sql 를 먼저 적용하세요." : ""}</div>}

      {st && st.totalInvoices === 0 && !error && (
        <div className="b2b-empty" style={{ marginBottom: 16 }}>스캔할 송장 데이터가 없습니다. <Link href="/fulfill/scan/upload">송장 업로드</Link>에서 파일을 먼저 올리세요.</div>
      )}

      <section className="b2b-card" style={{ marginBottom: 14 }}>
        <div className="sm-between" style={{ alignItems: "baseline" }}>
          <label className="b2b-field-label">송장번호 스캔 <span className="sm-faint" style={{ fontWeight: 400 }}>(하이픈 있어도/없어도 인식)</span></label>
          <span className="sm-faint" style={{ fontSize: 12 }}>
            이번 스캔 <strong style={{ color: "var(--sm-success)", fontSize: 14 }}>{st?.scannedCount ?? 0}</strong>건 · 대상 {st?.totalInvoices ?? 0}건
            {pending > 0 && <span style={{ color: "var(--sm-info)", marginLeft: 6 }}>· 처리 중 {pending}</span>}
          </span>
        </div>
        <input
          ref={scanRef}
          className="b2b-input"
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitScan(); } }}
          placeholder="바코드를 스캔하거나 송장번호 입력 후 Enter"
          autoFocus
          style={{ fontSize: 20, padding: "12px 14px", fontWeight: 700, letterSpacing: 0.5 }}
        />
        {msg && (
          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 14, fontWeight: 700,
            background: msg.kind === "ok" ? "var(--sm-success-bg)" : msg.kind === "dup" ? "var(--sm-warning-bg)" : "var(--sm-danger-bg)",
            color: msg.kind === "ok" ? "var(--sm-success)" : msg.kind === "dup" ? "var(--sm-warning)" : "var(--sm-danger)" }}>
            {msg.kind === "ok" ? "✓ " : msg.kind === "dup" ? "· " : ""}{msg.text}
          </div>
        )}
      </section>

      {/* 인쇄 → 상품 가지러 → 초기화 → 다음 스캔. 두 버튼을 크고 눈에 띄게. */}
      <div className="sm-row" style={{ gap: 12, marginBottom: 6, flexWrap: "wrap" }}>
        <button className="b2b-btn-primary" onClick={printTally} disabled={!st || st.tally.length === 0}
          style={{ flex: "1 1 200px", padding: "16px", fontSize: 17, fontWeight: 800 }}>인쇄 <span style={{ opacity: 0.8, fontWeight: 600 }}>(F2)</span></button>
        <button onClick={reset} disabled={!st || st.scannedCount === 0}
          style={{ flex: "1 1 200px", padding: "16px", fontSize: 17, fontWeight: 800, cursor: "pointer",
            background: "var(--sm-warning-bg)", color: "var(--sm-warning)", border: "2px solid var(--sm-warning)", borderRadius: 10,
            opacity: !st || st.scannedCount === 0 ? 0.5 : 1 }}>↺ 초기화 <span style={{ opacity: 0.8, fontWeight: 600 }}>(F4)</span></button>
      </div>
      <p className="sm-faint" style={{ fontSize: 11.5, margin: "0 0 16px", textAlign: "center" }}>단축키 — 스캔: Enter · 인쇄: F2 · 초기화: F4</p>

      <section className="b2b-card">
        <div className="b2b-card-head">
          <span className="b2b-card-title">가지러 갈 상품 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 총 {st?.totalUnits.toLocaleString() ?? 0}개 · 묶음 전개 반영</span></span>
        </div>
        {!st || st.tally.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 24 }}>아직 스캔된 송장이 없습니다. 위에서 스캔을 시작하세요.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>품목명</th><th>SKU</th><th className="num">수량</th></tr></thead>
              <tbody>
                {st.tally.map((t) => (
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
        {st && st.tally.some((t) => t.unknown) && <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 8, color: "var(--sm-danger)" }}>빨간 줄 = 상품마스터에 없는 단품코드. <Link href="/b2b/products">상품마스터</Link>에 등록하면 상품명으로 집계됩니다.</p>}
      </section>
    </div>
  );
}
