"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

// 거래명세표 — 커스텀 작성. 발주 없이 손으로 채워 인쇄/PDF 로 뽑는다.
//  발주 1건짜리 명세표(/b2b/orders/[id]/statement)와 '보이는 결과'는 같아야 해서 레이아웃·세액 규칙을 맞췄다.
//  차이: 값의 출처가 전부 입력이고, 공급자·입금계좌는 설정값을 초기값으로 불러온 뒤 고칠 수 있다.
//  저장하지 않는다(1회성 출력) — 입력 중 새로고침 사고만 막으려 브라우저에 임시 보관한다.

type Supplier = { name: string; biz_no: string; ceo: string; addr: string; biz_type: string; biz_item: string; email: string; bank: string };
type Buyer = { name: string; biz_no: string; ceo: string; addr: string };
type Line = { key: string; name: string; spec: string; qty: string; price: string; exempt: boolean };

const EMPTY_SUPPLIER: Supplier = { name: "", biz_no: "", ceo: "", addr: "", biz_type: "", biz_item: "", email: "", bank: "" };
const won = (n: number) => Math.round(n).toLocaleString();
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const newLine = (): Line => ({ key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: "", spec: "", qty: "1", price: "", exempt: false });

const DRAFT_KEY = "b2b_statement_custom_draft";

