"use client";

// 재고 목록 = 재고 + 생산 통합 화면(2026-07-29 — 구 /production/inventory '생산' 흡수).
//  기본 열(SKU·품목·현재고·안전재고·하루 출고·예상소진) + 재고(총입고·총출고·재고자산)
//  + 판단(입고 예정·권장생산) + 액션(입·출·조정). 체크 후 '선택 N종 생산 요청'을 누르면
//  '생산 요청' 메뉴로 이동해 새 생산 요청 창이 권장 수량 채워진 채 열린다(sessionStorage 핸드오프).
//  AI 조언도 이 화면에서.
//  재고 수치 = /api/inventory/overview, 생산 수치(권장생산) = /api/production/inventory
//  (소매·도매 필터 = 그 채널 수식, 전체 = 소매+도매 권장 합) — SKU 로 조인.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { OverviewRow } from "@/app/api/inventory/overview/route";
import { INV_TYPE_COLOR, INV_CHANNEL_COLOR, RESERVED_CHANNELS, type InvChannelFilter, type InventoryTxn } from "@/app/lib/inventory";
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
  adjustMemo: string; adjustUntil: string | null; safety: number; recommend: number; recommendGross?: number;
  inbound?: number; inboundDue?: string | null; // 입고 예정(열린 제조사 요청서 잔여) — 권장에서 이미 뺀 양
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
//  품목은 가중치를 25% 올렸다(112→140). 늘린 28px 은 여유가 남던 열에서 되가져와
//  합계(=TABLE_MIN)는 그대로다 — 1366 창의 무스크롤을 지키기 위해. 줄인 열도 헤더·내용이 잘리지 않는 걸 실측 확인했다.
const COL = {
  chk: 31, sku: 108, name: 140, qty: 72, daily: 78, dep: 76,
  inb: 84, rec: 76, pin: 64, pout: 64, val: 96, act: 78,
} as const;
// 전체 열 합 1106 — 사이드바(237)+스크롤바(15) 더해도 1366 창에 들어간다.
// 확정형 탭(프로모션·도매 대량)은 판단 열(체크·하루 출고·예상소진·입고 예정·권장생산)이 빠져 더 좁다.
const FULL_COLS = Object.keys(COL) as (keyof typeof COL)[];
const CONFIRMED_COLS: (keyof typeof COL)[] = ["sku", "name", "qty", "pin", "pout", "val", "act"];

// 정렬 가능한 컬럼(생산 열 포함)
type SortKey = "name" | "qty" | "inbound" | "depletion_days" | "period_in" | "period_out" | "daily_out" | "value" | "recommend" | "request_by";
const numKey = (r: OverviewRow, k: Exclude<SortKey, "recommend" | "request_by">): number | string =>
  k === "name" ? r.name
    : k === "depletion_days" ? (r.depletion_days ?? Number.POSITIVE_INFINITY)
    : k === "inbound" ? (r.inbound ?? 0)   // 선택 필드 — 없으면 0 으로 내려야 정렬이 NaN 으로 깨지지 않는다
    : (r[k] as number);

