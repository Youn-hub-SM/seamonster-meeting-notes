"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Item = { name: string; prodName: string; sku: string | null; spec: string; qty: number };
type Unit = { id: string; kind: "order" | "manual"; status: string; company: string; orderNo: string | null; date: string | null; items: Item[] };
type Contributor = { company: string; qty: number; unitId: string; kind: "order" | "manual"; status: string };
type ProdCard = { key: string; product: string; spec: string; date: string | null; totalQty: number; status: string; contributors: Contributor[] };
type BacklogRow = { key: string; name: string; spec: string; b: Record<Bucket, number>; cum0: number; cum1: number; cum2: number; cum3: number; total: number };

const COLUMNS = ["생산대기", "생산중", "생산완료"] as const;
const COL_COLOR: Record<string, string> = { "생산대기": "#6b7280", "생산중": "#b86e00", "생산완료": "#22863a" };

function rollup(statuses: string[]): string {
  if (statuses.length === 0) return "생산대기";
  if (statuses.every((s) => s === "생산완료")) return "생산완료";
  if (statuses.every((s) => s === "생산대기")) return "생산대기";
  return "생산중";
}

// ── 타임라인(백로그) 주간 경계 — 월요일 시작, KST 기준(today는 API가 준 KST 날짜)
function addDays(iso: string, n: number) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function md(iso: string) { return iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : ""; }
type Bounds = { today: string; wEnd: string; w1End: string; w2End: string };
function weekBounds(today: string): Bounds {
  const d = new Date(today + "T00:00:00Z");
  const sinceMon = (d.getUTCDay() + 6) % 7; // 0=월
  const wEnd = addDays(today, 6 - sinceMon); // 이번 주 일요일
  return { today, wEnd, w1End: addDays(wEnd, 7), w2End: addDays(wEnd, 14) };
}
type Bucket = "overdue" | "w0" | "w1" | "w2" | "w3" | "none";
function bucketOf(date: string | null, B: Bounds): Bucket {
  if (!date) return "none";
  if (date < B.today) return "overdue";
  if (date <= B.wEnd) return "w0";
  if (date <= B.w1End) return "w1";
  if (date <= B.w2End) return "w2";
  return "w3";
}

