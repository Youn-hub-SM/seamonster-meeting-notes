"use client";

// 오디언스 추출 — 조건 묶음 카드 하나(2026-11-22 대표: "and or 등을 넣어 고도화한 필터링 — 이해하기 쉽게").
//  묶음 = 주문의 범위(구매 기간·채널·상품) + 그 범위에서 센 값(주문 횟수·누적 금액) + 마지막 구매일.
//  카드 머리에 지금 넣은 조건을 한 줄로 읽어 준다(describeG) — 넣은 조건이 어떤 고객을 뜻하는지 바로 보이게.
//  찾는 묶음(조건 n)과 빼는 묶음(제외 n)이 같은 카드를 쓴다. 묶음 사이의 그리고/또는은 부모(page.tsx)가 정한다.
import { useMemo, useState } from "react";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";
import { matchKoQuery } from "@/app/lib/hangul";
import { qty } from "@/app/lib/format";

// 상품 조건 = 목록에서 고른 상품(skus — 상품코드 정확히) + 고른 주문 상품명(names — 주문서 이름 정확히) + 포함어(keywords — 든 말). 합쳐서 '그중 하나라도'.
export type Sku = { sku: string; label: string };
export type G = { from: string; to: string; channels: string[]; skus: Sku[]; names: string[]; keywords: string[]; only: boolean; minOrders: string; maxOrders: string; minAmount: string; lastFrom: string; lastTo: string };
export const EMPTY_G: G = { from: "", to: "", channels: [], skus: [], names: [], keywords: [], only: false, minOrders: "", maxOrders: "", minAmount: "", lastFrom: "", lastTo: "" };
const hasProduct = (g: G) => g.skus.length > 0 || g.names.length > 0 || g.keywords.length > 0;
// '이 상품만'은 상품을 골랐을 때만 조건이다
export const isEmptyG = (g: G): boolean => JSON.stringify({ ...g, only: false }) === JSON.stringify(EMPTY_G);
export const toGroupPayload = (g: G) => ({ ...g, products: g.keywords.join(", "), keywords: undefined, only: g.only && hasProduct(g) });
export type ProductOption = { sku: string; name: string; listing: string; orders: number };
export type NameOption = { name: string; orders: number };

const digits = (s: string) => s.replace(/[^0-9]/g, "");
const SUGGEST_MAX = 60; // 목록에 한 번에 그리는 줄 수 — 주문 상품명은 수천 개라 전부 그리면 느리다
// 무엇으로 찾을지 먼저 고른다(2026-11-13 대표: "너무 많아서 안 보이네. 선택 후 검색하는 게 나을듯").
//  상품명·상품코드 = 상품 마스터의 상품(고르면 상품코드로 잡는다), 주문 상품명 = 주문서에 적힌 이름 그대로.
const PRODUCT_BY = [{ key: "name", label: "상품명" }, { key: "code", label: "상품코드" }, { key: "order", label: "주문 상품명" }] as const;
type ProductBy = (typeof PRODUCT_BY)[number]["key"];

// 넣은 조건을 한 줄로 — '카페24 · 2026-10-01~2026-10-31 · 광어회 포함 주문 3회 이상'
export function describeG(g: G): string {
  if (isEmptyG(g)) return "";
  const names = [...g.skus.map((s) => s.label || s.sku), ...g.names, ...g.keywords.map((k) => `‘${k}’ 포함 상품`)];
  const product = names.length ? (names.length > 2 ? `${names.slice(0, 2).join(", ")} 외 ${names.length - 2}개` : names.join(", ")) : "";
  const mn = Number(g.minOrders) || 0, mx = Number(g.maxOrders) || 0;
  const count = mn && mx ? (mn === mx ? `${qty(mn)}회` : `${qty(mn)}~${qty(mx)}회`) : mn ? `${qty(mn)}회 이상` : mx ? `${qty(mx)}회 이하` : "";
  const core = product && g.only ? [`${product}만 구매`, count ? `주문 ${count}` : ""].filter(Boolean).join(" · ")
    : product ? `${product} 포함 주문 ${count || "1회 이상"}` : `주문 ${count || "1회 이상"}`;
  return [
    g.channels.length ? g.channels.join("·") : "",
    g.from || g.to ? `${g.from || "처음"}~${g.to || "오늘"}` : "",
    core,
    g.minAmount ? `구매 금액 ${Number(g.minAmount).toLocaleString("ko-KR")}원 이상` : "",
    g.lastFrom || g.lastTo ? `마지막 구매 ${g.lastFrom || "처음"}~${g.lastTo || "오늘"}` : "",
  ].filter(Boolean).join(" · ");
}

