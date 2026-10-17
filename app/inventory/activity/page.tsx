"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { INV_TYPE_COLOR, INV_CHANNEL_COLOR, type InventoryTxn, type InvChannel, type InvChannelFilter } from "@/app/lib/inventory";
import { ChannelFilter } from "../ChannelTabs";
import { deleteLedger, isMoveTxn } from "../TxnTable";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { matchKoQuery } from "@/app/lib/hangul";

// 생산요청 상태 변경/작성 이벤트(activity_log) — 원장과 함께 날짜별로 섞어 표시.
type PrEvent = { id: string; date: string; created_at: string; summary: string; actor: string | null };
const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
function kstDate(iso: string) { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }); } catch { return (iso || "").slice(0, 10); } }

// txns GET 이 함께 싣는 출처 칸(131) — 이동·B2B 연동 판정용(없으면 종전 표식으로 본다)
type Txn = InventoryTxn & { source?: string | null; order_no?: string | null };
// B2B 연동 행(선점·발송 후 취소 미반품) — 발주에서 정리한다. 서버 lockKindOf 와 같은 표식(출처 b2b*, 그 전 기록은 created_by)
const isB2bTxn = (t: Txn) => String(t.source ?? "").startsWith("b2b") || t.created_by === "B2B 자동출고";

type Feed =
  | { kind: "txn"; date: string; ts: string; t: Txn }
  | { kind: "event"; date: string; ts: string; e: PrEvent };

