"use client";

// 취소·반품 처리(온라인 발주 › 취소·반품, 2026-11-20 대표 지시) — 주문번호로 주문을 찾아 상품을 수량 단위로 취소한다.
//  한 번 처리로 세 가지를 맞춘다: ① 매출에서 빼기(항상) ② 배송일지에서 박스 빼기(선택) ③ 재고에 돌려놓기(선택).
//  ①은 서버가 한 트랜잭션으로 반영한다(/api/fulfill/cancel → migration 175). ②③은 이 화면이 기존 저장 경로로 이어서 기록한다 —
//  배송일지 직접수정(/api/fulfill/log), 입고 사유 '고객 반품'(/api/inventory/txn — 세트 전개·요청 키 규칙 그대로).
//  ②③이 끝나지 않았으면 기록 줄에 '남음'이 보이고 [이어서 처리]로 마저 한다(같은 id·요청 키라 두 번 기록되지 않는다).
//  [되돌리기] = 매출 복구 + 박스 보정·재고 입고 지우기.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { qty, won, dateTime } from "@/app/lib/format";

type Line = { row_hash: string; channel: string; order_date: string; product_name: string; option_name: string; sku_code: string; quantity: number; subtotal_amount: number; cancelled_qty: number; product_id: string | null; product_label: string | null; stock_tracked: boolean };
type Order = { channel: string; order_id: string; order_date: string; customer: string; lines: Line[]; gone: { product_name: string; option_name: string; qty: number }[] };
type Box = { date: string; side: "n" | "g"; category: string; qty: number; entry_id?: string | null; done?: boolean };
type Stock = { product_id: string; name: string; qty: number; request_key: string; txn_ids?: string[]; done?: boolean };
type Rec = {
  id: number; kind: string; channel: string; order_id: string; order_date: string | null; note: string | null; cancel_qty: number; cancel_amount: number;
  box: Box | null; stock: Stock[] | null; status: "active" | "reverted"; created_by: string | null; created_at: string; reverted_by: string | null; reverted_at: string | null;
  lines: { product_name: string | null; option_name: string | null; sku_code: string | null; cancel_qty: number; cancel_amount: number }[];
};
type Pick = { qty: string; amount: string; touched: boolean }; // 줄마다 취소 수량·금액(금액은 손대기 전까지 수량에 비례)