export default function CustomStatementPage() {
  const [supplier, setSupplier] = useState<Supplier>(EMPTY_SUPPLIER);
  const [stamp, setStamp] = useState("");
  const [useStamp, setUseStamp] = useState(true);
  const [buyer, setBuyer] = useState<Buyer>({ name: "", biz_no: "", ceo: "", addr: "" });
  const [date, setDate] = useState(kstToday());
  const [docNo, setDocNo] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [loading, setLoading] = useState(true);
  const [restored, setRestored] = useState(false);

  // 설정의 공급자·직인을 초기값으로. 브라우저에 남은 작성 중 내용이 있으면 그걸 우선한다.
  useEffect(() => {
    (async () => {
      try {
        const sj = await (await fetch("/api/b2b/settings/statement", { cache: "no-store" })).json();
        if (sj.ok) { setSupplier({ ...EMPTY_SUPPLIER, ...(sj.supplier || {}) }); setStamp(sj.stamp || ""); }
      } catch { /* 설정 없이도 손으로 채워 쓸 수 있다 */ }
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) {
          const d = JSON.parse(raw) as { supplier?: Supplier; buyer?: Buyer; date?: string; docNo?: string; lines?: Line[]; useStamp?: boolean };
          if (d.supplier) setSupplier({ ...EMPTY_SUPPLIER, ...d.supplier });
          if (d.buyer) setBuyer(d.buyer);
          if (d.date) setDate(d.date);
          if (d.docNo !== undefined) setDocNo(d.docNo);
          if (d.lines?.length) setLines(d.lines);
          if (d.useStamp !== undefined) setUseStamp(d.useStamp);
          setRestored(true);
        }
      } catch { /* 손상된 임시본은 무시 */ }
      setLoading(false);
    })();
  }, []);

  // 작성 중 내용 임시 보관 — 실수로 새로고침해도 날아가지 않게. 저장 기능이 아니다.
  useEffect(() => {
    if (loading) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ supplier, buyer, date, docNo, lines, useStamp })); } catch { /* 용량 초과 등 무시 */ }
  }, [loading, supplier, buyer, date, docNo, lines, useStamp]);

  // 세액 — 발주 명세표와 같은 규칙(과세 라인만 공급가액 10%, 원 단위 반올림)
  const calc = useMemo(() => {
    const rows = lines.map((l) => {
      const supply = Math.round((Number(l.qty) || 0) * (Number(l.price) || 0));
      const vat = l.exempt ? 0 : Math.round(supply * 0.1);
      return { l, supply, vat };
    });
    const subtotal = rows.reduce((s, r) => s + r.supply, 0);
    const vat = rows.reduce((s, r) => s + r.vat, 0);
    return { rows, subtotal, vat, total: subtotal + vat };
  }, [lines]);

  // 출력에 넣을 줄 판정 — 표와 '비었음' 안내가 같은 기준을 써야 한다(따로 두면 빈 행과 안내문이 같이 뜬다).
  //  수량은 기본값이 1이라 단독으로는 '입력했다'로 보지 않는다.
  const hasContent = (l: Line) => !!l.name.trim() || Number(l.price) > 0;
  const filled = lines.filter(hasContent);
  const setLine = (key: string, patch: Partial<Line>) => setLines((p) => p.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function resetAll() {
    if (!window.confirm("작성 중인 내용을 모두 지울까요? (공급자 정보는 설정값으로 되돌립니다)")) return;
    localStorage.removeItem(DRAFT_KEY);
    setBuyer({ name: "", biz_no: "", ceo: "", addr: "" });
    setDate(kstToday()); setDocNo(""); setLines([newLine()]); setRestored(false);
    fetch("/api/b2b/settings/statement", { cache: "no-store" })
      .then((r) => r.json())
      .then((sj) => { if (sj.ok) setSupplier({ ...EMPTY_SUPPLIER, ...(sj.supplier || {}) }); })
      .catch(() => {});
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div>
          <h1 className="b2b-page-title">거래명세표 작성</h1>
          <span style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>발주 없이 직접 채워 인쇄합니다</span>
        </div>
        <div className="b2b-page-actions">
          <Link href="/b2b/orders" className="b2b-btn-secondary">발주 목록</Link>
          <button className="b2b-btn-secondary" onClick={resetAll}>새로 작성</button>
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading}>인쇄 / PDF</button>
        </div>
      </header>

      {restored && (
        <div className="sm-warn no-print">작성 중이던 내용을 불러왔습니다. 처음부터 쓰려면 [새로 작성]을 누르세요.</div>
      )}

      {/* ───── 입력부 (인쇄 제외) ───── */}
      <section className="b2b-card no-print" style={{ marginBottom: 20 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">내용 입력</span></div>

        <div className="b2b-field-row" style={{ marginBottom: 14 }}>
          <label className="b2b-field"><span className="b2b-field-label">거래일자</span>
            <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="b2b-field"><span className="b2b-field-label">문서번호 <span className="sm-faint" style={{ fontWeight: 400 }}>(선택)</span></span>
            <input className="b2b-input" value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="비우면 표시 안 함" /></label>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>공급자 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>(설정값을 불러왔습니다 · 고쳐도 설정은 안 바뀝니다)</span></div>
            <Field label="상호" value={supplier.name} onChange={(v) => setSupplier({ ...supplier, name: v })} />
            <Field label="등록번호" value={supplier.biz_no} onChange={(v) => setSupplier({ ...supplier, biz_no: v })} />
            <Field label="대표" value={supplier.ceo} onChange={(v) => setSupplier({ ...supplier, ceo: v })} />
            <Field label="사업장" value={supplier.addr} onChange={(v) => setSupplier({ ...supplier, addr: v })} />
            <Field label="업태" value={supplier.biz_type} onChange={(v) => setSupplier({ ...supplier, biz_type: v })} />
            <Field label="종목" value={supplier.biz_item} onChange={(v) => setSupplier({ ...supplier, biz_item: v })} />
            <Field label="이메일" value={supplier.email} onChange={(v) => setSupplier({ ...supplier, email: v })} />
            <Field label="입금계좌" value={supplier.bank} onChange={(v) => setSupplier({ ...supplier, bank: v })} placeholder="예: 국민 123-45-6789 (예금주)" />
            {stamp && (
              <label className="sm-row" style={{ gap: 7, marginTop: 8, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" className="b2b-checkbox" checked={useStamp} onChange={(e) => setUseStamp(e.target.checked)} /> 직인 표시
              </label>
            )}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>공급받는자</div>
            <Field label="상호" value={buyer.name} onChange={(v) => setBuyer({ ...buyer, name: v })} />
            <Field label="등록번호" value={buyer.biz_no} onChange={(v) => setBuyer({ ...buyer, biz_no: v })} />
            <Field label="성명" value={buyer.ceo} onChange={(v) => setBuyer({ ...buyer, ceo: v })} />
            <Field label="주소" value={buyer.addr} onChange={(v) => setBuyer({ ...buyer, addr: v })} />
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="sm-between" style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>품목</span>
            <button className="b2b-btn-secondary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setLines((p) => [...p, newLine()])}>+ 품목 추가</button>
          </div>
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>품목</th><th style={{ width: 110 }}>규격</th><th className="num" style={{ width: 90 }}>수량</th><th className="num" style={{ width: 120 }}>단가</th><th style={{ width: 66 }}>면세</th><th className="num" style={{ width: 120 }}>공급가액</th><th style={{ width: 44 }} /></tr></thead>
              <tbody>
                {calc.rows.map(({ l, supply }) => (
                  <tr key={l.key}>
                    <td><input className="b2b-input" value={l.name} onChange={(e) => setLine(l.key, { name: e.target.value })} placeholder="품목명" /></td>
                    <td><input className="b2b-input" value={l.spec} onChange={(e) => setLine(l.key, { spec: e.target.value })} placeholder="규격" /></td>
                    <td><input className="b2b-input" type="number" min={0} step="0.01" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} style={{ textAlign: "right" }} /></td>
                    <td><input className="b2b-input" type="number" min={0} value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} style={{ textAlign: "right" }} placeholder="0" /></td>
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" className="b2b-checkbox" checked={l.exempt} onChange={(e) => setLine(l.key, { exempt: e.target.checked })} title="체크하면 세액 0" />
                    </td>
                    <td className="num b2b-money">{won(supply)}</td>
                    <td style={{ textAlign: "center" }}>
                      {lines.length > 1 && (
                        <button type="button" className="b2b-icon-btn is-danger" aria-label="줄 삭제" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>✕</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>세액은 과세 품목의 공급가액 10%로 자동 계산됩니다. 면세 품목은 체크하세요.</p>
        </div>
      </section>

      {/* ───── 출력부 (발주 명세표와 같은 모양) ───── */}
      <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "30px 34px", maxWidth: 860, boxShadow: "var(--sm-shadow-card)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 10, marginBottom: 14 }}>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: 10 }}>거래명세표</h2>
          <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>
            <div>(공급받는자 보관용)</div>
            <div style={{ marginTop: 4 }}>
              거래일자 <strong style={{ color: "var(--sm-black)" }}>{date || "-"}</strong>
              {docNo.trim() ? <> · No. <strong style={{ color: "var(--sm-black)" }}>{docNo.trim()}</strong></> : null}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginBottom: 16 }}>
          <div style={{ border: "1px solid var(--sm-border)", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sm-text-mid)", marginBottom: 6 }}>공급자</div>
            <InfoRow label="등록번호" value={supplier.biz_no} strong />
            <InfoRow label="상호" value={supplier.name} stampSrc={useStamp && stamp ? stamp : undefined} extraLabel="대표" extra={supplier.ceo} />
            <InfoRow label="사업장" value={supplier.addr} />
            <InfoRow label="업태" value={supplier.biz_type} extraLabel="종목" extra={supplier.biz_item} />
            <InfoRow label="이메일" value={supplier.email} />
          </div>
          <div style={{ border: "1px solid var(--sm-border)", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sm-text-mid)", marginBottom: 6 }}>공급받는자</div>
            <InfoRow label="등록번호" value={buyer.biz_no} strong />
            <InfoRow label="상호" value={buyer.name} extraLabel="성명" extra={buyer.ceo} />
            <InfoRow label="주소" value={buyer.addr} />
          </div>
        </div>

        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead>
              <tr><th style={{ width: 34 }}>No</th><th>품목</th><th>규격</th><th className="num">수량</th><th className="num">단가</th><th className="num">공급가액</th><th className="num">세액</th><th style={{ width: 52 }}>비고</th></tr>
            </thead>
            <tbody>
              {calc.rows.filter(({ l }) => hasContent(l)).map(({ l, supply, vat }, i) => (
                <tr key={l.key}>
                  <td style={{ textAlign: "center", color: "var(--sm-text-mid)" }}>{i + 1}</td>
                  <td>{l.name || "-"}</td>
                  <td>{l.spec || "-"}</td>
                  <td className="num b2b-money">{(Number(l.qty) || 0).toLocaleString()}</td>
                  <td className="num b2b-money">{won(Number(l.price) || 0)}</td>
                  <td className="num b2b-money">{won(supply)}</td>
                  <td className="num b2b-money">{vat > 0 ? won(vat) : "-"}</td>
                  <td style={{ textAlign: "center", fontSize: 12, color: "var(--sm-text-mid)" }}>{l.exempt ? "면세" : ""}</td>
                </tr>
              ))}
              {filled.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--sm-text-light)", padding: "18px 0" }}>위에서 품목을 입력하세요</td></tr>
              )}
              <tr style={{ fontWeight: 800, background: "var(--sm-bg-subtle)" }}>
                <td colSpan={5}>합계</td>
                <td className="num b2b-money">{won(calc.subtotal)}</td>
                <td className="num b2b-money">{won(calc.vat)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "2px solid var(--sm-black)", borderRadius: 8, padding: "12px 16px", marginTop: 14 }}>
          <strong style={{ fontSize: 15 }}>합계금액 (공급가액 + 세액)</strong>
          <strong style={{ fontSize: 22 }}>{won(calc.total)}원</strong>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", border: "1px solid var(--sm-border)", borderRadius: 8, padding: "10px 14px", marginTop: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-text-mid)", flex: "0 0 auto" }}>입금계좌</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{supplier.bank || "-"}</span>
        </div>

        <p style={{ marginTop: 14, fontSize: 12, color: "var(--sm-text-mid)" }}>위와 같이 거래하였음을 확인합니다.</p>
      </section>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
      <span style={{ width: 62, flex: "0 0 auto", fontSize: 12, color: "var(--sm-text-mid)" }}>{label}</span>
      <input className="b2b-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{ flex: 1, minWidth: 0 }} />
    </label>
  );
}

function InfoRow({ label, value, strong, extraLabel, extra, stampSrc }: { label: string; value?: string | null; strong?: boolean; extraLabel?: string; extra?: string | null; stampSrc?: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "3px 0", borderTop: "1px solid var(--sm-border-light)" }}>
      <span style={{ width: 52, flex: "0 0 auto", color: "var(--sm-text-mid)", fontSize: 12 }}>{label}</span>
      <span style={{ fontWeight: strong ? 700 : 500, flex: 1 }}>{value || "-"}</span>
      {stampSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={stampSrc} alt="직인" style={{ width: 46, height: 46, objectFit: "contain", mixBlendMode: "multiply", opacity: 0.9, margin: "-16px 0", flex: "0 0 auto" }} />
      ) : null}
      {extraLabel ? (
        <>
          <span style={{ color: "var(--sm-text-mid)", fontSize: 12, flex: "0 0 auto" }}>{extraLabel}</span>
          <span style={{ fontWeight: 500, flex: "0 0 auto" }}>{extra || "-"}</span>
        </>
      ) : null}
    </div>
  );
}
