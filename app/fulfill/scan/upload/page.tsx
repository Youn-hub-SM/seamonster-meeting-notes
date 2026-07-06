"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Upload = { id: string; title: string; created_by: string | null; created_at: string; invoice_count: number; item_count: number };
type FileResult = { name: string; invoiceCount: number; itemCount: number; excludedNothing: number; error?: string };

const fmtTime = (iso: string) => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export default function ScanUploadPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [poolItemCount, setPoolItemCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ files: FileResult[]; unmatched: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/fulfill/scan/uploads", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setUploads(j.uploads || []);
      setPoolItemCount(j.poolItemCount || 0);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 실패"); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function upload(files: FileList) {
    setUploading(true); setError(""); setResult(null);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append("file", f));
      const j = await (await fetch("/api/fulfill/scan/uploads", { method: "POST", body: fd })).json();
      if (!j.ok && (!j.files || j.files.length === 0)) throw new Error(j.error || "업로드 실패");
      setResult({ files: j.files || [], unmatched: j.unmatched || [] });
      if (j.error) setError(j.error);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "업로드 실패"); }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function removeUpload(id: string) {
    if (!confirm("이 업로드 파일의 송장 데이터를 삭제할까요?")) return;
    try {
      const j = await (await fetch(`/api/fulfill/scan/uploads/${id}`, { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "삭제 실패");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
  }

  async function clearAll() {
    if (!confirm("풀의 모든 송장 데이터와 스캔 내역을 비울까요? 되돌릴 수 없습니다.")) return;
    try {
      const j = await (await fetch("/api/fulfill/scan/uploads", { method: "DELETE" })).json();
      if (!j.ok) throw new Error(j.error || "비우기 실패");
      setResult(null);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "비우기 실패"); }
  }

  return (
    <div className="b2b-container" style={{ maxWidth: 820 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">송장 업로드</h1>
          <p className="b2b-page-subtitle">
            택배사 <strong>&lsquo;파일접수 상세내역&rsquo;</strong>(운송장번호·상품코드·내품수량) 엑셀/CSV를 <strong>여러 개 한 번에</strong> 올릴 수 있습니다. 올린 데이터는 모두 하나의 풀에 쌓이고, <Link href="/fulfill/scan">송장 스캔</Link> 화면에서 전체를 대상으로 스캔합니다.
          </p>
        </div>
        <div className="b2b-page-actions"><Link className="b2b-btn-secondary" href="/fulfill/scan">송장 스캔 →</Link></div>
      </header>

      {error && <div className="b2b-error">{error}{error.includes("057") ? " — supabase/migrations/057_fulfill_scan.sql 를 먼저 적용하세요." : ""}</div>}

      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">파일 올리기</span>
          <a href="/api/fulfill/scan/template" className="change-link" style={{ fontSize: 12 }}>양식 다운로드</a>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 12px", lineHeight: 1.6 }}>
          엑셀(.xlsx)·CSV, <strong>여러 파일 선택 가능</strong>. 열 제목에서 <strong>송장번호·상품코드·수량</strong>을 자동 인식하고, NOTHING(정기배송 등)은 제외합니다. 송장번호는 하이픈이 있어도/없어도 동일하게 인식돼요.
        </p>
        <div className="sm-row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="b2b-btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? "업로드 중…" : "파일 선택 (여러 개 가능)"}</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" multiple style={{ display: "none" }} onChange={(e) => { const f = e.target.files; if (f && f.length) upload(f); }} />
        </div>
        {result && (
          <div className="prod-sku-ok" style={{ fontSize: 12.5, marginTop: 12 }}>
            {result.files.map((f, i) => (
              <div key={i} style={{ color: f.error ? "var(--sm-danger)" : undefined }}>
                {f.error ? "✗" : "✓"} <strong>{f.name}</strong> — {f.error ? f.error : `송장 ${f.invoiceCount.toLocaleString()}건 · 라인 ${f.itemCount.toLocaleString()}개${f.excludedNothing ? ` · NOTHING ${f.excludedNothing} 제외` : ""}`}
              </div>
            ))}
            {result.unmatched.length > 0 && <div style={{ color: "var(--sm-danger)", marginTop: 6 }}>미등록 단품코드 {result.unmatched.length}개: {result.unmatched.slice(0, 15).join(", ")}{result.unmatched.length > 15 ? " …" : ""} — <Link href="/b2b/products">상품마스터</Link>에 없으면 스캔 집계에 빨간 줄로 표시됩니다.</div>}
          </div>
        )}
      </section>

      <section className="b2b-card">
        <div className="b2b-card-head">
          <span className="b2b-card-title">올린 파일 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 풀 라인 {poolItemCount.toLocaleString()}개</span></span>
          <div className="sm-row" style={{ gap: 6 }}>
            <button className="b2b-btn-secondary" style={{ padding: "5px 10px", fontSize: 12 }} onClick={load} disabled={loading}>새로고침</button>
            {uploads.length > 0 && <button className="b2b-btn-secondary" style={{ padding: "5px 10px", fontSize: 12, color: "var(--sm-danger)" }} onClick={clearAll}>전체 비우기</button>}
          </div>
        </div>
        {loading ? (
          <div className="b2b-loading">불러오는 중…</div>
        ) : uploads.length === 0 ? (
          <div className="b2b-empty"><div className="b2b-empty-icon">📦</div>올린 파일이 없습니다. 위에서 송장 파일을 올리세요.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>파일</th><th className="num">송장</th><th className="num">라인</th><th>올린이</th><th>올린 시각</th><th></th></tr></thead>
              <tbody>
                {uploads.map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.title || "(제목 없음)"}</strong></td>
                    <td className="num b2b-money">{u.invoice_count.toLocaleString()}</td>
                    <td className="num b2b-money">{u.item_count.toLocaleString()}</td>
                    <td className="sm-faint">{u.created_by || "-"}</td>
                    <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{fmtTime(u.created_at)}</td>
                    <td><button className="b2b-btn-secondary" style={{ padding: "4px 8px", fontSize: 12, color: "var(--sm-danger)" }} onClick={() => removeUpload(u.id)}>삭제</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
