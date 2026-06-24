"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ProductRow = { product_name: string; spec: string; qty: number; companies: string[]; order_count: number };
type DayBucket = { date: string; label: string; total_qty: number; order_count: number; products: ProductRow[] };
type Promotion = { id: string; name: string; start: string; end: string; expectedQty: number; note?: string; color?: string };
type ItemStat = { sku: string; name: string; stock: number | null; dailyOut: number; depletionDays: number | null };
type Manual = { id: string; sku: string; name: string; qty: number; productionDate: string; stock: number | null; dailyOut: number; depletionDate: string | null };
type PItem = { name: string; spec: string; qty: number; manual: boolean; manualId?: string; sku?: string };
type MergedDay = { date: string; label: string; total_qty: number; hasManual: boolean; products: PItem[] };

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const RANGES = [7, 14, 30] as const;

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

const EMPTY_PROMO: Partial<Promotion> = { name: "", start: "", end: "", expectedQty: 0, note: "" };

export default function ProductionSchedulePage() {
  const [days, setDays] = useState<DayBucket[]>([]);
  const [manual, setManual] = useState<Manual[]>([]);
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const today = todayIso();
  const [view, setView] = useState(() => { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }; });
  const [range, setRange] = useState<number>(14);

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
      const [pr, pm, mn] = await Promise.all([
        fetch("/api/b2b/orders/production-summary", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/production/promotions", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/production/manual", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (!pr.ok) throw new Error(pr.error || "생산일정 조회 실패");
      setDays(pr.days || []);
      if (pm.ok) setPromos(pm.promotions || []);
      if (mn.ok) setManual(mn.items || []);
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

  // 우측 목록: 범위(다가오는 N일) + 지연 + 미정, 날짜 오름차순
  const listDays = useMemo(() => {
    const limit = addDaysIso(today, range);
    return [...merged.values()]
      .filter((d) => !d.date || d.date <= limit)
      .sort((a, b) => { if (!a.date) return 1; if (!b.date) return -1; return a.date.localeCompare(b.date); });
  }, [merged, today, range]);

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
  function pickItem(sku: string) {
    const it = itemStats.find((i) => i.sku === sku);
    setAddModal((m) => {
      if (!m) return m;
      if (!it) return { ...m, sku: "", name: "", stock: null, dailyOut: 0, depletionDate: null };
      const dep = it.depletionDays != null ? addDaysIso(today, it.depletionDays) : null;
      return { ...m, sku: it.sku, name: it.name, stock: it.stock, dailyOut: it.dailyOut, depletionDate: dep, productionDate: dep || today };
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
                      title={`${p.name} · 예상 ${p.expectedQty.toLocaleString()}개`} onClick={() => setPromoModal(p)}>
                      {iso === p.start ? `🎯 ${p.name}` : " "}
                    </div>
                  ))}
                  {bucket && (
                    <div className="prod-cal-prod" title={bucket.products.map((x) => `${x.name} ${x.qty}${x.manual ? " (직접)" : ""}`).join("\n")}>
                      <span className="prod-cal-qty">{bucket.total_qty.toLocaleString()}</span>
                      <span className="prod-cal-cnt">{bucket.products.length}종{bucket.hasManual ? " ✏" : ""}</span>
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

        {/* 우측: 생산 목록 */}
        <aside className="prod-cal-side">
          <div className="prod-cal-side-head">
            생산 목록
            <div className="prod-range-tabs">
              {RANGES.map((n) => (
                <button key={n} className={`prod-range-tab ${range === n ? "is-active" : ""}`} onClick={() => setRange(n)}>{n}일</button>
              ))}
            </div>
          </div>
          {loading ? (
            <div className="b2b-loading">불러오는 중...</div>
          ) : listDays.length === 0 ? (
            <div className="b2b-empty" style={{ padding: "30px 16px" }}><div className="b2b-empty-icon">🏭</div>{range}일 내 생산 일정이 없습니다.</div>
          ) : (
            <div className="prod-side-list">
              {listDays.map((d) => {
                const overdue = !!d.date && d.date < today;
                const isToday = d.date === today;
                return (
                  <div key={d.date || "unset"} className={`prod-side-day ${overdue ? "is-overdue" : ""} ${isToday ? "is-today" : ""}`}>
                    <div className="prod-side-day-head">
                      <span className="prod-side-day-label">{d.label}</span>
                      {overdue && <span className="prod-day-badge is-overdue">지연</span>}
                      {isToday && <span className="prod-day-badge is-today">오늘</span>}
                      <span className="prod-side-day-qty">{d.total_qty.toLocaleString()}개</span>
                    </div>
                    <ul className="prod-side-items">
                      {d.products.map((p, i) => (
                        <li key={i}>
                          <span className="prod-side-item-name">
                            {p.name}{p.spec ? <span className="prod-side-item-spec"> {p.spec}</span> : ""}
                            {p.manual && <span className="prod-side-manual-tag">직접</span>}
                          </span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span className="prod-side-item-qty">{p.qty.toLocaleString()}</span>
                            {p.manual && p.manualId && (
                              <button className="prod-side-del" title="삭제" onClick={() => deleteManual(p.manualId!)}>✕</button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
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
                    <select className="b2b-select" value={addModal.sku} onChange={(e) => pickItem(e.target.value)} disabled={statsLoading}>
                      <option value="">{statsLoading ? "..." : "품목 선택"}</option>
                      {itemStats.map((it) => <option key={it.sku} value={it.sku}>{it.name} ({it.sku})</option>)}
                    </select>
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
                  <span style={{ fontSize: 11.5, color: "var(--sm-text-light)" }}>목표일은 예상 소진일로 자동 설정됩니다. 필요하면 바꾸세요.</span>
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
                <label className="b2b-field-label">예상 판매량 (기간 합)</label>
                <input type="number" className="b2b-input" value={promoModal.expectedQty ?? 0} onChange={(e) => setPromoModal({ ...promoModal, expectedQty: Number(e.target.value) })} placeholder="예: 500" />
              </div>
              <div className="b2b-field">
                <label className="b2b-field-label">메모 (선택)</label>
                <input className="b2b-input" value={promoModal.note || ""} onChange={(e) => setPromoModal({ ...promoModal, note: e.target.value })} placeholder="대상 품목·채널 등" />
              </div>
            </div>
            <div className="b2b-modal-foot">
              <div>{promoModal.id && <button className="b2b-btn-secondary" onClick={() => deletePromo(promoModal.id!)} disabled={savingPromo} style={{ color: "#c92a2a" }}>삭제</button>}</div>
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
