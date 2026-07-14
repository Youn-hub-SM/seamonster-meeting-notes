"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Warn = { rowNo: number; addr: string; name: string };
type FileOut = { name: string; b64: string };
type Parcel = { category: string; normal: number; guarantee: number };
type Result = {
  stats: { total: number; excludedNothing: number; normalCount: number; guaranteeCount: number; parcels: number; parcelsGuar: number };
  fees: { baseNormal: number; baseGuar: number; guarExtra: number };
  parcelSummary: Parcel[];
  addressWarnings: Warn[];
  unmatched: string[];
  outbound: { sku: string; name: string; qty: number }[];
  codeCount: number;
  files: { normal: FileOut; guarantee: FileOut | null; parcel: FileOut };
};
type DItem = { sku: string; name: string; qty: number; kind: "single" | "bundle" | "unmatched" | "ambiguous" };
type DProd = { productId: string; name: string; option: string; need: number; current: number; after: number; short: boolean };
type DispatchPreview = { items: DItem[]; products: DProd[]; shortages: number; message?: string };
type DispatchDone = { orderNo: string; groupId: string; dispatched: number; totalQty: number; shortages: number };

const KW_KEY = "fulfill_addr_keywords";
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const STEPS = ["발주엑셀 업로드", "CN 파일 다운로드", "배송일지 기록", "상품 출고"];

