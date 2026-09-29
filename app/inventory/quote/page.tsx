"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { QuoteItem, QuoteSummary } from "@/app/lib/inventory-quote";
import ReturnModal from "./ReturnModal";
import QuoteSheet from "./QuoteSheet";

const THIS_MONTH = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
const won = (n: number) => Math.round(n).toLocaleString();

type QuoteResp = { ok: boolean; month: string; items: QuoteItem[]; summary: QuoteSummary; error?: string };
type Snapshot = { month: string; confirmed_at: string; confirmed_by: string | null; summary: QuoteSummary; items: QuoteItem[] };
type SnapRow = { month: string; confirmed_at: string; confirmed_by: string | null; summary: QuoteSummary };

export default function QuotePage() {
  const [ym, setYm] = useState(THIS_MONTH());
  const [rent, setRent] = useState(0);
  const [etc, setEtc] = useState(0);
  const [taxEtc, setTaxEtc] = useState(0);
  const [data, setData] = useState<QuoteResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  // 결산 확정(스냅샷) — migration 101. 미적용이면 확정 UI 만 숨긴다.
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [snapReady, setSnapReady] = useState(false);
  const [snapBusy, setSnapBusy] = useState(false);
  // 확정된 결산 목록(화면 아래) + 펼쳐 본 확정본. 확정본은 확정 당시 저장한 결산서 그대로다.
  const [snapList, setSnapList] = useState<SnapRow[]>([]);
  const [viewMonth, setViewMonth] = useState<string | null>(null);
  const [viewSnap, setViewSnap] = useState<Snapshot | null>(null);
  const [viewErr, setViewErr] = useState("");
  // 화면에 결산서가 둘(지금·확정본)일 때 인쇄할 쪽 — 나머지는 인쇄에서 빠진다
  const [printTarget, setPrintTarget] = useState<"live" | "snap">("live");

  // 임대료·기타는 매달 고정값에 가까워 브라우저에 기억.
  useEffect(() => {
    const r = Number(localStorage.getItem("inv_quote_rent")); if (r > 0) setRent(r);
    const e = Number(localStorage.getItem("inv_quote_etc")); if (e > 0) setEtc(e);
    const tx = Number(localStorage.getItem("inv_quote_tax_etc")); if (tx > 0) setTaxEtc(tx);
  }, []);
  useEffect(() => { localStorage.setItem("inv_quote_rent", String(rent)); }, [rent]);
  useEffect(() => { localStorage.setItem("inv_quote_etc", String(etc)); }, [etc]);
  useEffect(() => { localStorage.setItem("inv_quote_tax_etc", String(taxEtc)); }, [taxEtc]);

  const load = useCallback(async (m: string, r: number, e: number, tx: number) => {
    setLoading(true); setError("");
    try {
      const j: QuoteResp = await (await fetch(`/api/inventory/quote?month=${m}&rent=${r}&etc=${e}&tax_etc=${tx}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setData(j);
    } catch (err) { setError(err instanceof Error ? err.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { const t = setTimeout(() => load(ym, rent, etc, taxEtc), 250); return () => clearTimeout(t); }, [load, ym, rent, etc, taxEtc]);

  // 월 전환·연속 요청 시 이전 응답이 새 화면을 덮지 않게 순번 가드
  const snapSeq = useRef(0);
  const loadSnap = useCallback(async (m: string) => {
    const seq = ++snapSeq.current;
    try {
      const j = await (await fetch(`/api/inventory/quote/snapshot?month=${m}`, { cache: "no-store" })).json();
      if (seq !== snapSeq.current) return;
      if (j.ok) { setSnap(j.snapshot || null); setSnapReady(!j.unavailable); }
    } catch { /* 확정 기능만 조용히 비활성 — 결산 자체는 그대로 */ }
  }, []);
  useEffect(() => { setSnap(null); loadSnap(ym); }, [loadSnap, ym]); // 이전 달 확정 배너 잔상 방지

  const loadList = useCallback(async () => {
    try {
      const j = await (await fetch("/api/inventory/quote/snapshot?list=1", { cache: "no-store" })).json();
      if (j.ok) setSnapList(j.snapshots || []);
    } catch { /* 목록만 비어 보인다 — 결산 자체는 그대로 */ }
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  // 확정본 펼치기 — 저장된 요약·품목표를 그대로 불러온다(재계산 아님)
  const viewSeq = useRef(0);
  const openSnap = useCallback(async (m: string) => {
    const seq = ++viewSeq.current;
    setViewMonth(m); setViewSnap(null); setViewErr("");
    try {
      const j = await (await fetch(`/api/inventory/quote/snapshot?month=${m}`, { cache: "no-store" })).json();
      if (seq !== viewSeq.current) return;
      if (!j.ok) throw new Error(j.error || "확정본 조회 실패");
      if (!j.snapshot) { setViewErr("확정본이 없습니다 — 확정이 해제됐을 수 있습니다."); return; }
      setViewSnap(j.snapshot);
    } catch (e) { if (seq === viewSeq.current) setViewErr(e instanceof Error ? e.message : "확정본 조회 실패"); }
  }, []);
  function closeSnap() { viewSeq.current++; setViewMonth(null); setViewSnap(null); setViewErr(""); }
  // 펼치면 그 자리로 스크롤 — 상단 배너의 '확정본 보기'를 눌러도 아래 결산서가 바로 보이게
  const viewRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (viewMonth) viewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [viewMonth]);

  // 인쇄할 결산서를 정해 두고 인쇄 — 끝나면 다시 '지금 결산'이 기본
  function printSheet(target: "live" | "snap") {
    flushSync(() => setPrintTarget(target));
    window.print();
    setPrintTarget("live");
  }

  async function confirmQuote() {
    if (!window.confirm(snap
      ? `${ym} 결산을 다시 확정할까요? 기존 확정본을 덮어씁니다.`
      : `${ym} 결산을 확정할까요? 확정 후 원장이 바뀌면 이 화면에 경고가 표시됩니다.`)) return;
    setSnapBusy(true);
    try {
      const r = await fetch("/api/inventory/quote/snapshot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: ym, rent, etc, tax_etc: taxEtc }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) { alert(`확정 실패: ${j?.error || "서버 오류"}`); return; }
      setSnap(j.snapshot);
      void loadList();
      if (viewMonth === ym) void openSnap(ym); // 펼쳐 둔 확정본이 이 달이면 새 확정본으로
      // 확정본은 서버 최신 원장 기준 — 화면 데이터도 같은 기준으로 갱신해 역방향 경고 방지
      await load(ym, rent, etc, taxEtc);
    } catch { alert("확정 실패: 네트워크 오류 — 잠시 후 다시 시도하세요."); }
    finally { setSnapBusy(false); }
  }
  async function unconfirmQuote() {
    if (!window.confirm(`${ym} 결산 확정을 해제할까요?`)) return;
    try {
      const r = await fetch(`/api/inventory/quote/snapshot?month=${ym}`, { method: "DELETE" });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) { alert(`해제 실패: ${j?.error || "서버 오류"}`); return; }
      setSnap(null);
      void loadList();
      if (viewMonth === ym) closeSnap();
    } catch { alert("해제 실패: 네트워크 오류 — 잠시 후 다시 시도하세요."); }
  }
  const dtKst = (iso: string) => {
    try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16); }
    catch { return iso.slice(0, 16).replace("T", " "); }
  };

  const s = data?.summary;
  const items = data?.items ?? [];

  // 확정본 vs 현재 재계산 — 원장에서 나오는 숫자만 비교(임대료·기타 입력값과 무관).
  //  월 전환 직후엔 snap/data 가 서로 다른 달일 수 있어 같은 달일 때만 비교한다.
  const snapDiffs = (() => {
    if (!snap || !s) return [];
    if (snap.month !== ym || data?.month !== ym) return [];
    const c = snap.summary; const d: string[] = [];
    const cmp = (label: string, a: number, b: number, unit = "") => {
      if (Math.round(a) !== Math.round(b)) d.push(`${label} ${a.toLocaleString()}${unit} → ${b.toLocaleString()}${unit}`);
    };
    cmp("품목", c.itemCount, s.itemCount, "종");
    cmp("매입수량", c.totalQty, s.totalQty, "개");
    cmp("반품수량", c.totalReturnQty ?? 0, s.totalReturnQty ?? 0, "개");
    cmp("총 매입금액", c.totalAmount, s.totalAmount, "원");
    return d;
  })();
  const exportUrl = `/api/inventory/quote/export?month=${ym}&rent=${rent}&etc=${etc}&tax_etc=${taxEtc}`;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div><h1 className="b2b-page-title">월간 매입 결산</h1></div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={() => setReturnOpen(true)}>제조사 반품 입력</button>
          {snapReady && (
            <button className="b2b-btn-secondary" onClick={confirmQuote} disabled={snapBusy || loading || !s}>
              {snap ? "재확정" : "결산 확정"}
            </button>
          )}
          <a className="b2b-btn-secondary" href={exportUrl}>엑셀 다운로드</a>
          <button className="b2b-btn-primary" onClick={() => printSheet("live")} disabled={loading || items.length === 0}>인쇄 / PDF</button>
        </div>
      </header>
      {error && <div className="b2b-error no-print">{error}</div>}
      {snap && (snapDiffs.length === 0 ? (
        <div className="sm-success no-print" style={{ marginBottom: 12 }}>
          {Number(ym.slice(5))}월 결산 확정됨 — {dtKst(snap.confirmed_at)}{snap.confirmed_by ? ` · ${snap.confirmed_by}` : ""} · 확정 총 입금액 {won(snap.summary.deposit)}원
          <button className="b2b-link-btn" style={{ marginLeft: 10, fontSize: 12 }} onClick={() => openSnap(ym)}>확정본 보기</button>
          <button className="b2b-link-btn sm-faint" style={{ marginLeft: 10, fontSize: 12 }} onClick={unconfirmQuote}>확정 해제</button>
        </div>
      ) : (
        <div className="sm-warn no-print" style={{ marginBottom: 12 }}>
          <strong>확정({dtKst(snap.confirmed_at)}) 이후 원장이 바뀌었습니다:</strong> {snapDiffs.join(" · ")}
          <button className="b2b-link-btn" style={{ marginLeft: 8, fontSize: 12 }} onClick={() => openSnap(ym)}>확정본 보기</button>
          <button className="b2b-link-btn sm-faint" style={{ marginLeft: 8, fontSize: 12 }} onClick={unconfirmQuote}>확정 해제</button>
        </div>
      ))}

      <section className="b2b-card no-print" style={{ marginBottom: 16 }}>
        <div className="sm-row" style={{ gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>대상 월
            <input className="b2b-input" type="month" value={ym} max={THIS_MONTH()} onChange={(e) => setYm(e.target.value)} style={{ width: "auto" }} /></label>
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>임대료(총액·부가세 포함)
            <input className="b2b-input" type="number" min={0} value={rent || ""} onChange={(e) => setRent(Number(e.target.value) || 0)} placeholder="0" style={{ width: 130, textAlign: "right" }} /></label>
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>면세 기타
            <input className="b2b-input" type="number" min={0} value={etc || ""} onChange={(e) => setEtc(Number(e.target.value) || 0)} placeholder="0" style={{ width: 120, textAlign: "right" }} /></label>
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>과세 기타
            <input className="b2b-input" type="number" min={0} value={taxEtc || ""} onChange={(e) => setTaxEtc(Number(e.target.value) || 0)} placeholder="0" style={{ width: 130, textAlign: "right" }} /></label>
        </div>
      </section>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : items.length === 0 && !s?.rentTotal ? (
        <div className="b2b-empty">{ym} 매입 내역이 없습니다.</div>
      ) : s && (
        <QuoteSheet ym={ym} s={s} items={items} printable={printTarget === "live"} />
      )}

      {/* 확정된 결산 — 확정할 때 저장된 결산서(요약·품목표) 그대로. 원장이 나중에 바뀌어도 이 표는 그대로다 */}
      {snapList.length > 0 && (
        <section className="b2b-card no-print" style={{ marginTop: 24, maxWidth: 900 }}>
          <div className="b2b-card-head"><span className="b2b-card-title">확정된 결산</span></div>
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>대상 월</th><th>확정</th><th className="num">품목</th><th className="num">총 매입금액</th><th className="num">총 입금액</th><th style={{ width: 90 }}></th></tr></thead>
              <tbody>
                {snapList.map((r) => (
                  <tr key={r.month} style={viewMonth === r.month ? { background: "var(--sm-bg-subtle)" } : undefined}>
                    <td style={{ fontWeight: 700 }}>{r.month}</td>
                    <td className="sm-faint" style={{ fontSize: 12 }}>{dtKst(r.confirmed_at)}{r.confirmed_by ? ` · ${r.confirmed_by}` : ""}</td>
                    <td className="num b2b-money">{(r.summary?.itemCount ?? 0).toLocaleString()}종</td>
                    <td className="num b2b-money">{won(r.summary?.totalAmount ?? 0)}</td>
                    <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(r.summary?.deposit ?? 0)}</td>
                    <td style={{ textAlign: "right" }}>
                      {viewMonth === r.month
                        ? <button className="b2b-btn-secondary" style={{ padding: "2px 10px", fontSize: 12 }} onClick={closeSnap}>닫기</button>
                        : <button className="b2b-btn-secondary" style={{ padding: "2px 10px", fontSize: 12 }} onClick={() => openSnap(r.month)}>보기</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {viewMonth && (
        <div ref={viewRef} style={{ marginTop: 16, scrollMarginTop: 16 }}>
          <div className="sm-row no-print" style={{ gap: 8, marginBottom: 10, maxWidth: 900, justifyContent: "flex-end" }}>
            <button className="b2b-btn-primary" onClick={() => printSheet("snap")} disabled={!viewSnap}>확정본 인쇄 / PDF</button>
            <button className="b2b-btn-secondary" onClick={closeSnap}>닫기</button>
          </div>
          {viewErr ? <div className="b2b-error no-print">{viewErr}</div>
            : !viewSnap ? <div className="b2b-loading no-print">확정본 불러오는 중...</div>
            : <QuoteSheet ym={viewSnap.month} s={viewSnap.summary} items={viewSnap.items || []}
                stamp={`확정본 · ${dtKst(viewSnap.confirmed_at)}${viewSnap.confirmed_by ? ` · ${viewSnap.confirmed_by}` : ""}`}
                printable={printTarget === "snap"} />}
        </div>
      )}

      {returnOpen && (
        <ReturnModal
          month={ym}
          onClose={() => setReturnOpen(false)}
          onSaved={() => { setReturnOpen(false); load(ym, rent, etc, taxEtc); }}
        />
      )}
    </div>
  );
}
