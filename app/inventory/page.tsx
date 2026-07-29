"use client";

// 재고 목록 = 재고 + 생산 통합 화면(2026-07-29 — 구 /production/inventory '생산' 흡수).
//  기본 열(SKU·품목·현재고·안전재고·하루 출고·예상소진) + 재고(총입고·총출고·재고자산)
//  + 생산(권장생산·주문필요) + 액션(입·출·조정 / 보정). 체크 후 '선택 N종 생산 요청'을 누르면
//  '생산 요청' 메뉴로 이동해 새 생산 요청 창이 권장 수량 채워진 채 열린다(sessionStorage 핸드오프).
//  AI 조언도 이 화면에서.
//  재고 수치 = /api/inventory/overview, 생산 수치(권장·주문필요·보정) = /api/production/inventory
//  (소매·도매 필터 = 그 채널 수식, 전체 = 소매+도매 권장 합) — SKU 로 조인.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { OverviewRow } from "@/app/api/inventory/overview/route";
import type { InvChannelFilter } from "@/app/lib/inventory";
import TxnModal from "./TxnModal";
import { ChannelFilter, writeChannelOf } from "./ChannelTabs";
import PromoManager from "@/app/components/PromoManager";
import { matchKoQuery } from "@/app/lib/hangul";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
function shift(iso: string, n: number) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

const PERIODS = [["일일", 1], ["7일", 7], ["14일", 14], ["30일", 30], ["지정", 0]] as const;
type PMode = (typeof PERIODS)[number][0];