export default function GroupCard({ title, exclude, value, onChange, onRemove, channels, products, orderNames, productsError, loadProducts }: {
  title: string;                 // '조건 1' · '제외 1'
  exclude?: boolean;             // 빼는 묶음
  value: G;
  onChange: (g: G) => void;
  onRemove?: () => void;         // 없으면 지우기 버튼을 그리지 않는다(마지막 남은 조건)
  channels: string[];
  products: ProductOption[] | null;
  orderNames: NameOption[];
  productsError: string;
  loadProducts: () => void;
}) {
  const [typed, setTyped] = useState("");                         // 상품 검색칸에 치고 있는 말
  const [productBy, setProductBy] = useState<ProductBy>("name"); // 무엇으로 찾을지
  const g = value;
  const set = <K extends keyof G>(k: K, v: G[K]) => onChange({ ...g, [k]: v });
  const byLabel = PRODUCT_BY.find((t) => t.key === productBy)!.label;

  // 목록 = 고른 종류 하나만. 그 종류의 글자(상품명 / 상품코드 / 주문 상품명)로만 찾고, 맞는 것을 주문 많은 순으로 SUGGEST_MAX 줄까지.
  const options: ComboOption[] = useMemo(() => {
    const q = typed.trim();
    if (productBy === "order") {
      return orderNames.filter((n) => !g.names.includes(n.name) && (!q || matchKoQuery(n.name, q))).slice(0, SUGGEST_MAX)
        .map((n) => ({ id: `name:${n.name}`, label: n.name, sub: `주문 ${qty(n.orders)}건` }));
    }
    const rest = (products || []).filter((p) => !g.skus.some((s) => s.sku === p.sku));
    if (productBy === "code") return rest.filter((p) => !q || matchKoQuery(p.sku, q)).slice(0, SUGGEST_MAX).map((p) => ({ id: `sku:${p.sku}`, label: p.sku, sub: `${p.name} · 주문 ${qty(p.orders)}건` }));
    return rest.filter((p) => !q || matchKoQuery(p.name, q)).slice(0, SUGGEST_MAX).map((p) => ({ id: `sku:${p.sku}`, label: p.name, sub: `${p.sku} · 주문 ${qty(p.orders)}건` }));
  }, [products, orderNames, g.skus, g.names, typed, productBy]);
  const add = (o: ComboOption) => {
    if (o.id.startsWith("name:")) { const name = o.id.slice(5); if (!g.names.includes(name)) set("names", [...g.names, name]); }
    else { const sku = o.id.slice(4); if (!g.skus.some((s) => s.sku === sku)) set("skus", [...g.skus, { sku, label: products?.find((p) => p.sku === sku)?.name || sku }]); }
    setTyped("");
  };
  const addKeyword = () => { const k = typed.replace(/,/g, " ").trim(); if (k && !g.keywords.includes(k)) set("keywords", [...g.keywords, k]); setTyped(""); };
  const toggleChannel = (ch: string) => set("channels", g.channels.includes(ch) ? g.channels.filter((x) => x !== ch) : [...g.channels, ch]);
  const sentence = describeG(g);

  return (
    <div className={`aud-group ${exclude ? "is-exclude" : ""}`}>
      <div className="aud-group-head">
        <span className="b2b-status-pill aud-group-badge">{title}</span>
        <span className="aud-group-sentence">{sentence ? `${sentence}${exclude ? " 고객을 뺀다" : " 고객"}` : exclude ? "뺄 고객의 조건을 넣으세요" : "찾을 고객의 조건을 넣으세요"}</span>
        {onRemove && <button type="button" className="b2b-link-btn aud-group-remove" onClick={onRemove}>{title} 지우기</button>}
      </div>
      <div className="aud-form">
        <div className="b2b-field">
          <span className="b2b-field-label">구매 기간</span>
          <div className="aud-range">
            <input type="date" className="b2b-input" value={g.from} onChange={(e) => set("from", e.target.value)} aria-label={`${title} 구매 기간 시작일`} />
            <span>~</span>
            <input type="date" className="b2b-input" value={g.to} onChange={(e) => set("to", e.target.value)} aria-label={`${title} 구매 기간 종료일`} />
          </div>
        </div>
        <div className="b2b-field">
          <span className="b2b-field-label">마지막 구매일</span>
          <div className="aud-range">
            <input type="date" className="b2b-input" value={g.lastFrom} onChange={(e) => set("lastFrom", e.target.value)} aria-label={`${title} 마지막 구매일 시작`} />
            <span>~</span>
            <input type="date" className="b2b-input" value={g.lastTo} onChange={(e) => set("lastTo", e.target.value)} aria-label={`${title} 마지막 구매일 끝`} />
          </div>
        </div>
        {channels.length > 0 && (
          <div className="b2b-field aud-wide">
            <span className="b2b-field-label">채널</span>
            <div className="sm-tabs" role="group" aria-label={`${title} 채널`}>
              {channels.map((ch) => (
                <button key={ch} type="button" className={`sm-tab ${g.channels.includes(ch) ? "is-active" : ""}`} aria-pressed={g.channels.includes(ch)} onClick={() => toggleChannel(ch)}>{ch}</button>
              ))}
            </div>
          </div>
        )}
        <div className="b2b-field aud-wide" onFocusCapture={loadProducts} onPointerDownCapture={loadProducts}>
          <span className="b2b-field-label">상품</span>
          {productsError && <div className="b2b-error">{productsError}</div>}
          <div className="aud-product">
            <div className="sm-tabs" role="group" aria-label={`${title} 상품을 찾는 기준`}>
              {PRODUCT_BY.map((t) => (
                <button key={t.key} type="button" className={`sm-tab ${productBy === t.key ? "is-active" : ""}`} aria-pressed={productBy === t.key} onClick={() => { setProductBy(t.key); setTyped(""); }}>{t.label}</button>
              ))}
            </div>
            <Combobox key={productBy} value="" options={options} onSelect={add} onType={setTyped} allowFreeText
              ariaLabel={`${title} ${byLabel} 검색`} placeholder={`${byLabel} 검색`} emptyText={products ? `일치하는 ${byLabel}이 없습니다` : "상품을 불러오는 중..."} />
          </div>
          {typed.trim() && (
            <div><button type="button" className="b2b-link-btn" onClick={addKeyword}>이름·코드에 ‘{typed.trim()}’가 든 상품 모두 담기</button></div>
          )}
          {hasProduct(g) && (
            <div className="aud-chips">
              {g.skus.map((s) => (
                <button key={s.sku} type="button" className="aud-chip" aria-label={`${s.label} 빼기`} onClick={() => set("skus", g.skus.filter((x) => x.sku !== s.sku))}>
                  {s.label}<span className="aud-chip-code">{s.sku}</span><span aria-hidden="true">✕</span>
                </button>
              ))}
              {g.names.map((n) => (
                <button key={n} type="button" className="aud-chip" aria-label={`${n} 빼기`} onClick={() => set("names", g.names.filter((x) => x !== n))}>
                  {n}<span className="aud-chip-code">주문 상품명</span><span aria-hidden="true">✕</span>
                </button>
              ))}
              {g.keywords.map((k) => (
                <button key={k} type="button" className="aud-chip" aria-label={`‘${k}’ 포함 조건 빼기`} onClick={() => set("keywords", g.keywords.filter((x) => x !== k))}>
                  ‘{k}’ 포함<span aria-hidden="true">✕</span>
                </button>
              ))}
            </div>
          )}
          {hasProduct(g) && (
            <div className="sm-tabs" role="group" aria-label={`${title} 상품 범위`}>
              <button type="button" className={`sm-tab ${!g.only ? "is-active" : ""}`} aria-pressed={!g.only} onClick={() => set("only", false)}>이 상품을 산 고객</button>
              <button type="button" className={`sm-tab ${g.only ? "is-active" : ""}`} aria-pressed={g.only} onClick={() => set("only", true)}>이 상품만 산 고객</button>
            </div>
          )}
        </div>
        <div className="b2b-field">
          <span className="b2b-field-label">주문 횟수</span>
          <div className="aud-range">
            <input className="b2b-input aud-num" inputMode="numeric" value={g.minOrders} onChange={(e) => set("minOrders", digits(e.target.value))} placeholder="예: 2" aria-label={`${title} 주문 횟수 최소`} />
            <span>~</span>
            <input className="b2b-input aud-num" inputMode="numeric" value={g.maxOrders} onChange={(e) => set("maxOrders", digits(e.target.value))} placeholder="예: 5" aria-label={`${title} 주문 횟수 최대`} />
            <span>회</span>
          </div>
        </div>
        <div className="b2b-field">
          <span className="b2b-field-label">누적 구매 금액</span>
          <div className="aud-range">
            <input className="b2b-input aud-num" inputMode="numeric" value={g.minAmount ? Number(g.minAmount).toLocaleString("ko-KR") : ""} onChange={(e) => set("minAmount", digits(e.target.value))} placeholder="예: 100,000" aria-label={`${title} 누적 구매 금액 최소`} />
            <span>원 이상</span>
          </div>
        </div>
      </div>
    </div>
  );
}
