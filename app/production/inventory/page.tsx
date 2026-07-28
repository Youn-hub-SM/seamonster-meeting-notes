"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { matchKoQuery } from "@/app/lib/hangul";
import { addBusinessDays } from "@/app/lib/business-days";

type InvRow = {
  sku: string;
  name: string;
  stock: number | null;
  dailyOut: number;
  rawDailyOut: number;
  autoSafety: number;
  promoQty: number;
  adjust: number;
  adjustRaw: number;
  adjustExcludeRaw: number;
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

type Priority = { sku: string; name: string; urgency: string; qty: number; byWhen: string; reason: string };
type Advice = { summary: string; priorities: Priority[]; notes: string[] };
const URG_STYLE: Record<string, { bg: string; fg: string }> = {
  "높음": { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
  "중간": { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  "낮음": { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
};

export default function InventoryPage() {
  const [rows, setRows] = useState<InvRow[]>([]);
  const [itemCount, setItemCount] = useState(0);
  const [leadDays, setLeadDays] = useState(10);
  const [spanDays, setSpanDays] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [onlyNeed, setOnlyNeed] = useState(true);
  const [editRow, setEditRow] = useState<InvRow | null>(null);
  const [eDelta, setEDelta] = useState("");
  const [eExclude, setEExclude] = useState("");
  const [eMemo, setEMemo] = useState("");
  const [eUntil, setEUntil] = useState("");
  const [saving, setSaving] = useState(false);
  // 채널 탭 — 소매/도매 각각의 재고·소진 속도로 조언(도매는 행사·보정 없는 순수 수식).
  const [channel, setChannel] = useState<"소매" | "도매">("소매");
  // AI 조언 (생산 조언 합침)
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);

  async function genAdvice() {
    setAdviceLoading(true); setError("");
    try {
      const res = await fetch("/api/production/advice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "AI 조언 생성 실패");
      setAdvice(j.advice);
    } catch (e) { setError(e instanceof Error ? e.message : "AI 조언 생성 실패"); }
    setAdviceLoading(false);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/production/inventory?channel=${encodeURIComponent(channel)}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
      setItemCount(j.itemCount || 0);
      setLeadDays(j.leadDays || 10);
      setSpanDays(j.velocitySpanDays || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }, [channel]);

  useEffect(() => { load(); }, [load]);
  // 탭 전환 시 선택·AI 조언 초기화(채널이 다르면 다른 데이터)
  useEffect(() => { setSel(new Set()); setAdvice(null); }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    let needItems = 0, needQty = 0, below = 0, urgent = 0, soon = 0;
    for (const r of rows) {
      if (r.recommend > 0) { needItems++; needQty += r.recommend; }
      if (r.belowSafety) below++;
      if (r.requestByDays != null) {
        if (r.requestByDays <= 0) urgent++;
        else if (r.requestByDays <= 7) soon++;
      }
    }
    return { needItems, needQty, below, urgent, soon };
  }, [rows]);

  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const base = onlyNeed ? rows.filter((r) => r.recommend > 0) : rows;
    const q = search.trim();
    return q ? base.filter((r) => matchKoQuery(`${r.name} ${r.sku}`, q)) : base;   // 이름·SKU·초성 검색
  }, [rows, onlyNeed, search]);

  // 생산 요청 — 품목을 체크하고 버튼을 누르면 '수량 확인' 모달이 열린다.
  //  권장 수량이 기본으로 채워지며(0이면 빈칸) 실제 원하는 양으로 고쳐서 요청 처리.
  //  권장 생산이 없는 품목도 체크 가능(도매 등 MD 판단 물량).
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  type ReqLine = { sku: string; name: string; product_id: string; recommend: number; qty: string };
  const [reqDraft, setReqDraft] = useState<{ lines: ReqLine[]; missed: string[] } | null>(null);
  const [reqDue, setReqDue] = useState("");
  const [reqPurpose, setReqPurpose] = useState<"재고 보충" | "도매 납품">("재고 보충");
  const selectable = useMemo(() => shown.filter((r) => r.recommend > 0), [shown]);
  const allChecked = selectable.length > 0 && selectable.every((r) => sel.has(r.sku));
  const toggleSel = (sku: string) => setSel((s) => { const n = new Set(s); if (n.has(sku)) n.delete(sku); else n.add(sku); return n; });
  const toggleAll = () => setSel(allChecked ? new Set() : new Set([...sel, ...selectable.map((r) => r.sku)]));

  // 1단계: 체크한 품목을 SKU→product_id 로 매칭해 수량 확인 모달 열기
  async function openRequestDraft() {
    const picked = rows.filter((r) => sel.has(r.sku));
    if (!picked.length || creating) return;
    setCreating(true); setError("");
    try {
      // 품목 마스터에서 SKU → product_id 매칭(묶음 제외 — 세트는 자체 재고가 없어 생산 입고 대상 아님)
      const j = await (await fetch("/api/inventory/overview?channel=도매", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "품목 조회 실패");
      const bySku = new Map<string, string>();
      for (const row of (j.rows || []) as { product_id: string; sku: string | null; is_bundle?: boolean }[]) {
        if (row.sku && !row.is_bundle) bySku.set(row.sku.toUpperCase(), row.product_id);
      }
      const lines: ReqLine[] = [];
      const missed: string[] = [];
      for (const r of picked) {
        const pid = bySku.get(r.sku.toUpperCase());
        if (pid) lines.push({ sku: r.sku, name: r.name, product_id: pid, recommend: r.recommend, qty: r.recommend > 0 ? String(r.recommend) : "" });
        else missed.push(r.sku);
      }
      if (!lines.length) throw new Error(`선택 품목을 품목 목록에서 찾지 못했습니다: ${missed.join(", ")} (묶음이거나 SKU 미등록)`);
      setReqDue(addBusinessDays(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), 7));
      setReqPurpose(channel === "도매" ? "도매 납품" : "재고 보충"); // 탭 기준 기본 용도
      setReqDraft({ lines, missed });
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청 준비 실패");
    }
    setCreating(false);
  }

  // 2단계: 입력한 실제 수량으로 요청 생성
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
        body: JSON.stringify({ title: "생산 화면에서 생성", purpose: reqPurpose, due_date: reqDue || undefined, items }),
      })).json();
      if (!c.ok) throw new Error(c.error || "요청 생성 실패");
      router.push("/production/request"); // 생산 요청 목록에서 확인(일정에도 마감일 기준 반영)
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청 생성 실패");
      setCreating(false);
    }
  }

  function openEdit(r: InvRow) {
    setEditRow(r);
    setEDelta(r.adjustRaw ? String(r.adjustRaw) : "");
    setEExclude(r.adjustExcludeRaw ? String(r.adjustExcludeRaw) : "");
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
        body: JSON.stringify({ sku: editRow.sku, delta: Number(eDelta) || 0, excludeOut: Number(eExclude) || 0, memo: eMemo, until: eUntil || null }),
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

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산</h1>
          <p className="b2b-page-subtitle">{channel === "도매"
            ? <>도매 기준 — 안전재고 = 최근 하루 도매 소진(B2B 납품) × {leadDays}일. 행사·보정 없이 순수 수식.</>
            : <>소매 기준 — 안전재고 = 최근 하루 소매 출고 × {leadDays}일 + 프로모션 + 수동 보정</>}</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={openRequestDraft} disabled={sel.size === 0 || creating} title={sel.size === 0 ? "아래 표에서 품목을 체크하세요" : undefined}>
            {creating && !reqDraft ? "준비 중…" : `선택 ${sel.size}종 생산 요청`}
          </button>
          <button className="b2b-btn-secondary" onClick={genAdvice} disabled={adviceLoading}>
            {adviceLoading ? "AI 분석 중…" : advice ? "다시 분석" : "AI 조언"}
          </button>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* 필터 — 헤더와 분리해 위치 고정(클릭해도 안 밀림) */}
      <div className="sm-row" style={{ marginBottom: 12, gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div className="sm-tabs" style={{ margin: 0 }}>
          {(["소매", "도매"] as const).map((ch) => (
            <button key={ch} type="button" className={`sm-tab ${channel === ch ? "is-active" : ""}`} onClick={() => setChannel(ch)}>{ch}</button>
          ))}
        </div>
        <input className="b2b-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="품목 검색 — 이름·SKU·초성 (예: ㄱㅇ)" style={{ maxWidth: 280 }} />
        <label className="prod-filter-check">
          <input type="checkbox" checked={onlyNeed} onChange={(e) => setOnlyNeed(e.target.checked)} /> 생산필요만 보기
        </label>
        {sel.size > 0 && <span className="sm-faint" style={{ fontSize: 12 }}>체크 {sel.size}종 (검색을 바꿔도 유지)</span>}
      </div>

      <div className="b2b-dash-grid" style={{ marginBottom: 16 }}>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">생산 권장 품목</div>
          <div className="b2b-stat-card-value">{stats.needItems}종</div>
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">총 권장 생산량</div>
          <div className="b2b-stat-card-value">{stats.needQty.toLocaleString()}</div>
        </div>
        <div className="b2b-stat-card" style={stats.below > 0 ? { borderColor: "var(--sm-danger-border)" } : undefined}>
          <div className="b2b-stat-card-label" style={stats.below > 0 ? { color: "var(--sm-danger)" } : undefined}>
            안전재고 미달
          </div>
          <div className="b2b-stat-card-value" style={stats.below > 0 ? { color: "var(--sm-danger)" } : undefined}>
            {stats.below}종
          </div>
        </div>
      </div>

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
        <div className="b2b-empty">
          {onlyNeed ? "지금 추가로 생산할 품목이 없습니다." : "표시할 품목이 없습니다."}
        </div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead>
              <tr>
                <th style={{ width: 34 }}><input type="checkbox" checked={allChecked} onChange={toggleAll} title="권장 생산 있는 품목 전체 선택" /></th>
                <th>SKU</th>
                <th>품목</th>
                <th className="num">현재고</th>
                <th className="num">하루 출고</th>
                <th className="num">안전재고</th>
                {channel === "소매" && <th className="num">보정</th>}
                <th className="num">권장 생산</th>
                <th className="num">요청 마감</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.sku} className={r.belowSafety ? "is-overdue" : ""}>
                  <td><input type="checkbox" checked={sel.has(r.sku)} onChange={() => toggleSel(r.sku)} /></td>
                  <td><code style={{ fontSize: 11.5 }}>{r.sku}</code></td>
                  <td>
                    {r.name}
                    {!r.inBoxhero && <span className="prod-tag">원장에 없음</span>}
                  </td>
                  <td className="num">
                    {r.stock == null ? <span style={{ color: "var(--sm-text-light)" }}>-</span> : (
                      <span style={r.belowSafety ? { color: "var(--sm-danger)", fontWeight: 700 } : undefined}>
                        {r.stock.toLocaleString()}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {r.dailyOut || r.rawDailyOut ? (
                      <>
                        <span>{r.dailyOut.toFixed(1)}</span>
                        {(r.rawDailyOut - r.dailyOut) > 0.05 && (
                          <span className="inv-raw-out" title={`행사 제외 전 ${r.rawDailyOut.toFixed(1)}`}>행사↓</span>
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
                  {channel === "소매" && <td className="num">
                    <button type="button" className="inv-adj-btn" onClick={() => openEdit(r)} title={r.adjustMemo || "안전재고 보정"}>
                      {r.adjustRaw !== 0 || r.adjustExcludeRaw > 0 ? (
                        <span className={r.adjustRaw !== 0 && r.adjust === 0 && r.adjustUntil ? "inv-adj-expired" : "inv-adj-set"}>
                          {r.adjustExcludeRaw > 0 && <>행사−{r.adjustExcludeRaw.toLocaleString()}</>}
                          {r.adjustExcludeRaw > 0 && r.adjustRaw !== 0 ? " " : ""}
                          {r.adjustRaw !== 0 && <>{r.adjustRaw > 0 ? "+" : ""}{r.adjustRaw.toLocaleString()}</>}
                          {r.adjustUntil && <span className="inv-adj-until">~{r.adjustUntil.slice(5)}</span>}
                        </span>
                      ) : (
                        <span className="inv-adj-empty">+ 보정</span>
                      )}
                    </button>
                  </td>}
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

      {spanDays > 0 && (channel === "도매" ? (
        <p className="prod-note">※ 도매 안전재고 = 하루 도매 소진 × {leadDays}일. 하루 소진은 최근 약 {spanDays}일 도매 채널 출고(B2B 납품) 평균이며, 소매로 옮긴 이동분은 제외합니다(소매 부족은 소매 탭이 잡음 — 이중 계상 방지). 행사·수동 보정은 적용하지 않습니다.</p>
      ) : (
        <p className="prod-note">※ 안전재고 = 평상시 하루 출고 × {leadDays}일 + 행사 + 보정. 하루 출고는 최근 약 {spanDays}일 소매 채널 출고(판매) 평균이며, <strong>행사 기간에 나간 분은 빼서</strong> 평상시 속도만 잡습니다. 행사분은 '남은 기간'만큼만 따로 더하고, 미리 만들어둔 재고는 현재고로 차감됩니다.</p>
      ))}

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
                  <span style={{ fontSize: 13, fontWeight: 600 }}>용도</span>
                  <div className="sm-tabs" style={{ margin: 0 }}>
                    {(["재고 보충", "도매 납품"] as const).map((pp) => (
                      <button key={pp} type="button" className={`sm-tab ${reqPurpose === pp ? "is-active" : ""}`} onClick={() => setReqPurpose(pp)}>{pp}</button>
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
                    <tr key={l.sku}>
                      <td>{l.name} <code style={{ fontSize: 11 }} className="sm-faint">{l.sku}</code></td>
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
              {reqDraft.missed.length > 0 && (
                <p className="sm-warn" style={{ marginTop: 8, fontSize: 12 }}>
                  {reqDraft.missed.length}종은 품목 목록에 없어 제외됩니다: {reqDraft.missed.join(", ")} (묶음이거나 SKU 미등록)
                </p>
              )}
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
                  const newAuto = Math.ceil(newDaily * leadDays);
                  const newSafety = Math.max(0, newAuto + editRow.promoQty + (Number(eDelta) || 0));
                  return (
                    <>적용 후 안전재고 ≈ <strong>{newSafety.toLocaleString()}</strong> <span style={{ color: "var(--sm-text-light)", fontWeight: 400 }}>(하루 {newDaily.toFixed(1)}×{leadDays}일{editRow.promoQty > 0 ? ` +행사 ${editRow.promoQty}` : ""}{(Number(eDelta) || 0) !== 0 ? ` +확보 ${Number(eDelta) || 0}` : ""})</span></>
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