// 생산 수치(/api/production/inventory) — SKU 키 조인용
type ProdRow = {
  sku: string; name: string; stock: number | null; dailyOut: number; rawDailyOut: number;
  autoSafety: number; promoQty: number; adjust: number; adjustRaw: number; adjustExcludeRaw: number;
  adjustMemo: string; adjustUntil: string | null; safety: number; recommend: number;
  requestByDays: number | null; requestBy: string | null;
};
type Priority = { sku: string; name: string; urgency: string; qty: number; byWhen: string; reason: string };
type Advice = { summary: string; priorities: Priority[]; notes: string[] };
const URG_STYLE: Record<string, { bg: string; fg: string }> = {
  "높음": { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
  "중간": { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  "낮음": { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
};

// ── 표 열 폭 ──
//  아래 px 은 '표가 가장 좁을 때(= minWidth)' 의 하한이다. 브라우저에서 열별 자연폭을 재서
//  그 바로 위로 잡은 값 — 이 폭에서는 어느 열도 내용이 잘리지 않는다.
//  실제 렌더는 이 값을 %로 바꿔 쓰므로, 화면이 넓어지면 품목만 커지지 않고 모든 열이 같은 비율로 늘어난다.
const COL = {
  chk: 32, sku: 108, name: 112, qty: 72, safety: 78, daily: 80, dep: 78,
  pin: 68, pout: 68, val: 96, rec: 78, req: 80, act: 80, adj: 76,
} as const;
const TABLE_MIN = Object.values(COL).reduce((a, b) => a + b, 0); // 1106 — 사이드바(237)+스크롤바(15) 더해도 1366 창에 들어간다
const pct = (px: number) => `${((px / TABLE_MIN) * 100).toFixed(3)}%`;

// 정렬 가능한 컬럼(생산 열 포함)
type SortKey = "name" | "qty" | "auto_safety" | "depletion_days" | "period_in" | "period_out" | "daily_out" | "value" | "recommend" | "request_by";
const numKey = (r: OverviewRow, k: Exclude<SortKey, "recommend" | "request_by">): number | string =>
  k === "name" ? r.name : k === "depletion_days" ? (r.depletion_days ?? Number.POSITIVE_INFINITY) : (r[k] as number);

export default function InventoryPage() {
  const router = useRouter();
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [meta, setMeta] = useState<{ from: string; to: string; periodDays: number; leadDays: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [channel, setChannel] = useState<InvChannelFilter>("전체");
  const [pmode, setPmode] = useState<PMode>("30일");
  const [cfrom, setCfrom] = useState(shift(TODAY(), -6));
  const [cto, setCto] = useState(TODAY());
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "depletion_days", dir: "asc" });
  const [modalFor, setModalFor] = useState<string>("");
  const [promoOpen, setPromoOpen] = useState(false);

  const range = useMemo(() => {
    if (pmode === "지정") return { from: cfrom, to: cto };
    const days = (PERIODS.find((p) => p[0] === pmode)?.[1] as number) || 30;
    const to = TODAY();
    return { from: shift(to, -(days - 1)), to };
  }, [pmode, cfrom, cto]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const sp = new URLSearchParams({ from: range.from, to: range.to });
      if (channel !== "전체") sp.set("channel", channel);
      const j = await (await fetch(`/api/inventory/overview?${sp}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      // 번들(세트)은 자체 재고가 없어 재고 관리에서 제외(출고는 B2B 발송 시 구성품으로 자동 차감).
      setRows((j.rows || []).filter((r: OverviewRow) => !r.is_bundle)); setMeta(j.meta || null);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [range.from, range.to, channel]);
  useEffect(() => { load(); }, [load]);

  // ── 생산 수치 — 소매·도매 둘 다 조회. 표시 기준: 소매/도매 필터 = 그 채널 수식, 전체 = 소매+도매 합 ──
  const prodChannel = channel === "도매" ? "도매" : "소매"; // AI 조언용(조언 API 는 단일 채널)
  const [retailMap, setRetailMap] = useState<Map<string, ProdRow>>(new Map());
  const [wholeMap, setWholeMap] = useState<Map<string, ProdRow>>(new Map());
  const [prodLead, setProdLead] = useState(10);
  const [spanDays, setSpanDays] = useState(0);
  // 한쪽 채널만 실패하면 권장이 조용히 축소되어(합인데 한쪽만) 부족한 수량을 요청하게 된다 → 경고를 띄운다.
  const [prodWarn, setProdWarn] = useState("");
  const prodLoad = useCallback(async () => {
    try {
      const [r, w] = await Promise.all([
        (await fetch("/api/production/inventory?channel=소매", { cache: "no-store" })).json(),
        (await fetch("/api/production/inventory?channel=도매", { cache: "no-store" })).json(),
      ]);
      if (r.ok) {
        setRetailMap(new Map(((r.rows || []) as ProdRow[]).map((x) => [x.sku.toUpperCase(), x])));
        setProdLead(r.leadDays || 10);
        setSpanDays(r.velocitySpanDays || 0);
      }
      if (w.ok) setWholeMap(new Map(((w.rows || []) as ProdRow[]).map((x) => [x.sku.toUpperCase(), x])));
      const bad = [!r.ok && "소매", !w.ok && "도매"].filter(Boolean).join("·");
      setProdWarn(bad ? `${bad} 생산 수치를 불러오지 못했습니다 — 권장생산·주문필요가 실제보다 적게 보일 수 있습니다.` : "");
    } catch {
      setProdWarn("생산 수치를 불러오지 못했습니다 — 권장생산·주문필요가 비어 있거나 실제보다 적게 보일 수 있습니다.");
    }
  }, []);
  useEffect(() => { prodLoad(); }, [prodLoad]);

  // 채널 필터에 맞는 생산 수치 뷰 — 전체는 소매+도매 권장 합(새 생산 요청 창의 제조사 권장과 동일 기준),
  //  주문필요는 두 채널 중 더 급한 쪽. retail 은 보정 모달용 소매 원본 행.
  type ProdView = { has: boolean; recommend: number; requestByDays: number | null; requestBy: string | null; retail?: ProdRow };
  const prodView = useCallback((r: OverviewRow): ProdView => {
    const key = r.sku ? r.sku.toUpperCase() : null;
    const rr = key ? retailMap.get(key) : undefined;
    const ww = key ? wholeMap.get(key) : undefined;
    if (channel === "소매") return { has: !!rr, recommend: rr?.recommend ?? 0, requestByDays: rr?.requestByDays ?? null, requestBy: rr?.requestBy ?? null, retail: rr };
    if (channel === "도매") return { has: !!ww, recommend: ww?.recommend ?? 0, requestByDays: ww?.requestByDays ?? null, requestBy: ww?.requestBy ?? null, retail: rr };
    let days: number | null = null, by: string | null = null;
    for (const p of [rr, ww]) {
      if (p?.requestByDays == null) continue;
      if (days == null || p.requestByDays < days) { days = p.requestByDays; by = p.requestBy; }
    }
    return { has: !!(rr || ww), recommend: (rr?.recommend ?? 0) + (ww?.recommend ?? 0), requestByDays: days, requestBy: by, retail: rr };
  }, [channel, retailMap, wholeMap]);

  const qtyOf = useCallback((id: string) => rows.find((r) => r.product_id === id)?.qty || 0, [rows]);
  const products = useMemo(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, unit: r.unit })), [rows]);
  const totals = useMemo(() => ({
    items: rows.length,
    value: rows.reduce((s, r) => s + r.value, 0),
    low: rows.filter((r) => r.low).length,
    out: rows.reduce((s, r) => s + r.period_out, 0),
  }), [rows]);
  // 생산 카드 — 권장 생산>0 = 안전재고(행사·보정 반영) 미달과 동일 데이터라 하나만 노출. 채널 기준은 표와 동일.
  const prodStats = useMemo(() => {
    let needItems = 0, needQty = 0;
    const keys = new Set([...retailMap.keys(), ...wholeMap.keys()]);
    for (const k of keys) {
      const rr = retailMap.get(k), ww = wholeMap.get(k);
      const rec = channel === "소매" ? (rr?.recommend ?? 0) : channel === "도매" ? (ww?.recommend ?? 0) : (rr?.recommend ?? 0) + (ww?.recommend ?? 0);
      if (rec > 0) { needItems++; needQty += rec; }
    }
    return { needItems, needQty };
  }, [retailMap, wholeMap, channel]);

  const shown = useMemo(() => {
    const q = search.trim();
    const f = rows.filter((r) => {
      if (onlyLow && !r.low) return false;
      if (q && !matchKoQuery(`${r.name} ${r.sku || ""} ${r.spec || ""} ${r.attrs || ""}`, q)) return false; // 속성/분류·초성 검색
      return true;
    });
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    const val = (r: OverviewRow): number | string => {
      if (key === "recommend") { const v = prodView(r); return v.has ? v.recommend : -1; }
      if (key === "request_by") return prodView(r).requestByDays ?? Number.POSITIVE_INFINITY;
      return numKey(r, key);
    };
    return [...f].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb), "ko") * mul;
      return (va - vb) * mul;
    });
  }, [rows, search, onlyLow, sort, prodView]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }
  const Th = ({ k, label, num, w }: { k: SortKey; label: string; num?: boolean; w?: number | string }) => (
    <th className={num ? "num" : undefined} onClick={() => toggleSort(k)} style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none", width: w }} title="클릭하여 정렬">
      {label}<span style={{ marginLeft: 3, color: sort.key === k ? "var(--sm-orange)" : "var(--sm-text-light)", fontSize: 10 }}>{sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </th>
  );

  // ── 생산 요청 — 체크 후 버튼을 누르면 '생산 요청' 메뉴로 이동, 새 생산 요청 창이 권장 수량 채워져 열린다 ──
  const [sel, setSel] = useState<Set<string>>(new Set()); // product_id
  const selectable = useMemo(() => shown.filter((r) => prodView(r).recommend > 0), [shown, prodView]);
  const allChecked = selectable.length > 0 && selectable.every((r) => sel.has(r.product_id));
  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSel(allChecked ? new Set() : new Set([...sel, ...selectable.map((r) => r.product_id)]));
  useEffect(() => { setSel(new Set()); }, [channel]); // 채널 바꾸면 선택 초기화(기준 데이터가 다름)

  function goRequest() {
    const picked = rows.filter((r) => sel.has(r.product_id));
    if (!picked.length) return;
    // 도매 필터 → 도매 요청(도매 권장), 그 외 → 제조사 요청(소매+도매 합) — 새 생산 요청 창의 권장 열과 동일 수식
    const purpose = channel === "도매" ? "도매 납품" : "재고 보충";
    const items = picked
      .filter((r) => r.sku)
      .map((r) => {
        const key = (r.sku as string).toUpperCase();
        const rr = retailMap.get(key), ww = wholeMap.get(key);
        const qty = purpose === "도매 납품" ? (ww?.recommend ?? 0) : (rr?.recommend ?? 0) + (ww?.recommend ?? 0);
        return { sku: r.sku, qty };
      });
    // SKU 로 넘기므로 SKU 없는 품목은 못 보낸다 — 조용히 빠지지 않게 알린다
    if (items.length < picked.length) {
      const no = picked.filter((r) => !r.sku).map((r) => r.name).join(", ");
      if (!items.length) { setError(`SKU 가 없는 품목은 생산 요청으로 넘길 수 없습니다: ${no} (상품 마스터에서 SKU를 등록하세요)`); return; }
      setError(`SKU 가 없어 제외된 품목: ${no}`);
    }
    try { sessionStorage.setItem("prod_req_prefill", JSON.stringify({ purpose, at: Date.now(), items })); } catch { /* noop */ }
    router.push("/production/request");
  }

  // ── 안전재고 보정(소매 기준 생산 수치에만 적용) ──
  const [editRow, setEditRow] = useState<ProdRow | null>(null);
  const [eDelta, setEDelta] = useState("");
  const [eExclude, setEExclude] = useState("");
  const [eMemo, setEMemo] = useState("");
  const [eUntil, setEUntil] = useState("");
  const [saving, setSaving] = useState(false);
  function openEdit(p: ProdRow) {
    setEditRow(p);
    setEDelta(p.adjustRaw ? String(p.adjustRaw) : "");
    setEExclude(p.adjustExcludeRaw ? String(p.adjustExcludeRaw) : "");
    setEMemo(p.adjustMemo || "");
    setEUntil(p.adjustUntil || "");
  }
  async function saveAdjust() {
    if (!editRow) return;
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/production/safety-adjust", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: editRow.sku, delta: Number(eDelta) || 0, excludeOut: Number(eExclude) || 0, memo: eMemo, until: eUntil || null }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setEditRow(null);
      await prodLoad();
    } catch (e) { setError(e instanceof Error ? e.message : "보정 저장 실패"); }
    setSaving(false);
  }

  // ── AI 조언(생산) ──
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  useEffect(() => { setAdvice(null); }, [prodChannel]);
  async function genAdvice() {
    setAdviceLoading(true); setError("");
    try {
      const res = await fetch("/api/production/advice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: prodChannel }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "AI 조언 생성 실패");
      setAdvice(j.advice);
    } catch (e) { setError(e instanceof Error ? e.message : "AI 조언 생성 실패"); }
    setAdviceLoading(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고 목록</h1>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={genAdvice} disabled={adviceLoading}>{adviceLoading ? "AI 분석 중…" : advice ? "다시 분석" : "AI 조언"}</button>
          <button className="b2b-btn-secondary" onClick={() => setPromoOpen(true)} title="프로모션 기간·예상판매 등록 → 안전재고에 반영">프로모션</button>
          <button className="b2b-btn-primary" onClick={goRequest} disabled={sel.size === 0}
            title={sel.size === 0 ? "아래 표에서 품목을 체크하세요"
              : channel === "도매" ? "생산 요청 메뉴로 이동해 도매 요청 창을 엽니다 (권장 = 도매 수식)"
              : "생산 요청 메뉴로 이동해 제조사 요청 창을 엽니다 (권장 = 소매+도매 합)"}>
            {`선택 ${sel.size}종 생산 요청`}
          </button>
          <button className="b2b-btn-primary" onClick={() => setModalFor("__new__")}>+ 입·출·조정</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}
      {prodWarn && <div className="sm-warn" style={{ marginBottom: 12 }}>{prodWarn}</div>}

      {/* 데이터박스 6종 — 재고 4 + 생산 2 (생산 권장 품목 = 안전재고(행사·보정 반영) 미달과 동일 데이터라 통합) */}
      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">품목 수</div><div className="b2b-stat-card-value">{totals.items}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 자산(원가)</div><div className="b2b-stat-card-value b2b-money">{totals.value.toLocaleString()}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 부족</div><div className="b2b-stat-card-value" style={{ color: totals.low ? "var(--sm-danger)" : "var(--sm-black)" }}>{totals.low}건</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">기간 총출고</div><div className="b2b-stat-card-value b2b-money">{totals.out.toLocaleString()}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">생산 권장 품목</div><div className="b2b-stat-card-value" style={{ color: prodStats.needItems ? "var(--sm-orange)" : "var(--sm-black)" }}>{prodStats.needItems}종</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">총 권장 생산량</div><div className="b2b-stat-card-value b2b-money">{prodStats.needQty.toLocaleString()}</div></div>
      </div>

      <div className="sm-between" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <ChannelFilter value={channel} onChange={setChannel} />
          <div className="sm-tabs" style={{ margin: 0 }}>
            {PERIODS.map(([k]) => <button key={k} className={`sm-tab ${pmode === k ? "is-active" : ""}`} onClick={() => setPmode(k)}>{k === "지정" ? "날짜 지정" : k}</button>)}
          </div>
          {pmode === "지정" && (
            <span className="sm-row" style={{ gap: 6 }}>
              <input type="date" className="b2b-input" value={cfrom} max={cto} onChange={(e) => setCfrom(e.target.value)} style={{ width: "auto" }} />
              <span className="sm-faint">~</span>
              <input type="date" className="b2b-input" value={cto} min={cfrom} max={TODAY()} onChange={(e) => setCto(e.target.value)} style={{ width: "auto" }} />
            </span>
          )}
          <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>
            <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> 부족만 보기
          </label>
          {sel.size > 0 && <span className="sm-faint" style={{ fontSize: 12 }}>체크 {sel.size}종 (검색을 바꿔도 유지)</span>}
        </div>
        <input className="b2b-input" placeholder="품목·SKU·옵션·속성/분류 — 초성 가능 (예: ㄱㅇ)" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 300, maxWidth: "100%" }} />
      </div>

      {meta && <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>기간 {meta.from} ~ {meta.to} ({meta.periodDays}일) · 안전재고 = 일평균소진 × 리드타임 {meta.leadDays}일 + 프로모션 확보분 · {channel === "전체" ? "권장생산은 소매+도매 합, 주문필요는 더 급한 채널" : `권장생산·주문필요는 ${channel}`} 기준 · ‘선택 N종 생산 요청’은 {channel === "도매" ? "도매" : "제조사"} 요청으로 넘어갑니다</p>}

      {adviceLoading && <div className="b2b-loading">AI가 판매추세·재고·발주를 종합해 분석 중입니다… (최대 1분)</div>}
      {advice && (
        <section style={{ marginBottom: 18 }}>
          <div className="prod-advice-summary">
            <div className="prod-advice-summary-icon"></div>
            <div>{advice.summary}</div>
          </div>
          {advice.priorities && advice.priorities.length > 0 && (
            <div className="prod-prio-list" style={{ marginTop: 12 }}>
              {advice.priorities.map((p, i) => {
                const u = URG_STYLE[p.urgency] || URG_STYLE["낮음"];
                return (
                  <div key={i} className="prod-prio-card">
                    <div className="prod-prio-rank">{i + 1}</div>
                    <div className="prod-prio-body">
                      <div className="prod-prio-top">
                        <span className="prod-prio-name">{p.name}</span>
                        <code className="prod-prio-sku">{p.sku}</code>
                        <span className="prod-prio-urg" style={{ background: u.bg, color: u.fg }}>{p.urgency}</span>
                      </div>
                      <div className="prod-prio-meta">
                        <span className="prod-prio-qty">{Number(p.qty).toLocaleString()}개</span>
                        <span className="prod-prio-when">{p.byWhen}</span>
                      </div>
                      <div className="prod-prio-reason">{p.reason}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {advice.notes && advice.notes.length > 0 && (
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.8, fontSize: 12.5, color: "var(--sm-text-mid)" }}>
              {advice.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
          <p className="prod-note" style={{ marginTop: 8 }}>※ 아래 표가 이 조언의 근거(현재고·안전재고·권장 생산량)입니다.</p>
        </section>
      )}

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : shown.length === 0 ? (
        <div className="b2b-empty">{rows.length === 0 ? "활성 품목이 없습니다. 상품 마스터에 제품을 등록하세요." : "조건에 맞는 품목이 없습니다."}</div>
      ) : (
        <div className="b2b-table-wrap">
          {/* tableLayout fixed + 열 폭을 % 로 — 내용 길이에 흔들리지 않으면서, 화면이 넓어지면
              품목만 커지는 대신 모든 열이 같은 비율로 넓어진다. minWidth(TABLE_MIN) 가 하한이라
              그 폭에서는 COL 의 실측 px 과 정확히 같아진다. */}
          <table className="b2b-table inv-table" style={{ tableLayout: "fixed", minWidth: TABLE_MIN }}>
            <thead><tr>
              <th style={{ width: pct(COL.chk) }}><input type="checkbox" checked={allChecked} onChange={toggleAll} title="권장 생산 있는 품목 전체 선택" /></th>
              <th style={{ width: pct(COL.sku) }}>SKU</th><Th k="name" label="품목" w={pct(COL.name)} />
              <Th k="qty" label="현재고" num w={pct(COL.qty)} /><Th k="auto_safety" label="안전재고" num w={pct(COL.safety)} /><Th k="daily_out" label="하루 출고" num w={pct(COL.daily)} /><Th k="depletion_days" label="예상소진" num w={pct(COL.dep)} />
              <Th k="period_in" label="총입고" num w={pct(COL.pin)} /><Th k="period_out" label="총출고" num w={pct(COL.pout)} />
              <Th k="value" label="재고자산" num w={pct(COL.val)} />
              <Th k="recommend" label="권장생산" num w={pct(COL.rec)} /><Th k="request_by" label="주문필요" num w={pct(COL.req)} />
              <th style={{ width: pct(COL.act) }}></th><th className="num" style={{ width: pct(COL.adj) }}>보정</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => {
                const pv = prodView(r);
                const adj = channel !== "도매" ? pv.retail : undefined; // 보정은 소매 수식에만 적용
                const picked = sel.has(r.product_id);
                return (
                /* 줄 어디를 눌러도 선택 토글 — 체크박스·버튼 칸은 아래에서 전파를 막는다 */
                <tr key={r.product_id}
                  className={`${pv.has ? "is-pick" : ""} ${picked ? "is-sel" : ""}`}
                  onClick={pv.has ? () => toggleSel(r.product_id) : undefined}
                  style={{ background: r.low ? "var(--sm-danger-bg)" : undefined }}>
                  <td onClick={(e) => e.stopPropagation()}>{pv.has ? <input type="checkbox" checked={picked} onChange={() => toggleSel(r.product_id)} /> : null}</td>
                  <td className="sm-faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sku || "-"}</td>
                  {/* 비례 배분이라 넓은 화면에서도 품목 폭이 무한정 늘지는 않는다 → 잘린 이름은 마우스를 올려 확인 */}
                  <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${r.name}${r.spec ? ` ${r.spec}` : ""}`}><strong>{r.name}</strong>{r.spec ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{r.spec}</span> : null}{r.is_bundle ? <span className="b2b-status-pill" style={{ marginLeft: 6, background: "var(--sm-orange-light)", color: "var(--sm-orange)" }}>세트</span> : null}</td>
                  <td className="num b2b-money" style={{ fontWeight: 700, color: r.low ? "var(--sm-danger)" : "var(--sm-black)" }} title={r.is_bundle ? "구성품으로 만들 수 있는 세트 수(가용)" : undefined}>{r.qty.toLocaleString()}<span className="sm-faint" style={{ fontWeight: 400, marginLeft: 2 }}>{r.is_bundle ? "세트" : r.unit}</span></td>
                  <td className="num b2b-money" title={r.promo_qty ? `프로모션 확보분 +${r.promo_qty.toLocaleString()} 포함` : undefined}>{r.auto_safety.toLocaleString()}{r.promo_qty ? <span style={{ color: "var(--sm-orange)", fontSize: 10, marginLeft: 2 }}></span> : null}</td>
                  <td className="num b2b-money">{r.daily_out ? r.daily_out.toLocaleString() : "-"}</td>
                  <td className="num b2b-money" style={{ color: r.depletion_days == null ? "var(--sm-text-light)" : r.depletion_days <= (meta?.leadDays ?? 10) ? "var(--sm-danger)" : "var(--sm-black)" }}>{r.depletion_days == null ? "-" : `${r.depletion_days}일`}</td>
                  <td className="num b2b-money" style={{ color: r.period_in ? "var(--sm-success)" : "var(--sm-text-light)" }}>{r.period_in ? r.period_in.toLocaleString() : "-"}</td>
                  <td className="num b2b-money" style={{ color: r.period_out ? "var(--sm-info)" : "var(--sm-text-light)" }}>{r.period_out ? r.period_out.toLocaleString() : "-"}</td>
                  <td className="num b2b-money">{r.value.toLocaleString()}</td>
                  <td className="num">{!pv.has ? <span className="sm-faint">-</span> : pv.recommend > 0 ? <strong style={{ color: "var(--sm-orange)" }}>{pv.recommend.toLocaleString()}</strong> : <span style={{ color: "var(--sm-text-light)" }}>0</span>}</td>
                  <td className="num">
                    {!pv.has || pv.requestByDays == null ? (
                      <span style={{ color: "var(--sm-text-light)" }}>-</span>
                    ) : pv.requestByDays <= 0 ? (
                      <span className="inv-dl-cell-urgent">지금!</span>
                    ) : (
                      <span className={pv.requestByDays <= 7 ? "inv-dl-cell-soon" : "inv-dl-cell-ok"}>
                        D-{pv.requestByDays}{pv.requestBy && <span className="inv-dl-cell-date"> {pv.requestBy.slice(5)}</span>}
                      </span>
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}><button className="b2b-btn-secondary" style={{ padding: "4px 6px", fontSize: 11.5, whiteSpace: "nowrap" }} onClick={() => setModalFor(r.product_id)}>입·출·조정</button></td>
                  <td className="num" onClick={(e) => e.stopPropagation()}>
                    {adj ? (
                      <button type="button" className="inv-adj-btn" onClick={() => openEdit(adj)} title={adj.adjustMemo || "안전재고 보정"}>
                        {adj.adjustRaw !== 0 || adj.adjustExcludeRaw > 0 ? (
                          <span className={adj.adjustRaw !== 0 && adj.adjust === 0 && adj.adjustUntil ? "inv-adj-expired" : "inv-adj-set"}>
                            {adj.adjustExcludeRaw > 0 && <>행사−{adj.adjustExcludeRaw.toLocaleString()}</>}
                            {adj.adjustExcludeRaw > 0 && adj.adjustRaw !== 0 ? " " : ""}
                            {adj.adjustRaw !== 0 && <>{adj.adjustRaw > 0 ? "+" : ""}{adj.adjustRaw.toLocaleString()}</>}
                            {adj.adjustUntil && <span className="inv-adj-until">~{adj.adjustUntil.slice(5)}</span>}
                          </span>
                        ) : (
                          <span className="inv-adj-empty">+ 보정</span>
                        )}
                      </button>
                    ) : (
                      <span style={{ color: "var(--sm-text-light)" }}>-</span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modalFor && (
        <TxnModal
          products={products}
          qtyOf={qtyOf}
          defaultProductId={modalFor === "__new__" ? "" : modalFor}
          defaultChannel={writeChannelOf(channel)}
          qtySource={channel}
          lockProduct={modalFor !== "__new__"}
          onClose={() => setModalFor("")}
          onSaved={() => { setModalFor(""); load(); }}
        />
      )}

      {promoOpen && (
        <PromoManager
          products={rows.map((r) => ({ sku: r.sku, name: r.name, spec: r.spec }))}
          onClose={() => setPromoOpen(false)}
          onChanged={() => { load(); prodLoad(); }}
        />
      )}

      {editRow && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">안전재고 보정 — {editRow.name}</span>
              <button className="b2b-modal-close" onClick={() => setEditRow(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <p className="inv-modal-auto">
                지금 <strong>평상시 하루 {editRow.dailyOut.toFixed(1)}개</strong>씩 나가서 자동 안전재고가 <strong>{editRow.autoSafety.toLocaleString()}개</strong>입니다{editRow.promoQty > 0 && <> (+ 예정 행사 {editRow.promoQty.toLocaleString()})</>}. 행사로 평소보다 많이 나갔다면 그 출고를 빼고, 더 확보할 게 있으면 더하세요.
              </p>
              <label className="b2b-field">
                <span className="b2b-field-label">① 행사 출고 빼기 (개)</span>
                <input className="b2b-input" type="number" min={0} value={eExclude} onChange={(e) => setEExclude(e.target.value)} placeholder="예: 500" />
                <span className="inv-field-hint">최근 {spanDays}일간 <strong>행사·이벤트로</strong> 평소보다 많이 나간 출고량. 이만큼은 평상시 속도에서 빼서 안전재고를 정상치로 낮춥니다.</span>
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">② 추가 확보 (개)</span>
                <input className="b2b-input" type="number" value={eDelta} onChange={(e) => setEDelta(e.target.value)} placeholder="예: 200 (음수도 가능)" />
                <span className="inv-field-hint">앞으로 더 만들어둘 양을 안전재고에 더합니다.</span>
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">사유 (선택)</span>
                <input className="b2b-input" type="text" value={eMemo} onChange={(e) => setEMemo(e.target.value)} placeholder="예: 여름 프로모션" />
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">만료일 (선택) — 지나면 자동 해제</span>
                <input className="b2b-input" type="date" value={eUntil} onChange={(e) => setEUntil(e.target.value)} />
              </label>
              <p className="inv-modal-preview">
                {(() => {
                  const sd = Math.max(1, spanDays);
                  const baseDaily = editRow.dailyOut + (editRow.adjustExcludeRaw || 0) / sd; // 기존 행사출고 빼기 되돌린 평상시
                  const newDaily = Math.max(0, baseDaily - (Number(eExclude) || 0) / sd);
                  const newAuto = Math.ceil(newDaily * prodLead);
                  const newSafety = Math.max(0, newAuto + editRow.promoQty + (Number(eDelta) || 0));
                  return (
                    <>적용 후 안전재고 ≈ <strong>{newSafety.toLocaleString()}</strong> <span style={{ color: "var(--sm-text-light)", fontWeight: 400 }}>(하루 {newDaily.toFixed(1)}×{prodLead}일{editRow.promoQty > 0 ? ` +행사 ${editRow.promoQty}` : ""}{(Number(eDelta) || 0) !== 0 ? ` +확보 ${Number(eDelta) || 0}` : ""})</span></>
                  );
                })()}
              </p>
            </div>
            <div className="b2b-modal-foot">
              <button className="b2b-btn-secondary" onClick={() => { setEDelta(""); setEExclude(""); setEMemo(""); setEUntil(""); }}>초기화</button>
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setEditRow(null)}>취소</button>
                <button className="b2b-btn-primary" onClick={saveAdjust} disabled={saving}>{saving ? "저장 중..." : "저장"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
