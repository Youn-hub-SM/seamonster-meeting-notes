"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Warn = { rowNo: number; addr: string; name: string };
type FileOut = { name: string; b64: string };
type Parcel = { category: string; normal: number; guarantee: number };
type Result = {
  stats: { total: number; excludedNothing: number; normalCount: number; guaranteeCount: number; parcels: number; parcelsGuar: number };
  fees: { baseNormal: number; baseGuar: number };
  parcelSummary: Parcel[];
  addressWarnings: Warn[];
  unmatched: string[];
  codeCount: number;
  files: { normal: FileOut; guarantee: FileOut | null; parcel: FileOut };
};

const KW_KEY = "fulfill_addr_keywords";
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

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
  const [ack, setAck] = useState(false); // 주소 경고 확인 체크
  const [recordDate, setRecordDate] = useState(kstToday());
  const [recording, setRecording] = useState(false);
  const [recordOk, setRecordOk] = useState("");

  async function recordLog() {
    if (!res || !recordDate) return;
    setRecording(true); setRecordOk(""); setError("");
    try {
      const boxes_normal: Record<string, number> = {}, boxes_guar: Record<string, number> = {};
      for (const p of res.parcelSummary) { if (p.normal) boxes_normal[p.category] = p.normal; if (p.guarantee) boxes_guar[p.category] = p.guarantee; }
      const r = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ log_date: recordDate, record: true, boxes_normal, boxes_guar, base_fee_normal: res.fees.baseNormal, base_fee_guar: res.fees.baseGuar }) });
      const j = await r.json(); if (!j.ok) throw new Error(j.error || "기록 실패");
      setRecordOk(`${recordDate} 배송일지에 기록했어요.`);
    } catch (e) { setError(e instanceof Error ? e.message : "기록 실패"); }
    setRecording(false);
  }

  useEffect(() => { setKeywords(localStorage.getItem(KW_KEY) || ""); }, []);
  function saveKeywords(v: string) { setKeywords(v); localStorage.setItem(KW_KEY, v); }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name); setError(""); setRes(null); setAck(false); setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("keywords", keywords);
      const j = await (await fetch("/api/fulfill/generate", { method: "POST", body: fd })).json();
      if (!j.ok) throw new Error(j.error || "생성 실패");
      setRes(j as Result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "생성 실패");
    }
    setLoading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  const blocked = !!res && res.addressWarnings.length > 0 && !ack; // 주소 경고 있으면 확인 전까지 다운로드 잠금

  return (
    <div className="b2b-container" style={{ maxWidth: 880 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">택배 발주처리</h1>
          <p className="b2b-page-subtitle">
            소매 주문 엑셀(A~M)을 올리면 <strong>CNplus 발주 파일(일반 + 도착보장)</strong>을 만들어 드립니다.
            단품코드 NOTHING 제외 · 도착보장 분리(운임구분 3) · 박스타입/운임 자동. 품목명·중량은 <Link href="/fulfill/codes">코드표</Link> 기준.
          </p>
        </div>
        <div className="b2b-page-actions"><Link className="b2b-btn-secondary" href="/fulfill/codes">코드표 관리</Link></div>
      </header>

      {error && <div className="b2b-error">{error}{error.includes("053") || error.includes("코드표") ? " — 코드표를 먼저 업로드하세요(코드표 관리)." : ""}</div>}

      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-field" style={{ marginBottom: 12 }}>
          <label className="b2b-field-label">주소 경고어 <span className="sm-faint" style={{ fontWeight: 400 }}>(선택 · 쉼표로 구분 · 이 브라우저에 저장)</span></label>
          <input className="b2b-input" value={keywords} onChange={(e) => saveKeywords(e.target.value)} placeholder="예: 제주마루 702호, 군부대, 사서함" />
          <span className="sm-faint" style={{ fontSize: 12 }}>주소에 이 단어가 들어간 주문이 있으면 발주 전 경고합니다.</span>
        </div>
        <div className="sm-row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="b2b-btn-primary" onClick={() => fileRef.current?.click()} disabled={loading}>{loading ? "만드는 중…" : "주문 엑셀 올리기"}</button>
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
              ⚠️ <strong>상품마스터에 택배정보가 없는 단품코드 {res.unmatched.length}개</strong> — 이 상품들은 <strong>품목명이 비고 중량이 0</strong>이라 박스타입/운임이 틀릴 수 있어요. <Link href="/b2b/products">상품마스터</Link>에서 택배 상품명·중량을 채운 뒤 다시 만드세요.
              <div className="sm-faint" style={{ marginTop: 6, fontSize: 12 }}>{res.unmatched.slice(0, 30).join(" · ")}{res.unmatched.length > 30 ? " …" : ""}</div>
            </div>
          )}

          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span className="b2b-card-title">택배량 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 주문(택배) {res.stats.parcels}건 (일반 {res.stats.parcels - res.stats.parcelsGuar} · 도착보장 {res.stats.parcelsGuar})</span></span>
              <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <input type="date" className="b2b-input" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} style={{ width: "auto", padding: "5px 8px", fontSize: 12 }} title="배송일지에 기록할 날짜" />
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
            <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 6 }}>주문(주문번호+주소) 단위로 총중량에 따라 박스종류를 나눠 셈. 배송일지 &lsquo;택배량&rsquo; 시트와 동일 기준.</p>
          </section>

          {res.addressWarnings.length > 0 && (
            <div style={{ padding: "12px 16px", borderRadius: 10, background: "var(--sm-warning-bg)", border: "1px solid var(--sm-warning)", marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
              🚨 <strong>주소 경고 {res.addressWarnings.length}건</strong> — 발주 전 반드시 확인하세요.
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                {res.addressWarnings.slice(0, 20).map((w, i) => <li key={i}>{w.name || "(이름?)"} · {w.addr}</li>)}
              </ul>
              <label className="sm-row" style={{ gap: 7, marginTop: 10, fontSize: 13, cursor: "pointer", fontWeight: 700 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 위 주소들을 확인했습니다 (체크해야 다운로드 가능)
              </label>
            </div>
          )}

          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">발주 파일 다운로드</span></div>
            <div className="sm-row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="b2b-btn-primary" disabled={blocked || res.stats.normalCount === 0} onClick={() => downloadB64(res.files.normal.name, res.files.normal.b64)}>
                CNplus 일반 ({res.stats.normalCount})
              </button>
              <button className="b2b-btn-secondary" disabled={blocked || !res.files.guarantee} onClick={() => res.files.guarantee && downloadB64(res.files.guarantee.name, res.files.guarantee.b64)}>
                CNplus [도착보장] ({res.stats.guaranteeCount})
              </button>
              {blocked && <span style={{ fontSize: 12, color: "var(--sm-danger)" }}>주소 경고를 확인(체크)해야 받을 수 있어요.</span>}
            </div>
            <p className="sm-faint" style={{ fontSize: 11.5, marginTop: 10 }}>코드표 {res.codeCount.toLocaleString()}개 기준. 도착보장은 운임구분(Q)=3으로 설정됩니다.</p>
          </section>
        </>
      )}
    </div>
  );
}
