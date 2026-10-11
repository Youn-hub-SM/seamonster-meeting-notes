"use client";

import { useEffect, useRef, useState } from "react";
import SalesReportPanel from "../SalesReportPanel";
import { won as fmtWon, dateShort } from "@/app/lib/format";

type Preview = {
  ok: boolean; error?: string;
  summary?: { total_rows: number; valid: number; invalid: number; dup_in_file: number; dup_in_db: number; new_rows: number; revenue: number };
  date_range?: { from: string; to: string } | null;
  channels?: string[];
  sample?: { order_date: string; channel: string; order_id: string; product_name: string; sku_code: string; quantity: number; subtotal_amount: number }[];
  errors?: string[];
  dup_groups?: { order_date: string; channel: string; order_id: string; product_name: string; option_name: string; quantity: number; subtotal_amount: number; count: number }[];
  dup_group_count?: number;
  // default_period = 파일 날짜(기본) · month_period = 그 달 1일~말일(월 정산 대조용) — 교체 범위 버튼
  replace?: { period: { from: string; to: string } | null; default_period?: { from: string; to: string } | null; month_period?: { from: string; to: string } | null; widen?: boolean; blocked: string | null; scopes: ReplaceScopeView[]; skipped: string[]; outside: number; uncovered_keys?: string[] } | null;
  changed?: { count: number; examples: { channel: string; order_id: string; product_name: string; option_name: string; old_qty: number; old_amount: number; new_qty: number; new_amount: number }[] } | null;
};
// win_from/to = 실제로 지우는 날짜(기본 = 그 채널 파일 날짜) · uncovered = 파일에 그 채널 행이 없거나 지울 행보다 적은데 기존 행이 지워지는 날
//  (rows = 그날 지울 행, file_rows = 그날 파일 행)
type ReplaceScopeView = { channel: string; file_rows: number; file_from: string; file_to: string; win_from?: string; win_to?: string; short?: boolean; existing: number; to_delete: number; delete_amount: number; uncovered?: { date: string; rows: number; amount: number; file_rows?: number; partial?: boolean }[] };
type Batch = { id: string; filename: string; total_rows: number; inserted: number; skipped: number; uploaded_by: string | null; status: "active" | "reverted"; created_at: string; reverted_at: string | null; note?: string | null };
// replaceFrom/To = 미리보기가 계산한 교체 기간(빈칸이면 서버 기본값) — 적용은 이 값을 그대로 보낸다
// widen = 채널 파일 날짜 밖까지 교체 기간 전체로 지움(명시해야만)
type UploadOpts = { dupMode: "merge" | "separate"; replace: boolean; replaceFrom: string; replaceTo: string; widen: boolean };
const NO_OPTS: UploadOpts = { dupMode: "merge", replace: false, replaceFrom: "", replaceTo: "", widen: false };
const sameOpts = (a: UploadOpts, b: UploadOpts) => a.dupMode === b.dupMode && a.replace === b.replace && a.replaceFrom === b.replaceFrom && a.replaceTo === b.replaceTo && a.widen === b.widen;

const won = (n: number) => `${fmtWon(n)}원`;
const fmtTime = (iso: string) => { try { return new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }); } catch { return iso; } };