// 활동 히스토리 — 날짜별 아코디언. 입고·출고·조정 원장 + 생산요청 상태 변경을 함께 표시.
export default function ActivityPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [txns, setTxns] = useState<Txn[]>([]);
  const [events, setEvents] = useState<PrEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<InvChannelFilter>("전체");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // 취소 결과 안내(성공 notice·부분 성공 경고) — 다시 읽어도 남고 [닫기]로 지운다(적어 둘 문구가 들어 있을 수 있다, S9)
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const txnUrl = `/api/inventory/txns?limit=2000${channel === "전체" ? "" : `&channel=${encodeURIComponent(channel)}`}`;
      const [tj, ej] = await Promise.all([
        (await fetch(txnUrl, { cache: "no-store" })).json(),
        // 생산요청 작성·상태변경 이벤트(생산=도매) — B2B 변경기록엔 제외되고 여기(생산·재고)로만 온다.
        fetch("/api/b2b/activity?type=production_request.created,production_request.status_changed,production_request.draft,production_request.notice&limit=300", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ ok: false })),
      ]);
      if (!tj.ok) throw new Error(tj.error || "변경 기록을 불러오지 못했습니다. [다시 불러오기]를 누르세요.");
      const rows: Txn[] = tj.rows || [];
      setTxns(rows);
      const evs: PrEvent[] = ej.ok
        ? (ej.activities || []).map((a: { id: string; created_at: string; summary: string; actor: string | null }) => ({ id: a.id, created_at: a.created_at, date: kstDate(a.created_at), summary: a.summary, actor: a.actor }))
        : [];
      setEvents(evs);
      const firstDate = rows[0]?.txn_date || evs[0]?.date;
      setOpen(new Set(firstDate ? [firstDate] : [])); // 가장 최근 날짜만 펼침
    } catch (e) { setError(e instanceof Error ? e.message : "변경 기록을 불러오지 못했습니다. [다시 불러오기]를 누르세요."); }
    setLoading(false);
  }, [channel]);
  useEffect(() => { load(); }, [load]);

  async function cancel(t: Txn) {
    // 재고 이동은 출발·도착 두 행이 한 짝 — 짝 단위로 취소해야 두 칸이 함께 원복되고 요청서 배정도 풀린다(판정 = isMoveTxn, isMoveRow 와 같은 규칙)
    const isMove = isMoveTxn(t) && !!t.group_id;
    if (!(await (isMove
      ? confirm({ title: "재고 이동 취소", body: "출발·도착 두 칸이 함께 원복되고, 요청서 배정도 함께 풀립니다.", action: "이동 취소" })
      : confirm({ title: `${t.type} 기록 취소`, body: t.status === "대기" ? "대기 기록이 지워집니다." : "이 기록이 지워지고 재고가 원복됩니다.", action: "기록 취소" })))) return;
    // 온라인발주 배치 한 줄은 서버가 확인(409 confirm_required)을 한 번 더 받는다 — deleteLedger 가 묻고 confirm=1 로 다시 보낸다
    setFlash(null);
    const res = await deleteLedger(isMove ? `/api/inventory/move?group_id=${encodeURIComponent(String(t.group_id))}` : `/api/inventory/txn?id=${encodeURIComponent(t.id)}`, { confirm, error: toast.error });
    if (!res.ok) return;
    // 부분 성공(행은 지웠고 뒤처리만 실패)도 ok — 다시 읽고 서버 문구를 경고로 남긴다
    if (res.notice) setFlash({ ok: !res.warn, text: res.notice });
    await load();
  }

  const q = search.trim();
  // 생산요청은 도매 활동 → '소매' 필터일 땐 숨김.
  const shownEvents = useMemo(() => {
    if (channel === "소매") return [];
    return q ? events.filter((e) => matchKoQuery(e.summary, q)) : events;
  }, [events, q, channel]);
  const filteredTxns = useMemo(() => q
    ? txns.filter((t) => matchKoQuery(`${t.product_name} ${t.sku || ""} ${t.memo || ""} ${t.partner || ""}`, q))
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
  const today = TODAY();
  const isOpen = (d: string) => (q ? true : open.has(d)); // 검색 중이면 매칭 날짜 자동 펼침
  const toggle = (d: string) => setOpen((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; });

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">재고 변경 기록</h1></div>
        <div className="b2b-page-actions"><button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "불러오는 중..." : "다시 불러오기"}</button></div>
      </header>

      {error && <div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div>}
      {flash && (
        <div className={flash.ok ? "sm-success" : "sm-warn"} style={{ marginBottom: 12, whiteSpace: "pre-line", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ flex: 1 }}>{flash.text}</span>
          <button className="b2b-link-btn" onClick={() => setFlash(null)}>닫기</button>
        </div>
      )}

      <div className="sm-between" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <ChannelFilter value={channel} onChange={setChannel} />
          <input className="b2b-input" placeholder="품목·SKU 검색" aria-label="품목·SKU·메모·거래처 검색" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260, maxWidth: "100%" }} />
        </div>
        {q && <span className="sm-faint" style={{ fontSize: 12 }}>{groups.length}일 · {totalCount}건</span>}
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : groups.length === 0 ? (
        <div className="b2b-empty">{txns.length === 0 && events.length === 0 ? "재고 변경 기록이 없습니다. 재고 목록의 [입·출·조정 기록]으로 기록하세요." : "조건에 맞는 기록이 없습니다. 검색어를 지우거나 채널을 바꾸세요."}</div>
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
                  <strong style={{ fontSize: 13 }}>{date}</strong>
                  <span className="sm-faint" style={{ fontSize: 12 }}>{list.length}건</span>
                  <span className="sm-row" style={{ gap: 4, marginLeft: "auto", flexWrap: "wrap" }}>
                    {Object.entries(byType).map(([ty, n]) => { const c = INV_TYPE_COLOR[ty as keyof typeof INV_TYPE_COLOR]; return <span key={ty} className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{ty} {n}</span>; })}
                    {evCount > 0 && <span className="b2b-status-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>생산요청 {evCount}</span>}
                  </span>
                </button>
                {o && (
                  <div className="b2b-table-wrap" style={{ borderTop: "1px solid var(--sm-border)" }}>
                    <table className="b2b-table">
                      <thead><tr><th>품목 / 내용</th><th>유형</th><th>채널</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th><th>메모</th><th>담당</th><th></th></tr></thead>
                      <tbody>
                        {list.map((it) => it.kind === "event" ? (
                          <tr key={`ev-${it.e.id}`}>
                            <td colSpan={6}><span className="b2b-status-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)", marginRight: 8 }}>생산요청</span>{it.e.summary}</td>
                            <td>-</td>
                            <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{it.e.actor || "-"}</td>
                            <td></td>
                          </tr>
                        ) : (() => {
                          const t = it.t; const c = INV_TYPE_COLOR[t.type];
                          return (
                            <tr key={t.id}>
                              <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.product_name}{t.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{t.sku}</span> : null}</td>
                              <td style={{ whiteSpace: "nowrap" }}>
                                <span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{t.type}</span>
                                {/* 대기 = 현재고에 안 들어간 행, 예정 = 오늘 뒤 거래일(대개 B2B 선점) — 오늘 재고와 구분해 보인다(S6) */}
                                {t.status === "대기"
                                  ? <span className="b2b-status-pill" style={{ marginLeft: 4, background: "var(--sm-warning-bg)", color: "var(--sm-warning)" }}>대기</span>
                                  : t.txn_date > today ? <span className="b2b-status-pill" style={{ marginLeft: 4, background: "var(--sm-info-bg)", color: "var(--sm-info)" }}>예정</span> : null}
                              </td>
                              <td>{t.channel ? (() => { const ch = INV_CHANNEL_COLOR[t.channel as InvChannel]; return <span className="b2b-status-pill" style={{ background: ch.bg, color: ch.fg }}>{t.channel}</span>; })() : <span className="sm-faint">-</span>}</td>
                              <td className="num b2b-money" style={{ color: c.fg, fontWeight: 700 }}>{t.qty > 0 ? "+" : ""}{t.qty.toLocaleString()}</td>
                              <td className="num b2b-money">{t.unit_amount ? t.unit_amount.toLocaleString() : "-"}</td>
                              <td>{t.partner || "-"}</td>
                              <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.memo || ""}>{t.memo || "-"}</td>
                              <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{t.created_by || "-"}</td>
                              {/* 이동(짝 행)·B2B 연동(선점·발송 후 취소 미반품)은 단건 취소 금지 — 서버(txn DELETE)가 409 로 막고, 화면은 어디서 취소하는지만 안내.
                                  shipment_id 는 txns GET 이 싣지 않아 출처 칸(source b2b*)·created_by 로 판별 */}
                              <td style={{ whiteSpace: "nowrap" }}>
                                {isMoveTxn(t) && !t.group_id
                                  ? <span className="sm-faint" style={{ fontSize: 12 }} title="두 칸이 함께 원복되도록 재고 이동 화면 또는 입고 및 출고 목록의 이동 행에서 취소합니다">재고 이동에서</span>
                                  : isB2bTxn(t)
                                    ? <span className="sm-faint" style={{ fontSize: 12 }} title={t.source === "b2b_cancel_kept" ? "발송 후 취소(미반품) 출고 — 발주를 복구하면 함께 정리됩니다" : "발주의 발송일정에서 수정·삭제하면 재고가 함께 원복됩니다"}>발주에서</span>
                                    : <button className="b2b-link-btn" onClick={() => cancel(t)} style={{ color: "var(--sm-danger)" }}>기록 취소</button>}
                              </td>
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
