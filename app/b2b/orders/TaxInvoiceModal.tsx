"use client";

// 세금계산서 발행(볼타) — '계산서 발행 › 정보 확인 및 수정 › 발행 완료' (2026-10-08 대표 결정, 미리보기 필수).
//  금액은 발주로 서버가 계산(거래명세표와 같은 값) — 화면에선 품목명·규격·작성일자·영수/청구·공급받는자 정보만 고친다.
//  발행 요청 때 미리보기 지문(fingerprint)을 같이 보내, 그새 발주가 바뀌었으면 서버가 거절한다.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useEscClose } from "@/app/lib/use-esc";
import { won } from "@/app/lib/format";
import { formatBizNo } from "@/app/lib/b2b-types";
import {
  partyErrors, partyWarnings, approxDueDate, kstToday, TAX_TYPE_TITLE, PURPOSE_LABEL,
  type TiParty, type TaxTypeCode, type PurposeCode,
} from "@/app/lib/tax-invoice-calc";
import type { InvoiceContext, TaxInvoiceRow } from "@/app/lib/tax-invoice";

// 서버 rowRank/rowActive 와 같은 순위(tax-invoice.ts 는 서버 전용이라 값은 가져오지 않는다)
const rowRank = (r: TaxInvoiceRow) => (r.status === "발행완료" ? 3 : r.status === "요청" ? 2 : r.fail_code === "ISSUED_DUPLICATE" ? 1 : 0);