export default function InventoryPage() {
  const router = useRouter();
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [meta, setMeta] = useState<{ from: string; to: string; periodDays: number; leadDays: number; cycleDays?: number; horizonDays?: number; inboundOk?: boolean } | null>(null);
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
  // 확정형 탭(프로모션·도매 대량) — 행사·발주에 맞춰 채웠다 한 번에 나가는 칸이라 속도 기반 판단
  //  (하루 출고 평균·예상소진·권장생산·부족)이 무의미하다. 생산은 요청서에서 제조사와 협의(기획 5절).
  //  입고 예정도 숨긴다: 제조사 입고는 소매 칸으로 들어오므로 이 칸의 '들어올 양'이 아니다.
  const confirmedTab = (RESERVED_CHANNELS as readonly string[]).includes(channel);
  const cols = confirmedTab ? CONFIRMED_COLS : FULL_COLS;
  const tableMin = cols.reduce((a, k) => a + COL[k], 0);
  const pct = (px: number) => `${((px / tableMin) * 100).toFixed(3)}%`;
  // 변경 히스토리 창 — 품목명을 누르면 그 품목의 원장(누가 언제 무엇을 입·출·조정했는지)을 보여준다
  const [historyFor, setHistoryFor] = useState<OverviewRow | null>(null);
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
  const [prodLead, setProdLead] = useState(7); // 안전재고 지평(리드타임 + 발주 주기)
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
        setProdLead(r.horizonDays || r.leadDays || 7);
        setSpanDays(r.velocitySpanDays || 0);
      }
      if (w.ok) setWholeMap(new Map(((w.rows || []) as ProdRow[]).map((x) => [x.sku.toUpperCase(), x])));
      const bad = [!r.ok && "소매", !w.ok && "도매"].filter(Boolean).join("·");
      // 입고 예정 집계 실패는 반대 방향(권장 과대 = 시켜 둔 물량을 또 시킴) — 따로 알린다
      const inbBad = r.ok && r.inboundOk === false;
      setProdWarn(bad ? `${bad} 생산 수치를 불러오지 못했습니다 — 권장생산이 실제보다 적게 보일 수 있습니다.`
        : inbBad ? "'입고 예정'(열린 생산 요청서 잔여)을 불러오지 못했습니다 — 권장생산이 시켜 둔 물량을 빼지 못해 실제보다 클 수 있습니다." : "");
    } catch {
      setProdWarn("생산 수치를 불러오지 못했습니다 — 권장생산이 비어 있거나 실제보다 적게 보일 수 있습니다.");
    }
  }, []);
  useEffect(() => { prodLoad(); }, [prodLoad]);

  // 채널 필터에 맞는 생산 수치 뷰 — 전체는 소매+도매 권장 합(새 생산 요청 창의 제조사 권장과 동일 기준),
  //  retail 은 소매 원본 행(전체 탭에서 소매 수치를 함께 쓰는 곳이 있다).
  type ProdView = { has: boolean; recommend: number; requestByDays: number | null; requestBy: string | null; retail?: ProdRow; detail?: string };
  const prodView = useCallback((r: OverviewRow): ProdView => {
    const key = r.sku ? r.sku.toUpperCase() : null;
    const rr = key ? retailMap.get(key) : undefined;
    const ww = key ? wholeMap.get(key) : undefined;
    // 확정형 칸(프로모션·도매 대량)은 권장 수식이 없는 칸이다 — 생산은 요청서를 보며 제조사와 협의(협의 생산).
    //  합계를 빌려 쓰면 이 칸과 무관한 수를 보여줄 뿐 아니라, 체크 → '선택 N종 생산 요청'이 발주·행사와
    //  연결되지 않은 제조사(재고 보충) 요청서를 만든다(115 가 order_id·company_id 를 둔 취지와 반대).
    if (channel === "도매 대량" || channel === "프로모션") return { has: false, recommend: 0, requestByDays: null, requestBy: null, retail: rr };
    // 소매 탭도 합산값이다(기획 14절 '여덟 번째' — 합산값이 서는 곳은 전체 탭과 소매 탭, 둘 다
    //  제조사 요청서를 만드는 자리). 소매 net 을 두면 화면 숫자와 요청 창 수량이 어긋난다.
    if (channel === "도매") return { has: !!ww, recommend: ww?.recommend ?? 0, requestByDays: ww?.requestByDays ?? null, requestBy: ww?.requestBy ?? null, retail: rr };
    let days: number | null = null, by: string | null = null;
    for (const p of [rr, ww]) {
      if (p?.requestByDays == null) continue;
      if (days == null || p.requestByDays < days) { days = p.requestByDays; by = p.requestBy; }
    }
    // 전체 = max(0, ①(소매 원값) + ②(도매) − ⑤(입고 예정)). ⑤를 항 안에서 빼면 소매가 넉넉한 주에
    //  차감분이 통째로 사라져 이미 시킨 물량을 또 시킨다(기획 14절 '여덟 번째').
    const g1 = rr?.recommendGross ?? rr?.recommend ?? 0; // 구 응답 폴백 — recommendGross 없으면 net 값
    const g2 = ww?.recommend ?? 0;
    const inb = rr?.inbound ?? 0;
    const combined = Math.max(0, Math.round((g1 + g2 - inb) * 100) / 100);
    return {
      has: !!(rr || ww), recommend: combined, requestByDays: days, requestBy: by, retail: rr,
      detail: `권장 = 온라인 일반 ${g1.toLocaleString()} + 도매 일반 ${g2.toLocaleString()} − 입고 예정 ${inb.toLocaleString()}`,
    };
  }, [channel, retailMap, wholeMap]);

  const qtyOf = useCallback((id: string) => rows.find((r) => r.product_id === id)?.qty || 0, [rows]);
  const products = useMemo(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, unit: r.unit, is_bundle: r.is_bundle })), [rows]);
  const totals = useMemo(() => ({
    items: rows.length,
    value: rows.reduce((s, r) => s + r.value, 0),
    low: rows.filter((r) => r.low).length,
    out: rows.reduce((s, r) => s + r.period_out, 0),
  }), [rows]);
  // 생산 카드 — 권장 생산>0 = 안전재고(행사 반영) 미달과 동일 데이터라 하나만 노출. 채널 기준은 표와 동일.
  const prodStats = useMemo(() => {
    let needItems = 0, needQty = 0;
    const keys = new Set([...retailMap.keys(), ...wholeMap.keys()]);
    for (const k of keys) {
      const rr = retailMap.get(k), ww = wholeMap.get(k);
      // 카드도 표 권장 열과 같은 식 — 확정형 탭 0, 도매 탭 ②, 나머지는 max(0, ①원값+② − ⑤)
      const g1 = rr?.recommendGross ?? rr?.recommend ?? 0;
      const rec = channel === "도매 대량" || channel === "프로모션" ? 0
        : channel === "도매" ? (ww?.recommend ?? 0)
        : Math.max(0, Math.round((g1 + (ww?.recommend ?? 0) - (rr?.inbound ?? 0)) * 100) / 100);
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
      {label}<span style={{ marginLeft: 3, color: sort.key === k ? "var(--sm-orange)" : "var(--sm-text-light)", fontSize: 12 }}>{sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </th>
  );

  // ── 생산 요청 — 체크 후 버튼을 누르면 '생산 요청' 메뉴로 이동, 새 생산 요청 창이 권장 수량 채워져 열린다 ──
  const [sel, setSel] = useState<Set<string>>(new Set()); // product_id
  const selectable = useMemo(() => shown.filter((r) => prodView(r).recommend > 0), [shown, prodView]);
  const allChecked = selectable.length > 0 && selectable.every((r) => sel.has(r.product_id));
  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSel(allChecked ? new Set() : new Set([...sel, ...selectable.map((r) => r.product_id)]));
  useEffect(() => {
    setSel(new Set()); // 채널 바꾸면 선택 초기화(기준 데이터가 다름)
    if ((RESERVED_CHANNELS as readonly string[]).includes(channel)) {
      // 확정형 탭엔 숨긴 열이 있다 — 그 열로 정렬 중이었으면 현재고로, 부족 필터는 해제(부족 판정 없음)
      setSort((s) => (["daily_out", "depletion_days", "inbound", "recommend", "request_by"].includes(s.key) ? { key: "qty", dir: "desc" } : s));
      setOnlyLow(false);
    }
  }, [channel]);

  function goRequest() {
    const picked = rows.filter((r) => sel.has(r.product_id));
    if (!picked.length) return;
    // 도매 필터 → 도매 요청(도매 권장), 그 외 → 제조사 요청 = max(0, ①원값+② − ⑤).
    //  화면 권장 열(prodView)과 같은 값을 넘겨야 본 숫자와 채워지는 수량이 일치한다(기획 14절 #8).
    const purpose = channel === "도매" ? "도매 납품" : "재고 보충";
    const items = picked
      .filter((r) => r.sku)
      .map((r) => {
        const key = (r.sku as string).toUpperCase();
        const ww = wholeMap.get(key);
        const qty = purpose === "도매 납품" ? (ww?.recommend ?? 0) : prodView(r).recommend;
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
          {/* 확정형 탭엔 생산 판단 액션이 없다 — AI 조언·선택 생산 요청은 속도 기반 칸(전체·소매·도매) 전용 */}
          {!confirmedTab && <button className="b2b-btn-secondary" onClick={genAdvice} disabled={adviceLoading}>{adviceLoading ? "AI 분석 중..." : advice ? "다시 분석" : "AI 조언"}</button>}
          <button className="b2b-btn-secondary" onClick={() => setPromoOpen(true)} title="프로모션 기간·예상판매 등록 → 안전재고에 반영">프로모션</button>
          {!confirmedTab && (
            <button className="b2b-btn-primary" onClick={goRequest} disabled={sel.size === 0}
              title={sel.size === 0 ? "아래 표에서 품목을 체크하세요"
                : channel === "도매" ? "생산 요청 메뉴로 이동해 도매 요청 창을 엽니다 (권장 = 도매 수식)"
                : "생산 요청 메뉴로 이동해 제조사 요청 창을 엽니다 (권장 = 소매+도매 합)"}>
              {`선택 ${sel.size}종 생산 요청`}
            </button>
          )}
          <button className="b2b-btn-primary" onClick={() => setModalFor("__new__")}>+ 입·출·조정</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}
      {/* 확정형 탭엔 권장생산·입고 예정이 없으므로 그 얘기를 하는 경고도 띄우지 않는다 */}
      {!confirmedTab && (prodWarn || meta?.inboundOk === false) && <div className="sm-warn" style={{ marginBottom: 12 }}>{prodWarn || "'입고 예정'(열린 생산 요청서 잔여)을 불러오지 못했습니다 — 부족 판정·권장생산이 시켜 둔 물량을 빼지 못해 실제보다 크게 보일 수 있습니다."}</div>}

      {/* 데이터박스 — 재고 4 + 생산 2. 확정형 탭은 판단 카드(부족·생산 2종)를 뺀 3종만(판정 자체가 없다) */}
      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">품목 수</div><div className="b2b-stat-card-value">{totals.items}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 자산(원가)</div><div className="b2b-stat-card-value b2b-money">{totals.value.toLocaleString()}</div></div>
        {!confirmedTab && <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 부족</div><div className="b2b-stat-card-value" style={{ color: totals.low ? "var(--sm-danger)" : "var(--sm-black)" }}>{totals.low}건</div></div>}
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">기간 총출고</div><div className="b2b-stat-card-value b2b-money">{totals.out.toLocaleString()}</div></div>
        {!confirmedTab && <div className="b2b-stat-card"><div className="b2b-stat-card-label">생산 권장 품목</div><div className="b2b-stat-card-value" style={{ color: prodStats.needItems ? "var(--sm-orange)" : "var(--sm-black)" }}>{prodStats.needItems}종</div></div>}
        {!confirmedTab && <div className="b2b-stat-card"><div className="b2b-stat-card-label">총 권장 생산량</div><div className="b2b-stat-card-value b2b-money">{prodStats.needQty.toLocaleString()}</div></div>}
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
          {!confirmedTab && (
            <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>
              <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> 부족만 보기
            </label>
          )}
          {sel.size > 0 && <span className="sm-faint" style={{ fontSize: 12 }}>체크 {sel.size}종 (검색을 바꿔도 유지)</span>}
        </div>
        <input className="b2b-input" placeholder="품목·SKU·옵션·속성/분류 — 초성 가능 (예: ㄱㅇ)" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 300, maxWidth: "100%" }} />
      </div>

      {meta && (confirmedTab
        ? <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>기간 {meta.from} ~ {meta.to} ({meta.periodDays}일) · 이 칸은 {channel === "프로모션" ? "행사에 맞춰" : "선결제 발주에 맞춰"} 채웠다가 한 번에 나가는 확정형 확보분입니다 — 하루 출고·예상소진·권장생산을 계산하지 않습니다. 생산은 생산 요청 화면에서 요청서를 보며 제조사와 협의합니다</p>
        : <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>기간 {meta.from} ~ {meta.to} ({meta.periodDays}일) · 하루 출고·예상소진은 이 기간 기준 · 입고 예정·권장생산은 최근 30일 기준(도매 하루출고는 30일·90일 평균 중 큰 값, 대량 발주 제외) · 목표 = 하루출고 × {meta.cycleDays ? `지평 ${meta.leadDays + meta.cycleDays}일(리드타임 ${meta.leadDays} + 발주 주기 ${meta.cycleDays})` : `리드타임 ${meta.leadDays}일`} · {channel === "도매" ? "권장생산 = 목표 − 현재고 (도매는 입고 예정을 빼지 않습니다 — 제조사 입고는 소매로 들어오고 도매 부족은 소매→도매 이동으로 채웁니다)" : "권장생산 = max(0, 소매 목표 − 소매 재고) + 도매 권장 − 입고 예정 (제조사 요청 기준 — 숫자에 마우스를 올리면 내역)"} · ‘선택 N종 생산 요청’은 {channel === "도매" ? "도매" : "제조사"} 요청으로 화면 숫자 그대로 넘어갑니다</p>
      )}
      {!confirmedTab && adviceLoading && <div className="b2b-loading">AI가 판매추세·재고·발주를 종합해 분석 중입니다… (최대 1분)</div>}
      {!confirmedTab && advice && (
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
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.8, fontSize: 12, color: "var(--sm-text-mid)" }}>
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
          <table className="b2b-table inv-table" style={{ tableLayout: "fixed", minWidth: tableMin }}>
            <thead><tr>
              {!confirmedTab && <th style={{ width: pct(COL.chk) }}><input type="checkbox" checked={allChecked} onChange={toggleAll} title="권장 생산 있는 품목 전체 선택" /></th>}
              <th style={{ width: pct(COL.sku) }}>SKU</th><Th k="name" label="품목" w={pct(COL.name)} />
              {/* 상태(지금 어떤가) → 판단(무엇을 할까) → 참고(기간 실적). 결정 17.
                  확정형 탭은 판단 열이 통째로 빠진다 — 상태와 기간 실적만 남는다 */}
              <Th k="qty" label="현재고" num w={pct(COL.qty)} />
              {!confirmedTab && <><Th k="daily_out" label="하루 출고" num w={pct(COL.daily)} /><Th k="depletion_days" label="예상소진" num w={pct(COL.dep)} />
              <Th k="inbound" label="입고 예정" num w={pct(COL.inb)} /><Th k="recommend" label="권장생산" num w={pct(COL.rec)} /></>}
              <Th k="period_in" label="총입고" num w={pct(COL.pin)} /><Th k="period_out" label="총출고" num w={pct(COL.pout)} />
              <Th k="value" label="재고자산" num w={pct(COL.val)} />
              <th style={{ width: pct(COL.act) }}></th>
            </tr></thead>
            <tbody>
              {shown.map((r) => {
                const pv = prodView(r);
                const picked = sel.has(r.product_id);
                return (
                /* 줄 어디를 눌러도 선택 토글 — 체크박스·버튼 칸은 아래에서 전파를 막는다 */
                <tr key={r.product_id}
                  className={`${pv.has ? "is-pick" : ""} ${picked ? "is-sel" : ""}`}
                  onClick={pv.has ? () => toggleSel(r.product_id) : undefined}
                  >
                  {!confirmedTab && <td onClick={(e) => e.stopPropagation()}>{pv.has ? <input type="checkbox" checked={picked} onChange={() => toggleSel(r.product_id)} /> : null}</td>}
                  <td className="sm-faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sku || "-"}</td>
                  {/* 비례 배분이라 넓은 화면에서도 품목 폭이 무한정 늘지는 않는다 → 잘린 이름은 마우스를 올려 확인 */}
                  <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${r.name}${r.spec ? ` ${r.spec}` : ""} — 누르면 변경 히스토리`} onClick={(e) => e.stopPropagation()}>
                    {/* 품목명 클릭 = 히스토리. 줄의 다른 곳 클릭 = 선택 토글(기존 동작 유지) */}
                    <button type="button" onClick={() => setHistoryFor(r)}
                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", textAlign: "left", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name}
                      {r.spec ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{r.spec}</span> : null}
                      {r.is_bundle ? <span className="b2b-status-pill" style={{ marginLeft: 6, background: "var(--sm-orange-light)", color: "var(--sm-orange)" }}>세트</span> : null}
                    </button>
                  </td>
                  <td className="num b2b-money" style={{ fontWeight: 700 }} title={r.is_bundle ? "구성품으로 만들 수 있는 세트 수(가용)" : undefined}>
                    {r.qty.toLocaleString()}<span className="sm-faint" style={{ fontWeight: 400, marginLeft: 2 }}>{r.is_bundle ? "세트" : r.unit}</span>
                    {(r.promo_pool ?? 0) > 0 && <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 4, color: "var(--sm-warning)" }} title="프로모션 칸 확보분 — 소매 계산(권장생산·부족)에는 들어가지 않습니다. 행사 생산은 요청서를 보며 제조사와 협의합니다">+프로모션 {r.promo_pool.toLocaleString()}</span>}
                  </td>
                  {!confirmedTab && <td className="num b2b-money">{r.daily_out ? r.daily_out.toLocaleString() : "-"}</td>}
                  {/* 예상소진 = 창고(현재고)만 기준. 입고 예정이 있으면 '입고 예정일 전에 바닥나는가'로 빨강을 판정 —
                      리드타임만 보면 시켜 둔 물량이 곧 오는데도 부족·권장(포지션 기준)과 신호가 엇갈린다 */}
                  {!confirmedTab && (() => {
                    const dep = r.depletion_days;
                    const inbDays = r.inbound_due ? Math.max(0, Math.round((Date.parse(r.inbound_due + "T00:00:00Z") - Date.parse(TODAY() + "T00:00:00Z")) / 86400_000)) : null;
                    const red = dep != null && ((r.inbound ?? 0) > 0 && inbDays != null ? dep < inbDays : dep <= (meta?.leadDays ?? 7));
                    const posDays = dep != null && r.daily_out > 0 ? Math.floor((r.qty + (r.inbound ?? 0)) / r.daily_out) : null;
                    const tip = dep == null ? undefined : (r.inbound ?? 0) > 0
                      ? `창고 기준 ${dep}일 · 입고 예정 ${r.inbound.toLocaleString()} 포함 시 ${posDays ?? "-"}일${r.inbound_due ? ` (마감 ${r.inbound_due.slice(5)}${inbDays != null ? `, ${inbDays}일 뒤` : ""})` : ""}${red ? " — 입고 전에 바닥날 수 있음" : ""}`
                      : `창고 기준 ${dep}일`;
                    return <td className="num b2b-money" title={tip} style={{ color: dep == null ? "var(--sm-text-light)" : red ? "var(--sm-danger)" : "var(--sm-black)" }}>{dep == null ? "-" : `${dep}일`}</td>;
                  })()}
                  {/* 입고 예정 = 시켜 두고 아직 안 온 양(열린 제조사 요청서 잔여). 권장생산이 이미 뺀 값이다.
                      확정형 탭엔 없다 — 제조사 입고는 소매 칸으로 들어오므로 이 칸의 '들어올 양'이 아니다 */}
                  {!confirmedTab && <td className="num b2b-money" style={{ color: (r.inbound ?? 0) > 0 ? "var(--sm-info)" : "var(--sm-text-light)" }}
                    title={(r.inbound ?? 0) > 0 ? `열린 제조사 요청서에 남은 양 — 권장생산에서 이미 뺐습니다\n${r.inbound_detail || ""}` : undefined}>
                    {(r.inbound ?? 0) > 0 ? r.inbound.toLocaleString() : "-"}
                    {(r.inbound ?? 0) > 0 && r.inbound_due ? <span className="sm-faint" style={{ display: "block", fontSize: 11 }}>마감 {r.inbound_due.slice(5)}{(r.inbound_overdue ?? 0) > 0 ? <span style={{ color: "var(--sm-warning)" }}> 지남</span> : null}</span> : null}
                  </td>}
                  {!confirmedTab && <td className="num" title={pv.detail}>{!pv.has ? <span className="sm-faint">-</span> : pv.recommend > 0 ? <strong style={{ color: "var(--sm-orange)" }}>{pv.recommend.toLocaleString()}</strong> : <span style={{ color: "var(--sm-text-light)" }}>0</span>}</td>}
                  <td className="num b2b-money" style={{ color: r.period_in ? "var(--sm-success)" : "var(--sm-text-light)" }}>{r.period_in ? r.period_in.toLocaleString() : "-"}</td>
                  <td className="num b2b-money" style={{ color: r.period_out ? "var(--sm-info)" : "var(--sm-text-light)" }}>{r.period_out ? r.period_out.toLocaleString() : "-"}</td>
                  <td className="num b2b-money">{r.value.toLocaleString()}</td>
                  <td onClick={(e) => e.stopPropagation()}><button className="b2b-btn-secondary" style={{ padding: "4px 6px", fontSize: 12, whiteSpace: "nowrap" }} onClick={() => setModalFor(r.product_id)}>입·출·조정</button></td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 품목 변경 히스토리 — 원장 공용 테이블(TxnTable) 재사용. 행 취소 시 재고가 원복되므로 목록도 다시 읽는다 */}
      {historyFor && (
        <div className="b2b-modal-backdrop" onClick={() => setHistoryFor(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 940 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">
                변경 히스토리 — {historyFor.name}{historyFor.spec ? ` ${historyFor.spec}` : ""}
                <span className="sm-faint" style={{ marginLeft: 10, fontSize: 13, fontWeight: 400 }}>
                  현재고 {historyFor.qty.toLocaleString()}{historyFor.is_bundle ? "세트" : historyFor.unit}
                </span>
              </span>
              <button className="b2b-modal-close" onClick={() => setHistoryFor(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 10px" }}>
                입고·출고·조정 원장입니다(관측 용도). ‘담당’이 그 처리를 한 사람이고, 발주·발송 연동 건은 메모에 출처가 적혀 있습니다.
                ‘재고’는 그 거래가 속한 재고 칸(소매·도매·프로모션·도매 대량) 기준으로 거래 전후의 수량입니다.
              </p>
              <ProductHistory productId={historyFor.product_id} />
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setHistoryFor(null)}>닫기</button>
              </div>
            </div>
          </div>
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

    </div>
  );
}

// 품목 변경 히스토리(관측 전용) — 원장 공용 TxnTable 과 달리 품목·단가·취소를 빼고,
//  각 거래 전후의 재고(그 거래 채널 기준)를 보여준다. 취소가 필요하면 활동 히스토리 메뉴에서.
//  재고 변화는 전체 이력의 누적합으로 계산하므로 한도(2000건)를 넘는 품목은 표시하지 않는다 —
//  잘린 이력으로 계산하면 숫자가 통째로 틀어진다.
function ProductHistory({ productId }: { productId: string }) {
  const [rows, setRows] = useState<InventoryTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError("");
      try {
        const j = await (await fetch(`/api/inventory/txns?product_id=${encodeURIComponent(productId)}&limit=2000`, { cache: "no-store" })).json();
        if (!j.ok) throw new Error(j.error || "조회 실패");
        if (alive) setRows(j.rows || []);
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "조회 오류"); }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [productId]);

  // API 는 최신순 — 과거→현재로 뒤집어 누적합(전후 재고)을 만들고 다시 최신순으로 보여준다.
  //  잔고는 '그 거래의 채널' 기준 — 합계 기준으로 보여주면 도매 출고 행에 소매까지 합친 숫자가 떠서
  //  "도매 출고인데 소매에서 빠졌다"는 오해가 생겼다(실데이터 검증으로 채널 차감은 정상이었음).
  const withBalance = useMemo(() => {
    const asc = [...rows].reverse();
    const balByCh = new Map<string, number>();
    const out = asc.map((t) => {
      const ch = t.channel || "소매"; // 구버전(채널 컬럼 이전) 기록은 소매로 취급 — 조회 화면과 동일 규칙
      const before = balByCh.get(ch) || 0;
      const after = Math.round((before + (Number(t.qty) || 0)) * 100) / 100;
      balByCh.set(ch, after);
      return { ...t, before, after };
    });
    return out.reverse();
  }, [rows]);
  const complete = rows.length < 2000; // 2000건 미만이면 전체 이력 = 누적합이 정확하다

  if (loading) return <div className="b2b-loading">불러오는 중...</div>;
  if (error) return <div className="b2b-error">{error}</div>;
  if (rows.length === 0) return <div className="b2b-empty">내역이 없습니다.</div>;

  return (
    <div className="b2b-table-wrap" style={{ maxHeight: 440, overflow: "auto" }}>
      <table className="b2b-table">
        <thead><tr><th>거래일</th><th>유형</th><th>채널</th><th className="num">수량</th><th className="num">재고</th><th>거래처</th><th>메모</th><th>담당</th></tr></thead>
        <tbody>
          {withBalance.map((t) => {
            const c = INV_TYPE_COLOR[t.type];
            const ch = t.channel ? INV_CHANNEL_COLOR[t.channel] : null;
            return (
              <tr key={t.id}>
                <td style={{ whiteSpace: "nowrap" }}>{t.txn_date?.slice(5)}</td>
                <td><span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{t.type}</span></td>
                <td>{ch ? <span className="b2b-status-pill" style={{ background: ch.bg, color: ch.fg }}>{t.channel}</span> : <span className="sm-faint">-</span>}</td>
                <td className="num b2b-money" style={{ color: c.fg, fontWeight: 700 }}>{t.qty > 0 ? "+" : ""}{t.qty.toLocaleString()}</td>
                <td className="num b2b-money" style={{ whiteSpace: "nowrap" }}>
                  {complete
                    ? <><span className="sm-faint">{t.before.toLocaleString()}</span> → <strong>{t.after.toLocaleString()}</strong></>
                    : <span className="sm-faint">-</span>}
                </td>
                <td>{t.partner || "-"}</td>
                <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.memo || ""}>{t.memo || "-"}</td>
                <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{t.created_by || "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!complete && <p className="sm-faint" style={{ fontSize: 12, padding: "6px 2px" }}>이력이 2,000건을 넘어 재고 전후 표시는 생략했습니다.</p>}
    </div>
  );
}