const digits = (s: string) => s.replace(/[^0-9]/g, "");
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const api = async (body: unknown) => {
  const res = await fetch("/api/fulfill/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || "처리하지 못했습니다.");
  return j;
};
const sideLabel = (s: "n" | "g") => (s === "g" ? "도착보장" : "일반");
// 남은 일 — 반영된 기록은 박스·재고가 기록돼 있어야 하고, 되돌린 기록은 지워져 있어야 한다
const pending = (r: Rec) => {
  const want = r.status === "active";
  return { box: !!r.box && !!r.box.done !== want, stock: (r.stock || []).filter((s) => !!s.done !== want).length };
};

export default function OrderCancelPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [records, setRecords] = useState<Rec[]>([]);
  const [boxCats, setBoxCats] = useState<string[]>([]);
  const [ready, setReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [chosen, setChosen] = useState(0);                 // 같은 주문번호가 여러 채널에 있을 때 고른 것
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [kind, setKind] = useState<"취소" | "반품">("취소");
  const [note, setNote] = useState("");
  const [boxOn, setBoxOn] = useState(false);
  const [box, setBox] = useState<{ date: string; side: "n" | "g"; category: string; qty: string }>({ date: kstToday(), side: "n", category: "", qty: "1" });
  const [stockOn, setStockOn] = useState(false);
  const [stockQty, setStockQty] = useState<Record<string, string>>({}); // 품목마다 돌려놓을 수량(손대면 여기, 아니면 취소 수량)
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "find" | "apply" | "settle">("");
  const requestKey = useRef("");

  const load = useCallback(async () => {
    try {
      const j = await (await fetch("/api/fulfill/cancel", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      setRecords(j.records || []); setReady(j.ready !== false); setLoadError("");
      const cats: string[] = j.boxCats || [];
      setBoxCats(cats); setBox((b) => (b.category || !cats.length ? b : { ...b, category: cats[0] }));
    } catch (e) { setLoadError(e instanceof Error ? e.message : "취소·반품 기록을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const order = orders?.[chosen] || null;
  const resetForm = () => { setPicks({}); setNote(""); setBoxOn(false); setStockOn(false); setStockQty({}); setBox((b) => ({ ...b, date: kstToday(), qty: "1" })); requestKey.current = crypto.randomUUID(); };

  const find = async () => {
    setError("");
    if (!query.trim()) { setError("주문번호를 입력하세요."); return; }
    setBusy("find");
    try {
      const j = await (await fetch(`/api/fulfill/cancel?order=${encodeURIComponent(query.trim())}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      setOrders(j.orders || []); setChosen(0); resetForm();
    } catch (e) { setOrders(null); setError(e instanceof Error ? e.message : "주문을 찾지 못했습니다."); }
    finally { setBusy(""); }
  };

  const setPickQty = (l: Line, v: string) => setPicks((p) => {
    const n = Math.min(Number(digits(v)) || 0, l.quantity);
    const cur = p[l.row_hash];
    const auto = n >= l.quantity ? l.subtotal_amount : Math.round((l.subtotal_amount * n) / l.quantity);
    return { ...p, [l.row_hash]: { qty: n ? String(n) : "", amount: cur?.touched && n < l.quantity ? cur.amount : String(auto), touched: !!cur?.touched && n < l.quantity } };
  });
  const setPickAmount = (l: Line, v: string) => setPicks((p) => ({ ...p, [l.row_hash]: { qty: p[l.row_hash]?.qty || "", amount: digits(v), touched: true } }));

  // 고른 줄 — 수량 > 0
  const selected = useMemo(() => (order?.lines || []).map((l) => ({ l, n: Number(picks[l.row_hash]?.qty) || 0, amount: Number(picks[l.row_hash]?.amount) || 0 })).filter((x) => x.n > 0), [order, picks]);
  const totalQty = selected.reduce((a, x) => a + x.n, 0);
  const totalAmount = selected.reduce((a, x) => a + (x.n >= x.l.quantity ? x.l.subtotal_amount : x.amount), 0);
  // 재고에 돌려놓을 품목 — 고른 줄을 상품 마스터 품목으로 묶는다. 상품 마스터에 없거나 재고를 관리하지 않는 코드는 따로 알린다.
  const stockRows = useMemo(() => {
    const by = new Map<string, { product_id: string; name: string; max: number }>();
    for (const x of selected) if (x.l.product_id && x.l.stock_tracked) {
      const c = by.get(x.l.product_id) || { product_id: x.l.product_id, name: x.l.product_label || x.l.product_name, max: 0 };
      c.max += x.n; by.set(x.l.product_id, c);
    }
    return [...by.values()];
  }, [selected]);
  const noStock = selected.filter((x) => !x.l.product_id || !x.l.stock_tracked);
  const stockOf = (r: { product_id: string; max: number }) => (stockQty[r.product_id] !== undefined ? Number(stockQty[r.product_id]) || 0 : r.max);

  // 박스·재고 단계를 기록 상태에 맞춘다 — 반영된 기록이면 기록하고, 되돌린 기록이면 지운다. 끝난 단계는 건너뛴다.
  const settle = async (rec: Rec): Promise<Rec> => {
    let cur = rec;
    const want = rec.status === "active";
    const memo = `${rec.kind} 처리 · ${rec.channel} ${rec.order_id}`;
    if (cur.box && !!cur.box.done !== want) {
      const b = cur.box;
      const body = want ? { log_date: b.date, add_entry: { id: b.entry_id, side: b.side, category: b.category, qty: -Math.abs(b.qty), note: memo } } : { log_date: b.date, del_entry: { id: b.entry_id } };
      const j = await (await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      if (!j.ok) throw new Error(`배송일지: ${j.error || "기록하지 못했습니다."}`);
      cur = (await api({ action: "mark", id: cur.id, box: { done: want } })).record;
    }
    for (const s of cur.stock || []) {
      if (!!s.done === want) continue;
      let ids = s.txn_ids || [];
      if (want) {
        const j = await (await fetch("/api/inventory/txn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id: s.product_id, type: "입고", qty: s.qty, channel: "소매", reason: "고객 반품", memo, done: true, request_key: s.request_key }) })).json();
        if (!j.ok) throw new Error(`재고(${s.name}): ${j.error || "기록하지 못했습니다."}`);
        ids = ((j.txns || (j.txn ? [j.txn] : [])) as { id: string }[]).map((t) => String(t.id));
      } else {
        for (const id of ids) {
          const res = await fetch(`/api/inventory/txn?id=${encodeURIComponent(id)}`, { method: "DELETE" });
          const j = await res.json().catch(() => ({}));
          if (!j.ok && res.status !== 404) throw new Error(`재고(${s.name}): ${j.error || "입고 기록을 지우지 못했습니다."}`);
        }
        ids = [];
      }
      cur = (await api({ action: "mark", id: cur.id, stock: [{ request_key: s.request_key, txn_ids: ids, done: want }] })).record;
    }
    return cur;
  };

  const apply = async () => {
    if (!order) return;
    setError("");
    if (!selected.length) { setError("취소할 상품의 수량을 넣으세요."); return; }
    const badAmount = selected.find((x) => x.n < x.l.quantity && x.amount > x.l.subtotal_amount);
    if (badAmount) { setError(`취소 금액이 남은 금액보다 큽니다 — ${badAmount.l.product_name}`); return; }
    const boxQty = Number(box.qty) || 0;
    if (boxOn && (!box.category || !boxQty || !box.date)) { setError("뺄 박스의 날짜·종류·수량을 넣으세요."); return; }
    const stock = stockOn ? stockRows.map((r) => ({ product_id: r.product_id, name: r.name, qty: stockOf(r) })).filter((s) => s.qty > 0) : [];
    const parts = [`${kind}: ${order.channel} ${order.order_id}`, `매출에서 빼기 — 상품 ${qty(totalQty)}개 · ${won(totalAmount)}원`];
    if (boxOn) parts.push(`배송일지(${box.date}) — ${sideLabel(box.side)} ${box.category} ${qty(boxQty)}박스 빼기`);
    if (stock.length) parts.push(`재고에 돌려놓기 — ${stock.map((s) => `${s.name} ${qty(s.qty)}개`).join(", ")}`);
    if (!(await confirm({ title: `${kind} 처리`, body: parts.join("\n"), action: `${kind} 처리`, danger: true }))) return;
    setBusy("apply");
    let rec: Rec | null = null;
    try {
      rec = (await api({
        action: "apply", requestKey: requestKey.current, kind, channel: order.channel, orderId: order.order_id, note,
        lines: selected.map((x) => ({ row_hash: x.l.row_hash, qty: x.n, amount: x.n >= x.l.quantity ? x.l.subtotal_amount : x.amount })),
        box: boxOn ? { date: box.date, side: box.side, category: box.category, qty: boxQty } : null, stock,
      })).record as Rec;
      await settle(rec);
      toast.success(`${kind} 처리했습니다 — ${qty(rec.cancel_qty)}개 · ${won(rec.cancel_amount)}원`);
      setOrders(null); setQuery("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "처리하지 못했습니다.";
      // 매출은 반영됐는데 박스·재고에서 멈춘 경우 — 기록 줄의 [이어서 처리]로 마저 한다
      if (rec) { toast.error(`매출은 반영했습니다. ${msg} — 아래 기록에서 [이어서 처리]를 누르세요.`); setOrders(null); }
      else setError(msg);
    } finally { setBusy(""); load(); }
  };

  const resume = async (r: Rec) => {
    setBusy("settle");
    try { await settle(r); toast.success("남은 처리를 마쳤습니다"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "처리하지 못했습니다."); }
    finally { setBusy(""); load(); }
  };
  const revert = async (r: Rec) => {
    const extra = [r.box?.done ? "배송일지의 박스 보정" : "", (r.stock || []).some((s) => s.done) ? "재고 입고 기록" : ""].filter(Boolean);
    if (!(await confirm({ title: `${r.kind} 되돌리기`, body: `${r.channel} ${r.order_id} — 뺐던 ${qty(r.cancel_qty)}개 · ${won(r.cancel_amount)}원을 매출에 되돌립니다.${extra.length ? `\n${extra.join("과 ")}도 함께 지웁니다.` : ""}`, action: "되돌리기" }))) return;
    setBusy("settle");
    try {
      const j = await api({ action: "revert", id: r.id });
      await settle(j.record as Rec);
      if (j.missing) toast.error(`되돌렸습니다. 다만 매출 줄 ${qty(j.missing)}개는 업로드로 이미 바뀌어 되살리지 않았습니다 — 매출을 확인하세요.`);
      else toast.success("되돌렸습니다");
    } catch (e) { toast.error(e instanceof Error ? e.message : "되돌리지 못했습니다."); }
    finally { setBusy(""); load(); }
  };

  return (
    <div className="b2b-container">
      <div className="b2b-page-head"><h1 className="b2b-page-title">취소·반품</h1></div>
      {loadError && <div className="b2b-error">{loadError}</div>}
      {!ready && <div className="sm-warn">취소 장부가 없습니다 — migration 175 를 먼저 적용하세요.</div>}

      <section className="b2b-form-section">
        {error && <div className="b2b-error" style={{ marginBottom: "var(--sm-space-4)" }}>{error}</div>}
        <form className="oc-find" onSubmit={(e) => { e.preventDefault(); find(); }}>
          <div className="b2b-field oc-find-field">
            <span className="b2b-field-label">주문번호</span>
            <input className="b2b-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="채널 주문번호" aria-label="주문번호" />
          </div>
          <button type="submit" className="b2b-btn-primary" disabled={!!busy}>{busy === "find" ? "찾는 중" : "주문 찾기"}</button>
        </form>

        {orders && orders.length === 0 && <div className="b2b-empty">그 주문번호의 소매 매출이 없습니다.</div>}
        {orders && orders.length > 1 && (
          <div className="sm-tabs oc-gap" role="group" aria-label="채널">
            {orders.map((o, i) => <button key={o.channel} type="button" className={`sm-tab ${i === chosen ? "is-active" : ""}`} aria-pressed={i === chosen} onClick={() => { setChosen(i); resetForm(); }}>{o.channel}</button>)}
          </div>
        )}

        {order && (
          <>
            <div className="oc-order">
              <span className="oc-order-id">{order.channel} {order.order_id}</span>
              <span className="oc-order-sub">{[order.order_date && `주문일 ${order.order_date}`, order.customer && `고객 ${order.customer}`].filter(Boolean).join(" · ")}</span>
            </div>
            {order.gone.length > 0 && <div className="sm-warn oc-gap">이미 전부 취소한 상품: {order.gone.map((g) => `${g.product_name}${g.option_name ? ` (${g.option_name})` : ""} ${qty(g.qty)}개`).join(", ")}</div>}
            {order.lines.length === 0 ? <div className="b2b-empty">남은 상품이 없습니다.</div> : (
              <div className="b2b-table-wrap">
                <table className="b2b-table oc-lines">
                  <thead><tr><th>상품</th><th>상품코드</th><th className="num">남은 수량</th><th className="num">남은 금액</th><th className="num">취소 수량</th><th className="num">취소 금액</th></tr></thead>
                  <tbody>
                    {order.lines.map((l) => {
                      const p = picks[l.row_hash]; const n = Number(p?.qty) || 0;
                      return (
                        <tr key={l.row_hash}>
                          <td className="oc-name">{l.product_name}{l.option_name ? <span className="oc-opt"> {l.option_name}</span> : null}{l.cancelled_qty > 0 ? <span className="oc-opt"> · 이미 {qty(l.cancelled_qty)}개 취소</span> : null}</td>
                          <td className="oc-code">{l.sku_code || "-"}</td>
                          <td className="num">{qty(l.quantity)}개</td>
                          <td className="num">{won(l.subtotal_amount)}원</td>
                          <td className="num"><input className="b2b-input oc-num" inputMode="numeric" value={p?.qty || ""} onChange={(e) => setPickQty(l, e.target.value)} placeholder="0" aria-label={`${l.product_name} 취소 수량`} /></td>
                          <td className="num"><input className="b2b-input oc-amount" inputMode="numeric" value={n ? Number(n >= l.quantity ? l.subtotal_amount : p?.amount || 0).toLocaleString("ko-KR") : ""} onChange={(e) => setPickAmount(l, e.target.value)} disabled={!n || n >= l.quantity} placeholder="0" aria-label={`${l.product_name} 취소 금액`} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {order.lines.length > 0 && (
              <div className="oc-form">
                <div className="b2b-field">
                  <span className="b2b-field-label">구분</span>
                  <div className="sm-tabs" role="group" aria-label="구분">
                    {(["취소", "반품"] as const).map((k) => <button key={k} type="button" className={`sm-tab ${kind === k ? "is-active" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{k}</button>)}
                  </div>
                </div>
                <div className="b2b-field">
                  <span className="b2b-field-label">메모</span>
                  <input className="b2b-input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} aria-label="메모" />
                </div>
                <div className="b2b-field oc-wide">
                  <span className="b2b-field-label">배송일지</span>
                  <div className="oc-row">
                    <div className="sm-tabs" role="group" aria-label="배송일지 박스">
                      <button type="button" className={`sm-tab ${!boxOn ? "is-active" : ""}`} aria-pressed={!boxOn} onClick={() => setBoxOn(false)}>빼지 않음</button>
                      <button type="button" className={`sm-tab ${boxOn ? "is-active" : ""}`} aria-pressed={boxOn} onClick={() => setBoxOn(true)}>박스 빼기</button>
                    </div>
                    {boxOn && (<>
                      <input type="date" className="b2b-input oc-date" value={box.date} max={kstToday()} onChange={(e) => setBox((b) => ({ ...b, date: e.target.value }))} aria-label="배송일지 날짜" />
                      <div className="sm-tabs" role="group" aria-label="배송 구분">
                        {(["n", "g"] as const).map((s) => <button key={s} type="button" className={`sm-tab ${box.side === s ? "is-active" : ""}`} aria-pressed={box.side === s} onClick={() => setBox((b) => ({ ...b, side: s }))}>{sideLabel(s)}</button>)}
                      </div>
                      <select className="b2b-select oc-cat" value={box.category} onChange={(e) => setBox((b) => ({ ...b, category: e.target.value }))} aria-label="박스 종류">
                        {boxCats.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input className="b2b-input oc-num" inputMode="numeric" value={box.qty} onChange={(e) => setBox((b) => ({ ...b, qty: digits(e.target.value) }))} aria-label="뺄 박스 수" />
                      <span>박스</span>
                    </>)}
                  </div>
                </div>
                <div className="b2b-field oc-wide">
                  <span className="b2b-field-label">재고</span>
                  <div className="oc-row">
                    <div className="sm-tabs" role="group" aria-label="재고">
                      <button type="button" className={`sm-tab ${!stockOn ? "is-active" : ""}`} aria-pressed={!stockOn} onClick={() => setStockOn(false)}>돌려놓지 않음</button>
                      <button type="button" className={`sm-tab ${stockOn ? "is-active" : ""}`} aria-pressed={stockOn} onClick={() => setStockOn(true)}>재고에 돌려놓기</button>
                    </div>
                  </div>
                  {stockOn && stockRows.map((r) => (
                    <div className="oc-row oc-stock" key={r.product_id}>
                      <span className="oc-stock-name">{r.name}</span>
                      <input className="b2b-input oc-num" inputMode="numeric" value={stockQty[r.product_id] !== undefined ? stockQty[r.product_id] : String(r.max)} onChange={(e) => setStockQty((q) => ({ ...q, [r.product_id]: digits(e.target.value) }))} aria-label={`${r.name} 돌려놓을 수량`} />
                      <span>개</span>
                    </div>
                  ))}
                  {stockOn && selected.length === 0 && <div className="oc-order-sub">취소 수량을 넣으면 돌려놓을 품목이 나옵니다.</div>}
                  {stockOn && noStock.length > 0 && <div className="sm-warn">재고에 넣지 못하는 상품(상품 마스터에 없는 코드이거나 재고를 관리하지 않는 품목): {noStock.map((x) => x.l.product_name).join(", ")}</div>}
                </div>
                <div className="oc-actions oc-wide">
                  <span className="oc-total">{selected.length ? `상품 ${qty(totalQty)}개 · ${won(totalAmount)}원` : ""}</span>
                  <button type="button" className="b2b-btn-danger" onClick={apply} disabled={!!busy || !ready || !selected.length}>{busy === "apply" ? "처리 중" : `${kind} 처리`}</button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <div className="b2b-card" style={{ marginTop: "var(--sm-space-5)" }}>
        <div className="b2b-card-head"><span className="b2b-card-title">취소·반품 기록</span></div>
        {loading ? <div className="b2b-loading">불러오는 중...</div>
          : records.length === 0 ? <div className="b2b-empty">취소·반품 기록이 없습니다.</div>
          : (
            <div className="b2b-table-wrap">
              <table className="b2b-table oc-history">
                <thead><tr><th>시각</th><th>누가</th><th>구분</th><th>주문</th><th>상품</th><th className="num">수량</th><th className="num">금액</th><th>배송일지</th><th>재고</th><th></th></tr></thead>
                <tbody>
                  {records.map((r) => {
                    const pd = pending(r); const left = pd.box || pd.stock > 0; const active = r.status === "active";
                    return (
                      <tr key={r.id}>
                        <td className="sm-nowrap">{dateTime(r.created_at)}</td>
                        <td className="sm-nowrap">{r.created_by || "-"}</td>
                        <td><span className="b2b-status-pill" style={active ? { background: "var(--sm-black)", color: "var(--sm-white)" } : { background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{active ? r.kind : `${r.kind} 되돌림`}</span></td>
                        <td className="sm-nowrap">{r.channel} {r.order_id}</td>
                        <td className="oc-name">{r.lines.map((l) => `${l.product_name || ""}${l.option_name ? ` (${l.option_name})` : ""} ${qty(l.cancel_qty)}개`).join(", ")}{r.note ? <div className="oc-opt">{r.note}</div> : null}</td>
                        <td className="num">{qty(r.cancel_qty)}개</td>
                        <td className="num">{won(r.cancel_amount)}원</td>
                        <td className="sm-nowrap">{r.box ? `${r.box.date.slice(5)} ${sideLabel(r.box.side)} ${r.box.category} ${qty(r.box.qty)}박스${pd.box ? " · 남음" : r.box.done ? "" : " · 지움"}` : "-"}</td>
                        <td>{r.stock?.length ? `${r.stock.map((s) => `${s.name} ${qty(s.qty)}개`).join(", ")}${pd.stock ? " · 남음" : r.stock.every((s) => s.done) ? "" : " · 지움"}` : "-"}</td>
                        <td className="actions sm-nowrap">
                          {left && <button type="button" className="b2b-link-btn" onClick={() => resume(r)} disabled={!!busy}>이어서 처리</button>}
                          {active && !left && <button type="button" className="b2b-link-btn" onClick={() => revert(r)} disabled={!!busy}>되돌리기</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}