export default function SalesUploadPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "apply">("");
  const [applied, setApplied] = useState<{ inserted: number; skipped: number; deleted: number; total_after: number | null } | null>(null);
  const [opts, setOpts] = useState<UploadOpts>(NO_OPTS);
  // previewOpts = 지금 보이는 미리보기를 계산한 옵션 — 적용은 이 값으로만 보낸다. previewFailed = 마지막 미리보기 실패(보이는 숫자가 낡음)
  const [previewOpts, setPreviewOpts] = useState<UploadOpts | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [periodDraft, setPeriodDraft] = useState({ from: "", to: "" }); // 교체 기간 입력 중 값 — '다시 계산' 전엔 적용 막음
  const [skipInvalid, setSkipInvalid] = useState(false); // 오류 행 빼고 적용 — 오류가 있으면 이걸 골라야 적용된다
  const [confirmUncovered, setConfirmUncovered] = useState(false); // 파일 행이 없거나 적은 날의 기존 행 삭제 확인 — 미리보기마다 초기화
  const [future, setFuture] = useState<{ rows: number | null; max: string } | null>(null); // 원장에 오늘 이후 날짜 행
  const [err, setErr] = useState("");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [reverting, setReverting] = useState("");
  const [batchErr, setBatchErr] = useState(false); // 이력 로드 실패 — '업로드 없음'과 구분
  const [applyNonce, setApplyNonce] = useState(0);   // 적용 성공마다 +1 → 인라인 리포트 패널 새로고침(재생성)
  const [reportPrompt, setReportPrompt] = useState<ReportItem[] | null>(null); // 최근 매출이 들어오면 '종합 리포트 생성' 안내 창(2026-09-30 — 일일·주간·월간)
  // 안내 창 순서(2026-10-01 대표 요청): 적용 → 일일 매출 리포트 메일 발송 → 종합 리포트 안내 창. 적용 직후엔 대상만 담아 둔다.
  const [pendingReports, setPendingReports] = useState<ReportItem[] | null>(null);

  function loadBatches() { setBatchErr(false); fetch("/api/sales/upload/batches").then((r) => r.json()).then((j) => { if (j.ok) setBatches(j.batches); else setBatchErr(true); }).catch(() => setBatchErr(true)); }
  function loadBounds() {
    fetch("/api/sales/bounds").then((r) => r.json()).then((j) => {
      setFuture(j?.ok && j.future_max ? { rows: j.future_rows ?? null, max: String(j.future_max) } : null);
    }).catch(() => {});
  }
  useEffect(() => { loadBatches(); loadBounds(); }, []);

  async function revert(b: Batch) {
    setReverting(b.id); setErr("");
    try {
      // 확인창 숫자 = 실제로 지워질 행 — 이력의 신규 건수는 적용이 중간에 끊기면 실제와 다를 수 있어 서버가 센다
      const c = await fetch(`/api/sales/upload/revert?batch_id=${encodeURIComponent(b.id)}`).then((r) => r.json());
      if (!c.ok) { setErr(c.error || "되돌릴 행 수를 확인하지 못했습니다"); return; }
      const n = Number(c.rows) || 0;
      const diff = n !== b.inserted ? ` (이력 기록 ${b.inserted.toLocaleString()}건과 다름)` : "";
      const replaced = (b.note || "").includes("기간 교체") ? "\n기간 교체로 지운 기존 행은 복구되지 않습니다 — 그 기간 매출이 줄어듭니다." : "";
      if (!window.confirm(`'${b.filename}' 업로드로 추가된 ${n.toLocaleString()}건을 삭제해 되돌립니다.${diff}${replaced}\n되돌릴 수 없습니다. 진행할까요?`)) return;
      const r = await fetch("/api/sales/upload/revert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch_id: b.id, expect_rows: n }) });
      const j = await r.json();
      if (!j.ok) setErr(j.error || "되돌리기 실패");
      loadBatches();
    } catch (e) { setErr((e as Error).message); }
    finally { setReverting(""); }
  }

  function pick(f: File | null) { setFile(f); setPreview(null); setApplied(null); setErr(""); setOpts(NO_OPTS); setPreviewOpts(null); setPreviewFailed(false); setPeriodDraft({ from: "", to: "" }); setSkipInvalid(false); setConfirmUncovered(false); }

  function formData(o: UploadOpts): FormData {
    const fd = new FormData(); fd.append("file", file as File);
    fd.append("dup_mode", o.dupMode);
    if (o.replace) {
      fd.append("replace", "1");
      if (o.widen) fd.append("replace_widen", "1");
      if (o.replaceFrom) fd.append("replace_from", o.replaceFrom);
      if (o.replaceTo) fd.append("replace_to", o.replaceTo);
    }
    return fd;
  }

  // 옵션을 바꾸면 미리보기를 다시 계산 — 적용은 미리보기를 계산한 옵션(previewOpts)으로만 보낸다.
  //  다시 계산이 실패하면 예전 미리보기는 남기되 낡음으로 표시하고 적용을 막는다(옵션과 숫자가 다른 채 적용 금지).
  function changeOpts(next: UploadOpts) { setOpts(next); setPeriodDraft({ from: next.replaceFrom, to: next.replaceTo }); if (preview) doPreview(next); }
  function restorePreviewOpts() { if (!previewOpts) return; setOpts(previewOpts); setPeriodDraft({ from: previewOpts.replaceFrom, to: previewOpts.replaceTo }); setPreviewFailed(false); setErr(""); }

  async function doPreview(o: UploadOpts = opts) {
    if (!file) return;
    setBusy("preview"); setErr(""); setApplied(null); setConfirmUncovered(false);
    try {
      const fd = formData(o);
      const r = await fetch("/api/sales/upload/preview", { method: "POST", body: fd });
      const j: Preview = await r.json();
      if (!j.ok) { setErr(j.error || "미리보기 실패"); setPreviewFailed(true); }
      else {
        setPreview(j); setPreviewFailed(false);
        // 서버가 정한(또는 받은) 교체 기간을 옵션·입력칸에 맞춘다 — 적용은 이 기간으로만
        const p = o.replace ? j.replace?.period : null;
        const synced = { ...o, replaceFrom: p?.from ?? "", replaceTo: p?.to ?? "" };
        setOpts(synced); setPreviewOpts(synced); setPeriodDraft({ from: synced.replaceFrom, to: synced.replaceTo });
      }
    } catch (e) { setErr((e as Error).message); setPreviewFailed(true); }
    finally { setBusy(""); }
  }

  async function doApply() {
    if (!file || !preview?.ok || !previewOpts || previewStale) return;
    const po = previewOpts;
    const sc = po.replace ? preview.replace?.scopes ?? [] : [];
    const del = sc.reduce((n, x) => n + x.to_delete, 0);
    // 채널마다 파일 날짜와 실제로 지우는 날짜를 같이 보여 준다(파일 행이 없거나 적은 날이 있으면 그 날짜도)
    const lines = sc.filter((x) => x.to_delete > 0).map((x) => {
      const thin = (x.uncovered ?? []).map((u) => dateShort(u.date));
      return `${x.channel} 파일 ${dateShort(x.file_from)}~${dateShort(x.file_to)} / 교체 ${dateShort(x.win_from ?? po.replaceFrom)}~${dateShort(x.win_to ?? po.replaceTo)} · ${x.to_delete.toLocaleString()}행`
        + (thin.length ? `\n  파일 행이 없거나 적은 날: ${thin.slice(0, 6).join(", ")}${thin.length > 6 ? ` 외 ${thin.length - 6}일` : ""}` : "");
    });
    if (del > 0 && !window.confirm(`기간 교체로 기존 ${del.toLocaleString()}행을 지웁니다.\n${lines.join("\n")}\n되돌리기로 복구되지 않습니다. 진행할까요?`)) return;
    setBusy("apply"); setErr("");
    try {
      const fd = formData(po);
      if (skipInvalid) fd.append("confirm_skip_invalid", "1");
      if (po.replace && confirmUncovered && uncoveredKeys.length) fd.append("confirm_uncovered", JSON.stringify(uncoveredKeys));
      // 확인창에 보인 지울 행 수 — 서버가 다시 계산한 수와 다르면 쓰기 전에 거절한다
      if (po.replace && preview.replace && !preview.replace.blocked) fd.append("expect_delete", String(del));
      const r = await fetch("/api/sales/upload/apply", { method: "POST", body: fd });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "적용 실패"); loadBatches(); loadBounds(); } // 중간 실패여도 이미 쓴 행·이력이 있을 수 있다
      else { setApplied({ inserted: j.inserted, skipped: j.skipped, deleted: Number(j.deleted) || 0, total_after: j.total_after }); loadBounds(); setPreview(null); setFile(null); if (fileRef.current) fileRef.current.value = ""; loadBatches(); setApplyNonce((n) => n + 1); setReportPrompt(null); setPendingReports(Array.isArray(j.report_items) && j.report_items.length ? j.report_items : null); }
    } catch (e) { setErr(`${(e as Error).message} — 적용이 중간에 끊겼을 수 있습니다. 최근 업로드를 확인하고 같은 파일로 미리보기를 다시 하세요.`); loadBatches(); loadBounds(); }
    finally { setBusy(""); }
  }

  const s = preview?.summary;
  const scopes = preview?.replace?.scopes ?? [];
  const toDelete = scopes.reduce((n, x) => n + x.to_delete, 0);
  const uncoveredKeys = preview?.replace?.uncovered_keys ?? [];
  const uncoveredScopes = scopes.filter((x) => (x.uncovered ?? []).length > 0);
  const uncoveredDays = uncoveredScopes.reduce((n, x) => n + (x.uncovered ?? []).length, 0);
  const uncoveredRows = uncoveredScopes.reduce((n, x) => n + (x.uncovered ?? []).reduce((m, u) => m + u.rows, 0), 0);
  const blockedByInvalid = !!s && s.invalid > 0 && !skipInvalid;
  const nothingToDo = !!s && s.new_rows === 0 && toDelete === 0;
  const periodDirty = opts.replace && (periodDraft.from !== opts.replaceFrom || periodDraft.to !== opts.replaceTo);
  // 보이는 미리보기가 지금 옵션으로 계산된 게 아님(다시 계산 실패) — 적용 불가
  const previewStale = !!preview && (previewFailed || !previewOpts || !sameOpts(opts, previewOpts));
  const canRestore = !!previewOpts && !sameOpts(opts, previewOpts);
  // 교체 범위 버튼 — 파일 날짜(기본, 넓히기 없음) / 그 달 전체(1일~말일 + 넓히기, 월 정산 대조용)
  const defPeriod = preview?.replace?.default_period ?? null, monthPeriod = preview?.replace?.month_period ?? null;
  const isFileRange = !!defPeriod && opts.replaceFrom === defPeriod.from && opts.replaceTo === defPeriod.to && !opts.widen;
  const isMonthRange = !!monthPeriod && opts.replaceFrom === monthPeriod.from && opts.replaceTo === monthPeriod.to && opts.widen;
  const monthDiffers = !!monthPeriod && (!defPeriod || defPeriod.from !== monthPeriod.from || defPeriod.to !== monthPeriod.to);
  // 기간 교체를 골랐는데 계획이 없거나(막힘·기간 미확정) 입력 중이면 적용 불가 — 서버도 같은 이유로 거절
  //  파일 행이 없거나 적은 날의 기존 행이 지워지면 그 날짜 확인 체크 전엔 적용 불가(서버도 확인 안 된 날짜가 있으면 거절)
  const replaceNotReady = opts.replace && (!preview?.replace || !!preview.replace.blocked || periodDirty || (uncoveredKeys.length > 0 && !confirmUncovered));
  const replaceShort = scopes.some((x) => !!x.short);
  const dupGroups = preview?.dup_groups ?? [];
  const dupGroupCount = preview?.dup_group_count ?? 0;
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
          <button className="b2b-btn-primary" onClick={() => doPreview()} disabled={!file || busy !== ""}>{busy === "preview" ? "분석 중..." : "미리보기"}</button>
          <a className="b2b-btn-secondary" href="/api/sales/upload/template" title="빈 양식(xlsx) 다운로드">양식 다운로드</a>
        </div>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>xlsx 권장 · 한글·영문 헤더 모두 인식</p>
      </section>

      {future && (
        <div className="sm-warn" style={{ marginTop: 12 }}>
          오늘 이후 날짜 매출 {future.rows != null ? `${future.rows.toLocaleString()}건` : "있음"}(최대 {future.max}) — 발송일·업로드 날짜를 확인하세요
        </div>
      )}
      {err && <p style={{ color: "var(--sm-danger)", marginTop: 12, whiteSpace: "pre-wrap" }}>{err}</p>}

      {applied && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head"><span className="b2b-card-title" style={{ color: "var(--sm-success)" }}>적용 완료 ✓</span></div>
          <p style={{ fontSize: 15 }}>신규 <strong>{applied.inserted.toLocaleString()}</strong>건 적재, 중복 {applied.skipped.toLocaleString()}건 제외.{applied.deleted > 0 && <> 기간 교체로 기존 {applied.deleted.toLocaleString()}행 삭제.</>}{applied.total_after != null && <> 현재 누적 <strong>{applied.total_after.toLocaleString()}</strong>행.</>}</p>
        </section>
      )}

      {applied && (
        <div style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 10px" }}>바로 리포트 만들기 · 발송</h2>
          <SalesReportPanel key={applyNonce} autoGenerate
            onSent={(type) => { if (type === "daily" && pendingReports) { setReportPrompt(pendingReports); setPendingReports(null); } }} />
        </div>
      )}

      {s && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">미리보기 — 적용 전 확인</span></div>
          {previewStale && (
            <div className="sm-warn" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700 }}>미리보기를 다시 하지 못했습니다 — 아래 숫자는 이전 옵션 기준이라 적용할 수 없습니다</div>
              <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                <button className="b2b-btn-secondary" disabled={busy !== ""} onClick={() => doPreview()}>{busy === "preview" ? "분석 중..." : "다시 미리보기"}</button>
                {canRestore && <button className="b2b-btn-secondary" disabled={busy !== ""} onClick={restorePreviewOpts}>이전 옵션으로</button>}
              </div>
            </div>
          )}
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
          {s.invalid > 0 && (
            <label className="sm-row" style={{ marginTop: 8, gap: 6, fontSize: 13 }}>
              <input type="checkbox" className="b2b-checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />
              오류 행 {s.invalid.toLocaleString()}건 빼고 적용
            </label>
          )}

          {preview?.changed && preview.changed.count > 0 && (
            <div className="sm-warn" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 700 }}>기존과 다른 행 {preview.changed.count.toLocaleString()}건 — 그대로 적용하면 기존 행과 새 행이 둘 다 남습니다. 취소·정정이 반영된 그 기간 전체 파일이면 기간 교체로 올리세요</div>
              <div className="b2b-table-wrap" style={{ marginTop: 6 }}>
                <table className="b2b-table">
                  <thead><tr><th>채널</th><th>주문번호</th><th>상품</th><th className="num">기존 수량</th><th className="num">기존 금액</th><th className="num">새 수량</th><th className="num">새 금액</th></tr></thead>
                  <tbody>
                    {preview.changed.examples.map((c, i) => (
                      <tr key={i}><td data-label="채널">{c.channel}</td><td data-label="주문번호">{c.order_id}</td><td data-label="상품">{c.product_name}{c.option_name ? ` · ${c.option_name}` : ""}</td><td data-label="기존 수량" className="num">{c.old_qty}</td><td data-label="기존 금액" className="num">{won(c.old_amount)}</td><td data-label="새 수량" className="num">{c.new_qty}</td><td data-label="새 금액" className="num">{won(c.new_amount)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {dupGroupCount > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="sm-between" style={{ gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>파일 안 동일 라인 {dupGroupCount.toLocaleString()}묶음</span>
                <label className="sm-row" style={{ gap: 6, fontSize: 13 }}>
                  <input type="checkbox" className="b2b-checkbox" checked={opts.dupMode === "separate"} disabled={busy !== ""}
                    onChange={(e) => changeOpts({ ...opts, dupMode: e.target.checked ? "separate" : "merge" })} />
                  동일 라인 따로 넣기
                </label>
              </div>
              <p className="sm-faint" style={{ fontSize: 12, margin: "4px 0 6px" }}>기본은 1줄만 넣음 — 같은 주문에 같은 상품을 따로 담은 경우만 따로 넣기</p>
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead><tr><th>주문일</th><th>채널</th><th>주문번호</th><th>상품</th><th>옵션</th><th className="num">수량</th><th className="num">결제금액</th><th className="num">줄 수</th></tr></thead>
                  <tbody>
                    {dupGroups.map((g, i) => (
                      <tr key={i}><td data-label="주문일">{g.order_date}</td><td data-label="채널">{g.channel}</td><td data-label="주문번호">{g.order_id}</td><td data-label="상품">{g.product_name}</td><td data-label="옵션">{g.option_name || "-"}</td><td data-label="수량" className="num">{g.quantity}</td><td data-label="결제금액" className="num">{won(g.subtotal_amount)}</td><td data-label="줄 수" className="num">{g.count}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {dupGroupCount > dupGroups.length && <p className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>상위 {dupGroups.length}묶음</p>}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label className="sm-row" style={{ gap: 6, fontSize: 13, fontWeight: 700 }}>
              {/* 오류 행이 있으면 켤 수 없다 — 빠진 행의 기존 원장 행이 '파일에 없음'으로 지워진다(서버도 거절) */}
              <input type="checkbox" className="b2b-checkbox" checked={opts.replace} disabled={busy !== "" || (s.invalid > 0 && !opts.replace)}
                onChange={(e) => changeOpts({ ...opts, replace: e.target.checked, replaceFrom: "", replaceTo: "", widen: false })} />
              기간 교체
            </label>
            <p className="sm-faint" style={{ fontSize: 12, margin: "4px 0 0" }}>채널마다 파일 날짜 안의 기존 행 중 파일에 없는 행을 지움(도매 제외, 되돌리기로 복구 안 됨) — 교체 기간 밖 파일 행은 추가만</p>
            {s.invalid > 0 && !opts.replace && <p style={{ fontSize: 12, margin: "4px 0 0", color: "var(--sm-warning)" }}>오류 행이 있어 기간 교체를 할 수 없습니다 — 파일을 고친 뒤 다시 올리세요</p>}
            {opts.replace && (defPeriod || monthPeriod) && (
              <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8, fontSize: 13 }}>
                <span>교체 범위</span>
                <div className="sm-tabs">
                  {defPeriod && (
                    <button className={`sm-tab ${isFileRange ? "is-active" : ""}`} disabled={busy !== ""}
                      onClick={() => changeOpts({ ...opts, replaceFrom: "", replaceTo: "", widen: false })}>파일 날짜 {dateShort(defPeriod.from)}~{dateShort(defPeriod.to)}</button>
                  )}
                  {monthPeriod && (
                    <button className={`sm-tab ${isMonthRange ? "is-active" : ""}`} disabled={busy !== ""}
                      onClick={() => changeOpts({ ...opts, replaceFrom: monthPeriod.from, replaceTo: monthPeriod.to, widen: true })}>그 달 전체 {dateShort(monthPeriod.from)}~{dateShort(monthPeriod.to)}</button>
                  )}
                </div>
              </div>
            )}
            {opts.replace && monthPeriod && monthDiffers && !isMonthRange && (
              <p className="sm-faint" style={{ fontSize: 12, margin: "4px 0 0" }}>월 정산 대조 파일이면 그 달 전체 — 파일에 행이 없는 날의 기존 행도 지웁니다(날짜 확인 필요)</p>
            )}
            {opts.replace && (
              <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8, fontSize: 13 }}>
                <span>교체 기간</span>
                <input type="date" className="b2b-input" style={{ width: 160 }} value={periodDraft.from} max={periodDraft.to || undefined} disabled={busy !== ""}
                  onChange={(e) => { const v = e.target.value; setPeriodDraft((p) => ({ ...p, from: v })); }} />
                <span>~</span>
                <input type="date" className="b2b-input" style={{ width: 160 }} value={periodDraft.to} min={periodDraft.from || undefined} disabled={busy !== ""}
                  onChange={(e) => { const v = e.target.value; setPeriodDraft((p) => ({ ...p, to: v })); }} />
                {periodDirty && (
                  <button className="b2b-btn-secondary" disabled={busy !== "" || !periodDraft.from || !periodDraft.to}
                    onClick={() => changeOpts({ ...opts, replaceFrom: periodDraft.from, replaceTo: periodDraft.to })}>다시 계산</button>
                )}
              </div>
            )}
            {preview?.replace?.blocked ? (
              <div className="b2b-error" style={{ marginTop: 6 }}>{preview.replace.blocked}</div>
            ) : preview?.replace && (
              preview.replace.scopes.length === 0 ? (
                <div className="b2b-empty" style={{ marginTop: 6 }}>교체할 채널이 없습니다.</div>
              ) : (
                <div className="b2b-table-wrap" style={{ marginTop: 6 }}>
                  <table className="b2b-table">
                    <thead><tr><th>채널</th><th>파일 날짜</th><th>교체 날짜</th><th className="num">파일 행</th><th className="num">기존 행</th><th className="num">지울 행</th><th className="num">지울 금액</th></tr></thead>
                    <tbody>
                      {preview.replace.scopes.map((x) => {
                        const wFrom = x.win_from ?? opts.replaceFrom, wTo = x.win_to ?? opts.replaceTo;
                        const wider = wFrom < x.file_from || wTo > x.file_to; // 파일 날짜 밖까지 지움(넓히기)
                        const thin = (x.uncovered ?? []).length > 0;          // 파일 행이 없거나 적은 날이 교체 날짜 안에 있음
                        return (
                          <tr key={x.channel}><td data-label="채널">{x.channel}</td><td data-label="파일 날짜">{dateShort(x.file_from)} ~ {dateShort(x.file_to)}</td><td data-label="교체 날짜" style={wider || thin ? { color: "var(--sm-warning)" } : undefined}>{dateShort(wFrom)} ~ {dateShort(wTo)}</td><td data-label="파일 행" className="num">{x.file_rows.toLocaleString()}</td><td data-label="기존 행" className="num">{x.existing.toLocaleString()}</td><td data-label="지울 행" className="num" style={x.to_delete > 0 ? { color: "var(--sm-danger)" } : undefined}>{x.to_delete.toLocaleString()}</td><td data-label="지울 금액" className="num">{won(x.delete_amount)}</td></tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            )}
            {preview?.replace && !preview.replace.blocked && (replaceShort || opts.widen) && (
              <div style={{ marginTop: 6 }}>
                <label className="sm-row" style={{ gap: 6, fontSize: 13 }}>
                  <input type="checkbox" className="b2b-checkbox" checked={opts.widen} disabled={busy !== "" || periodDirty}
                    onChange={(e) => changeOpts({ ...opts, widen: e.target.checked })} />
                  파일에 없는 날짜도 교체 기간 전체로 지우기
                </label>
                {!opts.widen && <p className="sm-faint" style={{ fontSize: 12, margin: "4px 0 0" }}>파일 날짜가 교체 기간보다 짧은 채널은 파일 날짜만 교체합니다</p>}
              </div>
            )}
            {preview?.replace && !preview.replace.blocked && uncoveredDays > 0 && (
              <div className="sm-warn" style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 700 }}>파일 행이 없거나 적은 날짜 {uncoveredDays.toLocaleString()}일 — 기존 {uncoveredRows.toLocaleString()}행이 지워집니다</div>
                {uncoveredScopes.map((x) => (
                  <div key={x.channel} style={{ fontSize: 12, marginTop: 4 }}>{x.channel}: {(x.uncovered ?? []).map((u) => `${dateShort(u.date)} 파일 ${(u.file_rows ?? 0).toLocaleString()}행 · 지울 ${u.rows.toLocaleString()}행`).join(", ")}</div>
                ))}
                <div style={{ fontSize: 12, marginTop: 4 }}>앞뒤 끝 날짜는 교체 기간을 좁혀 빼면 그 날은 추가만 합니다</div>
                <label className="sm-row" style={{ gap: 6, fontSize: 13, marginTop: 6 }}>
                  <input type="checkbox" className="b2b-checkbox" checked={confirmUncovered} disabled={busy !== ""} onChange={(e) => setConfirmUncovered(e.target.checked)} />
                  위 날짜의 기존 행도 지웁니다
                </label>
              </div>
            )}
            {!!preview?.replace?.outside && <p className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>기간 밖 파일 행 {preview.replace.outside.toLocaleString()}건 — 추가만</p>}
            {preview?.replace && preview.replace.skipped.length > 0 && <p className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>교체 안 함: {preview.replace.skipped.join(", ")}</p>}
          </div>
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
            <button className="b2b-btn-primary" onClick={doApply} disabled={busy !== "" || nothingToDo || blockedByInvalid || replaceNotReady || previewStale}>
              {busy === "apply" ? "적용 중..." : nothingToDo ? "적재할 신규 행 없음" : toDelete > 0 ? `${s.new_rows.toLocaleString()}건 적용 · ${toDelete.toLocaleString()}행 삭제` : `${s.new_rows.toLocaleString()}건 적용`}
            </button>
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
                    <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={b.note || undefined}>{b.filename}{b.note && <div className="sm-faint" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{b.note}</div>}</td>
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
