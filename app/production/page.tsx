"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ProductRow = { product_name: string; spec: string; qty: number; companies: string[]; order_count: number };
type DayBucket = { date: string; label: string; total_qty: number; order_count: number; products: ProductRow[] };
type Promotion = { id: string; name: string; start: string; end: string; expectedQty: number; note?: string; color?: string };

const WD = ["일", "월", "화", "수", "목", "금", "토"];

function pad(n: number) { return String(n).padStart(2, "0"); }
function isoOf(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayIso() { const t = new Date(); return isoOf(t); }

// 한 달 그리드(일요일 시작, 4~6주)
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
    if (week[6] >= lastOfMonth) break;
    if (weeks.length >= 6) break;
  }
  return weeks;
}

const EMPTY_PROMO: Partial<Promotion> = { name: "", start: "", end: "", expectedQty: 0, note: "" };

export default function ProductionSchedulePage() {
  const [days, setDays] = useState<DayBucket[]>([]);
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const today = todayIso();
  const [view, setView] = useState(() => { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }; });

  // 프로모션 모달
  const [promoModal, setPromoModal] = useState<Partial<Promotion> | null>(null);
  const [savingPromo, setSavingPromo] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [pr, pm] = await Promise.all([
        fetch("/api/b2b/orders/production-summary", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/production/promotions", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (!pr.ok) throw new Error(pr.error || "생산일정 조회 실패");
      setDays(pr.days || []);
      if (pm.ok) setPromos(pm.promotions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // date(iso) → DayBucket
  const byDate = useMemo(() => {
    const m = new Map<string, DayBucket>();
    for (const d of days) if (d.date) m.set(d.date, d);
    return m;
  }, [days]);

  // 해당 날짜를 덮는 프로모션
  const promosOn = useCallback((iso: string) => promos.filter((p) => p.start <= iso && iso <= p.end), [promos]);

  const weeks = useMemo(() => buildWeeks(view.y, view.m), [view]);

  // 우측 목록: 날짜 있는 생산일정 + 미정, 날짜 오름차순(미정 맨뒤)
  const listDays = useMemo(() => {
    return [...days].sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });
  }, [days]);

  function gotoMonth(delta: number) {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }
  function gotoToday() { const t = new Date(); setView({ y: t.getFullYear(), m: t.getMonth() }); }

  async function savePromo() {
    if (!promoModal) return;
    if (!promoModal.name?.trim()) { setError("프로모션 이름을 입력하세요."); return; }
    if (!promoModal.start) { setError("시작일을 입력하세요."); return; }
    setSavingPromo(true);
    setError("");
    try {
      const res = await fetch("/api/production/promotions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(promoModal),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setPromos(j.promotions || []);
      setPromoModal(null);
    } catch (err) { setError(err instanceof Error ? err.message : "저장 실패"); }
    setSavingPromo(false);
  }
  async function deletePromo(id: string) {
    if (!confirm("이 프로모션을 삭제할까요?")) return;
    setSavingPromo(true);
    try {
      const j = await (await fetch(`/api/production/promotions?id=${id}`, { method: "DELETE" })).json();
      if (j.ok) setPromos(j.promotions || []);
      setPromoModal(null);
    } catch { /* noop */ }
    setSavingPromo(false);
  }

  const monthLabel = `${view.y}년 ${view.m + 1}월`;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산일정</h1>
          <p className="b2b-page-subtitle">언제 무엇을 몇 개 생산해야 하는지 한눈에. 주요 프로모션(예상판매량)도 함께 표시됩니다.</p>
        </div>
        <div className="b2b-page-actions">
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
            {WD.map((w, i) => (
              <div key={w} className={`prod-cal-wd ${i === 0 ? "is-sun" : ""} ${i === 6 ? "is-sat" : ""}`}>{w}</div>
            ))}
            {weeks.flat().map((d) => {
              const iso = isoOf(d);
              const inMonth = d.getMonth() === view.m;
              const isToday = iso === today;
              const bucket = byDate.get(iso);
              const dayPromos = promosOn(iso);
              return (
                <div key={iso} className={`prod-cal-cell ${inMonth ? "" : "is-other"} ${isToday ? "is-today" : ""} ${bucket && iso < today ? "is-past-prod" : ""}`}>
                  <div className="prod-cal-daynum">{d.getDate()}</div>
                  {dayPromos.map((p) => (
                    <div key={p.id} className="prod-cal-promo" style={{ background: p.color || "#F15A30" }}
                      title={`${p.name} · 예상 ${p.expectedQty.toLocaleString()}개`}
                      onClick={() => setPromoModal(p)}>
                      {iso === p.start ? `🎯 ${p.name}` : " "}
                    </div>
                  ))}
                  {bucket && (
                    <div className="prod-cal-prod" title={bucket.products.map((x) => `${x.product_name} ${x.qty}`).join("\n")}>
                      <span className="prod-cal-qty">{bucket.total_qty.toLocaleString()}</span>
                      <span className="prod-cal-cnt">{bucket.products.length}종</span>
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
          <div className="prod-cal-side-head">생산 목록 <span className="prod-cal-side-sub">예정·지연</span></div>
          {loading ? (
            <div className="b2b-loading">불러오는 중...</div>
          ) : listDays.length === 0 ? (
            <div className="b2b-empty" style={{ padding: "30px 16px" }}><div className="b2b-empty-icon">🏭</div>생산이 필요한 발주가 없습니다.</div>
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
                          <span className="prod-side-item-name">{p.product_name}{p.spec ? <span className="prod-side-item-spec"> {p.spec}</span> : ""}</span>
                          <span className="prod-side-item-qty">{p.qty.toLocaleString()}</span>
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

      {/* 프로모션 모달 */}
      {promoModal && (
        <div className="b2b-modal-backdrop" onClick={() => setPromoModal(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h2 className="b2b-modal-title">{promoModal.id ? "프로모션 수정" : "프로모션 추가"}</h2>
            <div className="b2b-field">
              <label className="b2b-field-label">이름</label>
              <input className="b2b-input" value={promoModal.name || ""} onChange={(e) => setPromoModal({ ...promoModal, name: e.target.value })} placeholder="예: 6월 라방 특가" />
            </div>
            <div className="b2b-field-row" style={{ marginTop: 12 }}>
              <div className="b2b-field">
                <label className="b2b-field-label">시작일</label>
                <input type="date" className="b2b-input" value={promoModal.start || ""} onChange={(e) => setPromoModal({ ...promoModal, start: e.target.value })} />
              </div>
              <div className="b2b-field">
                <label className="b2b-field-label">종료일</label>
                <input type="date" className="b2b-input" value={promoModal.end || ""} onChange={(e) => setPromoModal({ ...promoModal, end: e.target.value })} />
              </div>
            </div>
            <div className="b2b-field" style={{ marginTop: 12 }}>
              <label className="b2b-field-label">예상 판매량 (기간 합)</label>
              <input type="number" className="b2b-input" value={promoModal.expectedQty ?? 0} onChange={(e) => setPromoModal({ ...promoModal, expectedQty: Number(e.target.value) })} placeholder="예: 500" />
            </div>
            <div className="b2b-field" style={{ marginTop: 12 }}>
              <label className="b2b-field-label">메모 (선택)</label>
              <input className="b2b-input" value={promoModal.note || ""} onChange={(e) => setPromoModal({ ...promoModal, note: e.target.value })} placeholder="대상 품목·채널 등" />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 18 }}>
              <div>
                {promoModal.id && (
                  <button className="b2b-btn-secondary" onClick={() => deletePromo(promoModal.id!)} disabled={savingPromo} style={{ color: "#c92a2a" }}>삭제</button>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
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
