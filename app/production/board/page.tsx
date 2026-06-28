"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

type Item = { name: string; prodName: string; sku: string | null; spec: string; qty: number };
type Unit = { id: string; kind: "order" | "manual"; status: string; company: string; orderNo: string | null; date: string | null; items: Item[] };
type Contributor = { unitId: string; kind: "order" | "manual"; company: string; qty: number; status: string };
type Batch = { date: string | null; qty: number; status: string; contributors: Contributor[] };
type Col = { key: string; label: string; sub: string; lo: string; hi: string; accent: string };
type Row = { key: string; name: string; spec: string; overdue: number; none: number; byCol: Record<string, number>; cumByCol: Record<string, number>; total: number; batches: Batch[] };

const FAR = "9999-12-31";
const WD = ["일", "월", "화", "수", "목", "금", "토"];
function addDays(iso: string, n: number) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function md(iso: string) { return iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : ""; }
function wd(iso: string) { return WD[new Date(iso + "T00:00:00Z").getUTCDay()]; }

function rollup(statuses: string[]): string {
  if (statuses.length === 0) return "생산대기";
  if (statuses.every((s) => s === "생산완료")) return "생산완료";
  if (statuses.every((s) => s === "생산대기")) return "생산대기";
  return "생산중";
}

// 주간(월요일 시작) / 일간 컬럼 정의 — 마지막 컬럼은 그 이후 전부를 담는 캐치올.
function buildCols(today: string, gran: "week" | "day"): Col[] {
  if (gran === "week") {
    const d = new Date(today + "T00:00:00Z");
    const sinceMon = (d.getUTCDay() + 6) % 7;
    const wEnd = addDays(today, 6 - sinceMon);
    const w1 = addDays(wEnd, 7), w2 = addDays(wEnd, 14);
    return [
      { key: "w0", label: "이번주", sub: `~${md(wEnd)}`, lo: today, hi: wEnd, accent: "var(--sm-danger)" },
      { key: "w1", label: "다음주", sub: `~${md(w1)}`, lo: addDays(wEnd, 1), hi: w1, accent: "var(--sm-info)" },
      { key: "w2", label: "2주후", sub: `~${md(w2)}`, lo: addDays(w1, 1), hi: w2, accent: "var(--sm-info)" },
      { key: "w3", label: "3주후+", sub: "", lo: addDays(w2, 1), hi: FAR, accent: "var(--sm-info)" },
    ];
  }
  const cols: Col[] = [];
  for (let k = 0; k < 7; k++) {
    const dt = addDays(today, k);
    cols.push({ key: `d${k}`, label: k === 0 ? "오늘" : md(dt), sub: `(${wd(dt)})`, lo: dt, hi: dt, accent: k === 0 ? "var(--sm-danger)" : "var(--sm-info)" });
  }
  cols.push({ key: "later", label: "그 이후", sub: "", lo: addDays(today, 7), hi: FAR, accent: "var(--sm-info)" });
  return cols;
}

