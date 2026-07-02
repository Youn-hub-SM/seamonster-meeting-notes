"use client";

import { useState } from "react";

type Row = { order_date: string; channel: string; order_id: string; product_name: string; option_name: string; sku_code: string; quantity: number; subtotal_amount: number };
type Result = {
  ok: boolean; error?: string; mode?: string;
  customer?: { phone: string; name: string | null; first_seen: string; last_seen: string; order_count: number; is_repeat: boolean } | null;
  summary?: { lines: number; orders: number; revenue: number; capped: boolean };
  rows?: Row[];
};

const won = (n: number) => `${(n || 0).toLocaleString()}원`;

export default function SalesSearchPage() {
  const [mode, setMode] = useState<"phone" | "order" | "text">("phone");
  const [phone, setPhone] = useState("");
  const [orderId, setOrderId] = useState("");
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [channel, setChannel] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function currentQuery() {
    const p = new URLSearchParams();
    if (mode === "phone" && phone) p.set("phone", phone);
    if (mode === "order" && orderId) p.set("order_id", orderId);
    if (mode === "text") { if (text) p.set("text", text); if (from) p.set("from", from); if (to) p.set("to", to); if (channel) p.set("channel", channel); }
    return p;
  }

  async function search() {
    setBusy(true); setErr(""); setRes(null);
    try {
      const r = await fetch(`/api/sales/search?${currentQuery().toString()}`);
      const j: Result = await r.json();
      if (!j.ok) setErr(j.error || "검색 실패");
      else setRes(j);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  function exportXlsx() {
    const p = new URLSearchParams();
    if (text) p.set("text", text);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (channel) p.set("channel", channel);
    window.open(`/api/sales/export?${p.toString()}`, "_blank");
  }

  const c = res?.customer, s = res?.summary;
  return (
    <div className="b2b-container" style={{ maxWidth: 920 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">주문 검색</h1>
          <p className="b2b-page-subtitle">전화번호로 구매/재구매 이력을 확인하거나, 주문번호·상품명·기간으로 매출 원장을 조회합니다.</p>
        </div>
      </header>

      <section className="b2b-card">
        <div className="sm-row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {([["phone", "전화번호"], ["order", "주문번호"], ["text", "상품·기간"]] as const).map(([m, label]) => (
            <button key={m} className={mode === m ? "b2b-btn-primary" : "b2b-btn-secondary"} onClick={() => { setMode(m); setRes(null); setErr(""); }}>{label}</button>
          ))}
        </div>

        {mode === "phone" && (
          <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="010-1234-5678" className="b2b-input" style={{ width: 200 }} />
            <button className="b2b-btn-primary" onClick={search} disabled={busy || !phone}>{busy ? "조회 중…" : "구매이력 조회"}</button>
          </div>
        )}
        {mode === "order" && (
          <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input value={orderId} onChange={(e) => setOrderId(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="주문번호(정확히 입력)" className="b2b-input" style={{ width: 260 }} />
            <button className="b2b-btn-primary" onClick={search} disabled={busy || !orderId}>{busy ? "조회 중…" : "조회"}</button>
          </div>
        )}
        {mode === "text" && (
          <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="상품명·SKU·주문번호" className="b2b-input" style={{ minWidth: 200, flex: 1 }} />
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="b2b-input" style={{ width: 150 }} />
            <span className="sm-faint">~</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="b2b-input" style={{ width: 150 }} />
            <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="채널(선택)" className="b2b-input" style={{ width: 130 }} />
            <button className="b2b-btn-primary" onClick={search} disabled={busy}>{busy ? "조회 중…" : "검색"}</button>
            <button className="b2b-btn-secondary" onClick={exportXlsx}>엑셀 추출</button>
          </div>
        )}
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>
          {mode === "phone" ? "전화번호는 저장된 해시로 대조해 구매이력을 찾습니다. 조회 기록은 활동 이력에 남습니다." : mode === "text" ? "엑셀 추출은 현재 검색 조건(상품명·기간·채널) 전체를 내려받습니다. 전화번호·이름은 포함되지 않습니다." : "주문번호 전체가 일치해야 합니다."}
        </p>
      </section>

      {err && <p style={{ color: "var(--sm-danger)", marginTop: 12, whiteSpace: "pre-wrap" }}>⚠️ {err}</p>}

      {c !== undefined && (
        c ? (
          <section className="b2b-card" style={{ marginTop: 12, borderColor: c.is_repeat ? "var(--sm-success)" : "var(--sm-border)" }}>
            <div className="b2b-card-head">
              <span className="b2b-card-title">{c.phone} {c.name ? `· ${c.name}` : ""}</span>
              <span style={{ fontSize: 12, fontWeight: 800, padding: "3px 10px", borderRadius: 999, background: c.is_repeat ? "var(--sm-success)" : "var(--sm-surface-2,#eef6f8)", color: c.is_repeat ? "#fff" : "var(--sm-faint)" }}>{c.is_repeat ? "재구매 고객" : "신규 고객"}</span>
            </div>
            <p style={{ fontSize: 14 }}>누적 주문 <strong>{c.order_count}</strong>건 · 첫 구매 {c.first_seen} · 최근 구매 {c.last_seen}</p>
          </section>
        ) : res?.mode === "phone" ? (
          <section className="b2b-card" style={{ marginTop: 12 }}><p style={{ fontSize: 14 }}>해당 전화번호의 구매이력이 없습니다. <span className="sm-faint">(신규 또는 다른 번호)</span></p></section>
        ) : null
      )}

      {s && (
        <section className="b2b-card" style={{ marginTop: 12 }}>
          <div className="b2b-card-head">
            <span className="b2b-card-title">결과 · 주문 {s.orders}건 / 라인 {s.lines}건 · 합계 {won(s.revenue)}</span>
          </div>
          {s.capped && <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>※ 상위 {s.lines}건만 표시됩니다. 전체는 엑셀 추출을 이용하세요.</p>}
          {res?.rows && res.rows.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table className="b2b-table" style={{ fontSize: 12.5 }}>
                <thead><tr><th>주문일</th><th>채널</th><th>주문번호</th><th>상품</th><th>옵션</th><th>SKU</th><th style={{ textAlign: "right" }}>수량</th><th style={{ textAlign: "right" }}>금액</th></tr></thead>
                <tbody>
                  {res.rows.map((r, i) => (
                    <tr key={i}><td>{r.order_date}</td><td>{r.channel}</td><td>{r.order_id}</td><td>{r.product_name}</td><td>{r.option_name}</td><td>{r.sku_code}</td><td style={{ textAlign: "right" }}>{r.quantity}</td><td style={{ textAlign: "right" }}>{won(r.subtotal_amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p style={{ fontSize: 14 }}>결과가 없습니다.</p>}
        </section>
      )}
    </div>
  );
}
