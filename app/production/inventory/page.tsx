"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type InvRow = {
  sku: string;
  name: string;
  stock: number | null;
  dailyOut: number;
  rawDailyOut: number;
  boxheroOutQty: number;
  b2bShippedQty: number;
  wholesaleSoldQty: number;
  demixApplied: boolean;
  demixClampedToZero: boolean;
  autoSafety: number;
  promoQty: number;
  adjust: number;
  adjustRaw: number;
  adjustMemo: string;
  adjustUntil: string | null;
  safety: number;
  demand: number;
  recommend: number;
  belowSafety: boolean;
  requestByDays: number | null;
  requestBy: string | null;
  inBoxhero: boolean;
  inB2B: boolean;
};

export default function InventoryPage() {
  const [rows, setRows] = useState<InvRow[]>([]);
  const [configured, setConfigured] = useState(true);
  const [itemCount, setItemCount] = useState(0);
  const [noSkuDemand, setNoSkuDemand] = useState(0);
  const [leadDays, setLeadDays] = useState(10);
  const [spanDays, setSpanDays] = useState(0);
  const [capped, setCapped] = useState(false);
  const [demixActive, setDemixActive] = useState(false);
  const [demixUnresolved, setDemixUnresolved] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [onlyNeed, setOnlyNeed] = useState(true);
  const [editRow, setEditRow] = useState<InvRow | null>(null);
  const [eDelta, setEDelta] = useState("");
  const [eMemo, setEMemo] = useState("");
  const [eUntil, setEUntil] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/production/inventory", { cache: "no-store" });
      const j = await res.json();
      if (j.configured === false) { setConfigured(false); setRows([]); setLoading(false); return; }
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      setConfigured(true);
      setRows(j.rows || []);
      setItemCount(j.itemCount || 0);
      setNoSkuDemand(j.noSkuDemand || 0);
      setLeadDays(j.leadDays || 10);
      setSpanDays(j.velocitySpanDays || 0);
      setCapped(!!j.velocityCapped);
      setDemixActive(!!j.demixActive);
      setDemixUnresolved(j.demixUnresolvedQty || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    let needItems = 0, needQty = 0, below = 0, urgent = 0, soon = 0, clamped = 0;
    for (const r of rows) {
      if (r.recommend > 0) { needItems++; needQty += r.recommend; }
      if (r.belowSafety) below++;
      if (r.requestByDays != null) {
        if (r.requestByDays <= 0) urgent++;
        else if (r.requestByDays <= 7) soon++;
      }
      if (r.demixClampedToZero) clamped++;
    }
    return { needItems, needQty, below, urgent, soon, clamped };
  }, [rows]);

  const clampedRows = useMemo(() => rows.filter((r) => r.demixClampedToZero), [rows]);

  // '생산필요만' 켜도 도매차감으로 0이 된(레이더 실종) 행은 보이게 유지
  const shown = useMemo(() => (onlyNeed ? rows.filter((r) => r.recommend > 0 || r.demixClampedToZero) : rows), [rows, onlyNeed]);

  function openEdit(r: InvRow) {
    setEditRow(r);
    setEDelta(r.adjustRaw ? String(r.adjustRaw) : "");
    setEMemo(r.adjustMemo || "");
    setEUntil(r.adjustUntil || "");
  }

  async function saveAdjust() {
    if (!editRow) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/production/safety-adjust", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: editRow.sku, delta: Number(eDelta) || 0, memo: eMemo, until: eUntil || null }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setEditRow(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "보정 저장 실패");
    }
    setSaving(false);
  }

  if (!configured && !loading) {
    return (
      <div className="b2b-container" style={{ maxWidth: 760 }}>
        <header className="b2b-page-head">
          <div>
            <h1 className="b2b-page-title">재고·생산필요</h1>
            <p className="b2b-page-subtitle">박스히어로 현재고와 B2B 수요를 합쳐 권장 생산량을 계산합니다.</p>
          </div>
        </header>
        <section className="b2b-card">
          <div className="b2b-empty" style={{ padding: "40px 20px" }}>
            <div className="b2b-empty-icon">🔌</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>박스히어로 연동이 필요합니다</div>
            <div style={{ color: "var(--sm-text-mid)", marginBottom: 16 }}>
              설정에서 박스히어로 API 토큰을 등록하면 현재고·안전재고가 연동됩니다.
            </div>
            <Link href="/production/settings" className="b2b-btn-primary">설정으로 이동</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고·생산필요</h1>
          <p className="b2b-page-subtitle">
            권장 생산량 = B2B 수요 + 안전재고 − 현재고. 안전재고 = 최근 하루 출고 × {leadDays}일 + 프로모션 + 수동 보정. 박스히어로 {itemCount}개 품목 기준.
          </p>
        </div>
        <div className="b2b-page-actions">
          <label className="prod-filter-check">
            <input type="checkbox" checked={onlyNeed} onChange={(e) => setOnlyNeed(e.target.checked)} />
            생산필요만
          </label>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-dash-grid" style={{ marginBottom: 16 }}>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">생산 권장 품목</div>
          <div className="b2b-stat-card-value">{stats.needItems}종</div>
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">총 권장 생산량</div>
          <div className="b2b-stat-card-value">{stats.needQty.toLocaleString()}</div>
        </div>
        <div className="b2b-stat-card" style={stats.below > 0 ? { borderColor: "#f5c6c6" } : undefined}>
          <div className="b2b-stat-card-label" style={stats.below > 0 ? { color: "#c92a2a" } : undefined}>
            안전재고 미달
          </div>
          <div className="b2b-stat-card-value" style={stats.below > 0 ? { color: "#c92a2a" } : undefined}>
            {stats.below}종
          </div>
        </div>
      </div>

      {stats.clamped > 0 && (
        <div className="inv-deadline-banner" style={{ background: "#fff0f0", borderColor: "#f5c6c6" }}>
          <span className="inv-dl-text">
            <span className="inv-dl-urgent">⚠ 도매 차감으로 {stats.clamped}종이 레이더에서 빠짐</span>
            <span className="inv-dl-hint"> — 소매 속도가 0이 되어 마감일이 안 잡힙니다({clampedRows.slice(0, 4).map((r) => r.sku).join(", ")}{clampedRows.length > 4 ? " 외" : ""}). 화이트리스트/차감비율을 확인하세요.</span>
          </span>
          <Link href="/production/settings" className="b2b-btn-secondary inv-dl-btn">설정</Link>
        </div>
      )}

      {(stats.urgent > 0 || stats.soon > 0) && (
        <div className="inv-deadline-banner">
          <span className="inv-dl-text">
            {stats.urgent > 0 && <span className="inv-dl-urgent">🔴 지금 생산요청 {stats.urgent}종</span>}
            {stats.urgent > 0 && stats.soon > 0 && <span className="inv-dl-sep"> · </span>}
            {stats.soon > 0 && <span className="inv-dl-soon">🟠 7일 내 마감 {stats.soon}종</span>}
            <span className="inv-dl-hint"> — 리드타임 {leadDays}일 기준, 이 날짜를 넘기면 만들어도 늦습니다.</span>
          </span>
          <Link href="/production/request" className="b2b-btn-secondary inv-dl-btn">생산요청서</Link>
        </div>
      )}

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : shown.length === 0 ? (
        <div className="b2b-empty">
          <div className="b2b-empty-icon">✅</div>
          {onlyNeed ? "지금 추가로 생산할 품목이 없습니다." : "표시할 품목이 없습니다."}
        </div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>품목</th>
                <th className="num">현재고</th>
                <th className="num">하루 출고</th>
                <th className="num">안전재고</th>
                <th className="num">보정</th>
                <th className="num">B2B 수요</th>
                <th className="num">권장 생산</th>
                <th className="num">요청 마감</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.sku} className={r.belowSafety ? "is-overdue" : ""}>
                  <td><code style={{ fontSize: 12.5 }}>{r.sku}</code></td>
                  <td>
                    {r.name}
                    {!r.inBoxhero && <span className="prod-tag">박스히어로 없음</span>}
                  </td>
                  <td className="num">
                    {r.stock == null ? <span style={{ color: "var(--sm-text-light)" }}>-</span> : (
                      <span style={r.belowSafety ? { color: "#c92a2a", fontWeight: 700 } : undefined}>
                        {r.stock.toLocaleString()}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {r.dailyOut || r.rawDailyOut ? (
                      <>
                        <span>{r.dailyOut.toFixed(1)}</span>
                        {(r.rawDailyOut - r.dailyOut - r.wholesaleSoldQty / Math.max(1, spanDays)) > 0.05 && (
                          <span className="inv-raw-out" title={`행사 제외 전 ${r.rawDailyOut.toFixed(1)}`}>행사↓</span>
                        )}
                        {r.wholesaleSoldQty > 0 && (
                          <span className="inv-demix-out" title={`도매 발송분 차감 (창내 B2B 발송 ${r.b2bShippedQty} 중 ${r.wholesaleSoldQty})`}>도매↓</span>
                        )}
                        {r.demixClampedToZero && (
                          <span className="inv-demix-clamp" title="도매 차감으로 소매 속도가 0이 됨 — 마감일이 사라집니다. 화이트리스트/비율 확인 요망">⚠0</span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: "var(--sm-text-light)" }}>-</span>
                    )}
                  </td>
                  <td className="num">
                    <div style={{ fontWeight: 600 }}>{r.safety.toLocaleString()}</div>
                    {(r.promoQty > 0 || r.adjust !== 0) && (
                      <div className="inv-safety-bd">
                        자동 {r.autoSafety.toLocaleString()}
                        {r.promoQty > 0 && <span className="inv-bd-promo"> · 행사 +{r.promoQty.toLocaleString()}</span>}
                        {r.adjust !== 0 && <span className="inv-bd-adj"> · 보정 {r.adjust > 0 ? "+" : ""}{r.adjust.toLocaleString()}</span>}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    <button type="button" className="inv-adj-btn" onClick={() => openEdit(r)} title={r.adjustMemo || "안전재고 보정"}>
                      {r.adjustRaw !== 0 ? (
                        <span className={r.adjustRaw !== 0 && r.adjust === 0 && r.adjustUntil ? "inv-adj-expired" : "inv-adj-set"}>
                          {r.adjustRaw > 0 ? "+" : ""}{r.adjustRaw.toLocaleString()}
                          {r.adjustUntil && <span className="inv-adj-until">~{r.adjustUntil.slice(5)}</span>}
                        </span>
                      ) : (
                        <span className="inv-adj-empty">+ 보정</span>
                      )}
                    </button>
                  </td>
                  <td className="num">{r.demand ? r.demand.toLocaleString() : "-"}</td>
                  <td className="num">
                    {r.recommend > 0 ? <strong style={{ color: "var(--sm-orange)" }}>{r.recommend.toLocaleString()}</strong> : <span style={{ color: "var(--sm-text-light)" }}>0</span>}
                  </td>
                  <td className="num">
                    {r.requestByDays == null ? (
                      <span style={{ color: "var(--sm-text-light)" }}>-</span>
                    ) : r.requestByDays <= 0 ? (
                      <span className="inv-dl-cell-urgent">지금!</span>
                    ) : (
                      <span className={r.requestByDays <= 7 ? "inv-dl-cell-soon" : "inv-dl-cell-ok"}>
                        D-{r.requestByDays}{r.requestBy && <span className="inv-dl-cell-date"> {r.requestBy.slice(5)}</span>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {spanDays > 0 && (
        <p className="prod-note">※ 안전재고 = 평상시 하루 출고 × {leadDays}일 + 행사 + 보정. 하루 출고는 최근 약 {spanDays}일 박스히어로 출고 평균이며, <strong>행사 기간에 나간 분은 빼서</strong> 평상시 속도만 잡습니다{capped ? " (출고 표본 일부만 집계)" : ""}. 행사분은 '남은 기간'만큼만 따로 더하고, 미리 만들어둔 재고는 현재고로 차감됩니다.</p>
      )}
      {demixActive && demixUnresolved > 0 && (
        <p className="prod-note">※ 도매 차감 중 SKU가 연결되지 않은 발송 {demixUnresolved.toLocaleString()}개는 차감에서 제외됐습니다(과대생산 안전측).</p>
      )}
      {noSkuDemand > 0 && (
        <p className="prod-note">※ SKU가 연결되지 않은 B2B 수요 {noSkuDemand.toLocaleString()}개는 재고 매칭에서 제외됐습니다(품목에 SKU를 지정하면 포함됩니다).</p>
      )}

      {editRow && (
        <div className="b2b-modal-backdrop" onClick={() => setEditRow(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">안전재고 보정 — {editRow.name}</span>
              <button className="b2b-modal-close" onClick={() => setEditRow(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <p className="inv-modal-auto">
                자동 <strong>{editRow.autoSafety.toLocaleString()}</strong>
                {editRow.promoQty > 0 && <> + 행사 <strong>{editRow.promoQty.toLocaleString()}</strong></>} 에 더하거나 뺄 값을 입력하세요. (음수 가능)
              </p>
              <label className="b2b-field">
                <span className="b2b-field-label">보정값 (개)</span>
                <input className="b2b-input" type="number" value={eDelta} onChange={(e) => setEDelta(e.target.value)} placeholder="예: 500 또는 -100" />
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">사유 (선택)</span>
                <input className="b2b-input" type="text" value={eMemo} onChange={(e) => setEMemo(e.target.value)} placeholder="예: 여름 프로모션 대비" />
              </label>
              <label className="b2b-field">
                <span className="b2b-field-label">만료일 (선택) — 지나면 자동 해제</span>
                <input className="b2b-input" type="date" value={eUntil} onChange={(e) => setEUntil(e.target.value)} />
              </label>
              <p className="inv-modal-preview">
                최종 안전재고 ≈ <strong>{Math.max(0, editRow.autoSafety + editRow.promoQty + (Number(eDelta) || 0)).toLocaleString()}</strong>
              </p>
            </div>
            <div className="b2b-modal-foot">
              <button className="b2b-btn-secondary" onClick={() => { setEDelta(""); setEMemo(""); setEUntil(""); }}>초기화</button>
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
