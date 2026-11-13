"use client";

// 오디언스 추출 — 조건으로 고객을 찾아 이름·전화번호를 엑셀로 내려받는다. 메시지 발송은 사람이 따로 한다.
//  고객 전화번호가 밖으로 나가는 유일한 화면이라, 검색과 추출이 모두 아래 기록에 남고 누구에게나 보인다.
//  [고객 찾기] = 인원과 미리보기 10명(이름·번호 가림) → [엑셀 내려받기] = 방금 찾은 조건 그대로.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";
import { matchKoQuery } from "@/app/lib/hangul";
import { qty, won, dateTime } from "@/app/lib/format";

// 상품 조건 = 목록에서 고른 상품(skus — 상품코드 정확히) + 고른 주문 상품명(names — 주문서 이름 정확히) + 포함어(keywords — 든 말). 합쳐서 '그중 하나라도 산 고객'.
type Sku = { sku: string; label: string };
type Cond = { from: string; to: string; channels: string[]; skus: Sku[]; names: string[]; keywords: string[]; minOrders: string; maxOrders: string; minAmount: string; lastFrom: string; lastTo: string };
const EMPTY: Cond = { from: "", to: "", channels: [], skus: [], names: [], keywords: [], minOrders: "", maxOrders: "", minAmount: "", lastFrom: "", lastTo: "" };
const toPayload = (c: Cond) => ({ ...c, products: c.keywords.join(", "), keywords: undefined });
type ProductOption = { sku: string; name: string; listing: string; orders: number };
type NameOption = { name: string; orders: number };
const SUGGEST_MAX = 60; // 목록에 한 번에 그리는 줄 수 — 주문 상품명은 수천 개라 전부 그리면 느리다
// 무엇으로 찾을지 먼저 고른다(2026-11-13 대표: "너무 많아서 안 보이네. 선택 후 검색하는 게 나을듯 — 상품명 → 상품명 검색").
//  상품명·상품코드 = 상품 마스터의 상품(고르면 상품코드로 잡는다), 주문 상품명 = 주문서에 적힌 이름 그대로.
const PRODUCT_BY = [{ key: "name", label: "상품명" }, { key: "code", label: "상품코드" }, { key: "order", label: "주문 상품명" }] as const;
type ProductBy = (typeof PRODUCT_BY)[number]["key"];
type Preview = { name: string; phone: string; orders: number; amount: number; first_date: string; last_date: string; items: string; codes: string; channels: string };
type Result = { count: number; excluded: number; capped: boolean; max: number; summary: string; preview: Preview[]; cond: Cond };
type History = { id: string | number; action: "검색" | "추출"; cond: string; count: number | null; actor: string | null; created_at: string; again?: boolean; saved?: Record<string, unknown> | null };

const digits = (s: string) => s.replace(/[^0-9]/g, "");

