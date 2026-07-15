"use client";

import { useEffect, useRef, useState } from "react";
import SalesReportPanel from "../SalesReportPanel";
import { won as fmtWon } from "@/app/lib/format";

type Preview = {
  ok: boolean; error?: string;
  summary?: { total_rows: number; valid: number; invalid: number; dup_in_file: number; dup_in_db: number; new_rows: number; revenue: number };
  date_range?: { from: string; to: string } | null;
  channels?: string[];
  sample?: { order_date: string; channel: string; order_id: string; product_name: string; sku_code: string; quantity: number; subtotal_amount: number }[];
  errors?: string[];
};
type Batch = { id: string; filename: string; total_rows: number; inserted: number; skipped: number; uploaded_by: string | null; status: "active" | "reverted"; created_at: string; reverted_at: string | null };

const won = (n: number) => `${fmtWon(n)}원`;
const fmtTime = (iso: string) => { try { return new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }); } catch { return iso; } };

export default function SalesUploadPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "apply">("");
  const [applied, setApplied] = useState<{ inserted: number; skipped: number; total_after: number | null } | null>(null);
  const [err, setErr] = useState("");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [reverting, setReverting] = useState("");
  const [applyNonce, setApplyNonce] = useState(0);   // 적용 성공마다 +1 → 인라인 리포트 패널 새로고침(재생성)

  function loadBatches() { fetch("/api/sales/upload/batches").then((r) => r.json()).then((j) => { if (j.ok) setBatches(j.batches); }).catch(() => {}); }
  useEffect(() => { loadBatches(); }, []);

  async function revert(b: Batch) {
    if (!window.confirm(`'${b.filename}' 업로드로 추가된 ${b.inserted.toLocaleString()}건을 삭제해 되돌립니다.\n되돌릴 수 없습니다. 진행할까요?`)) return;
    setReverting(b.id); setErr("");
    try {
      const r = await fetch("/api/sales/upload/revert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch_id: b.id }) });
      const j = await r.json();
      if (!j.ok) setErr(j.error || "되돌리기 실패");
      else loadBatches();
    } catch (e) { setErr((e as Error).message); }
    finally { setReverting(""); }
  }

  function pick(f: File | null) { setFile(f); setPreview(null); setApplied(null); setErr(""); }

  async function doPreview() {
    if (!file) return;
    setBusy("preview"); setErr(""); setApplied(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch("/api/sales/upload/preview", { method: "POST", body: fd });
      const j: Preview = await r.json();
      if (!j.ok) { setErr(j.error || "미리보기 실패"); setPreview(null); }
      else setPreview(j);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  async function doApply() {
    if (!file || !preview?.ok) return;
    setBusy("apply"); setErr("");
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch("/api/sales/upload/apply", { method: "POST", body: fd });
      const j = await r.json();
      if (!j.ok) setErr(j.error || "적용 실패");
      else { setApplied({ inserted: j.inserted, skipped: j.skipped, total_after: j.total_after }); setPreview(null); setFile(null); if (fileRef.current) fileRef.current.value = ""; loadBatches(); setApplyNonce((n) => n + 1); }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  const s = preview?.summary;
  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">매출 데이터 업로드</h1>
          <p className="b2b-page-subtitle">같은 파일을 다시 올려도 중복은 자동 제외됩니다</p>
        </div>
      </header>

      <section className="b2b-card">
        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.tsv" onChange={(e) => pick(e.target.files?.[0] || null)} />
          <button className="b2b-btn-primary" onClick={doPreview} disabled={!file || busy !== ""}>{busy === "preview" ? "분석 중…" : "미리보기"}</button>
          <a className="b2b-btn-secondary" href="/api/sales/upload/template" title="빈 양식(xlsx) 다운로드">양식 다운로드</a>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>xlsx 권장(인코딩 안전). 한글 헤더(판매처·주문일자·결제금액…) 또는 영문 헤더 모두 인식. 과거 전체(수만 행 이상)는 백필 스크립트로 이관하세요.</p>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>표준 주문수집 파일이 없을 땐 <strong>양식 다운로드</strong>로 빈 양식을 받아 손으로 채운 뒤 그대로 올리면 됩니다(일회성). 헤더 이름은 바꾸지 마세요.</p>
      </section>

      {err && <p style={{ color: "var(--sm-danger)", marginTop: 12, whiteSpace: "pre-wrap" }}>{err}</p>}

      {applied && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head"><span className="b2b-card-title" style={{ color: "var(--sm-success)" }}>적용 완료 ✓</span></div>
          <p style={{ fontSize: 14 }}>신규 <strong>{applied.inserted.toLocaleString()}</strong>건 적재, 중복 {applied.skipped.toLocaleString()}건 제외.{applied.total_after != null && <> 현재 누적 <strong>{applied.total_after.toLocaleString()}</strong>행.</>}</p>
        </section>
      )}

      {applied && (
        <div style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>바로 리포트 만들기 · 발송</h2>
          <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 10px" }}>방금 업로드한 데이터의 <strong>최신일 기준 일일 리포트</strong>가 자동 생성됩니다. 주간 전환·기준일 변경 후 그대로 발송할 수 있어요.</p>
          <SalesReportPanel key={applyNonce} autoGenerate />
        </div>
      )}

      {s && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">미리보기 — 적용 전 확인</span></div>
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, marginBottom: 12 }}>
            <Stat label="파일 행" v={s.total_rows.toLocaleString()} />
            <Stat label="신규 적재 예정" v={s.new_rows.toLocaleString()} accent />
            <Stat label="이미 있는 행(중복)" v={s.dup_in_db.toLocaleString()} />
            <Stat label="파일 내 중복" v={s.dup_in_file.toLocaleString()} />
            <Stat label="오류(제외)" v={s.invalid.toLocaleString()} danger={s.invalid > 0} />
            <Stat label="매출 합계" v={won(s.revenue)} />
          </div>
          <p className="sm-faint" style={{ fontSize: 12 }}>
            기간 {preview?.date_range ? `${preview.date_range.from} ~ ${preview.date_range.to}` : "-"} · 채널 {preview?.channels?.join(", ") || "-"}
          </p>
          {preview?.errors && preview.errors.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--sm-warning)" }}>오류 예시: {preview.errors.slice(0, 5).join(" / ")}{preview.errors.length > 5 ? " …" : ""}</div>
          )}
          {preview?.sample && preview.sample.length > 0 && (
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table className="b2b-table" style={{ fontSize: 12.5 }}>
                <thead><tr><th>주문일</th><th>채널</th><th>주문번호</th><th>상품</th><th>SKU</th><th style={{ textAlign: "right" }}>수량</th><th style={{ textAlign: "right" }}>결제금액</th></tr></thead>
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={i}><td>{r.order_date}</td><td>{r.channel}</td><td>{r.order_id}</td><td>{r.product_name}</td><td>{r.sku_code}</td><td style={{ textAlign: "right" }}>{r.quantity}</td><td style={{ textAlign: "right" }}>{won(r.subtotal_amount)}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="sm-faint" style={{ fontSize: 11, marginTop: 4 }}>상위 {preview.sample.length}건 미리보기 (전화번호·이름은 매출 원장에 저장하지 않습니다)</p>
            </div>
          )}
          <div className="sm-between" style={{ marginTop: 14 }}>
            <button className="b2b-btn-secondary" onClick={() => setPreview(null)}>취소</button>
            <button className="b2b-btn-primary" onClick={doApply} disabled={busy !== "" || s.new_rows === 0}>{busy === "apply" ? "적용 중…" : s.new_rows === 0 ? "적재할 신규 행 없음" : `${s.new_rows.toLocaleString()}건 적용`}</button>
          </div>
        </section>
      )}

      {batches.length > 0 && (
        <section className="b2b-card" style={{ marginTop: 16 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">최근 업로드 · 되돌리기</span></div>
          <p className="sm-faint" style={{ fontSize: 12, marginBottom: 10 }}>잘못 올린 업로드는 그 배치가 추가한 행만 정확히 삭제해 되돌립니다. 되돌린 뒤 같은 파일을 다시 올리면 복구됩니다(멱등).</p>
          <div style={{ overflowX: "auto" }}>
            <table className="b2b-table" style={{ fontSize: 12.5 }}>
              <thead><tr><th>시각</th><th>파일</th><th style={{ textAlign: "right" }}>신규</th><th>올린 사람</th><th>상태</th><th></th></tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>{fmtTime(b.created_at)}</td>
                    <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.filename}</td>
                    <td style={{ textAlign: "right" }}>{b.inserted.toLocaleString()}</td>
                    <td>{b.uploaded_by || "-"}</td>
                    <td>{b.status === "reverted" ? <span className="sm-faint">되돌림</span> : <span style={{ color: "var(--sm-success)", fontWeight: 700 }}>적용됨</span>}</td>
                    <td style={{ textAlign: "right" }}>
                      {b.status === "active" && <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => revert(b)} disabled={reverting !== ""}>{reverting === b.id ? "되돌리는 중…" : "되돌리기"}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, v, accent, danger }: { label: string; v: string; accent?: boolean; danger?: boolean }) {
  return (
    <div className="b2b-stat-card">
      <div className="b2b-stat-card-label">{label}</div>
      <div className="b2b-stat-card-value b2b-money" style={danger ? { color: "var(--sm-danger)" } : accent ? { color: "var(--sm-orange)" } : undefined}>{v}</div>
    </div>
  );
}
