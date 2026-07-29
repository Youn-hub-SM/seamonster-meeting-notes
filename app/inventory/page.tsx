"use client";

// 재고 목록 = 재고 + 생산 통합 화면(2026-07-29 — 구 /production/inventory '생산' 흡수).
//  기본 열(SKU·품목·현재고·안전재고·하루 출고·예상소진) + 재고(총입고·총출고·재고자산)
//  + 생산(권장생산·주문필요) + 액션(입·출·조정 / 보정). 체크 후 '선택 N종 생산 요청'으로
//  요청 생성(제조사/도매), AI 조언도 이 화면에서.
//  재고 수치 = /api/inventory/overview, 생산 수치(권장·주문필요·보정) = /api/production/inventory
//  (채널: 도매 필터면 도매, 그 외(전체·소매)는 소매 기준) — SKU 로 조인.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { OverviewRow } from "@/app/api/inventory/overview/route";
import type { InvChannelFilter } from "@/app/lib/inventory";
import TxnModal from "./TxnModal";
import { ChannelFilter, writeChannelOf } from "./ChannelTabs";
import PromoManager from "@/app/components/PromoManager";
import { matchKoQuery } from "@/app/lib/hangul";
import { addBusinessDays } from "@/app/lib/business-days";

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

  // ── 생산 수치 — 도매 필터면 도매 기준, 그 외는 소매 기준(판매 채널) ──
  const prodChannel = channel === "도매" ? "도매" : "소매";
  const [prodMap, setProdMap] = useState<Map<string, ProdRow>>(new Map());
  const [prodLead, setProdLead] = useState(10);
  const [spanDays, setSpanDays] = useState(0);
  const prodLoad = useCallback(async () => {
    try {
      const j = await (await fetch(`/api/production/inventory?channel=${encodeURIComponent(prodChannel)}`, { cache: "no-store" })).json();
      if (!j.ok) return;
      setProdMap(new Map(((j.rows || []) as ProdRow[]).map((r) => [r.sku.toUpperCase(), r])));
      setProdLead(j.leadDays || 10);
      setSpanDays(j.velocitySpanDays || 0);
    } catch { /* 생산 수치 없이도 재고 화면은 동작 */ }
  }, [prodChannel]);
  useEffect(() => { prodLoad(); }, [prodLoad]);
  const prodOf = useCallback((r: OverviewRow): ProdRow | undefined => (r.sku ? prodMap.get(r.sku.toUpperCase()) : undefined), [prodMap]);

  const qtyOf = useCallback((id: string) => rows.find((r) => r.product_id === id)?.qty || 0, [rows]);
  const products = useMemo(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, unit: r.unit })), [rows]);
  const totals = useMemo(() => ({
    items: rows.length,
    value: rows.reduce((s, r) => s + r.value, 0),
    low: rows.filter((r) => r.low).length,
    out: rows.reduce((s, r) => s + r.period_out, 0),
  }), [rows]);
  // 생산 카드 — 권장 생산>0 = 안전재고(행사·보정 반영) 미달과 동일 데이터라 하나만 노출
  const prodStats = useMemo(() => {
    let needItems = 0, needQty = 0;
    for (const p of prodMap.values()) if (p.recommend > 0) { needItems++; needQty += p.recommend; }
    return { needItems, needQty };
  }, [prodMap]);

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
      if (key === "recommend") return prodOf(r)?.recommend ?? -1;
      if (key === "request_by") return prodOf(r)?.requestByDays ?? Number.POSITIVE_INFINITY;
      return numKey(r, key);
    };
    return [...f].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb), "ko") * mul;
      return (va - vb) * mul;
    });
  }, [rows, search, onlyLow, sort, prodOf]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }
  const Th = ({ k, label, num, w }: { k: SortKey; label: string; num?: boolean; w?: number }) => (
    <th className={num ? "num" : undefined} onClick={() => toggleSort(k)} style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none", width: w }} title="클릭하여 정렬">
      {label}<span style={{ marginLeft: 3, color: sort.key === k ? "var(--sm-orange)" : "var(--sm-text-light)", fontSize: 10 }}>{sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </th>
  );

  // ── 생산 요청 만들기 — 체크 → 수량 확인 → 생성(생산 요청 목록으로 이동) ──
  const [sel, setSel] = useState<Set<string>>(new Set()); // product_id
  const [creating, setCreating] = useState(false);
  type ReqLine = { product_id: string; sku: string | null; name: string; recommend: number; qty: string };
  const [reqDraft, setReqDraft] = useState<{ lines: ReqLine[] } | null>(null);
  const [reqDue, setReqDue] = useState("");
  const [reqPurpose, setReqPurpose] = useState<"재고 보충" | "도매 납품">("재고 보충");
  const selectable = useMemo(() => shown.filter((r) => (prodOf(r)?.recommend ?? 0) > 0), [shown, prodOf]);
  const allChecked = selectable.length > 0 && selectable.every((r) => sel.has(r.product_id));
  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSel(allChecked ? new Set() : new Set([...sel, ...selectable.map((r) => r.product_id)]));
  useEffect(() => { setSel(new Set()); }, [channel]); // 채널 바꾸면 선택 초기화(기준 데이터가 다름)

  function openRequestDraft() {
    const picked = rows.filter((r) => sel.has(r.product_id));
    if (!picked.length) return;
    const lines: ReqLine[] = picked.map((r) => {
      const rec = prodOf(r)?.recommend ?? 0;
      return { product_id: r.product_id, sku: r.sku, name: r.name, recommend: rec, qty: rec > 0 ? String(rec) : "" };
    });
    setReqDue(addBusinessDays(TODAY(), 7));
    setReqPurpose(channel === "도매" ? "도매 납품" : "재고 보충");
    setReqDraft({ lines });
  }
  async function submitRequest() {
    if (!reqDraft || creating) return;
    const items = reqDraft.lines
      .map((l) => ({ product_id: l.product_id, requested_qty: Math.max(0, Math.round(Number(l.qty) || 0)) }))
      .filter((it) => it.requested_qty > 0);
    if (!items.length) { setError("수량을 1개 이상 입력하세요."); return; }
    setCreating(true); setError("");
    try {
      const c = await (await fetch("/api/production/requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "재고 목록에서 생성", purpose: reqPurpose, due_date: reqDue || undefined, items }),
      })).json();
      if (!c.ok) throw new Error(c.error || "요청 생성 실패");
      router.push("/production/request"); // 생산 요청 목록에서 확인(일정에도 마감일 기준 반영)
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청 생성 실패");
      setCreating(false);
    }
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
          <button className="b2b-btn-primary" onClick={openRequestDraft} disabled={sel.size === 0 || creating} title={sel.size === 0 ? "아래 표에서 품목을 체크하세요" : undefined}>
            {creating ? "요청 중…" : `선택 ${sel.size}종 생산 요청`}
          </button>
          <button className="b2b-btn-primary" onClick={() => setModalFor("__new__")}>+ 입·출·조정</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}

      {/* 데이터박스 6종 — 재고 4 + 생산 2 (생산 권장 품목 = 안전재고(행사·보정 반영) 미달과 동일 데이터라 통합) */}
      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">품목 수</div><div className="b2b-stat-card-value">{totals.items}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 자산(원가)</div><div className="b2b-stat-card-value b2b-money">{totals.value.toLocaleString()}원</div></div>
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

      {meta && <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>기간 {meta.from} ~ {meta.to} ({meta.periodDays}일) · 안전재고 = 일평균소진 × 리드타임 {meta.leadDays}일 + 프로모션 확보분 · 권장생산·주문필요는 {prodChannel} 기준</p>}

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
          {/* tableLayout fixed — 내용 길이와 무관하게 열 폭 고정 */}
          <table className="b2b-table" style={{ tableLayout: "fixed", minWidth: 1620 }}>
            <thead><tr>
              <th style={{ width: 34 }}><input type="checkbox" checked={allChecked} onChange={toggleAll} title="권장 생산 있는 품목 전체 선택" /></th>
              <th style={{ width: 150 }}>SKU</th><Th k="name" label="품목" />
              <Th k="qty" label="현재고" num w={110} /><Th k="auto_safety" label="안전재고" num w={120} /><Th k="daily_out" label="하루 출고" num w={110} /><Th k="depletion_days" label="예상소진" num w={110} />
              <Th k="period_in" label="총입고" num w={110} /><Th k="period_out" label="총출고" num w={110} />
              <Th k="value" label="재고자산" num w={130} />
              <Th k="recommend" label="권장생산" num w={110} /><Th k="request_by" label="주문필요" num w={130} />
              <th style={{ width: 110 }}></th><th className="num" style={{ width: 96 }}>보정</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => {
                const p = prodOf(r);
                return (
                <tr key={r.product_id} style={{ background: r.low ? "var(--sm-danger-bg)" : undefined }}>
                  <td>{p ? <input type="checkbox" checked={sel.has(r.product_id)} onChange={() => toggleSel(r.product_id)} /> : null}</td>
                  <td className="sm-faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sku || "-"}</td>
                  <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><strong>{r.name}</strong>{r.spec ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{r.spec}</span> : null}{r.is_bundle ? <span className="b2b-status-pill" style={{ marginLeft: 6, background: "var(--sm-orange-light)", color: "var(--sm-orange)" }}>세트</span> : null}</td>
                  <td className="num b2b-money" style={{ fontWeight: 700, color: r.low ? "var(--sm-danger)" : "var(--sm-black)" }} title={r.is_bundle ? "구성품으로 만들 수 있는 세트 수(가용)" : undefined}>{r.qty.toLocaleString()}<span className="sm-faint" style={{ fontWeight: 400, marginLeft: 2 }}>{r.is_bundle ? "세트" : r.unit}</span></td>
                  <td className="num b2b-money" title={r.promo_qty ? `프로모션 확보분 +${r.promo_qty.toLocaleString()} 포함` : undefined}>{r.auto_safety.toLocaleString()}{r.promo_qty ? <span style={{ color: "var(--sm-orange)", fontSize: 10, marginLeft: 2 }}></span> : null}</td>
                  <td className="num b2b-money">{r.daily_out ? r.daily_out.toLocaleString() : "-"}</td>
                  <td className="num b2b-money" style={{ color: r.depletion_days == null ? "var(--sm-text-light)" : r.depletion_days <= (meta?.leadDays ?? 10) ? "var(--sm-danger)" : "var(--sm-black)" }}>{r.depletion_days == null ? "-" : `${r.depletion_days}일`}</td>
                  <td className="num b2b-money" style={{ color: r.period_in ? "var(--sm-success)" : "var(--sm-text-light)" }}>{r.period_in ? r.period_in.toLocaleString() : "-"}</td>
                  <td className="num b2b-money" style={{ color: r.period_out ? "var(--sm-info)" : "var(--sm-text-light)" }}>{r.period_out ? r.period_out.toLocaleString() : "-"}</td>
                  <td className="num b2b-money">{r.value.toLocaleString()}</td>
                  <td className="num">{!p ? <span className="sm-faint">-</span> : p.recommend > 0 ? <strong style={{ color: "var(--sm-orange)" }}>{p.recommend.toLocaleString()}</strong> : <span style={{ color: "var(--sm-text-light)" }}>0</span>}</td>
                  <td className="num">
                    {!p || p.requestByDays == null ? (
                      <span style={{ color: "var(--sm-text-light)" }}>-</span>
                    ) : p.requestByDays <= 0 ? (
                      <span className="inv-dl-cell-urgent">지금!</span>
                    ) : (
                      <span className={p.requestByDays <= 7 ? "inv-dl-cell-soon" : "inv-dl-cell-ok"}>
                        D-{p.requestByDays}{p.requestBy && <span className="inv-dl-cell-date"> {p.requestBy.slice(5)}</span>}
                      </span>
                    )}
                  </td>
                  <td><button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setModalFor(r.product_id)}>입·출·조정</button></td>
                  <td className="num">
                    {p && prodChannel === "소매" ? (
                      <button type="button" className="inv-adj-btn" onClick={() => openEdit(p)} title={p.adjustMemo || "안전재고 보정"}>
                        {p.adjustRaw !== 0 || p.adjustExcludeRaw > 0 ? (
                          <span className={p.adjustRaw !== 0 && p.adjust === 0 && p.adjustUntil ? "inv-adj-expired" : "inv-adj-set"}>
                            {p.adjustExcludeRaw > 0 && <>행사−{p.adjustExcludeRaw.toLocaleString()}</>}
                            {p.adjustExcludeRaw > 0 && p.adjustRaw !== 0 ? " " : ""}
                            {p.adjustRaw !== 0 && <>{p.adjustRaw > 0 ? "+" : ""}{p.adjustRaw.toLocaleString()}</>}
                            {p.adjustUntil && <span className="inv-adj-until">~{p.adjustUntil.slice(5)}</span>}
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

      {/* 수량 확인 모달 — 체크한 품목의 실제 요청 수량을 입력해 요청 처리 */}
      {reqDraft && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">생산 요청 — 수량 확인</h2>
              <button className="b2b-modal-close" onClick={() => setReqDraft(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                <label className="sm-col" style={{ gap: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>요청</span>
                  <div className="sm-tabs" style={{ margin: 0 }}>
                    {(["재고 보충", "도매 납품"] as const).map((pp) => (
                      <button key={pp} type="button" className={`sm-tab ${reqPurpose === pp ? "is-active" : ""}`} onClick={() => setReqPurpose(pp)}>{pp === "재고 보충" ? "제조사" : "도매"}</button>
                    ))}
                  </div>
                </label>
                <label className="sm-col" style={{ gap: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>생산마감일 <span style={{ fontWeight: 400, color: "var(--sm-text-light)" }}>· 기본 7영업일</span></span>
                  <input type="date" className="b2b-input" style={{ width: 150 }} value={reqDue} onChange={(e) => setReqDue(e.target.value)} />
                </label>
              </div>

              <table className="b2b-table" style={{ fontSize: 13 }}>
                <thead><tr><th>품목</th><th className="num">권장</th><th className="num" style={{ width: 120 }}>요청 수량</th><th style={{ width: 36 }}></th></tr></thead>
                <tbody>
                  {reqDraft.lines.map((l, i) => (
                    <tr key={l.product_id}>
                      <td>{l.name} <code style={{ fontSize: 11 }} className="sm-faint">{l.sku || ""}</code></td>
                      <td className="num">{l.recommend > 0 ? l.recommend.toLocaleString() : <span className="sm-faint">-</span>}</td>
                      <td className="num">
                        <input className="b2b-input b2b-money" type="number" min={0} value={l.qty} placeholder="0"
                          onChange={(e) => setReqDraft((d) => d && ({ ...d, lines: d.lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)) }))}
                          style={{ width: 100, textAlign: "right", padding: "6px 8px" }} />
                      </td>
                      <td>{reqDraft.lines.length > 1 && (
                        <button className="b2b-link-btn" style={{ color: "var(--sm-text-light)" }} aria-label="빼기"
                          onClick={() => setReqDraft((d) => d && ({ ...d, lines: d.lines.filter((_, j) => j !== i) }))}>✕</button>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>수량 0인 품목은 요청에서 빠집니다. 요청 후 수정은 ‘생산 요청’ 메뉴의 ‘수정’에서.</p>
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setReqDraft(null)} disabled={creating}>취소</button>
                <button className="b2b-btn-primary" onClick={submitRequest} disabled={creating}>{creating ? "요청 중…" : "요청 처리"}</button>
              </div>
            </div>
          </div>
        </div>
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