function downloadB64(name: string, b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

export default function FulfillPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [step, setStep] = useState(0);
  const [ack, setAck] = useState(false);
  const [recordDate, setRecordDate] = useState(kstToday());
  const [recordMode, setRecordMode] = useState<"replace" | "add">("add"); // 더하기 기본
  const [recording, setRecording] = useState(false);
  const [recordOk, setRecordOk] = useState("");
  const [dispatch, setDispatch] = useState<DispatchPreview | null>(null);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchDone, setDispatchDone] = useState<DispatchDone | null>(null);

  useEffect(() => { setKeywords(localStorage.getItem(KW_KEY) || ""); }, []);
  function saveKeywords(v: string) { setKeywords(v); localStorage.setItem(KW_KEY, v); }

  // res 갱신 시 상품 출고 미리보기(재고 확인) 자동 로드
  useEffect(() => {
    setDispatch(null); setDispatchDone(null);
    const items = res?.outbound?.map((o) => ({ sku: o.sku, qty: o.qty })) || [];
    if (!items.length) return;
    let cancel = false;
    setDispatchLoading(true);
    (async () => {
      try {
        const j = await (await fetch("/api/fulfill/dispatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, commit: false }) })).json();
        if (!cancel && j.ok) setDispatch(j);
      } catch { /* 미리보기 실패는 무시 */ }
      if (!cancel) setDispatchLoading(false);
    })();
    return () => { cancel = true; };
  }, [res]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name); setError(""); setRes(null); setAck(false); setRecordOk(""); setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("keywords", keywords);
      const j = await (await fetch("/api/fulfill/generate", { method: "POST", body: fd })).json();
      if (!j.ok) throw new Error(j.error || "생성 실패");
      setRes(j as Result);
    } catch (err) { setError(err instanceof Error ? err.message : "생성 실패"); }
    setLoading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function recordLog(): Promise<boolean> {
    if (!res || !recordDate) return false;
    if (res.unmatched.length > 0 && !window.confirm(`미매칭 SKU ${res.unmatched.length}개가 있어 기본운임이 실제보다 적게 기록될 수 있어요.\n상품마스터에서 택배 정보를 채운 뒤 다시 만드는 걸 권장합니다.\n\n그래도 지금 기록할까요?`)) return false;
    setRecording(true); setRecordOk(""); setError("");
    let ok = false;
    try {
      const ex = await (await fetch(`/api/fulfill/log?from=${recordDate}&to=${recordDate}`, { cache: "no-store" })).json();
      const cur = ex.ok ? (ex.rows || []).find((r: { log_date: string; boxes_normal: Record<string, number>; boxes_guar: Record<string, number>; base_fee_normal: number; base_fee_guar: number }) => r.log_date === recordDate) : null;
      const hasData = !!cur && (Object.keys(cur.boxes_normal || {}).length > 0 || Object.keys(cur.boxes_guar || {}).length > 0 || cur.base_fee_normal > 0 || cur.base_fee_guar > 0);
      // 동일 데이터 감지 시 덮어쓰기 권유
      if (hasData) {
        if (recordMode === "add") {
          if (!window.confirm(`${recordDate}에 이미 배송일지 기록이 있습니다.\n\n같은 발주를 또 '더하기'하면 이중 집계됩니다. 동일한 데이터라면 '덮어쓰기'를 권장해요.\n\n그래도 '더하기'로 진행할까요?\n(취소 후 '덮어쓰기'로 바꿔 다시 눌러주세요)`)) { setRecording(false); return false; }
        } else if (!window.confirm(`${recordDate}에 이미 기록이 있습니다. 덮어쓸까요?`)) { setRecording(false); return false; }
      }
      const boxes_normal: Record<string, number> = {}, boxes_guar: Record<string, number> = {};
      for (const p of res.parcelSummary) { if (p.normal) boxes_normal[p.category] = p.normal; if (p.guarantee) boxes_guar[p.category] = p.guarantee; }
      const r = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ log_date: recordDate, record: true, mode: recordMode, boxes_normal, boxes_guar, base_fee_normal: res.fees.baseNormal, base_fee_guar: res.fees.baseGuar, guar_extra_fee: res.fees.guarExtra }) });
      const j = await r.json(); if (!j.ok) throw new Error(j.error || "기록 실패");
      setRecordOk(`${recordDate} 배송일지에 ${recordMode === "add" ? "더했어요(누적)" : "기록했어요"}.`);
      ok = true;
    } catch (e) { setError(e instanceof Error ? e.message : "기록 실패"); }
    setRecording(false);
    return ok;
  }

  // '다음 단계' = 그 단계 작업 수행 후 이동
  async function onNext() {
    if (!res) return;
    if (step === 0) { setStep(1); return; }
    if (step === 1) { // CN 2종 다운로드 후 이동
      if (!blocked) {
        const g = res.files.guarantee;
        if (res.stats.normalCount > 0) downloadB64(res.files.normal.name, res.files.normal.b64);
        if (g) setTimeout(() => downloadB64(g.name, g.b64), 400);
      }
      setStep(2); return;
    }
    if (step === 2) { // 아직 기록 안 했으면 배송일지 기록 후 이동
      if (!recordOk) { const done = await recordLog(); if (!done) return; }
      setStep(3); return;
    }
  }

  async function commitDispatch(force = false) {
    const items = res?.outbound?.map((o) => ({ sku: o.sku, qty: o.qty })) || [];
    if (!items.length) return;
    setDispatching(true); setError("");
    try {
      const r = await fetch("/api/fulfill/dispatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, commit: true, force }) });
      const j = await r.json();
      if (r.status === 409 && j.duplicate) {
        setDispatching(false);
        if (window.confirm(`${j.error}\n\n그래도 다시 출고할까요? (재고가 또 차감됩니다)`)) return commitDispatch(true);
        return;
      }
      if (!j.ok) throw new Error(j.error || "출고 실패");
      setDispatchDone(j);
    } catch (e) { setError(e instanceof Error ? e.message : "출고 실패"); }
    setDispatching(false);
  }

  function reset() { setRes(null); setStep(0); setFileName(""); setAck(false); setRecordOk(""); setError(""); }

  const blocked = !!res && res.addressWarnings.length > 0 && !ack; // 주소 경고 미확인
  const canJump = (i: number) => i === 0 || !!res;
  const canNext = step === 0 ? !!res : step === 1 ? !blocked : step === 2 ? true : false;

  return (
    <div className="b2b-container" style={{ maxWidth: 880 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">발주처리</h1>
          <p className="b2b-page-subtitle">소매 주문 엑셀 한 개로 <strong>CN 발주 → 배송일지 → 상품출고</strong>까지 순서대로 진행합니다. 한 단계씩 확인하며 진행하세요.</p>
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 6 }}>
          {res && <button className="b2b-btn-secondary" onClick={reset}>새 발주 시작</button>}
          <Link className="b2b-btn-secondary" href="/fulfill/log">배송일지</Link>
        </div>
      </header>

      {/* 진행 단계 */}
      <div className="sm-row" style={{ gap: 0, marginBottom: 18, alignItems: "flex-start" }}>
        {STEPS.map((label, i) => {
          const state = i < step ? "done" : i === step ? "cur" : "todo";
          const color = state === "done" ? "var(--sm-success)" : state === "cur" ? "var(--sm-orange)" : "var(--sm-border)";
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", flex: i < STEPS.length - 1 ? 1 : "0 0 auto" }}>
              <button onClick={() => canJump(i) && setStep(i)} disabled={!canJump(i)} title={label}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", cursor: canJump(i) ? "pointer" : "default", padding: 0 }}>
                <span style={{ width: 30, height: 30, borderRadius: "50%", background: state === "todo" ? "var(--sm-white)" : color, border: `2px solid ${color}`, color: state === "todo" ? "var(--sm-text-light)" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, flex: "0 0 auto" }}>
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span style={{ fontSize: 11, fontWeight: state === "cur" ? 700 : 500, color: state === "cur" ? "var(--sm-dark)" : "var(--sm-text-light)", whiteSpace: "nowrap" }}>{label}</span>
              </button>
              {i < STEPS.length - 1 && <div style={{ flex: 1, height: 2, background: i < step ? "var(--sm-success)" : "var(--sm-border)", margin: "0 8px", alignSelf: "flex-start", marginTop: 14 }} />}
            </div>
          );
        })}
      </div>

      {error && <div className="b2b-error">{error}{error.includes("054") ? " — 상품마스터에 택배 정보(migration 054)가 필요합니다." : ""}</div>}

      {/* STEP 0 — 업로드 */}
      {step === 0 && (
        <>
          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">① 발주엑셀 업로드</span></div>
            <div className="b2b-field" style={{ marginBottom: 12 }}>
              <label className="b2b-field-label">주소 경고어 <span className="sm-faint" style={{ fontWeight: 400 }}>(선택 · 쉼표로 구분 · 이 브라우저에 저장)</span></label>
              <input className="b2b-input" value={keywords} onChange={(e) => saveKeywords(e.target.value)} placeholder="예: 제주마루 702호, 군부대, 사서함" />
            </div>
            <div className="sm-row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button className="b2b-btn-primary" onClick={() => fileRef.current?.click()} disabled={loading}>{loading ? "만드는 중…" : res ? "다른 엑셀로 다시" : "주문 엑셀 올리기"}</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onFile} style={{ display: "none" }} />
              {fileName && <span className="sm-faint" style={{ fontSize: 12 }}>{fileName}</span>}
            </div>
          </section>

          {res && (
            <>
              <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
                <div className="b2b-stat-card"><div className="b2b-stat-card-label">전체 주문행</div><div className="b2b-stat-card-value">{res.stats.total.toLocaleString()}</div></div>
                <div className="b2b-stat-card"><div className="b2b-stat-card-label">NOTHING 제외</div><div className="b2b-stat-card-value" style={{ color: res.stats.excludedNothing ? "var(--sm-warning)" : "var(--sm-text-light)" }}>{res.stats.excludedNothing}</div></div>
                <div className="b2b-stat-card"><div className="b2b-stat-card-label">일반</div><div className="b2b-stat-card-value" style={{ color: "var(--sm-info)" }}>{res.stats.normalCount.toLocaleString()}</div></div>
                <div className="b2b-stat-card"><div className="b2b-stat-card-label">도착보장</div><div className="b2b-stat-card-value" style={{ color: "var(--sm-orange)" }}>{res.stats.guaranteeCount.toLocaleString()}</div></div>
              </div>
              {res.unmatched.length > 0 && (
                <div style={{ padding: "12px 16px", borderRadius: 10, background: "var(--sm-danger-bg)", border: "1px solid var(--sm-danger)", marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
                  <strong>상품마스터에 택배정보가 없는 단품코드 {res.unmatched.length}개</strong> — 품목명이 비고 중량이 0이라 박스타입/운임이 틀릴 수 있어요. <Link href="/b2b/products">상품마스터</Link>에서 채운 뒤 다시 만드세요.
                  <div className="sm-faint" style={{ marginTop: 6, fontSize: 12 }}>{res.unmatched.slice(0, 30).join(" · ")}{res.unmatched.length > 30 ? " …" : ""}</div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* STEP 1 — CN 다운로드 */}
      {step === 1 && res && (
        <>
          {res.addressWarnings.length > 0 && (
            <div style={{ padding: "12px 16px", borderRadius: 10, background: "var(--sm-warning-bg)", border: "1px solid var(--sm-warning)", marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
              <strong>주소 경고 {res.addressWarnings.length}건</strong> — 발주 전 반드시 확인하세요.
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                {res.addressWarnings.slice(0, 20).map((w, i) => <li key={i}>{w.name || "(이름?)"} · {w.addr}</li>)}
              </ul>
              <label className="sm-row" style={{ gap: 7, marginTop: 10, fontSize: 13, cursor: "pointer", fontWeight: 700 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 위 주소들을 확인했습니다 (체크해야 다운로드·다음 진행)
              </label>
            </div>
          )}
          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">② CN 파일 다운로드</span></div>
            <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button className="b2b-btn-primary" style={{ padding: "10px 20px", fontSize: 15, fontWeight: 700 }} disabled={blocked || res.stats.normalCount === 0}
                onClick={() => { const g = res.files.guarantee; downloadB64(res.files.normal.name, res.files.normal.b64); if (g) setTimeout(() => downloadB64(g.name, g.b64), 400); }}>
                모두 받기{res.files.guarantee ? " (2종)" : ""}
              </button>
              <button className="b2b-btn-secondary" disabled={blocked || res.stats.normalCount === 0} onClick={() => downloadB64(res.files.normal.name, res.files.normal.b64)}>CNplus 일반 ({res.stats.normalCount})</button>
              <button className="b2b-btn-secondary" disabled={blocked || !res.files.guarantee} onClick={() => res.files.guarantee && downloadB64(res.files.guarantee.name, res.files.guarantee.b64)}>CNplus [도착보장] ({res.stats.guaranteeCount})</button>
              {blocked && <span style={{ fontSize: 12, color: "var(--sm-danger)" }}>주소 경고를 확인(체크)해야 받을 수 있어요.</span>}
            </div>
            <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 10 }}>상품마스터 택배정보 {res.codeCount.toLocaleString()}개 기준. 도착보장은 운임구분(Q)=3. 두 파일 받은 뒤 &lsquo;다음&rsquo;.</p>
          </section>
        </>
      )}

      {/* STEP 2 — 배송일지 */}
      {step === 2 && res && (
        <section className="b2b-card">
          <div className="b2b-card-head" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span className="b2b-card-title">③ 배송일지 기록 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 택배 {res.stats.parcels}건 (일반 {res.stats.parcels - res.stats.parcelsGuar} · 도착보장 {res.stats.parcelsGuar})</span></span>
            <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <input type="date" className="b2b-input" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} style={{ width: "auto", padding: "5px 8px", fontSize: 12 }} />
              <div className="sm-tabs" style={{ margin: 0 }} title="같은 날짜에 이미 기록이 있을 때">
                <button className={`sm-tab ${recordMode === "add" ? "is-active" : ""}`} onClick={() => setRecordMode("add")}>더하기</button>
                <button className={`sm-tab ${recordMode === "replace" ? "is-active" : ""}`} onClick={() => setRecordMode("replace")}>덮어쓰기</button>
              </div>
              <button className="b2b-btn-primary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={recordLog} disabled={recording}>{recording ? "기록 중…" : "배송일지에 기록"}</button>
              <button className="b2b-btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => downloadB64(res.files.parcel.name, res.files.parcel.b64)}>택배량 엑셀</button>
            </div>
          </div>
          {recordOk && <div className="prod-sku-ok" style={{ fontSize: 12.5, margin: "0 0 8px" }}>✓ {recordOk} <Link href="/fulfill/log">배송일지 보기</Link></div>}
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>박스종류</th><th className="num">일반</th><th className="num">도착보장</th><th className="num">합계</th></tr></thead>
              <tbody>
                {res.parcelSummary.filter((p) => p.normal || p.guarantee).map((p) => (
                  <tr key={p.category}>
                    <td><strong>{p.category}</strong></td>
                    <td className="num b2b-money">{p.normal || "-"}</td>
                    <td className="num b2b-money" style={{ color: p.guarantee ? "var(--sm-orange)" : "var(--sm-text-light)" }}>{p.guarantee || "-"}</td>
                    <td className="num b2b-money" style={{ fontWeight: 700 }}>{p.normal + p.guarantee}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 6 }}>기본은 <strong>더하기(누적)</strong> — 하루 여러 배치를 합칩니다. 같은 발주를 다시 기록하면 이중 집계되니, 동일 데이터면 <strong>덮어쓰기</strong>로 진행하세요.</p>
        </section>
      )}

      {/* STEP 3 — 상품 출고 */}
      {step === 3 && res && (
        <section className="b2b-card">
          <div className="b2b-card-head" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span className="b2b-card-title">④ 상품 출고 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 소매 재고에서 차감</span></span>
            {!dispatchDone && dispatch && dispatch.products.length > 0 && (
              <button className="b2b-btn-primary" onClick={() => commitDispatch(false)} disabled={dispatching}>{dispatching ? "출고 중…" : `출고 완료 (${dispatch.products.length}품목)`}</button>
            )}
          </div>
          {dispatchLoading ? <div className="b2b-loading">재고 확인 중…</div> : dispatchDone ? (
            <div className="prod-sku-ok" style={{ fontSize: 13, lineHeight: 1.7 }}>
              ✓ <b>출고 완료</b> — {dispatchDone.dispatched}품목 · {dispatchDone.totalQty.toLocaleString()}개를 소매 재고에서 차감했습니다 (출고번호 <b>{dispatchDone.orderNo || "-"}</b>). <Link href="/inventory">재고 보기</Link>
              {dispatchDone.shortages > 0 ? <span style={{ color: "var(--sm-danger)" }}> · 재고 부족 {dispatchDone.shortages}품목(마이너스로 기록)</span> : null}
              <div className="sm-faint" style={{ fontSize: 11.5, marginTop: 6 }}>잘못 눌렀다면 <Link href="/inventory/activity">재고 활동 히스토리</Link>에서 이 출고번호 배치를 취소하면 원복됩니다. · <button className="b2b-link-btn" onClick={reset}>새 발주 시작</button></div>
            </div>
          ) : dispatch ? (
            <>
              {dispatch.items.some((i) => i.kind === "unmatched" || i.kind === "ambiguous") && (
                <div style={{ padding: "10px 14px", borderRadius: 10, background: "var(--sm-danger-bg)", border: "1px solid var(--sm-danger)", marginBottom: 12, fontSize: 12.5, lineHeight: 1.6 }}>
                  <strong>상품마스터에 없어 출고되지 않는 코드</strong> — <Link href="/b2b/products">상품마스터</Link>에 등록하면 다음부터 출고됩니다.
                  <div className="sm-faint" style={{ marginTop: 5, fontSize: 12 }}>{dispatch.items.filter((i) => i.kind === "unmatched" || i.kind === "ambiguous").map((i) => `${i.sku}${i.kind === "ambiguous" ? "(중복SKU)" : ""}`).join(" · ")}</div>
                </div>
              )}
              {dispatch.products.length === 0 ? (
                <div className="b2b-empty">{dispatch.message || "출고할 품목이 없습니다."}</div>
              ) : (
                <>
                  <div className="b2b-table-wrap">
                    <table className="b2b-table">
                      <thead><tr><th>상품</th><th>옵션</th><th className="num">출고수량</th><th className="num">현재 재고</th><th className="num">출고 후</th></tr></thead>
                      <tbody>
                        {dispatch.products.map((p) => (
                          <tr key={p.productId} style={p.short ? { background: "var(--sm-danger-bg)" } : undefined}>
                            <td><strong>{p.name}</strong></td>
                            <td style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>{p.option || "-"}</td>
                            <td className="num b2b-money">{p.need.toLocaleString()}</td>
                            <td className="num b2b-money">{p.current.toLocaleString()}</td>
                            <td className="num b2b-money" style={{ fontWeight: 700, color: p.short ? "var(--sm-danger)" : undefined }}>{p.after.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {dispatch.shortages > 0 && <p style={{ fontSize: 12, color: "var(--sm-danger)", marginTop: 6 }}>재고 부족 {dispatch.shortages}품목 — 출고는 진행되지만 마이너스 재고로 기록됩니다.</p>}
                  <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 6 }}>재고 확인 후 <strong>출고 완료</strong>를 누르면 소매 재고에서 차감됩니다. 묶음(세트)은 구성품으로 전개, 정기배송은 제외. 같은 발주 재출고는 막습니다.</p>
                </>
              )}
            </>
          ) : <div className="b2b-empty">출고할 품목이 없습니다.</div>}
        </section>
      )}

      {/* 이전/다음 */}
      {res && (
        <div className="sm-row" style={{ justifyContent: "space-between", marginTop: 18 }}>
          <button className="b2b-btn-secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>← 이전</button>
          {step < STEPS.length - 1 ? (
            <button className="b2b-btn-primary" onClick={onNext} disabled={!canNext || recording} title={!canNext ? "이 단계를 완료해야 넘어갈 수 있어요" : ""}>
              {step === 1 ? "CN 2종 받고 다음 →"
                : step === 2 ? (recording ? "기록 중…" : recordOk ? "다음: 상품 출고 →" : "배송일지에 기록 후 다음 →")
                  : `다음: ${STEPS[step + 1]} →`}
            </button>
          ) : <span className="sm-faint" style={{ fontSize: 12, alignSelf: "center" }}>마지막 단계</span>}
        </div>
      )}
    </div>
  );
}
