"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Combobox } from "@/app/b2b/orders/Combobox";

type Prod = { id: string; sku: string | null; name: string; spec: string | null };
type Move = { group_id: string; product_name: string; sku: string | null; qty: number; from: string; to: string; txn_date: string; memo: string | null; created_by: string | null; created_at: string; complete: boolean };

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export default function InventoryMovePage() {
  const [products, setProducts] = useState<Prod[]>([]);
  const [retail, setRetail] = useState<Map<string, number>>(new Map());
  const [whole, setWhole] = useState<Map<string, number>>(new Map());
  const [moves, setMoves] = useState<Move[]>([]);

  const [pid, setPid] = useState("");
  const [plabel, setPlabel] = useState("");
  const [dir, setDir] = useState<{ from: "소매" | "도매"; to: "소매" | "도매" }>({ from: "소매", to: "도매" });
  const [qty, setQty] = useState("");
  const [date, setDate] = useState(kstToday());
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const loadStock = useCallback(async () => {
    const [r, w, m] = await Promise.all([
      fetch("/api/inventory?channel=소매", { cache: "no-store" }).then((x) => x.json()).catch(() => null),
      fetch("/api/inventory?channel=도매", { cache: "no-store" }).then((x) => x.json()).catch(() => null),
      fetch("/api/inventory/move?limit=50", { cache: "no-store" }).then((x) => x.json()).catch(() => null),
    ]);
    if (r?.ok) setRetail(new Map((r.rows || []).map((x: { product_id: string; qty: number }) => [x.product_id, x.qty])));
    if (w?.ok) setWhole(new Map((w.rows || []).map((x: { product_id: string; qty: number }) => [x.product_id, x.qty])));
    if (m?.ok) setMoves(m.moves || []);
  }, []);
  useEffect(() => {
    fetch("/api/products", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) setProducts(j.products || []); }).catch(() => {});
    loadStock();
  }, [loadStock]);

  const fromQty = pid ? (dir.from === "소매" ? retail.get(pid) : whole.get(pid)) ?? 0 : 0;
  const toQty = pid ? (dir.to === "소매" ? retail.get(pid) : whole.get(pid)) ?? 0 : 0;
  const nQty = Math.max(0, Math.round(Number(qty) || 0));
  const shortage = pid && nQty > 0 && nQty > fromQty;

  const options = useMemo(() => products.map((p) => ({ id: p.id, label: p.spec ? `${p.name} | ${p.spec}` : p.name, sub: p.sku || "" })), [products]);

  async function submit() {
    setError(""); setOk("");
    if (!pid) { setError("품목을 선택하세요."); return; }
    if (nQty <= 0) { setError("옮길 수량을 입력하세요."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/inventory/move", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: pid, from: dir.from, to: dir.to, qty: nQty, txn_date: date, memo }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "이동 실패");
      setOk(`${plabel || "품목"} ${nQty}개를 ${dir.from} → ${dir.to} 로 옮겼어요.`);
      setQty(""); setMemo("");
      await loadStock();
    } catch (e) { setError(e instanceof Error ? e.message : "이동 실패"); }
    setBusy(false);
  }

  async function cancelMove(group_id: string) {
    if (!window.confirm("이 이동을 취소할까요? 양쪽 채널 재고가 원래대로 돌아갑니다.")) return;
    await fetch(`/api/inventory/move?group_id=${encodeURIComponent(group_id)}`, { method: "DELETE" });
    await loadStock();
  }

  const swap = () => setDir((d) => ({ from: d.to, to: d.from }));

  return (
    <div className="b2b-container" style={{ maxWidth: 760 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고 옮기기 (소매 ↔ 도매)</h1>
          <p className="b2b-page-subtitle">
            소매용으로 만든 제품을 도매로, 또는 그 반대로 <strong>재고를 옮깁니다</strong>. 한쪽에서 빼고 다른 쪽에 더하는 걸 한 번에 처리해요.
          </p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {ok && <div className="prod-sku-ok" style={{ fontSize: 13, marginBottom: 12 }}>✓ {ok}</div>}

      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-field">
          <label className="b2b-field-label">품목</label>
          <Combobox value={plabel} options={options}
            onSelect={(o) => { setPid(o.id); setPlabel(o.label); }}
            placeholder="제품 검색 — 이름 또는 SKU" ariaLabel="품목" />
        </div>

        {pid && (
          <div className="sm-row" style={{ gap: 14, margin: "10px 0 4px", fontSize: 13, flexWrap: "wrap" }}>
            <span>지금 재고 —</span>
            <span className="b2b-feed-pill" style={{ background: "var(--sm-info-bg)", color: "var(--sm-info)", fontWeight: 700 }}>소매 {(retail.get(pid) ?? 0).toLocaleString()}</span>
            <span className="b2b-feed-pill" style={{ background: "var(--sm-orange-light)", color: "var(--sm-orange)", fontWeight: 700 }}>도매 {(whole.get(pid) ?? 0).toLocaleString()}</span>
          </div>
        )}

        <div className="b2b-field" style={{ marginTop: 12 }}>
          <label className="b2b-field-label">어디로 옮길까요?</label>
          <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div className="sm-tabs" style={{ margin: 0 }}>
              <button className={`sm-tab ${dir.from === "소매" ? "is-active" : ""}`} onClick={() => setDir({ from: "소매", to: "도매" })}>소매 → 도매</button>
              <button className={`sm-tab ${dir.from === "도매" ? "is-active" : ""}`} onClick={() => setDir({ from: "도매", to: "소매" })}>도매 → 소매</button>
            </div>
            <button className="b2b-btn-secondary" onClick={swap} style={{ padding: "6px 10px", fontSize: 12 }} title="방향 뒤집기">⇄</button>
            <span className="sm-faint" style={{ fontSize: 12 }}>{dir.from} 재고에서 빼고 → {dir.to} 재고에 더함</span>
          </div>
        </div>

        <div className="b2b-field-row" style={{ marginTop: 12 }}>
          <div className="b2b-field">
            <label className="b2b-field-label">옮길 수량</label>
            <input className="b2b-input b2b-money" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
            {shortage && <span style={{ fontSize: 12, color: "var(--sm-danger)" }}>{dir.from} 재고({fromQty.toLocaleString()})보다 많아요. 그래도 옮기면 {dir.from}가 마이너스가 됩니다.</span>}
          </div>
          <div className="b2b-field">
            <label className="b2b-field-label">옮긴 날짜</label>
            <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="b2b-field" style={{ marginTop: 12 }}>
          <label className="b2b-field-label">메모 <span className="sm-faint" style={{ fontWeight: 400 }}>(선택)</span></label>
          <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 도매 주문 대응" />
        </div>

        {pid && nQty > 0 && (
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 10 }}>
            옮긴 뒤 예상 재고 — {dir.from} {(fromQty - nQty).toLocaleString()} · {dir.to} {(toQty + nQty).toLocaleString()}
          </p>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button className="b2b-btn-primary" onClick={submit} disabled={busy || !pid || nQty <= 0}>{busy ? "옮기는 중…" : "옮기기"}</button>
        </div>
      </section>

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">최근 옮긴 내역 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· {moves.length}건</span></span></div>
        {moves.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 20 }}>아직 옮긴 내역이 없습니다.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>날짜</th><th>품목</th><th className="num">수량</th><th>방향</th><th>담당</th><th></th></tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.group_id}>
                    <td style={{ whiteSpace: "nowrap" }}>{m.txn_date}</td>
                    <td><strong>{m.product_name}</strong>{m.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{m.sku}</span> : null}{m.memo ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>· {m.memo}</span> : null}</td>
                    <td className="num b2b-money" style={{ fontWeight: 700 }}>{m.qty.toLocaleString()}</td>
                    <td><span className="b2b-feed-pill" style={{ background: "var(--sm-bg)", color: "var(--sm-text-mid)", fontWeight: 700, fontSize: 11 }}>{m.from} → {m.to}</span>{!m.complete && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--sm-danger)" }}>불완전</span>}</td>
                    <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{m.created_by || "-"}</td>
                    <td><button className="b2b-link-btn" onClick={() => cancelMove(m.group_id)} style={{ color: "var(--sm-danger)" }}>취소</button></td>
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
