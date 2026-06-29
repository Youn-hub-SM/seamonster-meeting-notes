"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventoryTxn } from "@/app/lib/inventory";

const THIS_MONTH = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
function monthRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${ym}-01`;
  const to = new Date(y, m, 0).toISOString().slice(0, 10); // 말일
  return { from, to };
}

export default function QuotePage() {
  const [ym, setYm] = useState(THIS_MONTH());
  const [txns, setTxns] = useState<InventoryTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (m: string) => {
    setLoading(true); setError("");
    try {
      const { from, to } = monthRange(m);
      const j = await (await fetch(`/api/inventory/txns?type=입고&from=${from}&to=${to}&limit=2000`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setTxns(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(ym); }, [load, ym]);

  // 매입처 → 품목 집계
  const groups = useMemo(() => {
    const byPartner = new Map<string, Map<string, { name: string; qty: number; amount: number }>>();
    for (const t of txns) {
      const partner = t.partner || "(미지정)";
      const amount = (t.unit_amount || 0) * Math.abs(t.qty);
      const pm = byPartner.get(partner) || new Map();
      const key = t.product_id;
      const cur = pm.get(key) || { name: t.product_name || "", qty: 0, amount: 0 };
      cur.qty += Math.abs(t.qty); cur.amount += amount;
      pm.set(key, cur); byPartner.set(partner, pm);
    }
    return [...byPartner.entries()].map(([partner, pm]) => {
      const items = [...pm.values()].sort((a, b) => b.amount - a.amount);
      return { partner, items, qty: items.reduce((s, i) => s + i.qty, 0), amount: items.reduce((s, i) => s + i.amount, 0) };
    }).sort((a, b) => b.amount - a.amount);
  }, [txns]);
  const grand = useMemo(() => groups.reduce((s, g) => s + g.amount, 0), [groups]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div><h1 className="b2b-page-title">월간 매입 견적서</h1><p className="b2b-page-subtitle">선택한 달의 입고(매입)를 매입처·품목별로 정리합니다. 인쇄/PDF 로 저장하세요.</p></div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || txns.length === 0}>🖨 인쇄 / PDF</button>
        </div>
      </header>
      {error && <div className="b2b-error no-print">{error}</div>}

      <div className="no-print" style={{ marginBottom: 16 }}>
        <input className="b2b-input" type="month" value={ym} max={THIS_MONTH()} onChange={(e) => setYm(e.target.value)} style={{ width: "auto" }} />
      </div>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : txns.length === 0 ? (
        <div className="b2b-empty"><div className="b2b-empty-icon">🧾</div>{ym} 매입 내역이 없습니다.</div>
      ) : (
        <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "30px 32px", maxWidth: 820, boxShadow: "var(--sm-shadow-card)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 18 }}>
            <div><div style={{ fontSize: 13, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div><h2 style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>월간 매입 정리</h2></div>
            <div style={{ textAlign: "right", fontSize: 13, color: "var(--sm-text-mid)" }}>대상 월 · {ym}<div style={{ fontSize: 20, fontWeight: 800, color: "var(--sm-black)", marginTop: 4 }}>총 {grand.toLocaleString()}원</div></div>
          </div>
          {groups.map((g) => (
            <div key={g.partner} style={{ marginBottom: 18 }}>
              <div className="sm-between" style={{ marginBottom: 6 }}>
                <strong style={{ fontSize: 15 }}>{g.partner}</strong>
                <strong className="b2b-money">{g.amount.toLocaleString()}원</strong>
              </div>
              <table className="b2b-table">
                <thead><tr><th>품목</th><th className="num">수량</th><th className="num">금액</th></tr></thead>
                <tbody>
                  {g.items.map((it, i) => (
                    <tr key={i}><td>{it.name}</td><td className="num b2b-money">{it.qty.toLocaleString()}</td><td className="num b2b-money">{it.amount.toLocaleString()}</td></tr>
                  ))}
                  <tr style={{ fontWeight: 800, background: "var(--sm-bg-subtle)" }}><td>소계</td><td className="num">{g.qty.toLocaleString()}</td><td className="num">{g.amount.toLocaleString()}</td></tr>
                </tbody>
              </table>
            </div>
          ))}
          <div className="sm-between" style={{ borderTop: "2px solid var(--sm-black)", paddingTop: 10, fontSize: 17, fontWeight: 800 }}>
            <span>합계</span><span className="b2b-money">{grand.toLocaleString()}원</span>
          </div>
          <p className="sm-faint" style={{ fontSize: 11, marginTop: 12 }}>※ 금액 = 입고 단가 × 수량. 단가 미입력 건은 0원으로 집계됩니다.</p>
        </section>
      )}
    </div>
  );
}