type Step = "edit" | "done";
const STEPS = ["계산서 발행", "정보 확인 및 수정", "발행 완료"];
const ROW_STATUS: Record<TaxInvoiceRow["status"], { label: string; bg: string; fg: string }> = {
  "요청": { label: "발행 중", bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },
  "발행완료": { label: "발행완료", bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  "실패": { label: "실패", bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
};
const PARTY_FIELDS: { k: keyof TiParty; label: string; wide?: boolean; ph?: string }[] = [
  { k: "bizNo", label: "사업자등록번호", ph: "000-00-00000" },
  { k: "name", label: "상호" },
  { k: "ceo", label: "대표자" },
  { k: "address", label: "사업장 주소", wide: true },
  { k: "bizType", label: "업태" },
  { k: "bizItem", label: "종목" },
  { k: "email", label: "계산서 수신 이메일", wide: true },
  { k: "manager", label: "담당자" },
  { k: "phone", label: "담당자 휴대폰", ph: "010-0000-0000" },
];
const FS = "var(--sm-fs-base)", FS_META = "var(--sm-fs-xs)";
const STUCK_MS = 10 * 60e3;   // 이 시간이 지나도 '발행 중'이면 [실패로 처리]를 보인다(서버도 같은 기준)
const API = (id: string) => `/api/b2b/orders/${id}/tax-invoice`;

// JSON 이 아닌 응답(시간 초과 HTML 등)도 화면이 멈추지 않게
async function readJson(res: Response): Promise<Record<string, unknown> & { ok?: boolean; error?: string }> {
  const t = await res.text().catch(() => "");
  try { return t ? JSON.parse(t) : { ok: false, error: `빈 응답(HTTP ${res.status})` }; }
  catch { return { ok: false, error: res.ok ? "응답을 읽지 못했습니다." : `서버 오류(HTTP ${res.status}) — 잠시 뒤 [상태 새로고침]으로 결과를 확인하세요.` }; }
}

// 볼타 모드별 문서 종류마다 대표 기록 — 살아 있는 문서 먼저, 같은 순위면 최신(키가 없으면 모드 구분 없이)
function latestOf(c: InvoiceContext): TaxInvoiceRow[] {
  const rows = c.invoices.filter((r) => (c.mode ? r.mode === c.mode : true)).slice().reverse();
  const m = new Map<TaxTypeCode, TaxInvoiceRow>();
  for (const r of rows) { const cur = m.get(r.tax_type); if (!cur || rowRank(r) > rowRank(cur)) m.set(r.tax_type, r); }
  return [...m.values()].sort((a, b) => (a.tax_type === b.tax_type ? 0 : a.tax_type === "TAXABLE" ? -1 : 1)); // 과세 먼저
}
// 이번에 발행할 문서 종류 — 라이브는 살아 있는(발행 중·발행완료) 문서가 없는 종류만, 테스트는 전부
function issueTypesOf(c: InvoiceContext): Set<TaxTypeCode> {
  const all = c.draft.docs.map((d) => d.taxType);
  if (c.mode !== "live") return new Set(all);
  const active = new Set(c.invoices.filter((r) => r.mode === "live" && rowRank(r) > 0).map((r) => r.tax_type));
  return new Set(all.filter((t) => !active.has(t)));
}

export default function TaxInvoiceModal({ orderId, label, onClose }: { orderId: string; label: string; onClose: (changed: boolean) => void }) {
  const [ctx, setCtx] = useState<InvoiceContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [step, setStep] = useState<Step>("edit");
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [writeDate, setWriteDate] = useState("");
  const [purpose, setPurpose] = useState<PurposeCode>("CLAIM");
  const [supplied, setSupplied] = useState<TiParty | null>(null);
  const [saveCompany, setSaveCompany] = useState(true);
  const [lineEdits, setLineEdits] = useState<Partial<Record<TaxTypeCode, { name: string; spec: string }[]>>>({});
  const [description, setDescription] = useState("");
  const shownFp = useRef("");   // 화면에 그린 미리보기 지문 — 다시 불러왔을 때 발주가 바뀌었는지 본다
  const close = () => onClose(changed);
  useEscClose(close, busy);

  const initLines = (c: InvoiceContext) =>
    setLineEdits(Object.fromEntries(c.draft.docs.map((d) => [d.taxType, d.lines.map((l) => ({ name: l.name, spec: l.spec }))])));

  // nextStep 을 주지 않으면 기록으로 정한다 — 마지막 기록이 있으면(실패 포함) 결과 화면
  const applyCtx = (c: InvoiceContext, initFields0: boolean, nextStep?: Step) => {
    // 그새 발주(거래처·발송일·입금상태·금액·품목)가 바뀌었으면 입력칸을 모두 새 발주 기준으로 다시 채운다
    const stale = !initFields0 && !!shownFp.current && shownFp.current !== c.fingerprint;
    if (stale) setNotice("발주가 바뀌어 미리보기를 새로 불러왔습니다 — 거래처·작성일자·금액·품목을 다시 확인하세요.");
    const initFields = initFields0 || stale;
    shownFp.current = c.fingerprint;
    setCtx(c);
    setStep(nextStep ?? (latestOf(c).length ? "done" : "edit"));
    if (initFields) {
      setWriteDate(c.draft.writeDate);
      setPurpose(c.draft.purpose);
      setSupplied(c.supplied);
      initLines(c);
      setDescription([`발주 ${c.order.order_no}`, c.draft.freebies.length ? `증정: ${c.draft.freebies.join(", ")}` : ""].filter(Boolean).join(" · "));
    }
  };
  const reload = async (nextStep?: Step) => {
    const r = await readJson(await fetch(API(orderId), { cache: "no-store" }));
    if (!r.ok) throw new Error(r.error || "미리보기 실패");
    applyCtx(r as unknown as InvoiceContext, false, nextStep);
  };

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const j = await readJson(await fetch(API(orderId), { cache: "no-store" }));
        if (!live) return;
        if (!j.ok) throw new Error(j.error || "미리보기 실패");
        applyCtx(j as unknown as InvoiceContext, true);
      } catch (e) { if (live) setError(e instanceof Error ? e.message : "미리보기 실패"); }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  const dueDate = useMemo(() => {
    if (!ctx) return { date: "", exact: false };
    if (writeDate === ctx.draft.writeDate && ctx.dueExact) return { date: ctx.dueDate, exact: true };
    return { date: approxDueDate(writeDate), exact: false };
  }, [ctx, writeDate]);
  const issueTypes = useMemo(() => (ctx ? issueTypesOf(ctx) : new Set<TaxTypeCode>()), [ctx]);
  const issueDocs = ctx ? ctx.draft.docs.filter((d) => issueTypes.has(d.taxType)) : [];
  const issueTotal = issueDocs.reduce((s, d) => s + d.total, 0);
  const partial = !!ctx && issueDocs.length > 0 && issueDocs.length < ctx.draft.docs.length;

  // 발행을 막는 것 — 서버도 같은 검사를 다시 한다
  const blockers = useMemo(() => {
    if (!ctx || !supplied) return [];
    const b = [...ctx.draft.blockers];
    if (!ctx.migrated) b.push("migration 128 이 적용되지 않았습니다.");
    if (!ctx.configured) b.push("볼타 API 키가 없어 미리보기만 됩니다.");
    if (ctx.configured && ctx.bolta.issuer === "missing") b.push("볼타에 씨몬스터 사업자가 등록되지 않았습니다(최초 1회 설정).");
    if (ctx.configured && ctx.bolta.certificate === "missing") b.push("볼타에 공동인증서가 등록되지 않았습니다.");
    if (ctx.configured && ctx.bolta.certificate === "expired") b.push("볼타에 등록한 공동인증서가 만료됐습니다.");
    if (ctx.mode === "live" && ctx.order.tax_invoice_status !== "미발행" && ctx.order.tax_invoice_status !== "발행대기") b.push(`세금계산서 상태가 '${ctx.order.tax_invoice_status}'입니다.`);
    if (ctx.draft.docs.length && !issueTypes.size) b.push("이미 발행(요청)된 문서가 있습니다 — 고칠 내용은 수정발행으로 처리합니다.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(writeDate)) b.push("작성일자를 넣으세요.");
    else if (writeDate > kstToday()) b.push("작성일자는 오늘 이후로 할 수 없습니다.");
    else if (dueDate.date && kstToday() > dueDate.date) b.push(`발행 마감일(${dueDate.date})이 지났습니다.`);
    b.push(...partyErrors(ctx.supplier, "공급자"), ...partyErrors(supplied, "공급받는자"));
    return b;
  }, [ctx, supplied, writeDate, dueDate, issueTypes]);
  const warnings = ctx && supplied
    ? [...ctx.draft.warnings, ...ctx.suppliedNotes, ...partyWarnings(ctx.supplier, "공급자"), ...partyWarnings(supplied, "공급받는자")]
    : [];

  async function issue() {
    if (!ctx || !supplied || blockers.length || !issueDocs.length) return;
    const n = issueDocs.length;
    const msg = ctx.mode === "live"
      ? `국세청으로 전송됩니다. 발행 뒤 취소는 수정발행으로만 가능합니다.\n${n}장(${won(issueTotal)}원)을 발행할까요?`
      : `테스트 발행(국세청 미전송) ${n}장을 보낼까요?`;
    if (!window.confirm(msg)) return;
    setBusy(true); setError(""); setNotice("");
    let next: Step | undefined;
    try {
      const j = await readJson(await fetch(API(orderId), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "issue", fingerprint: ctx.fingerprint, writeDate, purpose, supplied, saveCompany, lines: lineEdits, description }),
      }));
      const results = Array.isArray(j.results) ? (j.results as { ok: boolean; uncertain?: boolean }[]) : null;
      if (!results) next = "edit";      // 서버가 발행 전에 거절 — 고쳐서 다시
      if (j.error) setError(j.error);
      if (results?.some((r) => r.uncertain)) setNotice("볼타 응답을 받지 못한 문서가 있습니다 — 접수 여부를 확인하는 중이니 잠시 뒤 [상태 새로고침]을 누르세요.");
    } catch (e) {
      setError(`${e instanceof Error ? e.message : "발행 실패"} — 접수됐을 수 있으니 [상태 새로고침]으로 확인하세요.`);
    } finally {
      // 성공·실패·끊김 모두 최신 기록으로 다시 그린다(서버가 일부라도 처리했을 수 있다)
      setChanged(true);
      try { await reload(next); } catch { /* 위 오류 메시지로 충분 */ }
      setBusy(false);
    }
  }

  async function post(body: Record<string, unknown>, fallback: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const j = await readJson(await fetch(API(orderId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      if (!j.ok) throw new Error(j.error || fallback);
      applyCtx(j as unknown as InvoiceContext, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
      try { await reload(); } catch { /* 무시 */ }
    } finally {
      setChanged(true);
      setBusy(false);
    }
  }
  const refresh = () => post({ action: "refresh" }, "새로고침 실패");
  const markFailed = (r: TaxInvoiceRow) => {
    if (!window.confirm(`${TAX_TYPE_TITLE[r.tax_type]} ${won(r.total)}원을 실패로 바꿀까요?\n볼타 개발자센터에서 이 문서가 실패(또는 미접수)인 것을 확인한 뒤에만 바꾸세요 — 실제로 발행된 문서를 바꾸면 다시 발행할 때 중복 발행됩니다.`)) return;
    post({ action: "mark_failed", rowId: r.id }, "실패 처리 실패");
  };

  async function openPdf(id: string) {
    setError("");
    const w = window.open("", "_blank"); // 팝업 차단 피하려 클릭 순간 연다
    try {
      for (let i = 0; i < 6; i++) {
        const j = await readJson(await fetch(`/api/b2b/tax-invoices/${id}/pdf`, { cache: "no-store" }));
        if (!j.ok) throw new Error(j.error || "PDF 조회 실패");
        if (j.ready && j.url) { if (w) w.location.href = String(j.url); else window.open(String(j.url), "_blank"); return; }
        await new Promise((r) => setTimeout(r, Math.min(10, Number(j.retryAfter) || 3) * 1000));
      }
      throw new Error("PDF 를 만드는 중입니다 — 잠시 뒤 다시 누르세요.");
    } catch (e) { w?.close(); setError(e instanceof Error ? e.message : "PDF 조회 실패"); }
  }

  const stepIdx = step === "edit" ? 1 : 2;
  const latestRows = ctx ? latestOf(ctx) : [];
  const canReissue = !!ctx && ctx.configured && (ctx.mode === "test" || (issueDocs.length > 0 && (ctx.order.tax_invoice_status === "미발행" || ctx.order.tax_invoice_status === "발행대기")));
  const now = Date.now();

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 820 }}>
        <div className="b2b-modal-head">
          <div>
            <h2 className="b2b-modal-title">세금계산서 발행</h2>
            <div style={{ marginTop: 4, fontSize: FS_META, color: "var(--sm-text-mid)" }}>{label}</div>
          </div>
          <button className="b2b-modal-close" onClick={close} disabled={busy}>✕</button>
        </div>

        <div className="b2b-modal-body sm-col" style={{ gap: 14, fontSize: FS }}>
          {/* 단계 */}
          <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", fontWeight: 700 }}>
            {STEPS.map((s, i) => (
              <span key={s} className="sm-row" style={{ gap: 6, alignItems: "center" }}>
                <span style={{ color: i < stepIdx ? "var(--sm-success)" : i === stepIdx ? "var(--sm-orange)" : "var(--sm-text-light)" }}>{i < stepIdx ? "✓ " : ""}{s}</span>
                {i < STEPS.length - 1 && <span style={{ color: "var(--sm-text-light)" }}>›</span>}
              </span>
            ))}
          </div>

          {loading && <div className="sm-faint">불러오는 중...</div>}
          {error && <div className="b2b-error">{error}</div>}
          {notice && <div className="sm-warn">{notice}</div>}
          {ctx?.mode === "test" && <div className="sm-warn">테스트 키 — 국세청에 전송되지 않고, 발주의 세금계산서 상태도 바뀌지 않습니다.</div>}

          {ctx && supplied && step === "edit" && (
            <>
              {blockers.length > 0 && <div className="b2b-error">{blockers.map((b) => <div key={b}>{b}</div>)}</div>}
              {warnings.length > 0 && <div className="sm-warn">{warnings.map((w) => <div key={w}>{w}</div>)}</div>}
              {partial && <div className="sm-warn">이미 발행된 문서는 두고 {issueDocs.map((d) => TAX_TYPE_TITLE[d.taxType]).join(", ")}만 발행합니다.</div>}

              <div className="b2b-field-row">
                <div className="b2b-field">
                  <label className="b2b-field-label">작성일자</label>
                  <input type="date" className="b2b-input" max={kstToday()} value={writeDate} onChange={(e) => setWriteDate(e.target.value)} />
                  <span className="sm-faint" style={{ fontSize: FS_META }}>발송일 {ctx.draft.writeDate || "-"} · 발행 마감 {dueDate.date || "-"}{dueDate.exact ? "" : "(대략)"}</span>
                </div>
                <div className="b2b-field">
                  <label className="b2b-field-label">영수 / 청구</label>
                  <div className="sm-tabs">
                    {(["RECEIPT", "CLAIM"] as PurposeCode[]).map((p) => (
                      <button key={p} type="button" className={`sm-tab ${purpose === p ? "is-active" : ""}`} onClick={() => setPurpose(p)}>{PURPOSE_LABEL[p]}</button>
                    ))}
                  </div>
                  <span className="sm-faint" style={{ fontSize: FS_META }}>입금상태 {ctx.order.payment_status}</span>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  공급자 <Link href="/b2b/settings" target="_blank" className="b2b-link-btn" style={{ fontSize: FS_META, fontWeight: 600, marginLeft: 6 }}>설정에서 수정</Link>
                </div>
                <div style={{ color: "var(--sm-text-mid)" }}>
                  {[ctx.supplier.name, formatBizNo(ctx.supplier.bizNo), ctx.supplier.ceo && `대표 ${ctx.supplier.ceo}`, ctx.supplier.bizType, ctx.supplier.bizItem, ctx.supplier.email].filter(Boolean).join(" · ") || "공급자 정보가 비었습니다"}
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>공급받는자 · {ctx.order.company_name}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                  {PARTY_FIELDS.map((f) => (
                    <label key={f.k} className="b2b-field" style={{ margin: 0, gridColumn: f.wide ? "1 / -1" : undefined }}>
                      <span className="b2b-field-label">{f.label}</span>
                      <input className="b2b-input" value={supplied[f.k]} placeholder={f.ph} onChange={(e) => setSupplied({ ...supplied, [f.k]: e.target.value })} />
                    </label>
                  ))}
                </div>
                <label className="sm-row" style={{ gap: 6, marginTop: 8, cursor: "pointer" }}>
                  <input type="checkbox" className="b2b-checkbox" checked={saveCompany} onChange={(e) => setSaveCompany(e.target.checked)} />
                  업체 주소록에도 저장(업태·종목·사업장 주소·계산서 수신 정보)
                </label>
              </div>

              {issueDocs.map((d) => (
                <div key={d.taxType}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>{TAX_TYPE_TITLE[d.taxType]} · {d.lines.length}줄</div>
                  <div className="b2b-table-wrap">
                    <table className="b2b-table">
                      <thead>
                        <tr><th>품목</th><th>규격</th><th className="num">수량</th><th className="num">단가</th><th className="num">공급가액</th>{d.taxType === "TAXABLE" && <th className="num">세액</th>}</tr>
                      </thead>
                      <tbody>
                        {d.lines.map((l, i) => {
                          const ed = lineEdits[d.taxType]?.[i] ?? { name: l.name, spec: l.spec };
                          const setEd = (patch: Partial<{ name: string; spec: string }>) => setLineEdits((prev) => {
                            const arr = [...(prev[d.taxType] ?? d.lines.map((x) => ({ name: x.name, spec: x.spec })))];
                            arr[i] = { ...arr[i], ...patch };
                            return { ...prev, [d.taxType]: arr };
                          });
                          return (
                            <tr key={i}>
                              <td><input className="b2b-input" style={{ minWidth: 160 }} value={ed.name} maxLength={100} onChange={(e) => setEd({ name: e.target.value })} />{l.note && <div className="sm-faint" style={{ fontSize: FS_META }}>{l.note}</div>}</td>
                              <td><input className="b2b-input" style={{ minWidth: 80 }} value={ed.spec} maxLength={60} onChange={(e) => setEd({ spec: e.target.value })} /></td>
                              <td className="num">{l.quantity != null ? l.quantity.toLocaleString() : "-"}</td>
                              <td className="num">{l.unitPrice != null ? won(l.unitPrice) : "-"}</td>
                              <td className="num">{won(l.supplyCost)}</td>
                              {d.taxType === "TAXABLE" && <td className="num">{won(l.tax)}</td>}
                            </tr>
                          );
                        })}
                        <tr>
                          <td colSpan={4} style={{ fontWeight: 700 }}>합계 {won(d.total)}원</td>
                          <td className="num" style={{ fontWeight: 700 }}>{won(d.supplyCost)}</td>
                          {d.taxType === "TAXABLE" && <td className="num" style={{ fontWeight: 700 }}>{won(d.tax)}</td>}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {d.mergedNames.length > 0 && <div className="sm-faint" style={{ fontSize: FS_META, marginTop: 4 }}>합친 품목: {d.mergedNames.join(", ")}</div>}
                </div>
              ))}

              <div style={{ fontWeight: 700, color: ctx.draft.expectedTotal === ctx.draft.statementTotal ? "var(--sm-success)" : "var(--sm-warning)" }}>
                계산서 합계 {won(ctx.draft.expectedTotal)}원 · 거래명세표 합계금액 {won(ctx.draft.statementTotal)}원{ctx.draft.expectedTotal === ctx.draft.statementTotal ? " ✓ 일치" : " — 다릅니다"}
              </div>

              <label className="b2b-field" style={{ margin: 0 }}>
                <span className="b2b-field-label">비고</span>
                <input className="b2b-input" value={description} maxLength={150} onChange={(e) => setDescription(e.target.value)} />
              </label>
            </>
          )}

          {ctx && step === "done" && (
            <>
              {latestRows.map((r) => {
                const st = ROW_STATUS[r.status];
                const stuck = r.status === "요청" && ctx.configured && now - Date.parse(r.created_at) > STUCK_MS;
                return (
                  <div key={r.id} style={{ border: "1px solid var(--sm-border)", borderRadius: "var(--sm-radius)", padding: 12 }}>
                    <div className="sm-row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <strong>{TAX_TYPE_TITLE[r.tax_type]} · {won(r.total)}원 · {PURPOSE_LABEL[r.purpose]} · {r.write_date}</strong>
                      <span className="sm-row" style={{ gap: 6, alignItems: "center" }}>
                        {!ctx.mode && <span className="sm-faint" style={{ fontSize: FS_META }}>{r.mode === "live" ? "라이브" : "테스트"}</span>}
                        <span className="b2b-status-pill" style={{ background: st.bg, color: st.fg }}>{st.label}</span>
                      </span>
                    </div>
                    <div className="sm-faint" style={{ fontSize: FS_META, marginTop: 4 }}>
                      공급가액 {won(r.supply_cost)}원{r.tax != null ? ` · 세액 ${won(r.tax)}원` : ""} · 요청 {r.created_by || "-"} {new Date(r.created_at).toLocaleString("ko-KR")}
                    </div>
                    {r.status === "발행완료" && (
                      <div className="sm-row" style={{ gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span>국세청 승인번호 <strong>{r.nts_id || "-"}</strong></span>
                        <button type="button" className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: FS_META }} onClick={() => openPdf(r.id)}>PDF</button>
                      </div>
                    )}
                    {r.status === "요청" && !r.issuance_key && <div className="sm-faint" style={{ fontSize: FS_META, marginTop: 6 }}>볼타 접수 번호를 아직 받지 못했습니다 — 새로고침하면 다시 확인합니다.</div>}
                    {r.fail_message && <div style={{ color: "var(--sm-danger)", marginTop: 6 }}>{r.fail_message}</div>}
                    {stuck && (
                      <div className="sm-row" style={{ gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="sm-faint" style={{ fontSize: FS_META }}>10분 넘게 결과가 없습니다 — 볼타 개발자센터에서 실패를 확인했다면</span>
                        <button type="button" className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: FS_META }} onClick={() => markFailed(r)} disabled={busy}>실패로 처리</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {latestRows.some((r) => r.status === "요청") && (
                <div className="sm-faint" style={{ fontSize: FS_META }}>{ctx.mode === "live" ? "국세청 처리에 보통 10분쯤 걸립니다 — 결과가 오면 자동으로 반영되고, 바로 확인하려면 [상태 새로고침]을 누르세요." : "테스트 발행은 보통 30초 안에 결과가 옵니다."}</div>
              )}
            </>
          )}
        </div>

        <div className="b2b-modal-foot">
          <span style={{ fontSize: FS, color: "var(--sm-text-mid)" }}>
            {ctx && step === "edit" ? `${issueDocs.length}장 · 합계 ${won(issueTotal)}원` : ""}
          </span>
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={close} disabled={busy}>닫기</button>
            {ctx && step === "edit" && (
              <>
                {latestRows.length > 0 && <button type="button" className="b2b-btn-secondary" onClick={() => setStep("done")} disabled={busy}>발행 기록</button>}
                <button type="button" className="b2b-btn-primary" onClick={issue} disabled={busy || blockers.length > 0}>
                  {busy ? "발행 중..." : ctx.mode === "test" ? "테스트 발행" : partial ? "남은 문서 발행" : "발행하기"}
                </button>
              </>
            )}
            {ctx && step === "done" && (
              <>
                {(canReissue || !ctx.configured) && <button type="button" className="b2b-btn-secondary" onClick={() => setStep("edit")} disabled={busy}>{!ctx.configured ? "미리보기" : ctx.mode === "test" ? "다시 테스트 발행" : partial ? "실패 문서 다시 발행" : "다시 발행"}</button>}
                {ctx.configured && <button type="button" className="b2b-btn-primary" onClick={refresh} disabled={busy}>{busy ? "확인 중..." : "상태 새로고침"}</button>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