export default function AudiencePage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [cond, setCond] = useState<Cond>(EMPTY);
  const [channels, setChannels] = useState<string[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"" | "search" | "export">("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<ProductOption[] | null>(null); // 상품 칸을 처음 누를 때 한 번 읽는다
  const [orderNames, setOrderNames] = useState<NameOption[]>([]);         // 주문서에 적힌 상품명(채널마다 다르다)
  const [productsError, setProductsError] = useState("");
  const [typed, setTyped] = useState("");                                  // 상품 검색칸에 치고 있는 말
  const [productBy, setProductBy] = useState<ProductBy>("name");          // 무엇으로 찾을지
  const productsAsked = useRef(false);

  const load = useCallback(async () => {
    try {
      const j = await (await fetch("/api/audience", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      setChannels(j.channels || []); setHistory(j.history || []); setLoadError("");
    } catch (e) { setLoadError(e instanceof Error ? e.message : "오디언스 기록을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = <K extends keyof Cond>(k: K, v: Cond[K]) => setCond((c) => ({ ...c, [k]: v }));

  const loadProducts = () => {
    if (productsAsked.current) return;
    productsAsked.current = true;
    fetch("/api/audience?products=1", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!j.ok) throw new Error(j.error);
      setProducts(j.products || []); setOrderNames(j.names || []);
    }).catch((e) => { productsAsked.current = false; setProductsError(e instanceof Error ? e.message : "상품 목록을 불러오지 못했습니다."); });
  };
  // 목록 = 고른 종류 하나만. 그 종류의 글자(상품명 / 상품코드 / 주문 상품명)로만 찾고, 맞는 것을 주문 많은 순으로 SUGGEST_MAX 줄까지.
  const productOptions: ComboOption[] = useMemo(() => {
    const q = typed.trim();
    if (productBy === "order") {
      return orderNames.filter((n) => !cond.names.includes(n.name) && (!q || matchKoQuery(n.name, q))).slice(0, SUGGEST_MAX)
        .map((n) => ({ id: `name:${n.name}`, label: n.name, sub: `주문 ${qty(n.orders)}건` }));
    }
    const rest = (products || []).filter((p) => !cond.skus.some((s) => s.sku === p.sku));
    if (productBy === "code") {
      return rest.filter((p) => !q || matchKoQuery(p.sku, q)).slice(0, SUGGEST_MAX).map((p) => ({ id: `sku:${p.sku}`, label: p.sku, sub: `${p.name} · 주문 ${qty(p.orders)}건` }));
    }
    return rest.filter((p) => !q || matchKoQuery(p.name, q)).slice(0, SUGGEST_MAX).map((p) => ({ id: `sku:${p.sku}`, label: p.name, sub: `${p.sku} · 주문 ${qty(p.orders)}건` }));
  }, [products, orderNames, cond.skus, cond.names, typed, productBy]);
  const addSku = (o: ComboOption) => {
    if (o.id.startsWith("name:")) { const name = o.id.slice(5); setCond((c) => (c.names.includes(name) ? c : { ...c, names: [...c.names, name] })); }
    else { const sku = o.id.slice(4); const label = products?.find((p) => p.sku === sku)?.name || sku; setCond((c) => (c.skus.some((s) => s.sku === sku) ? c : { ...c, skus: [...c.skus, { sku, label }] })); }
    setTyped("");
  };
  const addKeyword = () => { const k = typed.replace(/,/g, " ").trim(); if (k) setCond((c) => (c.keywords.includes(k) ? c : { ...c, keywords: [...c.keywords, k] })); setTyped(""); };
  const toggleChannel = (ch: string) => setCond((c) => ({ ...c, channels: c.channels.includes(ch) ? c.channels.filter((x) => x !== ch) : [...c.channels, ch] }));
  const isEmpty = JSON.stringify(cond) === JSON.stringify(EMPTY);

  const search = async () => {
    setError("");
    if (isEmpty) { setError("조건을 하나 이상 입력하세요."); return; }
    setBusy("search");
    try {
      const j = await (await fetch("/api/audience", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "search", cond: toPayload(cond) }) })).json();
      if (!j.ok) throw new Error(j.error);
      setResult({ ...j, cond });
      load();
    } catch (e) { setResult(null); setError(e instanceof Error ? e.message : "고객을 찾지 못했습니다."); }
    finally { setBusy(""); }
  };

  // 엑셀 받기 — 방금 찾은 조건(payload) 또는 기록의 조건(fromLog)으로. 어느 쪽이든 서버가 추출 기록을 새로 남긴다.
  const download = async (payload: unknown, fromLog?: string | number) => {
    setBusy("export");
    try {
      const res = await fetch("/api/audience", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "export", cond: payload, fromLog }) });
      if (!res.ok || !(res.headers.get("content-type") || "").includes("spreadsheet")) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "엑셀을 만들지 못했습니다."); }
      const n = res.headers.get("X-Audience-Count") || "0";
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `오디언스_${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "")}_${n}명.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast.success(`${qty(Number(n))}명을 엑셀로 내려받았습니다`);
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "엑셀을 만들지 못했습니다."); }
    finally { setBusy(""); }
  };
  const exportXlsx = async () => {
    if (!result) return;
    if (!(await confirm({ title: "엑셀 내려받기", body: `${qty(result.count)}명의 이름과 전화번호가 든 엑셀을 내려받습니다. 추출 기록에 남습니다.`, action: "엑셀 내려받기", danger: false }))) return;
    await download(toPayload(result.cond));
  };
  // 기록의 조건으로 다시 추출 — 명단은 저장하지 않으므로 같은 조건을 지금 데이터로 다시 조회한다(인원이 그때와 다를 수 있다)
  const reExport = async (h: History) => {
    if (!h.saved) return;
    const then = h.count == null ? "" : ` 그때는 ${qty(h.count)}명이었고 지금은 달라질 수 있습니다.`;
    if (!(await confirm({ title: "다시 추출", body: `같은 조건으로 지금 데이터에서 다시 뽑아 엑셀로 내려받습니다.${then} 추출 기록에 새로 남습니다.`, action: "다시 추출", danger: false }))) return;
    await download(h.saved, h.id);
  };

  return (
    <div className="b2b-container">
      <div className="b2b-page-head">
        <h1 className="b2b-page-title">오디언스 추출</h1>
      </div>
      {loadError && <div className="b2b-error">{loadError}</div>}

      <section className="b2b-form-section">
        {error && <div className="b2b-error" style={{ marginBottom: "var(--sm-space-4)" }}>{error}</div>}
        <div className="aud-form">
          <div className="b2b-field">
            <span className="b2b-field-label">구매 기간</span>
            <div className="aud-range">
              <input type="date" className="b2b-input" value={cond.from} onChange={(e) => set("from", e.target.value)} aria-label="구매 기간 시작일" />
              <span>~</span>
              <input type="date" className="b2b-input" value={cond.to} onChange={(e) => set("to", e.target.value)} aria-label="구매 기간 종료일" />
            </div>
          </div>
          <div className="b2b-field">
            <span className="b2b-field-label">마지막 구매일</span>
            <div className="aud-range">
              <input type="date" className="b2b-input" value={cond.lastFrom} onChange={(e) => set("lastFrom", e.target.value)} aria-label="마지막 구매일 시작" />
              <span>~</span>
              <input type="date" className="b2b-input" value={cond.lastTo} onChange={(e) => set("lastTo", e.target.value)} aria-label="마지막 구매일 끝" />
            </div>
          </div>
          {channels.length > 0 && (
            <div className="b2b-field aud-wide">
              <span className="b2b-field-label">채널</span>
              <div className="sm-tabs" role="group" aria-label="채널">
                {channels.map((ch) => (
                  <button key={ch} type="button" className={`sm-tab ${cond.channels.includes(ch) ? "is-active" : ""}`} aria-pressed={cond.channels.includes(ch)} onClick={() => toggleChannel(ch)}>{ch}</button>
                ))}
              </div>
            </div>
          )}
          <div className="b2b-field aud-wide" onFocusCapture={loadProducts} onPointerDownCapture={loadProducts}>
            <span className="b2b-field-label">상품</span>
            {productsError && <div className="b2b-error">{productsError}</div>}
            <div className="aud-product">
              <div className="sm-tabs" role="group" aria-label="상품을 찾는 기준">
                {PRODUCT_BY.map((t) => (
                  <button key={t.key} type="button" className={`sm-tab ${productBy === t.key ? "is-active" : ""}`} aria-pressed={productBy === t.key} onClick={() => { setProductBy(t.key); setTyped(""); }}>{t.label}</button>
                ))}
              </div>
              <Combobox key={productBy} value="" options={productOptions} onSelect={addSku} onType={setTyped} allowFreeText
                ariaLabel={`${PRODUCT_BY.find((t) => t.key === productBy)!.label} 검색`} placeholder={`${PRODUCT_BY.find((t) => t.key === productBy)!.label} 검색`}
                emptyText={products ? `일치하는 ${PRODUCT_BY.find((t) => t.key === productBy)!.label}이 없습니다` : "상품을 불러오는 중..."} />
            </div>
            {typed.trim() && (
              <div><button type="button" className="b2b-link-btn" onClick={addKeyword}>이름·코드에 ‘{typed.trim()}’가 든 상품 모두 담기</button></div>
            )}
            {(cond.skus.length > 0 || cond.names.length > 0 || cond.keywords.length > 0) && (
              <div className="aud-chips">
                {cond.skus.map((s) => (
                  <button key={s.sku} type="button" className="aud-chip" aria-label={`${s.label} 빼기`} onClick={() => setCond((c) => ({ ...c, skus: c.skus.filter((x) => x.sku !== s.sku) }))}>
                    {s.label}<span className="aud-chip-code">{s.sku}</span><span aria-hidden="true">✕</span>
                  </button>
                ))}
                {cond.names.map((n) => (
                  <button key={n} type="button" className="aud-chip" aria-label={`${n} 빼기`} onClick={() => setCond((c) => ({ ...c, names: c.names.filter((x) => x !== n) }))}>
                    {n}<span className="aud-chip-code">주문 상품명</span><span aria-hidden="true">✕</span>
                  </button>
                ))}
                {cond.keywords.map((k) => (
                  <button key={k} type="button" className="aud-chip" aria-label={`‘${k}’ 포함 조건 빼기`} onClick={() => setCond((c) => ({ ...c, keywords: c.keywords.filter((x) => x !== k) }))}>
                    ‘{k}’ 포함<span aria-hidden="true">✕</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="b2b-field">
            <span className="b2b-field-label">주문 횟수</span>
            <div className="aud-range">
              <input className="b2b-input aud-num" inputMode="numeric" value={cond.minOrders} onChange={(e) => set("minOrders", digits(e.target.value))} placeholder="예: 2" aria-label="주문 횟수 최소" />
              <span>~</span>
              <input className="b2b-input aud-num" inputMode="numeric" value={cond.maxOrders} onChange={(e) => set("maxOrders", digits(e.target.value))} placeholder="예: 5" aria-label="주문 횟수 최대" />
              <span>회</span>
            </div>
          </div>
          <div className="b2b-field">
            <span className="b2b-field-label">누적 구매 금액</span>
            <div className="aud-range">
              <input className="b2b-input aud-num" inputMode="numeric" value={cond.minAmount ? Number(cond.minAmount).toLocaleString("ko-KR") : ""} onChange={(e) => set("minAmount", digits(e.target.value))} placeholder="예: 100,000" aria-label="누적 구매 금액 최소" />
              <span>원 이상</span>
            </div>
          </div>
          <div className="aud-actions aud-wide">
            <button type="button" className="b2b-btn-primary" onClick={search} disabled={!!busy}>{busy === "search" ? "찾는 중" : "고객 찾기"}</button>
            <button type="button" className="b2b-btn-secondary" onClick={() => { setCond(EMPTY); setResult(null); setError(""); setTyped(""); }} disabled={!!busy || (isEmpty && !result)}>조건 지우기</button>
          </div>
        </div>
      </section>

      {result && (
        <section className="b2b-form-section" style={{ marginTop: "var(--sm-space-4)" }}>
          <div className="aud-result-head">
            <span className="aud-count">{qty(result.count)}명</span>
            <span className="aud-count-sub">안심번호(050)·번호 없는 고객 {qty(result.excluded)}명 제외</span>
            <button type="button" className="b2b-btn-secondary aud-export" onClick={exportXlsx} disabled={!!busy || result.count === 0}>{busy === "export" ? "만드는 중" : "엑셀 내려받기"}</button>
          </div>
          <div className="aud-cond">{result.summary}</div>
          {result.capped && <div className="sm-warn" style={{ marginBottom: "var(--sm-space-3)" }}>고객이 {qty(result.max)}명을 넘어 앞에서부터 {qty(result.max)}명만 다룹니다. 조건을 좁히세요.</div>}
          {result.count === 0 ? <div className="b2b-empty">조건에 맞는 고객이 없습니다.</div> : (
            <div className="b2b-table-wrap">
              <table className="b2b-table aud-table">
                <thead><tr><th>이름</th><th>전화번호</th><th className="num">주문 횟수</th><th className="num">누적 구매 금액</th><th>첫 구매일</th><th>마지막 구매일</th><th>상품명</th><th>상품코드</th><th>채널</th></tr></thead>
                <tbody>
                  {result.preview.map((p, i) => (
                    <tr key={i}><td>{p.name}</td><td className="sm-nowrap">{p.phone}</td><td className="num">{qty(p.orders)}회</td><td className="num">{won(p.amount)}원</td><td className="sm-nowrap">{p.first_date}</td><td className="sm-nowrap">{p.last_date}</td><td className="aud-items">{p.items}</td><td className="aud-codes">{p.codes}</td><td>{p.channels}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <div className="b2b-card" style={{ marginTop: "var(--sm-space-5)" }}>
        <div className="b2b-card-head"><span className="b2b-card-title">검색·추출 기록</span></div>
        {loading ? <div className="b2b-loading">불러오는 중...</div>
          : history.length === 0 ? <div className="b2b-empty">검색·추출 기록이 없습니다.</div>
          : (
            <div className="b2b-table-wrap">
              <table className="b2b-table aud-history">
                <thead><tr><th>시각</th><th>누가</th><th>한 일</th><th className="num">인원</th><th>조건</th><th></th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="sm-nowrap">{dateTime(h.created_at)}</td>
                      <td className="sm-nowrap">{h.actor || "-"}</td>
                      <td><span className="b2b-status-pill" style={h.action === "추출" ? { background: "var(--sm-black)", color: "var(--sm-white)" } : { background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{h.again ? "다시 추출" : h.action}</span></td>
                      <td className="num">{h.count == null ? "-" : `${qty(h.count)}명`}</td>
                      <td className="aud-cond-cell">{h.cond}</td>
                      <td className="actions sm-nowrap">{h.saved && <button type="button" className="b2b-link-btn" onClick={() => reExport(h)} disabled={!!busy}>다시 추출</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}
