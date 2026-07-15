"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { INV_TYPE_COLOR, INV_CHANNEL_COLOR, type InventoryTxn, type InvChannel, type InvChannelFilter } from "@/app/lib/inventory";
import { ChannelFilter } from "../ChannelTabs";

// 생산요청 상태 변경/작성 이벤트(activity_log) — 원장과 함께 날짜별로 섞어 표시.
type PrEvent = { id: string; date: string; created_at: string; summary: string; actor: string | null };
function kstDate(iso: string) { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }); } catch { return (iso || "").slice(0, 10); } }

type Feed =
  | { kind: "txn"; date: string; ts: string; t: InventoryTxn }
  | { kind: "event"; date: string; ts: string; e: PrEvent };

// 활동 히스토리 — 날짜별 아코디언. 입고·출고·조정 원장 + 생산요청 상태 변경을 함께 표시.
export default function ActivityPage() {
  const [txns, setTxns] = useState<InventoryTxn[]>([]);
  const [events, setEvents] = useState<PrEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<InvChannelFilter>("전체");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const txnUrl = `/api/inventory/txns?limit=2000${channel === "전체" ? "" : `&channel=${encodeURIComponent(channel)}`}`;
      const [tj, ej] = await Promise.all([
        (await fetch(txnUrl, { cache: "no-store" })).json(),
        // 생산요청 작성·상태변경 이벤트(생산=도매) — B2B 변경기록엔 제외되고 여기(생산·재고)로만 온다.
        fetch("/api/b2b/activity?type=production_request.created,production_request.status_changed&limit=300", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ ok: false })),
      ]);
      if (!tj.ok) throw new Error(tj.error || "조회 실패");
      const rows: InventoryTxn[] = tj.rows || [];
      setTxns(rows);
      const evs: PrEvent[] = ej.ok
        ? (ej.activities || []).map((a: { id: string; created_at: string; summary: string; actor: string | null }) => ({ id: a.id, created_at: a.created_at, date: kstDate(a.created_at), summary: a.summary, actor: a.actor }))
        : [];
      setEvents(evs);
      const firstDate = rows[0]?.txn_date || evs[0]?.date;
      setOpen(new Set(firstDate ? [firstDate] : [])); // 가장 최근 날짜만 펼침
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [channel]);
  useEffect(() => { load(); }, [load]);

  async function cancel(t: InventoryTxn) {
    if (!window.confirm("이 거래를 취소(삭제)할까요? 재고가 원복됩니다.")) return;
    await fetch(`/api/inventory/txn?id=${encodeURIComponent(t.id)}`, { method: "DELETE" });
    await load();
  }

  const q = search.trim().toLowerCase();
  // 생산요청은 도매 활동 → '소매' 필터일 땐 숨김.
  const shownEvents = useMemo(() => {
    if (channel === "소매") return [];
    return q ? events.filter((e) => e.summary.toLowerCase().includes(q)) : events;
  }, [events, q, channel]);
  const filteredTxns = useMemo(() => q
    ? txns.filter((t) => `${t.product_name} ${t.sku || ""} ${t.memo || ""} ${t.partner || ""}`.toLowerCase().includes(q))
    : txns, [txns, q]);

  // 날짜별 묶음(최신순) — 원장 + 생산요청 이벤트 통합, 날짜 안은 시각 내림차순.
  const groups = useMemo(() => {
    const items: Feed[] = [];
    for (const t of filteredTxns) items.push({ kind: "txn", date: t.txn_date || "(미지정)", ts: t.created_at || "", t });
    for (const e of shownEvents) items.push({ kind: "event", date: e.date || "(미지정)", ts: e.created_at || "", e });
    const m = new Map<string, Feed[]>();
    for (const it of items) { const a = m.get(it.date); if (a) a.push(it); else m.set(it.date, [it]); }
    for (const arr of m.values()) arr.sort((a, b) => b.ts.localeCompare(a.ts));
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filteredTxns, shownEvents]);

  const totalCount = filteredTxns.length + shownEvents.length;
  const isOpen = (d: string) => (q ? true : open.has(d)); // 검색 중이면 매칭 날짜 자동 펼침
  const toggle = (d: string) => setOpen((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; });

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">변경 기록</h1></div>
        <div className="b2b-page-actions"><button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button></div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}

      <div className="sm-between" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <ChannelFilter value={channel} onChange={setChannel} />
          <input className="b2b-input" placeholder="품목·SKU·메모·거래처 검색" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260, maxWidth: "100%" }} />
        </div>
        {q && <span className="sm-faint" style={{ fontSize: 12 }}>{groups.length}일 · {totalCount}건</span>}
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : groups.length === 0 ? (
        <div className="b2b-empty">{txns.length === 0 && events.length === 0 ? "내역이 없습니다." : "검색 결과가 없습니다."}</div>
      ) : (
        <div className="sm-col" style={{ gap: 8 }}>
          {groups.map(([date, list]) => {
            const o = isOpen(date);
            const byType = list.reduce((m, it) => { if (it.kind === "txn") m[it.t.type] = (m[it.t.type] || 0) + 1; return m; }, {} as Record<string, number>);
            const evCount = list.filter((it) => it.kind === "event").length;
            return (
              <section key={date} className="b2b-card" style={{ padding: 0, overflow: "hidden" }}>
                <button onClick={() => toggle(date)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ color: "var(--sm-text-light)", fontSize: 12, transform: o ? "rotate(90deg)" : "none", transition: "transform .12s" }}>▶</span>
                  <strong style={{ fontSize: 14 }}>{date}</strong>
                  <span className="sm-faint" style={{ fontSize: 12 }}>{list.length}건</span>
                  <span className="sm-row" style={{ gap: 4, marginLeft: "auto", flexWrap: "wrap" }}>
                    {Object.entries(byType).map(([ty, n]) => { const c = INV_TYPE_COLOR[ty as keyof typeof INV_TYPE_COLOR]; return <span key={ty} className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{ty} {n}</span>; })}
                    {evCount > 0 && <span className="b2b-status-pill" style={{ background: "var(--sm-orange-light)", color: "var(--sm-orange)" }}>생산요청 {evCount}</span>}
                  </span>
                </button>
                {o && (
                  <div className="b2b-table-wrap" style={{ borderTop: "1px solid var(--sm-border)" }}>
                    <table className="b2b-table">
                      <thead><tr><th>품목 / 내용</th><th>유형</th><th>채널</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th><th>메모</th><th>담당</th><th></th></tr></thead>
                      <tbody>
                        {list.map((it) => it.kind === "event" ? (
                          <tr key={`ev-${it.e.id}`}>
                            <td colSpan={6}><span className="b2b-status-pill" style={{ background: "var(--sm-orange-light)", color: "var(--sm-orange)", marginRight: 8 }}>생산요청</span>{it.e.summary}</td>
                            <td>-</td>
                            <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{it.e.actor || "-"}</td>
                            <td></td>
                          </tr>
                        ) : (() => {
                          const t = it.t; const c = INV_TYPE_COLOR[t.type];
                          return (
                            <tr key={t.id}>
                              <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.product_name}{t.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{t.sku}</span> : null}</td>
                              <td><span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{t.type}</span></td>
                              <td>{t.channel ? (() => { const ch = INV_CHANNEL_COLOR[t.channel as InvChannel]; return <span className="b2b-status-pill" style={{ background: ch.bg, color: ch.fg }}>{t.channel}</span>; })() : <span className="sm-faint">-</span>}</td>
                              <td className="num b2b-money" style={{ color: c.fg, fontWeight: 700 }}>{t.qty > 0 ? "+" : ""}{t.qty.toLocaleString()}</td>
                              <td className="num b2b-money">{t.unit_amount ? t.unit_amount.toLocaleString() : "-"}</td>
                              <td>{t.partner || "-"}</td>
                              <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.memo || ""}>{t.memo || "-"}</td>
                              <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{t.created_by || "-"}</td>
                              <td><button className="b2b-link-btn" onClick={() => cancel(t)} style={{ color: "var(--sm-danger)" }}>취소</button></td>
                            </tr>
                          );
                        })())}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
