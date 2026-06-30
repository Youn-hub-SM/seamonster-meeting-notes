"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Combobox, ComboOption } from "../b2b/orders/Combobox";

type ProductRow = { product_name: string; spec: string; qty: number; companies: string[]; order_count: number };
type DayBucket = { date: string; label: string; total_qty: number; order_count: number; products: ProductRow[] };
type PromoItem = { sku: string; name: string; qty: number | string };
type Promotion = { id: string; name: string; start: string; end: string; items: PromoItem[]; expectedQty: number; note?: string; color?: string };
type Product = { sku: string | null; name: string; spec: string | null };
type ItemStat = { sku: string; name: string; stock: number | null; dailyOut: number; depletionDays: number | null };
type Manual = { id: string; sku: string; name: string; qty: number; productionDate: string; stock: number | null; dailyOut: number; depletionDate: string | null };
type PItem = { name: string; spec: string; qty: number; manual: boolean; manualId?: string; sku?: string };
type MergedDay = { date: string; label: string; total_qty: number; hasManual: boolean; products: PItem[] };

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const FILTER_MODES = ["일자별", "7일", "14일", "30일", "지정"] as const;
type FilterMode = (typeof FILTER_MODES)[number];

function pad(n: number) { return String(n).padStart(2, "0"); }
function isoOf(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayIso() { return isoOf(new Date()); }
function addDaysIso(iso: string, n: number) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return isoOf(d); }
function dayLabel(iso: string) { const d = new Date(iso + "T00:00:00"); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`; }

function buildWeeks(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const lastOfMonth = new Date(year, month + 1, 0);
  const weeks: Date[][] = [];
  const cur = new Date(start);
  while (true) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) { week.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
    weeks.push(week);
    if (week[6] >= lastOfMonth || weeks.length >= 6) break;
  }
  return weeks;
}

const EMPTY_PROMO: Partial<Promotion> = { name: "", start: "", end: "", items: [], expectedQty: 0, note: "" };

export default function ProductionSchedulePage() {
  const [days, setDays] = useState<DayBucket[]>([]);
  const [manual, setManual] = useState<Manual[]>([]);
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const today = todayIso();
  const [view, setView] = useState(() => { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }; });
  // 하단 생산목록 필터 — 일자별/7·14·30일/지정
  const [fmode, setFmode] = useState<FilterMode>("14일");
  const [oneDate, setOneDate] = useState(today);
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(addDaysIso(today, 7));

  const [promoModal, setPromoModal] = useState<Partial<Promotion> | null>(null);
  const [savingPromo, setSavingPromo] = useState(false);

  // 생산일정 추가
  const [addModal, setAddModal] = useState<null | { sku: string; name: string; qty: number | string; productionDate: string; stock: number | null; dailyOut: number; depletionDate: string | null }>(null);
  const [itemStats, setItemStats] = useState<ItemStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsConfigured, setStatsConfigured] = useState(true);
  const [savingAdd, setSavingAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [pr, pm, mn, pd] = await Promise.all([
        fetch("/api/b2b/orders/production-summary", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/production/promotions", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/production/manual", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/b2b/products", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (!pr.ok) throw new Error(pr.error || "생산일정 조회 실패");
      setDays(pr.days || []);
      if (pm.ok) setPromos(pm.promotions || []);
      if (mn.ok) setManual(mn.items || []);
      if (pd.ok) setProducts((pd.products || []).map((p: Product) => ({ sku: p.sku, name: p.name, spec: p.spec })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // B2B + 수동을 날짜별로 병합
  const merged = useMemo(() => {
    const m = new Map<string, MergedDay>();
    const ensure = (date: string, label: string) => {
      let d = m.get(date);
      if (!d) { d = { date, label, total_qty: 0, hasManual: false, products: [] }; m.set(date, d); }
      return d;
    };
    for (const b of days) {
      const d = ensure(b.date, b.label);
      for (const p of b.products) d.products.push({ name: p.product_name, spec: p.spec, qty: p.qty, manual: false });
      d.total_qty += b.total_qty;
    }
    for (const e of manual) {
      const d = ensure(e.productionDate, dayLabel(e.productionDate));
      d.products.push({ name: e.name, spec: "", qty: e.qty, manual: true, manualId: e.id, sku: e.sku });
      d.total_qty += e.qty;
      d.hasManual = true;
    }
    return m;
  }, [days, manual]);

  const promosOn = useCallback((iso: string) => promos.filter((p) => p.start <= iso && iso <= p.end), [promos]);
  const weeks = useMemo(() => buildWeeks(view.y, view.m), [view]);

  // 하단 생산목록: 필터모드별. 일자별=특정일 / N일=다가오는 N일+지연+미정 / 지정=날짜 범위.
  const listDays = useMemo(() => {
    const all = [...merged.values()];
    let filtered: MergedDay[];
    if (fmode === "일자별") {
      filtered = all.filter((d) => d.date === oneDate);
    } else if (fmode === "지정") {
      const lo = fromDate || "0000-00-00", hi = toDate || "9999-12-31";
      filtered = all.filter((d) => !!d.date && d.date >= lo && d.date <= hi);
    } else {
      const n = fmode === "7일" ? 7 : fmode === "30일" ? 30 : 14;
      const limit = addDaysIso(today, n);
      filtered = all.filter((d) => !d.date || d.date <= limit);
    }
    return filtered.sort((a, b) => { if (!a.date) return 1; if (!b.date) return -1; return a.date.localeCompare(b.date); });
  }, [merged, today, fmode, oneDate, fromDate, toDate]);

  // 표(VOC 처리상태풍)용 — 일자 × 품목 평탄화. 날짜는 바뀔 때만 표시.
  const listRows = useMemo(() => listDays.flatMap((d) =>
    d.products.map((p) => ({ date: d.date || "", label: d.label, name: p.name, spec: p.spec, qty: p.qty, manual: p.manual, manualId: p.manualId }))
  ), [listDays]);

  function gotoMonth(delta: number) { setView((v) => { const d = new Date(v.y, v.m + delta, 1); return { y: d.getFullYear(), m: d.getMonth() }; }); }
  function gotoToday() { const t = new Date(); setView({ y: t.getFullYear(), m: t.getMonth() }); }

  async function savePromo() {
    if (!promoModal) return;
    if (!promoModal.name?.trim()) { setError("프로모션 이름을 입력하세요."); return; }
    if (!promoModal.start) { setError("시작일을 입력하세요."); return; }
    setSavingPromo(true); setError("");
    try {
      const j = await (await fetch("/api/production/promotions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(promoModal) })).json();
      if (!j.ok) throw new Error(j.error || "저장 실패");
      setPromos(j.promotions || []); setPromoModal(null);
    } catch (err) { setError(err instanceof Error ? err.message : "저장 실패"); }
    setSavingPromo(false);
  }
  async function deletePromo(id: string) {
    if (!confirm("이 프로모션을 삭제할까요?")) return;
    setSavingPromo(true);
    try { const j = await (await fetch(`/api/production/promotions?id=${id}`, { method: "DELETE" })).json(); if (j.ok) setPromos(j.promotions || []); setPromoModal(null); } catch { /* noop */ }
    setSavingPromo(false);
  }

  // 생산일정 추가
  async function openAdd() {
    setAddModal({ sku: "", name: "", qty: "", productionDate: today, stock: null, dailyOut: 0, depletionDate: null });
    setStatsLoading(true); setStatsConfigured(true);
    try {
      const j = await (await fetch("/api/production/item-stats", { cache: "no-store" })).json();
      if (j.configured === false) setStatsConfigured(false);
      else setItemStats(j.items || []);
    } catch { setStatsConfigured(false); }
    setStatsLoading(false);
  }
  function pickItem(sku: string, displayName?: string) {
    const it = itemStats.find((i) => i.sku === sku);
    setAddModal((m) => {
      if (!m) return m;
      if (!it) return { ...m, sku: "", name: "", stock: null, dailyOut: 0, depletionDate: null };
      const dep = it.depletionDays != null ? addDaysIso(today, it.depletionDays) : null;
      return { ...m, sku: it.sku, name: displayName || it.name, stock: it.stock, dailyOut: it.dailyOut, depletionDate: dep, productionDate: dep || today };
    });
  }
  async function saveAdd() {
    if (!addModal) return;
    if (!addModal.sku) { setError("품목을 선택하세요."); return; }
    if (!Number(addModal.qty)) { setError("생산량을 입력하세요."); return; }
    setSavingAdd(true); setError("");
    try {
      const j = await (await fetch("/api/production/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...addModal, qty: Number(addModal.qty) }) })).json();
      if (!j.ok) throw new Error(j.error || "저장 실패");
      setManual(j.items || []); setAddModal(null);
    } catch (err) { setError(err instanceof Error ? err.message : "저장 실패"); }
    setSavingAdd(false);
  }
  async function deleteManual(id: string) {
    try { const j = await (await fetch(`/api/production/manual?id=${id}`, { method: "DELETE" })).json(); if (j.ok) setManual(j.items || []); } catch { /* noop */ }
  }

  // SKU → 옵션(규격) — 검색 결과를 "상품명 | 옵션" 으로 보여주기 위해
  const specBySku = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products) if (p.sku && p.spec) m.set(p.sku.toUpperCase(), p.spec);
    return m;
  }, [products]);
  const productOptions: ComboOption[] = useMemo(
    () => products.map((p) => ({ id: p.sku || p.name, label: p.spec ? `${p.name} | ${p.spec}` : p.name, sub: p.sku || "" })),
    [products]
  );
  const itemStatOptions: ComboOption[] = useMemo(
    () => itemStats.map((it) => {
      const sp = specBySku.get(it.sku.toUpperCase());
      return { id: it.sku, label: sp ? `${it.name} | ${sp}` : it.name, sub: it.sku };
    }),
    [itemStats, specBySku]
  );
  function setPromoItems(updater: (items: PromoItem[]) => PromoItem[]) {
    setPromoModal((m) => (m ? { ...m, items: updater(m.items || []) } : m));
  }
  const promoTotal = (promoModal?.items || []).reduce((s, it) => s + (Number(it.qty) || 0), 0);

  const sel = addModal && addModal.sku ? itemStats.find((i) => i.sku === addModal.sku) : null;
  const monthLabel = `${view.y}년 ${view.m + 1}월`;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산일정</h1>
          <p className="b2b-page-subtitle">언제 무엇을 몇 개 생산할지 한눈에. 직접 생산일정을 추가하면 현재고·출고추세는 박스히어로에서 자동 채워집니다.</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={openAdd}>+ 생산일정 추가</button>
          <button className="b2b-btn-secondary" onClick={() => setPromoModal({ ...EMPTY_PROMO, start: today, end: today })}>+ 프로모션</button>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="prod-cal-layout">
        {/* 좌측: 캘린더 */}
        <div className="prod-cal">
          <div className="prod-cal-head">
            <div className="prod-cal-nav">
              <button onClick={() => gotoMonth(-1)} aria-label="이전 달">‹</button>
              <span className="prod-cal-month">{monthLabel}</span>
              <button onClick={() => gotoMonth(1)} aria-label="다음 달">›</button>
            </div>
            <button className="b2b-btn-secondary prod-cal-today" onClick={gotoToday}>오늘</button>
          </div>

          <div className="prod-cal-grid">
            {WD.map((w, i) => <div key={w} className={`prod-cal-wd ${i === 0 ? "is-sun" : ""} ${i === 6 ? "is-sat" : ""}`}>{w}</div>)}
            {weeks.flat().map((d) => {
              const iso = isoOf(d);
              const inMonth = d.getMonth() === view.m;
              const isToday = iso === today;
              const bucket = merged.get(iso);
              const dayPromos = promosOn(iso);
              return (
                <div key={iso} className={`prod-cal-cell ${inMonth ? "" : "is-other"} ${isToday ? "is-today" : ""}`}>
                  <div className="prod-cal-daynum">{d.getDate()}</div>
                  {dayPromos.map((p) => (
                    <div key={p.id} className="prod-cal-promo" style={{ background: p.color || "#F15A30" }}
                      title={`${p.name} · 예상 ${p.expectedQty.toLocaleString()}개${p.items && p.items.length ? "\n" + p.items.map((it) => `· ${it.name} ${Number(it.qty).toLocaleString()}`).join("\n") : ""}`} onClick={() => setPromoModal(p)}>
                      {iso === p.start ? `🎯 ${p.name}` : " "}
                    </div>
                  ))}
                  {bucket && (
                    <div className="prod-cal-items" title={bucket.products.map((x) => `${x.name} ${x.qty.toLocaleString()}개${x.manual ? " (직접)" : ""}`).join("\n")}>
                      {bucket.products.slice(0, 3).map((x, i) => (
                        <div key={i} className="prod-cal-item">
                          <span className="prod-cal-item-name">{x.manual ? "✏ " : ""}{x.name}</span>
                          <span className="prod-cal-item-qty">{x.qty.toLocaleString()}</span>
                        </div>
                      ))}
                      {bucket.products.length > 3 && (
                        <div className="prod-cal-item-more">외 {bucket.products.length - 3}종 · 합 {bucket.total_qty.toLocaleString()}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {promos.length > 0 && (
            <div className="prod-cal-legend">
              {promos.map((p) => (
                <button key={p.id} className="prod-cal-legend-item" onClick={() => setPromoModal(p)}>
                  <span className="prod-cal-legend-dot" style={{ background: p.color || "#F15A30" }} />
                  {p.name} <span className="prod-cal-legend-q">예상 {p.expectedQty.toLocaleString()}개</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 하단: 생산 목록 (캘린더 아래 전체폭) */}
        <aside className="prod-cal-side">
          <div className="prod-cal-side-head" style={{ flexWrap: "wrap" }}>
            <span>생산 목록</span>
            <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginLeft: "auto" }}>
              <div className="sm-tabs">
                {FILTER_MODES.map((m) => (
                  <button key={m} className={`sm-tab ${fmode === m ? "is-active" : ""}`} onClick={() => setFmode(m)}>{m === "지정" ? "날짜 지정" : m}</button>
                ))}
              </div>
              {fmode === "일자별" && (
                <input type="date" className="b2b-input" value={oneDate} onChange={(e) => setOneDate(e.target.value)} style={{ width: "auto" }} />
              )}
              {fmode === "지정" && (
                <span className="sm-row" style={{ gap: 6 }}>
                  <input type="date" className="b2b-input" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} style={{ width: "auto" }} />
                  <span className="sm-faint">~</span>
                  <input type="date" className="b2b-input" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} style={{ width: "auto" }} />
                </span>
              )}
            </div>
          </div>
          {loading ? (
            <div className="b2b-loading">불러오는 중...</div>
          ) : listDays.length === 0 ? (
            <div className="b2b-empty" style={{ padding: "30px 16px" }}><div className="b2b-empty-icon">🏭</div>{fmode === "일자별" ? `${oneDate} 생산 일정이 없습니다.` : fmode === "지정" ? "선택 기간에 생산 일정이 없습니다." : `다가오는 ${fmode} 내 생산 일정이 없습니다.`}</div>
          ) : (
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>생산일</th><th>품목</th><th>규격</th><th className="num">수량</th><th>구분</th><th>상태</th><th></th></tr></thead>
                <tbody>
                  {listRows.map((r, i) => {
                    const status = !r.date ? "미정" : r.date < today ? "지연" : r.date === today ? "오늘" : "예정";
                    const sc = status === "지연" ? { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" }
                      : status === "오늘" ? { bg: "var(--sm-orange-light, rgba(241,90,48,.1))", fg: "var(--sm-orange)" }
                      : status === "예정" ? { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" }
                      : { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" };
                    const newDay = i === 0 || listRows[i - 1].date !== r.date;
                    return (
                      <tr key={i} style={newDay && i > 0 ? { borderTop: "2px solid var(--sm-border)" } : undefined}>
                        <td style={{ whiteSpace: "nowrap", color: newDay ? "var(--sm-black)" : "transparent", fontWeight: newDay ? 600 : 400 }}>{r.label}</td>
                        <td>{r.name}</td>
                        <td>{r.spec || "-"}</td>
                        <td className="num b2b-money">{r.qty.toLocaleString()}</td>
                        <td><span className="b2b-feed-pill" style={{ background: r.manual ? "var(--sm-bg-subtle)" : "var(--sm-info-bg)", color: r.manual ? "var(--sm-text-mid)" : "var(--sm-info)" }}>{r.manual ? "직접" : "B2B"}</span></td>
                        <td><span className="b2b-feed-pill" style={{ background: sc.bg, color: sc.fg, fontWeight: 700, whiteSpace: "nowrap" }}>{status}</span></td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {r.manual && r.manualId && <button className="b2b-link-btn" title="삭제" onClick={() => deleteManual(r.manualId!)} style={{ color: "var(--sm-danger)" }}>✕</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </aside>
      </div>

      <p className="prod-note">※ 박스히어로 재고를 반영한 “실제 생산 필요량”·생산 조언은 재고·생산필요 / 생산 조언 메뉴에서 확인하세요.</p>

      {/* 생산일정 추가 모달 */}
      {addModal && (
        <div className="b2b-modal-backdrop" onClick={() => setAddModal(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="b2b-modal-head"><h2 className="b2b-modal-title">생산일정 추가</h2></div>
            {!statsConfigured ? (
              <div className="b2b-modal-body">
                <div className="b2b-empty" style={{ padding: "24px 10px" }}>박스히어로 연동이 필요합니다. 설정에서 토큰을 등록하세요.</div>
              </div>
            ) : (
              <>
                <div className="b2b-modal-body">
                  <div className="b2b-field">
                    <label className="b2b-field-label">품목 {statsLoading && <span style={{ color: "var(--sm-text-light)", fontWeight: 400 }}>· 불러오는 중...</span>}</label>
                    <Combobox
                      value={addModal.name}
                      options={itemStatOptions}
                      onSelect={(o) => pickItem(o.id, o.label)}
                      placeholder={statsLoading ? "불러오는 중..." : "상품명·SKU 검색"}
                      ariaLabel="품목"
                    />
                  </div>

                  {sel && (
                    <div className="prod-add-stats">
                      <div><span>현재고</span><strong>{sel.stock?.toLocaleString() ?? "-"}</strong></div>
                      <div><span>하루 평균 출고</span><strong>{sel.dailyOut.toLocaleString()}</strong></div>
                      <div><span>예상 소진일</span><strong>{addModal.depletionDate ? `${dayLabel(addModal.depletionDate)} (${sel.depletionDays}일)` : "—"}</strong></div>
                    </div>
                  )}

                  <div className="b2b-field-row">
                    <div className="b2b-field">
                      <label className="b2b-field-label">생산량</label>
                      <input type="number" className="b2b-input" value={addModal.qty} onChange={(e) => setAddModal({ ...addModal, qty: e.target.value })} placeholder="생산할 수량" autoFocus />
                    </div>
                    <div className="b2b-field">
                      <label className="b2b-field-label">생산 목표일</label>
                      <input type="date" className="b2b-input" value={addModal.productionDate} onChange={(e) => setAddModal({ ...addModal, productionDate: e.target.value })} />
                    </div>
                  </div>
                  <span style={{ fontSize: 10.5, color: "var(--sm-text-light)" }}>목표일은 예상 소진일로 자동 설정됩니다. 필요하면 바꾸세요.</span>
                </div>
                <div className="b2b-modal-foot">
                  <div />
                  <div className="b2b-modal-foot-right">
                    <button className="b2b-btn-secondary" onClick={() => setAddModal(null)} disabled={savingAdd}>취소</button>
                    <button className="b2b-btn-primary" onClick={saveAdd} disabled={savingAdd || !addModal.sku}>{savingAdd ? "저장 중..." : "추가"}</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 프로모션 모달 */}
      {promoModal && (
        <div className="b2b-modal-backdrop" onClick={() => setPromoModal(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="b2b-modal-head"><h2 className="b2b-modal-title">{promoModal.id ? "프로모션 수정" : "프로모션 추가"}</h2></div>
            <div className="b2b-modal-body">
              <div className="b2b-field">
                <label className="b2b-field-label">이름</label>
                <input className="b2b-input" value={promoModal.name || ""} onChange={(e) => setPromoModal({ ...promoModal, name: e.target.value })} placeholder="예: 6월 라방 특가" />
              </div>
              <div className="b2b-field-row">
                <div className="b2b-field">
                  <label className="b2b-field-label">시작일</label>
                  <input type="date" className="b2b-input" value={promoModal.start || ""} onChange={(e) => setPromoModal({ ...promoModal, start: e.target.value })} />
                </div>
                <div className="b2b-field">
                  <label className="b2b-field-label">종료일</label>
                  <input type="date" className="b2b-input" value={promoModal.end || ""} onChange={(e) => setPromoModal({ ...promoModal, end: e.target.value })} />
                </div>
              </div>
              <div className="b2b-field">
                <label className="b2b-field-label">상품별 예상 판매량</label>
                {(promoModal.items || []).length === 0 && (
                  <div style={{ fontSize: 11.5, color: "var(--sm-text-light)", marginBottom: 6 }}>어떤 상품이 얼마나 나갈지 추가하세요. (MD 전달 수치)</div>
                )}
                {(promoModal.items || []).map((it, i) => (
                  <div key={i} className="promo-item-row">
                    <div className="promo-item-combo">
                      <Combobox
                        value={it.name}
                        options={productOptions}
                        onSelect={(o) => setPromoItems((items) => items.map((x, xi) => (xi === i ? { ...x, sku: o.id, name: o.label } : x)))}
                        placeholder="상품 검색"
                        ariaLabel="상품"
                      />
                    </div>
                    <input type="number" className="b2b-input promo-item-qty" value={it.qty} onChange={(e) => setPromoItems((items) => items.map((x, xi) => (xi === i ? { ...x, qty: e.target.value } : x)))} placeholder="수량" />
                    <button type="button" className="promo-item-del" onClick={() => setPromoItems((items) => items.filter((_, xi) => xi !== i))} title="삭제">✕</button>
                  </div>
                ))}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
                  <button type="button" className="promo-item-add" onClick={() => setPromoItems((items) => [...items, { sku: "", name: "", qty: "" }])}>+ 상품 추가</button>
                  {promoTotal > 0 && <span className="promo-item-total">합계 <strong>{promoTotal.toLocaleString()}개</strong></span>}
                </div>
              </div>
              <div className="b2b-field">
                <label className="b2b-field-label">메모 (선택)</label>
                <input className="b2b-input" value={promoModal.note || ""} onChange={(e) => setPromoModal({ ...promoModal, note: e.target.value })} placeholder="대상 품목·채널 등" />
              </div>
            </div>
            <div className="b2b-modal-foot">
              <div>{promoModal.id && <button className="b2b-btn-secondary" onClick={() => deletePromo(promoModal.id!)} disabled={savingPromo} style={{ color: "var(--sm-danger)" }}>삭제</button>}</div>
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setPromoModal(null)} disabled={savingPromo}>취소</button>
                <button className="b2b-btn-primary" onClick={savePromo} disabled={savingPromo}>{savingPromo ? "저장 중..." : "저장"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