export default function ProductionBoardPage() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [today, setToday] = useState("");
  const [view, setView] = useState<"product" | "company" | "timeline">("product");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const j = await (await fetch("/api/production/board", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setUnits(j.cards || []);
      setToday(j.today || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 오류");
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // 품목별 카드 (품목+규격+생산일)
  const productCards = useMemo(() => {
    const m = new Map<string, ProdCard>();
    for (const u of units) {
      for (const it of u.items) {
        // 같은 SKU = 같은 생산품목으로 묶음 (B2B 품목명 달라도). SKU 없으면 품목명+규격.
        const groupId = it.sku || `${it.name}|${it.spec}`;
        const key = `${groupId}|${u.date || ""}`;
        let c = m.get(key);
        if (!c) { c = { key, product: it.prodName || it.name, spec: it.spec, date: u.date, totalQty: 0, status: "", contributors: [] }; m.set(key, c); }
        c.totalQty += it.qty;
        c.contributors.push({ company: u.company, qty: it.qty, unitId: u.id, kind: u.kind, status: u.status });
      }
    }
    const cards = [...m.values()];
    for (const c of cards) c.status = rollup(c.contributors.map((x) => x.status));
    return cards;
  }, [units]);

  // 타임라인(생산 백로그): 미완료(생산대기·생산중)를 SKU별로 주간 버킷에 쌓고 누적 계산.
  //  핵심 — 각 주 칸은 '그 주까지 끝내야 할 누적량'이라 지연되면 다음 주로 굴러가 커진다.
  const backlog = useMemo(() => {
    if (!today) return { rows: [] as BacklogRow[], maxCum: 1, totOverdue: 0, totW0: 0, B: null as Bounds | null };
    const B = weekBounds(today);
    const m = new Map<string, BacklogRow>();
    for (const u of units) {
      if (u.status === "생산완료") continue;
      for (const it of u.items) {
        const gid = it.sku || `${it.name}|${it.spec}`;
        let r = m.get(gid);
        if (!r) { r = { key: gid, name: it.prodName || it.name, spec: it.spec, b: { overdue: 0, w0: 0, w1: 0, w2: 0, w3: 0, none: 0 }, cum0: 0, cum1: 0, cum2: 0, cum3: 0, total: 0 }; m.set(gid, r); }
        r.b[bucketOf(u.date, B)] += it.qty;
      }
    }
    const rows = [...m.values()].map((r) => {
      r.cum0 = r.b.overdue + r.b.w0;
      r.cum1 = r.cum0 + r.b.w1;
      r.cum2 = r.cum1 + r.b.w2;
      r.cum3 = r.cum2 + r.b.w3;
      r.total = r.cum3 + r.b.none;
      return r;
    }).filter((r) => r.total > 0)
      .sort((a, b) => b.b.overdue - a.b.overdue || b.cum0 - a.cum0 || a.name.localeCompare(b.name, "ko"));
    const maxCum = Math.max(1, ...rows.map((r) => r.cum3));
    const totOverdue = rows.reduce((s, r) => s + r.b.overdue, 0);
    const totW0 = rows.reduce((s, r) => s + r.cum0, 0);
    return { rows, maxCum, totOverdue, totW0, B };
  }, [units, today]);

  async function moveUnits(refs: { id: string; kind: "order" | "manual" }[], status: string) {
    const seen = new Set<string>();
    const uniq = refs.filter((r) => { const k = r.kind + r.id; if (seen.has(k)) return false; seen.add(k); return true; });
    const prev = units;
    setUnits((us) => us.map((u) => (uniq.some((r) => r.id === u.id && r.kind === u.kind) ? { ...u, status } : u)));
    try {
      await Promise.all(uniq.map(async (r) => {
        const url = r.kind === "order" ? `/api/b2b/orders/${r.id}` : `/api/production/manual`;
        const body = r.kind === "order" ? { production_status: status } : { id: r.id, status };
        const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || "변경 실패");
      }));
    } catch (e) {
      setUnits(prev);
      setError(e instanceof Error ? e.message : "변경 실패");
    }
  }

  const overdueCount = useMemo(() => {
    if (view === "product") return productCards.filter((c) => c.status !== "생산완료" && c.date && c.date < today).length;
    return units.filter((u) => u.status !== "생산완료" && u.date && u.date < today).length;
  }, [productCards, units, view, today]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산 보드</h1>
          <p className="b2b-page-subtitle">같은 품목·생산일은 한 카드로 묶어 생산 전·중·완료를 체크합니다. 생산일이 지난 미완료는 재고 쇼트 위험.</p>
        </div>
        <div className="b2b-page-actions">
          <div className="prod-range-tabs">
            <button className={`prod-range-tab ${view === "product" ? "is-active" : ""}`} onClick={() => setView("product")}>품목별</button>
            <button className={`prod-range-tab ${view === "company" ? "is-active" : ""}`} onClick={() => setView("company")}>발주처별</button>
            <button className={`prod-range-tab ${view === "timeline" ? "is-active" : ""}`} onClick={() => setView("timeline")}>타임라인</button>
          </div>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {view !== "timeline" && overdueCount > 0 && (
        <div className="b2b-error" style={{ background: "#fff4e0", color: "#b86e00", border: "1px solid #f0d9a8" }}>
          ⚠ 생산일이 지났는데 아직 생산 전/중인 건 {overdueCount}건 — 재고 쇼트 위험
        </div>
      )}

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : view === "timeline" ? (
        !backlog.B || backlog.rows.length === 0 ? (
          <div className="b2b-loading">생산할 항목이 없습니다.</div>
        ) : (
          <div className="tl-block">
            <div className="tl-summary">
              {backlog.totOverdue > 0
                ? <span className="tl-sum-bad">🔴 지연 {backlog.totOverdue.toLocaleString()}개 밀림</span>
                : <span className="tl-sum-ok">✓ 지연 없음</span>}
              <span className="tl-sum-dot">·</span>
              <span>이번주까지 <strong>{backlog.totW0.toLocaleString()}개</strong> 생산 필요</span>
            </div>
            <p className="tl-help">각 칸 = 그 시점까지 끝내야 할 <strong>누적</strong> 생산량(지연분 포함). 작은 <span className="tl-help-new">+N</span>은 그 주에 새로 잡힌 양 — 밀리면 다음 칸으로 굴러가 커집니다.</p>
            <div className="tl-wrap">
              <table className="tl-table">
                <thead><tr>
                  <th className="tl-item-h">품목</th>
                  <th className="tl-h-overdue">지연</th>
                  <th>이번주<span className="tl-th-sub">~{md(backlog.B.wEnd)}</span></th>
                  <th>다음주<span className="tl-th-sub">~{md(backlog.B.w1End)}</span></th>
                  <th>2주후<span className="tl-th-sub">~{md(backlog.B.w2End)}</span></th>
                  <th>3주후+</th>
                  <th className="tl-h-none">미정</th>
                </tr></thead>
                <tbody>
                  {backlog.rows.map((r) => {
                    const weeks = [
                      { cum: r.cum0, nw: r.b.w0, c: "#e8590c" },
                      { cum: r.cum1, nw: r.b.w1, c: "#1971c2" },
                      { cum: r.cum2, nw: r.b.w2, c: "#1971c2" },
                      { cum: r.cum3, nw: r.b.w3, c: "#1971c2" },
                    ];
                    return (
                      <tr key={r.key} className={r.b.overdue > 0 ? "tl-row-bad" : ""}>
                        <td className="tl-item"><span className="tl-item-name">{r.name}</span>{r.spec ? <span className="tl-item-spec"> {r.spec}</span> : ""}</td>
                        <td className="tl-cell tl-overdue">
                          <span className="tl-num" style={{ color: r.b.overdue > 0 ? "#c92a2a" : "#cdd2d8" }}>{r.b.overdue > 0 ? r.b.overdue.toLocaleString() : "·"}</span>
                        </td>
                        {weeks.map((w, i) => (
                          <td key={i} className="tl-cell">
                            {w.cum > 0 && <span className="tl-bar" style={{ width: `${Math.round((w.cum / backlog.maxCum) * 100)}%`, background: w.c }} />}
                            <span className="tl-num" style={{ color: w.cum > 0 ? "var(--sm-text)" : "#cdd2d8" }}>{w.cum > 0 ? w.cum.toLocaleString() : "·"}</span>
                            {w.nw > 0 && <span className="tl-new">+{w.nw.toLocaleString()}</span>}
                          </td>
                        ))}
                        <td className="tl-cell tl-none"><span className="tl-num" style={{ color: r.b.none > 0 ? "var(--sm-text-mid)" : "#cdd2d8" }}>{r.b.none > 0 ? r.b.none.toLocaleString() : "·"}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : (
        <div className="kanban">
          {COLUMNS.map((col) => {
            const ci = COLUMNS.indexOf(col);
            const productItems = productCards.filter((c) => c.status === col).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
            const companyItems = units.filter((u) => u.status === col).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
            const count = view === "product" ? productItems.length : companyItems.length;
            return (
              <div key={col} className="kanban-col">
                <div className="kanban-col-head" style={{ color: COL_COLOR[col] }}>
                  {col} <span className="kanban-col-count">{count}</span>
                </div>
                <div className="kanban-col-body">
                  {count === 0 ? (
                    <div className="kanban-empty">없음</div>
                  ) : view === "product" ? (
                    productItems.map((c) => {
                      const overdue = c.status !== "생산완료" && !!c.date && c.date < today;
                      return (
                        <div key={c.key} className={`kanban-card ${overdue ? "is-overdue" : ""}`}>
                          <div className="kanban-card-top">
                            <span className="kanban-card-company">{c.product}{c.spec ? <span className="ki-spec"> {c.spec}</span> : ""}</span>
                            {c.date && <span className={`kanban-card-date ${overdue ? "is-overdue" : ""}`}>{c.date.slice(5)}</span>}
                          </div>
                          <div className="kanban-card-bigqty">{c.totalQty.toLocaleString()}<span>개</span></div>
                          <div className="kanban-card-contributors">
                            {c.contributors.map((x, i) => (
                              <span key={i}>{x.company} {x.qty.toLocaleString()}{x.kind === "manual" ? "(직접)" : ""}{i < c.contributors.length - 1 ? " · " : ""}</span>
                            ))}
                          </div>
                          <div className="kanban-card-actions">
                            {ci > 0 && <button onClick={() => moveUnits(c.contributors.map((x) => ({ id: x.unitId, kind: x.kind })), COLUMNS[ci - 1])}>←</button>}
                            {ci < COLUMNS.length - 1 && (
                              <button className="kanban-fwd" onClick={() => moveUnits(c.contributors.map((x) => ({ id: x.unitId, kind: x.kind })), COLUMNS[ci + 1])}>
                                {col === "생산대기" ? "생산 시작 →" : "생산 완료 ✓"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    companyItems.map((u) => {
                      const overdue = u.status !== "생산완료" && !!u.date && u.date < today;
                      return (
                        <div key={u.kind + u.id} className={`kanban-card ${overdue ? "is-overdue" : ""}`}>
                          <div className="kanban-card-top">
                            <span className="kanban-card-company">{u.company}{u.kind === "manual" && <span className="prod-side-manual-tag">직접</span>}</span>
                            {u.date && <span className={`kanban-card-date ${overdue ? "is-overdue" : ""}`}>{u.date.slice(5)}</span>}
                          </div>
                          <ul className="kanban-card-items">
                            {u.items.map((it, i) => (
                              <li key={i}><span className="ki-name">{it.name}{it.spec ? ` ${it.spec}` : ""}</span><span className="ki-qty">{it.qty.toLocaleString()}</span></li>
                            ))}
                          </ul>
                          <div className="kanban-card-actions">
                            {ci > 0 && <button onClick={() => moveUnits([{ id: u.id, kind: u.kind }], COLUMNS[ci - 1])}>←</button>}
                            {ci < COLUMNS.length - 1 && (
                              <button className="kanban-fwd" onClick={() => moveUnits([{ id: u.id, kind: u.kind }], COLUMNS[ci + 1])}>
                                {col === "생산대기" ? "생산 시작 →" : "생산 완료 ✓"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
