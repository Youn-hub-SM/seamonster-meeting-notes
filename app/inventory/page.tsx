"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { OverviewRow } from "@/app/api/inventory/overview/route";
import type { InvChannelFilter } from "@/app/lib/inventory";
import TxnModal from "./TxnModal";
import { ChannelFilter, writeChannelOf } from "./ChannelTabs";
import PromoManager from "@/app/components/PromoManager";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
function shift(iso: string, n: number) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

const PERIODS = [["일일", 1], ["7일", 7], ["14일", 14], ["30일", 30], ["지정", 0]] as const;
type PMode = (typeof PERIODS)[number][0];

// 정렬 가능한 컬럼
type SortKey = "name" | "qty" | "auto_safety" | "depletion_days" | "period_in" | "period_out" | "daily_out" | "value";
const numKey = (r: OverviewRow, k: SortKey): number | string =>
  k === "name" ? r.name : k === "depletion_days" ? (r.depletion_days ?? Number.POSITIVE_INFINITY) : (r[k] as number);

export default function InventoryPage() {
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

  const qtyOf = useCallback((id: string) => rows.find((r) => r.product_id === id)?.qty || 0, [rows]);
  const products = useMemo(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, unit: r.unit })), [rows]);
  const totals = useMemo(() => ({
    items: rows.length,
    value: rows.reduce((s, r) => s + r.value, 0),
    low: rows.filter((r) => r.low).length,
    out: rows.reduce((s, r) => s + r.period_out, 0),
  }), [rows]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const f = rows.filter((r) => {
      if (onlyLow && !r.low) return false;
      if (q && !(`${r.name} ${r.sku || ""} ${r.spec || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    return [...f].sort((a, b) => {
      const va = numKey(a, key), vb = numKey(b, key);
      if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb), "ko") * mul;
      return (va - vb) * mul;
    });
  }, [rows, search, onlyLow, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }
  const Th = ({ k, label, num }: { k: SortKey; label: string; num?: boolean }) => (
    <th className={num ? "num" : undefined} onClick={() => toggleSort(k)} style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" }} title="클릭하여 정렬">
      {label}<span style={{ marginLeft: 3, color: sort.key === k ? "var(--sm-orange)" : "var(--sm-text-light)", fontSize: 10 }}>{sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </th>
  );

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고 목록</h1>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={() => setPromoOpen(true)} title="프로모션 기간·예상판매 등록 → 안전재고에 반영">프로모션</button>
          <button className="b2b-btn-primary" onClick={() => setModalFor("__new__")}>+ 입·출·조정</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}

      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">품목 수</div><div className="b2b-stat-card-value">{totals.items}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 자산(원가)</div><div className="b2b-stat-card-value b2b-money">{totals.value.toLocaleString()}원</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">재고 부족</div><div className="b2b-stat-card-value" style={{ color: totals.low ? "var(--sm-danger)" : "var(--sm-black)" }}>{totals.low}건</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">기간 총출고</div><div className="b2b-stat-card-value b2b-money">{totals.out.toLocaleString()}</div></div>
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
        </div>
        <input className="b2b-input" placeholder="품목·SKU·옵션 검색" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220, maxWidth: "100%" }} />
      </div>

      {meta && <p className="sm-faint" style={{ fontSize: 12, marginBottom: 8 }}>기간 {meta.from} ~ {meta.to} ({meta.periodDays}일) · 안전재고 = 일평균소진 × 리드타임 {meta.leadDays}일 + 프로모션 확보분</p>}

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : shown.length === 0 ? (
        <div className="b2b-empty">{rows.length === 0 ? "활성 품목이 없습니다. 상품 마스터에 제품을 등록하세요." : "조건에 맞는 품목이 없습니다."}</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr>
              <Th k="name" label="품목" /><th>SKU</th>
              <Th k="qty" label="현재고" num /><Th k="auto_safety" label="안전재고" num /><Th k="depletion_days" label="예상소진" num />
              <Th k="period_in" label="총입고" num /><Th k="period_out" label="총출고" num /><Th k="daily_out" label="일평균소진" num />
              <Th k="value" label="재고자산" num /><th></th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.product_id} style={{ background: r.low ? "var(--sm-danger-bg)" : undefined }}>
                  <td><strong>{r.name}</strong>{r.spec ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{r.spec}</span> : null}{r.is_bundle ? <span className="b2b-status-pill" style={{ marginLeft: 6, background: "var(--sm-orange-light)", color: "var(--sm-orange)" }}>세트</span> : null}</td>
                  <td className="sm-faint">{r.sku || "-"}</td>
                  <td className="num b2b-money" style={{ fontWeight: 700, color: r.low ? "var(--sm-danger)" : "var(--sm-black)" }} title={r.is_bundle ? "구성품으로 만들 수 있는 세트 수(가용)" : undefined}>{r.qty.toLocaleString()}<span className="sm-faint" style={{ fontWeight: 400, marginLeft: 2 }}>{r.is_bundle ? "세트" : r.unit}</span></td>
                  <td className="num b2b-money" title={r.promo_qty ? `프로모션 확보분 +${r.promo_qty.toLocaleString()} 포함` : undefined}>{r.auto_safety.toLocaleString()}{r.promo_qty ? <span style={{ color: "var(--sm-orange)", fontSize: 10, marginLeft: 2 }}></span> : null}</td>
                  <td className="num b2b-money" style={{ color: r.depletion_days == null ? "var(--sm-text-light)" : r.depletion_days <= (meta?.leadDays ?? 10) ? "var(--sm-danger)" : "var(--sm-black)" }}>{r.depletion_days == null ? "-" : `${r.depletion_days}일`}</td>
                  <td className="num b2b-money" style={{ color: r.period_in ? "var(--sm-success)" : "var(--sm-text-light)" }}>{r.period_in ? r.period_in.toLocaleString() : "-"}</td>
                  <td className="num b2b-money" style={{ color: r.period_out ? "var(--sm-info)" : "var(--sm-text-light)" }}>{r.period_out ? r.period_out.toLocaleString() : "-"}</td>
                  <td className="num b2b-money">{r.daily_out ? r.daily_out.toLocaleString() : "-"}</td>
                  <td className="num b2b-money">{r.value.toLocaleString()}</td>
                  <td><button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setModalFor(r.product_id)}>입·출·조정</button></td>
                </tr>
              ))}
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
          onChanged={load}
        />
      )}
    </div>
  );
}
