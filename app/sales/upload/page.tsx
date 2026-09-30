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
  const [batchErr, setBatchErr] = useState(false); // 이력 로드 실패 — '업로드 없음'과 구분
  const [applyNonce, setApplyNonce] = useState(0);   // 적용 성공마다 +1 → 인라인 리포트 패널 새로고침(재생성)
  const [reportPrompt, setReportPrompt] = useState<ReportItem[] | null>(null); // 최근 매출이 들어오면 '종합 리포트 생성' 안내 창(2026-09-30 — 일일·주간·월간)

  function loadBatches() { setBatchErr(false); fetch("/api/sales/upload/batches").then((r) => r.json()).then((j) => { if (j.ok) setBatches(j.batches); else setBatchErr(true); }).catch(() => setBatchErr(true)); }
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
      else { setApplied({ inserted: j.inserted, skipped: j.skipped, total_after: j.total_after }); setPreview(null); setFile(null); if (fileRef.current) fileRef.current.value = ""; loadBatches(); setApplyNonce((n) => n + 1); if (Array.isArray(j.report_items) && j.report_items.length) setReportPrompt(j.report_items); }
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
          <button className="b2b-btn-primary" onClick={doPreview} disabled={!file || busy !== ""}>{busy === "preview" ? "분석 중..." : "미리보기"}</button>
          <a className="b2b-btn-secondary" href="/api/sales/upload/template" title="빈 양식(xlsx) 다운로드">양식 다운로드</a>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>xlsx 권장 · 한글·영문 헤더 모두 인식</p>
      </section>

      {err && <p style={{ color: "var(--sm-danger)", marginTop: 12, whiteSpace: "pre-wrap" }}>{err}</p>}

      {applied && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head"><span className="b2b-card-title" style={{ color: "var(--sm-success)" }}>적용 완료 ✓</span></div>
          <p style={{ fontSize: 15 }}>신규 <strong>{applied.inserted.toLocaleString()}</strong>건 적재, 중복 {applied.skipped.toLocaleString()}건 제외.{applied.total_after != null && <> 현재 누적 <strong>{applied.total_after.toLocaleString()}</strong>행.</>}</p>
        </section>
      )}

      {applied && (
        <div style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 10px" }}>바로 리포트 만들기 · 발송</h2>
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
              <table className="b2b-table">
                <thead><tr><th>주문일</th><th>채널</th><th>주문번호</th><th>상품</th><th>SKU</th><th style={{ textAlign: "right" }}>수량</th><th style={{ textAlign: "right" }}>결제금액</th></tr></thead>
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={i}><td>{r.order_date}</td><td>{r.channel}</td><td>{r.order_id}</td><td>{r.product_name}</td><td>{r.sku_code}</td><td style={{ textAlign: "right" }}>{r.quantity}</td><td style={{ textAlign: "right" }}>{won(r.subtotal_amount)}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>상위 {preview.sample.length}건</p>
            </div>
          )}
          <div className="sm-between" style={{ marginTop: 14 }}>
            <button className="b2b-btn-secondary" onClick={() => setPreview(null)}>취소</button>
            <button className="b2b-btn-primary" onClick={doApply} disabled={busy !== "" || s.new_rows === 0}>{busy === "apply" ? "적용 중..." : s.new_rows === 0 ? "적재할 신규 행 없음" : `${s.new_rows.toLocaleString()}건 적용`}</button>
          </div>
        </section>
      )}

      {(batches.length > 0 || batchErr) && (
        <section className="b2b-card" style={{ marginTop: 16 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">최근 업로드 · 되돌리기</span></div>
          {batchErr && <div className="b2b-error" style={{ marginBottom: 8 }}>업로드 이력을 불러오지 못했습니다 — 새로고침해 주세요.</div>}
          <div style={{ overflowX: "auto" }}>
            <table className="b2b-table">
              <thead><tr><th>시각</th><th>파일</th><th style={{ textAlign: "right" }}>신규</th><th>올린 사람</th><th>상태</th><th></th></tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>{fmtTime(b.created_at)}</td>
                    <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.filename}</td>
                    <td style={{ textAlign: "right" }}>{b.inserted.toLocaleString()}</td>
                    <td>{b.uploaded_by || "-"}</td>
                    <td>{b.status === "reverted" ? <span className="b2b-status-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>되돌림</span> : <span className="b2b-status-pill" style={{ background: "var(--sm-success-bg)", color: "var(--sm-success)" }}>적용됨</span>}</td>
                    <td style={{ textAlign: "right" }}>
                      {b.status === "active" && <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => revert(b)} disabled={reverting !== ""}>{reverting === b.id ? "되돌리는 중..." : "되돌리기"}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {reportPrompt && (
        <div className="b2b-modal-backdrop" onClick={() => setReportPrompt(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">종합 리포트를 만들어 발송하세요</h2>
              <button className="b2b-modal-close" onClick={() => setReportPrompt(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <p style={{ fontSize: 15 }}>{reportPrompt.filter((x) => x.period === "daily").map((x) => x.label).join(", ") || "지난 기간"} 매출이 반영됐습니다. 리포트마다 생성하고, 확인한 뒤 팀즈로 보내 주세요.</p>
              {reportPrompt.length > 1 && (
                <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  {reportPrompt.map((x) => <a key={`${x.period}${x.date}`} className="b2b-btn-secondary" href={reportHref(x)} target="_blank" rel="noopener">{x.label} {REPORT_NAME[x.period]} 생성</a>)}
                </div>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setReportPrompt(null)}>나중에</button>
                {reportPrompt.length === 1 && <a className="b2b-btn-primary" href={reportHref(reportPrompt[0])}>{REPORT_NAME[reportPrompt[0].period]} 생성</a>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type ReportItem = { period: "daily" | "weekly" | "monthly"; date: string; label: string };
const REPORT_NAME: Record<ReportItem["period"], string> = { daily: "일일 종합 리포트", weekly: "주간 종합 리포트", monthly: "월간 종합 리포트" };
const reportHref = (x: ReportItem) => `/briefing?period=${x.period}&date=${x.date}&run=1`;

function Stat({ label, v, accent, danger }: { label: string; v: string; accent?: boolean; danger?: boolean }) {
  return (
    <div className="b2b-stat-card">
      <div className="b2b-stat-card-label">{label}</div>
      <div className="b2b-stat-card-value b2b-money" style={danger ? { color: "var(--sm-danger)" } : accent ? { color: "var(--sm-orange)" } : undefined}>{v}</div>
    </div>
  );
}