export default function ProductionBoardPage() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [today, setToday] = useState("");
  const [gran, setGran] = useState<"week" | "day">("week");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  // 생산 백로그: 미완료(생산대기·생산중)를 SKU별로 주간/일간 버킷에 쌓고 누적 계산.
  //  각 칸 = 그 시점까지 끝내야 할 누적량(지연분 포함) → 밀리면 다음 칸으로 굴러가 커진다.
  //  행을 펼치면 그 품목의 배치(생산일별 + 발주처)에서 바로 완료 처리.
  const backlog = useMemo(() => {
    if (!today) return { cols: [] as Col[], rows: [] as Row[], maxCum: 1, totOverdue: 0, totFirst: 0 };
    const cols = buildCols(today, gran);
    type Acc = { key: string; name: string; spec: string; overdue: number; none: number; byCol: Record<string, number>; batches: Map<string, Batch> };
    const m = new Map<string, Acc>();
    for (const u of units) {
      if (u.status === "생산완료") continue;
      for (const it of u.items) {
        const gid = it.sku || `${it.name}|${it.spec}`;
        let r = m.get(gid);
        if (!r) { r = { key: gid, name: it.prodName || it.name, spec: it.spec, overdue: 0, none: 0, byCol: {}, batches: new Map() }; m.set(gid, r); }
        const d = u.date;
        if (!d) r.none += it.qty;
        else if (d < today) r.overdue += it.qty;
        else { const col = cols.find((c) => d >= c.lo && d <= c.hi); if (col) r.byCol[col.key] = (r.byCol[col.key] || 0) + it.qty; }
        const bkey = d || "";
        let b = r.batches.get(bkey);
        if (!b) { b = { date: d, qty: 0, status: "", contributors: [] }; r.batches.set(bkey, b); }
        b.qty += it.qty;
        b.contributors.push({ unitId: u.id, kind: u.kind, company: u.company, qty: it.qty, status: u.status });
      }
    }
    const last = cols[cols.length - 1]?.key;
    const rows: Row[] = [...m.values()].map((r) => {
      let cum = r.overdue;
      const cumByCol: Record<string, number> = {};
      for (const c of cols) { cum += r.byCol[c.key] || 0; cumByCol[c.key] = cum; }
      const batches = [...r.batches.values()]
        .map((b) => ({ ...b, status: rollup(b.contributors.map((x) => x.status)) }))
        .sort((a, b) => (a.date || FAR).localeCompare(b.date || FAR));
      return { key: r.key, name: r.name, spec: r.spec, overdue: r.overdue, none: r.none, byCol: r.byCol, cumByCol, total: cum + r.none, batches };
    }).filter((r) => r.total > 0)
      .sort((a, b) => b.overdue - a.overdue || (b.cumByCol[cols[0].key] || 0) - (a.cumByCol[cols[0].key] || 0) || a.name.localeCompare(b.name, "ko"));
    const maxCum = Math.max(1, ...rows.map((r) => r.cumByCol[last] || 0));
    const totOverdue = rows.reduce((s, r) => s + r.overdue, 0);
    const totFirst = rows.reduce((s, r) => s + (r.cumByCol[cols[0].key] || 0), 0);
    return { cols, rows, maxCum, totOverdue, totFirst };
  }, [units, today, gran]);

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
  function completeBatch(b: Batch) {
    if (!window.confirm(`이 배치를 '생산완료'로 처리할까요? (${b.qty.toLocaleString()}개)\n완료하면 백로그에서 빠집니다.`)) return;
    moveUnits(b.contributors.map((c) => ({ id: c.unitId, kind: c.kind })), "생산완료");
  }
  function toggle(key: string) {
    setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  const cols = backlog.cols;
  const firstLabel = cols[0]?.label || "이번주";

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산 보드</h1>
          <p className="b2b-page-subtitle">밀린 생산이 쌓이는 백로그. 각 칸 = 그 시점까지 끝내야 할 누적 생산량. 행을 펼쳐 생산일별로 완료 처리하세요.</p>
        </div>
        <div className="b2b-page-actions">
          <div className="prod-range-tabs">
            <button className={`prod-range-tab ${gran === "week" ? "is-active" : ""}`} onClick={() => setGran("week")}>주 단위</button>
            <button className={`prod-range-tab ${gran === "day" ? "is-active" : ""}`} onClick={() => setGran("day")}>일 단위</button>
          </div>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : backlog.rows.length === 0 ? (
        <div className="b2b-loading">생산할 항목이 없습니다.</div>
      ) : (
        <>
          <div className="tl-summary">
            {backlog.totOverdue > 0
              ? <span className="tl-sum-bad">🔴 지연 {backlog.totOverdue.toLocaleString()}개 밀림</span>
              : <span className="tl-sum-ok">✓ 지연 없음</span>}
            <span className="tl-sum-dot">·</span>
            <span>{firstLabel}까지 <strong>{backlog.totFirst.toLocaleString()}개</strong> 생산 필요</span>
          </div>
          <p className="tl-help">각 칸 = 그 시점까지 끝내야 할 <strong>누적</strong> 생산량(지연분 포함). 작은 <span className="tl-help-new">+N</span>은 그때 새로 잡힌 양 — 밀리면 다음 칸으로 굴러가 커집니다. 품목을 <strong>클릭</strong>하면 생산일별로 완료 처리할 수 있어요.</p>
          <div className="tl-wrap">
            <table className="tl-table">
              <thead><tr>
                <th className="tl-item-h">품목</th>
                <th className="tl-h-overdue">지연</th>
                {cols.map((c) => <th key={c.key}>{c.label}{c.sub && <span className="tl-th-sub">{c.sub}</span>}</th>)}
                <th className="tl-h-none">미정</th>
              </tr></thead>
              <tbody>
                {backlog.rows.map((r) => {
                  const isOpen = expanded.has(r.key);
                  return (
                    <Fragment key={r.key}>
                      <tr className={`${r.overdue > 0 ? "tl-row-bad" : ""} ${isOpen ? "tl-row-open" : ""}`}>
                        <td className="tl-item tl-clickable" onClick={() => toggle(r.key)}>
                          <span className={`tl-caret ${isOpen ? "is-open" : ""}`}>▸</span>
                          <span className="tl-item-name">{r.name}</span>{r.spec ? <span className="tl-item-spec"> {r.spec}</span> : ""}
                        </td>
                        <td className="tl-cell tl-overdue">
                          <span className="tl-num" style={{ color: r.overdue > 0 ? "var(--sm-danger)" : "#cdd2d8" }}>{r.overdue > 0 ? r.overdue.toLocaleString() : "·"}</span>
                        </td>
                        {cols.map((c) => {
                          const cum = r.cumByCol[c.key] || 0;
                          const nw = r.byCol[c.key] || 0;
                          return (
                            <td key={c.key} className="tl-cell">
                              {cum > 0 && <span className="tl-bar" style={{ width: `${Math.round((cum / backlog.maxCum) * 100)}%`, background: c.accent }} />}
                              <span className="tl-num" style={{ color: cum > 0 ? "var(--sm-text)" : "#cdd2d8" }}>{cum > 0 ? cum.toLocaleString() : "·"}</span>
                              {nw > 0 && <span className="tl-new">+{nw.toLocaleString()}</span>}
                            </td>
                          );
                        })}
                        <td className="tl-cell tl-none"><span className="tl-num" style={{ color: r.none > 0 ? "var(--sm-text-mid)" : "#cdd2d8" }}>{r.none > 0 ? r.none.toLocaleString() : "·"}</span></td>
                      </tr>
                      {isOpen && (
                        <tr className="tl-detail-row">
                          <td colSpan={cols.length + 3}>
                            <div className="tl-batches">
                              {r.batches.map((b) => {
                                const overdue = !!b.date && b.date < today;
                                return (
                                  <div key={(b.date || "none")} className="tl-batch">
                                    <span className={`tl-batch-date ${overdue ? "is-overdue" : ""}`}>{b.date ? `${md(b.date)}(${wd(b.date)})` : "미정"}</span>
                                    <span className={`tl-batch-st st-${b.status}`}>{b.status}</span>
                                    <span className="tl-batch-co">{b.contributors.map((c, i) => <span key={i}>{c.company} {c.qty.toLocaleString()}{c.kind === "manual" ? "(직접)" : ""}{i < b.contributors.length - 1 ? " · " : ""}</span>)}</span>
                                    <span className="tl-batch-qty">합계 {b.qty.toLocaleString()}</span>
                                    <span className="tl-batch-btns">
                                      {b.status === "생산대기" && <button onClick={() => moveUnits(b.contributors.map((c) => ({ id: c.unitId, kind: c.kind })), "생산중")}>생산 시작</button>}
                                      {b.status === "생산중" && <button onClick={() => moveUnits(b.contributors.map((c) => ({ id: c.unitId, kind: c.kind })), "생산대기")}>↩ 대기</button>}
                                      <button className="tl-done-btn" onClick={() => completeBatch(b)}>완료 ✓</button>
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
