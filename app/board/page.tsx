"use client";

// 주요 지표 — 루커 스튜디오식 보고서 화면(2026-11-15 개편): 위에 기간 선택기·필터, 아래에 스코어카드·선 그래프·표를 칸칸이 배치.
//  서버가 저장해 둔 180일치 묶음(/api/board, app/lib/board.ts)을 한 번 받아, 기간·필터를 바꿔도 여기서 잘라 계산한다(board-types.ts).
//  날마다 더할 수 없는 값(신규·재구매 고객 수)과 상품별 표만 기간이 바뀔 때 /api/board/detail 로 받는다.
//  비율(객단가·ROAS·전환율)은 기간 합계끼리 나눈다. 비교는 언제나 '직전 같은 길이 기간'.
//  주제 보고서(2026-11-16): 고정 네 쪽 뒤에 주제 탭 — 조건(상품·페이지·광고 이름에 든 말)으로 정의한 주제의 묶음을 /api/board/topic 에서 받아 같은 기간으로 자른다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { StackedBar, LineChart, Sparkline, Donut, ChartLegend, PIE_COLORS, moneyCompact } from "@/app/components/charts";
import { won } from "@/app/lib/format";
import { spanOf, spanSum, addSeries, cut, sumOf, pctChange, ratio, lastKnown, shiftDay, daysBetween, topicWords, type BoardSnapshot, type BoardDetail, type Span, type BoardTopic, type TopicSnapshot } from "@/app/lib/board-types";

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const weekday = (ymd: string) => WD[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
const POLL_MS = 40_000, POLL_MAX = 4, HOURLY_MS = 60 * 60_000;
const C_CUR = PIE_COLORS[1], C_PREV = "var(--sm-text-light)", C_META = PIE_COLORS[1], C_NAVER = PIE_COLORS[2];

// ── 기간 ──
type Preset = { key: string; label: string; range: (base: string) => [string, string] };
const lastN = (n: number) => (base: string): [string, string] => [shiftDay(base, -(n - 1)), base];
const PRESETS: Preset[] = [
  { key: "d1", label: "기준일 하루", range: lastN(1) },
  { key: "d7", label: "최근 7일", range: lastN(7) },
  { key: "d14", label: "최근 14일", range: lastN(14) },
  { key: "d28", label: "최근 28일", range: lastN(28) },
  { key: "d90", label: "최근 90일", range: lastN(90) },
  { key: "mtd", label: "이번 달", range: (b) => [`${b.slice(0, 8)}01`, b] },
  { key: "lm", label: "지난달", range: (b) => { const to = shiftDay(`${b.slice(0, 8)}01`, -1); return [`${to.slice(0, 8)}01`, to]; } },
];
type Range = { preset: string; from: string; to: string };
type Filters = { salesCh: string[] | null; media: string[] | null; gaCh: string[] | null }; // null = 전체
const PAGES = [["summary", "요약"], ["sales", "매출"], ["ads", "광고·유입"], ["sub", "정기배송·고객"]] as const;
type PageKey = (typeof PAGES)[number][0];

// ── 증감 ── good = 어느 쪽이 좋은가(none = 판정하지 않는 숫자: 광고비 등)
type Good = "up" | "down" | "none";
type Delta = { text: string; tone: "good" | "bad" | "flat" } | null;
const arrow = (d: number) => (d > 0 ? "▲" : d < 0 ? "▼" : "");
const toneOf = (diff: number, flat: boolean, good: Good): "good" | "bad" | "flat" => (good === "none" || flat ? "flat" : (diff > 0) === (good === "up") ? "good" : "bad");
function pctDelta(cur: number | null, prev: number | null, good: Good): Delta {
  const p = pctChange(cur, prev);
  if (p == null) return null;
  const r = Math.round(p * 10) / 10;
  return { text: `${arrow(r)} ${Math.abs(r)}%`.trim(), tone: toneOf(r, Math.abs(r) < 1, good) };
}
function ppDelta(cur: number | null, prev: number | null, good: Good): Delta { // 비율(%)끼리의 차 — %p
  if (cur == null || prev == null) return null;
  const r = Math.round((cur - prev) * 10) / 10;
  return { text: `${arrow(r)} ${Math.abs(r)}%p`.trim(), tone: toneOf(r, r === 0, good) };
}
function absDelta(cur: number | null, prev: number | null, unit: string, good: Good): Delta {
  if (cur == null || prev == null) return null;
  const r = cur - prev;
  return { text: `${arrow(r)} ${Math.abs(r).toLocaleString()}${unit}`.trim(), tone: toneOf(r, r === 0, good) };
}
const DeltaText = ({ d }: { d: Delta }) => (d ? <span className={`bd-delta is-${d.tone}`}>{d.text}</span> : <span className="bd-delta is-flat">-</span>);

const wonS = (n: number | null | undefined) => (n == null ? null : `${won(n)}원`);
const cnt = (n: number | null | undefined, unit: string) => (n == null ? null : `${Math.round(n).toLocaleString()}${unit}`);
const fix2 = (v: number | null | undefined) => (v == null ? null : v.toFixed(2));
const pct1 = (v: number | null | undefined) => (v == null ? null : `${v.toFixed(1)}%`);
const pct2 = (v: number | null | undefined) => (v == null ? null : `${v.toFixed(2)}%`);
const prevNote = (text: string | null | undefined) => (text ? `직전 ${text}` : undefined);

// ── 부품 ──
function Card({ w, title, right, children }: { w: 4 | 6 | 8 | 12; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={`bd-card bd-c${w}`}>
      <div className="bd-card-head"><span className="bd-card-title">{title}</span>{right}</div>
      {children}
    </section>
  );
}
function Score({ label, value, delta, note, spark }: { label: string; value: string | null; delta?: Delta; note?: string; spark?: (number | null)[] }) {
  return (
    <div className="bd-card bd-score bd-c2">
      <div className="bd-score-label">{label}</div>
      <div className={`bd-score-value${value == null ? " is-light" : ""}`}>{value ?? "-"}</div>
      <div className="bd-score-sub">{delta && <DeltaText d={delta} />}{note && <span>{note}</span>}</div>
      {spark && <div className="bd-score-spark"><Sparkline values={spark} color={C_CUR} /></div>}
    </div>
  );
}

// 표 — 열 제목을 눌러 정렬, 막대 열은 그 열의 최댓값 대비 폭. 합계 줄은 정렬과 무관하게 맨 아래.
type Col<R> = { key: string; label: string; num?: boolean; bar?: boolean; w?: 30 | 45; sort: (r: R) => number | string; cell: (r: R) => React.ReactNode };
function DataTable<R>({ rows, cols, rowKey, sortKey, foot, empty }: { rows: R[]; cols: Col<R>[]; rowKey: (r: R) => string; sortKey: string; foot?: React.ReactNode[]; empty: string }) {
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: sortKey, desc: true });
  const col = cols.find((c) => c.key === sort.key) || cols[0];
  const sorted = [...rows].sort((a, b) => {
    const x = col.sort(a), y = col.sort(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko");
    return sort.desc ? -c : c;
  });
  const maxOf = (c: Col<R>) => Math.max(1, ...rows.map((r) => Number(c.sort(r)) || 0));
  if (!rows.length) return <div className="b2b-empty">{empty}</div>;
  return (
    <div className="b2b-table-wrap bd-table-wrap">
      <table className="b2b-table is-compact">
        <thead>
          <tr>{cols.map((c) => (
            <th key={c.key} className={[c.num ? "num" : "", c.w ? `bd-w${c.w}` : ""].filter(Boolean).join(" ") || undefined} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined}>
              <button type="button" className="bd-th-btn" onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : true }))}>
                {c.label}<span className="bd-th-arrow">{sort.key === c.key ? (sort.desc ? "▼" : "▲") : ""}</span>
              </button>
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={rowKey(r)}>{cols.map((c) => (
              <td key={c.key} className={c.num ? "num" : undefined}>
                {c.bar ? <span className="bd-cellbar"><i style={{ width: `${Math.max(0, Math.min(100, ((Number(c.sort(r)) || 0) / maxOf(c)) * 100))}%` }} /><span>{c.cell(r)}</span></span> : c.cell(r)}
              </td>
            ))}</tr>
          ))}
        </tbody>
        {foot && <tfoot><tr className="bd-foot">{foot.map((x, i) => <td key={i} className={cols[i]?.num ? "num" : undefined}>{x}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

// 위쪽 컨트롤(기간·필터) — 누르면 아래로 열리는 작은 창. 바깥을 누르거나 Esc 로 닫는다.
function usePop() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return { open, setOpen, ref };
}
function DateControl({ range, base, min, onChange }: { range: Range; base: string; min: string; onChange: (r: Range) => void }) {
  const { open, setOpen, ref } = usePop();
  const [from, setFrom] = useState(range.from), [to, setTo] = useState(range.to);
  useEffect(() => { setFrom(range.from); setTo(range.to); }, [range.from, range.to]);
  const label = PRESETS.find((p) => p.key === range.preset)?.label || "직접 고름";
  const bad = !from || !to || from > to || from < min || to > base;
  return (
    <div className="bd-ctl" ref={ref}>
      <button type="button" className="bd-ctl-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="bd-ctl-k">기간</span><strong>{range.from} ~ {range.to}</strong><span className="bd-ctl-k">{label}</span><span className="bd-ctl-caret">▾</span>
      </button>
      {open && (
        <div className="bd-pop bd-pop-date">
          <div className="bd-pop-list">
            {PRESETS.map((p) => (
              <button key={p.key} type="button" className={`bd-pop-item${range.preset === p.key ? " is-active" : ""}`}
                onClick={() => { const [f, t] = p.range(base); onChange({ preset: p.key, from: f < min ? min : f, to: t }); setOpen(false); }}>{p.label}</button>
            ))}
          </div>
          <div className="bd-pop-custom">
            <label className="b2b-field"><span className="b2b-field-label">시작일</span><input type="date" className="b2b-input" value={from} min={min} max={base} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="b2b-field"><span className="b2b-field-label">종료일</span><input type="date" className="b2b-input" value={to} min={min} max={base} onChange={(e) => setTo(e.target.value)} /></label>
            <button type="button" className="b2b-btn-primary" disabled={bad} onClick={() => { onChange({ preset: "custom", from, to }); setOpen(false); }}>기간 적용</button>
          </div>
        </div>
      )}
    </div>
  );
}
function FilterControl({ label, options, value, onChange }: { label: string; options: string[]; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const { open, setOpen, ref } = usePop();
  const sel = value ?? options;
  const toggle = (o: string) => {
    const next = sel.includes(o) ? sel.filter((x) => x !== o) : [...sel, o];
    onChange(next.length === options.length ? null : next);
  };
  const text = value == null ? "전체" : value.length === 0 ? "없음" : value.length === 1 ? value[0] : `${value.length}개`;
  return (
    <div className="bd-ctl" ref={ref}>
      <button type="button" className={`bd-ctl-btn${value != null ? " is-on" : ""}`} aria-expanded={open} disabled={!options.length} onClick={() => setOpen(!open)}>
        <span className="bd-ctl-k">{label}</span><strong>{text}</strong><span className="bd-ctl-caret">▾</span>
      </button>
      {open && (
        <div className="bd-pop">
          <div className="bd-pop-tools">
            <button type="button" className="b2b-link-btn" onClick={() => onChange(null)}>전체 선택</button>
            <button type="button" className="b2b-link-btn" onClick={() => onChange([])}>모두 해제</button>
          </div>
          <div className="bd-pop-checks">
            {options.map((o) => (
              <label key={o} className="bd-check"><input type="checkbox" checked={sel.includes(o)} onChange={() => toggle(o)} /><span>{o}</span></label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 묶음 → 화면 값(기간·필터 적용) ──
function buildView(s: BoardSnapshot, sp: Span, f: Filters) {
  const N = s.days.length;
  const win = <T,>(xs: T[]): T[] => cut(xs, sp.i0, sp.i1);
  const prevWin = (xs: (number | null)[]): (number | null)[] | null => (sp.prev ? cut(xs, sp.prev.i0, sp.prev.i1) : null);
  const days = win(s.days), labels = days.map(md);
  const on = (list: string[] | null, name: string) => !list || list.includes(name);

  // 매출
  const sales = s.sales.ok ? s.sales : null;
  const chSel = sales ? sales.channels.filter((c) => on(f.salesCh, c.name)) : [];
  const rev = addSeries(chSel.map((c) => c.rev), N), orders = addSeries(chSel.map((c) => c.orders), N);
  const revS = sales ? spanSum(rev, sp) : null, ordS = sales ? spanSum(orders, sp) : null;
  const aov = revS && ordS ? { cur: ratio(revS.cur, ordS.cur), prev: ratio(revS.prev, ordS.prev) } : null;
  const aovSeries = rev.map((v, i) => (orders[i] > 0 ? v / orders[i] : null));
  const chRows = chSel.map((c) => { const r = spanSum(c.rev, sp), o = spanSum(c.orders, sp); return { name: c.name, rev: r.cur, prevRev: r.prev, orders: o.cur, aov: ratio(r.cur, o.cur), series: win(c.rev) }; })
    .filter((r) => r.rev !== 0 || r.orders > 0).sort((a, b) => b.rev - a.rev);

  // 광고
  const meta = s.meta?.ok && on(f.media, "메타") ? s.meta : null, naver = s.naver?.ok && on(f.media, "네이버") ? s.naver : null;
  const naverEx: (number | null)[] = naver ? naver.cost.map((v) => (v == null ? null : v / 1.1)) : []; // VAT 제외
  const spend = addSeries([meta ? meta.spend : [], naverEx], N);
  const hasAds = !!(meta || naver);
  const spendS = hasAds ? spanSum(spend, sp) : null;
  const mSpend = meta ? spanSum(meta.spend, sp) : null, mValue = meta ? spanSum(meta.value, sp) : null;
  const nCost = naver ? spanSum(naverEx, sp) : null, nSales = naver ? spanSum(naver.purchaseSales, sp) : null;
  const mRoas = mSpend && mValue ? { cur: ratio(mValue.cur, mSpend.cur), prev: ratio(mValue.prev, mSpend.prev) } : null;
  const nRoas = nCost && nSales ? { cur: ratio(nSales.cur, nCost.cur), prev: ratio(nSales.prev, nCost.prev) } : null;
  const naverPending = !!naver && [...win(naver.cost), ...(prevWin(naver.cost) || [])].some((v) => v == null);
  const mediaRows = [
    ...(meta && mSpend && mValue ? [{ name: "메타", spend: mSpend.cur, prevSpend: mSpend.prev, impressions: sumOf(win(meta.impressions)), clicks: sumOf(win(meta.clicks)), purchases: sumOf(win(meta.purchases)), value: mValue.cur, roas: mRoas?.cur ?? null }] : []),
    ...(naver && nCost && nSales ? [{ name: "네이버", spend: nCost.cur, prevSpend: nCost.prev, impressions: sumOf(win(naver.impressions)), clicks: sumOf(win(naver.clicks)), purchases: sumOf(win(naver.purchases)), value: nSales.cur, roas: naver.purchaseOk ? (nRoas?.cur ?? null) : null }] : []),
  ];

  // 유입(GA4)
  const ga = s.ga?.ok ? s.ga : null;
  const gaSel = ga ? ga.channels.filter((c) => on(f.gaCh, c.name)) : [];
  const sessions = addSeries(gaSel.map((c) => c.sessions), N), gaPurchases = addSeries(gaSel.map((c) => c.purchases), N);
  const sesS = ga ? spanSum(sessions, sp) : null, purS = ga ? spanSum(gaPurchases, sp) : null;
  const conv = sesS && purS ? { cur: ratio(purS.cur * 100, sesS.cur), prev: ratio(purS.prev == null ? null : purS.prev * 100, sesS.prev) } : null;
  const gaRows = gaSel.map((c) => { const x = spanSum(c.sessions, sp), p = spanSum(c.purchases, sp); return { name: c.name, sessions: x.cur, prevSessions: x.prev, purchases: p.cur, conv: ratio(p.cur * 100, x.cur) }; })
    .filter((r) => r.sessions > 0).sort((a, b) => b.sessions - a.sessions);

  // 정기배송·VOC
  const sub = s.sub.ok ? s.sub : null, voc = s.voc.ok ? s.voc : null;
  const active = sub ? { cur: lastKnown(sub.active, sp.i1), prev: sp.prev ? lastKnown(sub.active, sp.prev.i1) : null } : null;
  const pause = sub ? lastKnown(sub.pause, sp.i1) : null;
  const newS = sub ? spanSum(sub.newCnt, sp) : null, cancelS = sub ? spanSum(sub.cancelCnt, sp) : null, subRevS = sub ? spanSum(sub.subRev, sp) : null;
  const allRev = sales ? spanSum(addSeries(sales.channels.map((c) => c.rev), N), sp) : null; // 정기배송 매출 비중의 분모는 전체 채널
  const vocS = voc ? spanSum(voc.counts, sp) : null;

  return {
    win, prevWin, hasPrev: !!sp.prev, days, labels, sales, rev, orders, revS, ordS, aov, aovSeries, chRows,
    meta, naver, naverEx, spend, hasAds, spendS, mRoas, nRoas, naverPending, mediaRows,
    ga, sessions, gaPurchases, sesS, purS, conv, gaRows,
    sub, voc, active, pause, newS, cancelS, subRevS, allRev, vocS,
  };
}
type View = ReturnType<typeof buildView>;
const why = (x: BoardSnapshot["meta"] | BoardSnapshot["naver"] | BoardSnapshot["ga"]) => (x == null ? "연결 안 됨" : x.ok ? undefined : "조회 실패");

// 이번 기간(실선)과 직전 기간(점선) — 같은 자리의 날끼리 겹쳐 그린다
type Win = Pick<View, "labels" | "win" | "prevWin" | "hasPrev">;
function CompareLine({ v, values, fmtAxis, fmtTip, unit }: { v: Win; values: (number | null)[]; fmtAxis?: (n: number) => string; fmtTip?: (n: number) => string; unit: string }) {
  const prev = v.prevWin(values);
  return (
    <LineChart periods={v.labels} fmtAxis={fmtAxis} fmtTip={fmtTip} unit={unit}
      series={[{ key: "이번 기간", values: v.win(values), color: C_CUR }, ...(prev ? [{ key: "직전 기간", values: prev, color: C_PREV, dashed: true }] : [])]} />
  );
}
const CompareLegend = ({ v }: { v: Win }) => <ChartLegend items={[["이번 기간", C_CUR], ...(v.hasPrev ? [["직전 기간", C_PREV] as [string, string]] : [])]} />;
const mediaLegend = (v: View): [string, string][] => [...(v.meta ? [["메타", C_META] as [string, string]] : []), ...(v.naver ? [["네이버", C_NAVER] as [string, string]] : [])];
function SpendLine({ v }: { v: View }) {
  if (!v.hasAds) return <div className="b2b-empty">광고 숫자가 없습니다.</div>;
  return (
    <LineChart periods={v.labels} fmtAxis={moneyCompact} fmtTip={won} unit="원"
      series={[...(v.meta ? [{ key: "메타", values: v.win(v.meta.spend) as (number | null)[], color: C_META }] : []), ...(v.naver ? [{ key: "네이버", values: v.win(v.naverEx).map((x) => (x == null ? null : Math.round(x))), color: C_NAVER }] : [])]} />
  );
}

// ── 스코어카드 묶음(여러 쪽에서 같이 쓴다) ──
const ScoreRev = ({ v }: { v: View }) => <Score label="매출" value={wonS(v.revS?.cur)} delta={pctDelta(v.revS?.cur ?? null, v.revS?.prev ?? null, "up")} note={prevNote(v.revS?.prev != null ? `${moneyCompact(v.revS.prev)}원` : null)} spark={v.win(v.rev)} />;
const ScoreOrders = ({ v }: { v: View }) => <Score label="주문 건수" value={cnt(v.ordS?.cur, "건")} delta={pctDelta(v.ordS?.cur ?? null, v.ordS?.prev ?? null, "up")} note={prevNote(cnt(v.ordS?.prev, "건"))} spark={v.win(v.orders)} />;
const ScoreAov = ({ v }: { v: View }) => <Score label="객단가" value={wonS(v.aov?.cur)} delta={pctDelta(v.aov?.cur ?? null, v.aov?.prev ?? null, "up")} note={prevNote(wonS(v.aov?.prev))} spark={v.win(v.aovSeries)} />;
const ScoreSpend = ({ v, s }: { v: View; s: BoardSnapshot }) => (
  <Score label="광고비" value={wonS(v.spendS ? Math.round(v.spendS.cur) : null)} delta={pctDelta(v.spendS?.cur ?? null, v.spendS?.prev ?? null, "none")}
    note={v.hasAds ? (v.naverPending ? "네이버 광고비 일부 받는 중" : prevNote(v.spendS?.prev != null ? `${moneyCompact(Math.round(v.spendS.prev))}원` : null)) : (why(s.meta) ?? why(s.naver))} spark={v.hasAds ? v.win(v.spend) : undefined} />
);
const ScoreSessions = ({ v, s }: { v: View; s: BoardSnapshot }) => <Score label="방문" value={cnt(v.sesS?.cur, "회")} delta={pctDelta(v.sesS?.cur ?? null, v.sesS?.prev ?? null, "up")} note={v.ga ? prevNote(cnt(v.sesS?.prev, "회")) : why(s.ga)} spark={v.ga ? v.win(v.sessions) : undefined} />;
const ScoreActive = ({ v }: { v: View }) => <Score label="정기배송 이용중" value={cnt(v.active?.cur, "명")} delta={absDelta(v.active?.cur ?? null, v.active?.prev ?? null, "명", "up")} note={v.pause != null ? `일시정지 ${v.pause.toLocaleString()}명` : undefined} spark={v.sub ? v.win(v.sub.active) : undefined} />;
const ScoreSubRev = ({ v }: { v: View }) => {
  const share = v.subRevS && v.allRev ? ratio(v.subRevS.cur * 100, v.allRev.cur) : null;
  return <Score label="정기배송 매출" value={wonS(v.subRevS?.cur)} delta={pctDelta(v.subRevS?.cur ?? null, v.subRevS?.prev ?? null, "up")} note={share != null ? `전체의 ${share.toFixed(1)}%` : undefined} spark={v.sub ? v.win(v.sub.subRev) : undefined} />;
};

function Errors({ list }: { list: string[] }) {
  if (!list.length) return null;
  return <div className="b2b-error bd-c12">{list.length === 1 ? list[0] : <ul>{list.map((e) => <li key={e}>{e}</li>)}</ul>}</div>;
}
const failOf = (label: string, x: { ok: boolean; error?: string } | null) => (x && !x.ok ? `${label}: ${x.error}` : "");
function DonutCard({ data, colors, center, centerSub, fmt }: { data: [string, number][]; colors: string[]; center: string; centerSub: string; fmt: (n: number, total: number) => string }) {
  const total = data.reduce((a, [, n]) => a + n, 0);
  return (
    <div className="bd-donut">
      <Donut data={data} colors={colors} size={148} center={center} centerSub={centerSub} />
      <div className="bd-donut-legend">
        {data.map(([name, n], i) => (
          <div key={name} className="sm-between"><span className="sm-row bd-donut-name"><span className="sm-stat-hero-dot" style={{ background: colors[i] }} /><span className="sm-ellipsis">{name}</span></span><span className="num">{fmt(n, total)}</span></div>
        ))}
      </div>
    </div>
  );
}

// 채널별 매출 비중 — 큰 6곳 + 기타. 가운데 숫자는 고리 안에 들어가게 '만원'·'억원' 단위로 줄인다
function ChannelDonut({ v }: { v: View }) {
  const top = v.chRows.slice(0, 6), restRev = v.chRows.slice(6).reduce((a, r) => a + r.rev, 0);
  const donut: [string, number][] = [...top.map((r): [string, number] => [r.name, Math.max(0, r.rev)]), ...(restRev > 0 ? [["기타", restRev] as [string, number]] : [])];
  const total = donut.reduce((a, [, n]) => a + n, 0);
  if (total <= 0) return <div className="b2b-empty">매출이 없습니다.</div>;
  const [center, unit] = total >= 1e8 ? [(total / 1e8).toFixed(1), "억원"] : [Math.round(total / 1e4).toLocaleString(), "만원"];
  return <DonutCard data={donut} colors={donut.map((_, i) => PIE_COLORS[i % PIE_COLORS.length])} center={center} centerSub={unit} fmt={(n, t) => `${(Math.round((n / t) * 1000) / 10).toFixed(1)}%`} />;
}

// ── 쪽 ──
function SummaryPage({ v, s }: { v: View; s: BoardSnapshot }) {
  return (
    <>
      <Errors list={[failOf("매출", s.sales), failOf("메타 광고", s.meta), failOf("네이버 광고", s.naver), failOf("GA4", s.ga), failOf("정기배송", s.sub)].filter(Boolean)} />
      <ScoreRev v={v} /><ScoreOrders v={v} /><ScoreAov v={v} /><ScoreSpend v={v} s={s} /><ScoreSessions v={v} s={s} /><ScoreActive v={v} />
      <Card w={8} title="매출 추이" right={<CompareLegend v={v} />}><CompareLine v={v} values={v.rev} fmtAxis={moneyCompact} fmtTip={won} unit="원" /></Card>
      <Card w={4} title="채널별 매출 비중"><ChannelDonut v={v} /></Card>
      <Card w={6} title="광고비 추이" right={<ChartLegend items={mediaLegend(v)} />}><SpendLine v={v} /></Card>
      <Card w={6} title="방문 추이" right={v.ga ? <CompareLegend v={v} /> : undefined}>
        {v.ga ? <CompareLine v={v} values={v.sessions} unit="회" /> : <div className="b2b-empty">방문 숫자가 없습니다.</div>}
      </Card>
    </>
  );
}

type DetailState = { key: string; data: BoardDetail | null; loading: boolean; error: string };
function SalesPage({ v, s, detail }: { v: View; s: BoardSnapshot; detail: DetailState }) {
  const top = v.chRows.slice(0, 5), rest = v.chRows.slice(5);
  const series = top.map((c) => ({ key: c.name, values: c.series }));
  if (rest.length) series.push({ key: "기타", values: v.labels.map((_, i) => rest.reduce((a, c) => a + (c.series[i] || 0), 0)) });
  const total = v.revS?.cur ?? 0;
  const cust = detail.data?.cust ?? null;
  const rep = cust ? { cur: ratio(cust.cur.repeatCust * 100, cust.cur.total), prev: ratio(cust.prev.repeatCust * 100, cust.prev.total) } : null;
  type ChRow = View["chRows"][number];
  const chCols: Col<ChRow>[] = [
    { key: "name", label: "채널", sort: (r) => r.name, cell: (r) => r.name },
    { key: "rev", label: "매출(원)", num: true, bar: true, sort: (r) => r.rev, cell: (r) => won(r.rev) },
    { key: "share", label: "비중", num: true, sort: (r) => r.rev, cell: (r) => (total > 0 ? `${(Math.round((r.rev / total) * 1000) / 10).toFixed(1)}%` : "-") },
    { key: "orders", label: "주문 건수", num: true, sort: (r) => r.orders, cell: (r) => r.orders.toLocaleString() },
    { key: "aov", label: "객단가(원)", num: true, sort: (r) => r.aov ?? 0, cell: (r) => won(r.aov) },
    { key: "delta", label: "직전 대비", num: true, sort: (r) => pctChange(r.rev, r.prevRev) ?? -Infinity, cell: (r) => <DeltaText d={pctDelta(r.rev, r.prevRev, "up")} /> },
  ];
  type PRow = BoardDetail["products"][number];
  const pCols: Col<PRow>[] = [
    { key: "name", label: "상품", sort: (r) => r.name, cell: (r) => <span title={r.code}>{r.name}</span> },
    { key: "rev", label: "매출(원)", num: true, bar: true, sort: (r) => r.rev, cell: (r) => won(r.rev) },
    { key: "qty", label: "수량", num: true, sort: (r) => r.qty, cell: (r) => r.qty.toLocaleString() },
    { key: "orders", label: "주문 건수", num: true, sort: (r) => r.orders, cell: (r) => r.orders.toLocaleString() },
    { key: "delta", label: "직전 대비", num: true, sort: (r) => pctChange(r.rev, r.prevRev) ?? -Infinity, cell: (r) => <DeltaText d={pctDelta(r.rev, r.prevRev, "up")} /> },
  ];
  const waiting = detail.loading ? "불러오는 중..." : undefined;
  return (
    <>
      <Errors list={[failOf("매출", s.sales), failOf("정기배송", s.sub), detail.error ? `상품·고객: ${detail.error}` : ""].filter(Boolean)} />
      <ScoreRev v={v} /><ScoreOrders v={v} /><ScoreAov v={v} /><ScoreSubRev v={v} />
      <Score label="신규 고객" value={cnt(cust?.cur.newCust, "명")} delta={cust ? pctDelta(cust.cur.newCust, cust.prev.newCust, "up") : null} note={cust ? prevNote(cnt(cust.prev.newCust, "명")) : waiting} />
      <Score label="재구매 고객 비율" value={pct1(rep?.cur)} delta={rep ? ppDelta(rep.cur, rep.prev, "up") : null} note={cust ? `재구매 ${cust.cur.repeatCust.toLocaleString()}명` : waiting} />
      <Card w={8} title="일별 매출" right={<ChartLegend items={series.map((x, i) => [x.key, PIE_COLORS[i % PIE_COLORS.length]])} />}>
        <StackedBar periods={v.labels} series={series} fmtAxis={moneyCompact} unit="원" />
      </Card>
      <Card w={4} title="채널별 매출 비중"><ChannelDonut v={v} /></Card>
      <Card w={6} title="채널별">
        <DataTable rows={v.chRows} cols={chCols} rowKey={(r) => r.name} sortKey="rev" empty="매출이 없습니다."
          foot={["합계", won(total), total > 0 ? "100.0%" : "-", (v.ordS?.cur ?? 0).toLocaleString(), won(v.aov?.cur), <DeltaText key="d" d={pctDelta(v.revS?.cur ?? null, v.revS?.prev ?? null, "up")} />]} />
      </Card>
      <Card w={6} title="상품별 상위 30">
        {detail.loading && !detail.data ? <div className="b2b-loading">불러오는 중...</div>
          : <DataTable rows={detail.data?.products ?? []} cols={pCols} rowKey={(r) => r.code} sortKey="rev" empty="매출이 없습니다." />}
      </Card>
    </>
  );
}

function AdsPage({ v, s }: { v: View; s: BoardSnapshot }) {
  type MRow = View["mediaRows"][number];
  const mCols: Col<MRow>[] = [
    { key: "name", label: "매체", sort: (r) => r.name, cell: (r) => r.name },
    { key: "spend", label: "광고비(원)", num: true, bar: true, sort: (r) => r.spend, cell: (r) => won(r.spend) },
    { key: "imp", label: "노출", num: true, sort: (r) => r.impressions, cell: (r) => r.impressions.toLocaleString() },
    { key: "clicks", label: "클릭", num: true, sort: (r) => r.clicks, cell: (r) => r.clicks.toLocaleString() },
    { key: "ctr", label: "CTR", num: true, sort: (r) => ratio(r.clicks, r.impressions) ?? 0, cell: (r) => pct2(ratio(r.clicks * 100, r.impressions)) ?? "-" },
    { key: "cpc", label: "CPC(원)", num: true, sort: (r) => ratio(r.spend, r.clicks) ?? 0, cell: (r) => won(ratio(r.spend, r.clicks)) },
    { key: "purchases", label: "구매", num: true, sort: (r) => r.purchases, cell: (r) => r.purchases.toLocaleString() },
    { key: "value", label: "구매액(원)", num: true, sort: (r) => r.value, cell: (r) => won(r.value) },
    { key: "roas", label: "ROAS", num: true, sort: (r) => r.roas ?? 0, cell: (r) => fix2(r.roas) ?? "미확정" },
    { key: "delta", label: "광고비 직전 대비", num: true, sort: (r) => pctChange(r.spend, r.prevSpend) ?? -Infinity, cell: (r) => <DeltaText d={pctDelta(r.spend, r.prevSpend, "none")} /> },
  ];
  type GRow = View["gaRows"][number];
  const sesTotal = v.sesS?.cur ?? 0;
  const gCols: Col<GRow>[] = [
    { key: "name", label: "유입 채널", sort: (r) => r.name, cell: (r) => r.name },
    { key: "sessions", label: "방문", num: true, bar: true, sort: (r) => r.sessions, cell: (r) => r.sessions.toLocaleString() },
    { key: "share", label: "비중", num: true, sort: (r) => r.sessions, cell: (r) => (sesTotal > 0 ? `${(Math.round((r.sessions / sesTotal) * 1000) / 10).toFixed(1)}%` : "-") },
    { key: "purchases", label: "구매", num: true, sort: (r) => r.purchases, cell: (r) => r.purchases.toLocaleString() },
    { key: "conv", label: "전환율", num: true, sort: (r) => r.conv ?? 0, cell: (r) => pct2(r.conv) ?? "-" },
    { key: "delta", label: "직전 대비", num: true, sort: (r) => pctChange(r.sessions, r.prevSessions) ?? -Infinity, cell: (r) => <DeltaText d={pctDelta(r.sessions, r.prevSessions, "up")} /> },
  ];
  return (
    <>
      <Errors list={[failOf("메타 광고", s.meta), failOf("네이버 광고", s.naver), failOf("GA4", s.ga), s.ga?.ok && s.ga.truncated ? "GA4: 행이 많아 일부만 받았습니다." : ""].filter(Boolean)} />
      <ScoreSpend v={v} s={s} />
      <Score label="메타 ROAS" value={fix2(v.mRoas?.cur)} delta={pctDelta(v.mRoas?.cur ?? null, v.mRoas?.prev ?? null, "up")} note={v.meta ? prevNote(fix2(v.mRoas?.prev)) : why(s.meta)} />
      <Score label="네이버 ROAS" value={v.naver && !v.naver.purchaseOk ? null : fix2(v.nRoas?.cur)} delta={v.naver?.purchaseOk ? pctDelta(v.nRoas?.cur ?? null, v.nRoas?.prev ?? null, "up") : null}
        note={v.naver ? (v.naver.purchaseOk ? prevNote(fix2(v.nRoas?.prev)) : "구매 전환 미확정") : why(s.naver)} />
      <ScoreSessions v={v} s={s} />
      <Score label="구매(GA4)" value={cnt(v.purS?.cur, "건")} delta={pctDelta(v.purS?.cur ?? null, v.purS?.prev ?? null, "up")} note={v.ga ? prevNote(cnt(v.purS?.prev, "건")) : why(s.ga)} spark={v.ga ? v.win(v.gaPurchases) : undefined} />
      <Score label="구매 전환율" value={pct2(v.conv?.cur)} delta={ppDelta(v.conv?.cur ?? null, v.conv?.prev ?? null, "up")} note={v.ga ? prevNote(pct2(v.conv?.prev)) : why(s.ga)} />
      <Card w={6} title="광고비 추이" right={<ChartLegend items={mediaLegend(v)} />}><SpendLine v={v} /></Card>
      <Card w={6} title="방문 추이" right={v.ga ? <CompareLegend v={v} /> : undefined}>
        {v.ga ? <CompareLine v={v} values={v.sessions} unit="회" /> : <div className="b2b-empty">방문 숫자가 없습니다.</div>}
      </Card>
      <Card w={12} title="매체별"><DataTable rows={v.mediaRows} cols={mCols} rowKey={(r) => r.name} sortKey="spend" empty="광고 숫자가 없습니다." /></Card>
      <Card w={12} title="유입 채널별">
        <DataTable rows={v.gaRows} cols={gCols} rowKey={(r) => r.name} sortKey="sessions" empty="방문 숫자가 없습니다."
          foot={["합계", sesTotal.toLocaleString(), sesTotal > 0 ? "100.0%" : "-", (v.purS?.cur ?? 0).toLocaleString(), pct2(v.conv?.cur) ?? "-", <DeltaText key="d" d={pctDelta(v.sesS?.cur ?? null, v.sesS?.prev ?? null, "up")} />]} />
      </Card>
    </>
  );
}

function SubPage({ v, s, detail }: { v: View; s: BoardSnapshot; detail: DetailState }) {
  const cust = detail.data?.cust ?? null;
  const rep = cust ? { cur: ratio(cust.cur.repeatCust * 100, cust.cur.total), prev: ratio(cust.prev.repeatCust * 100, cust.prev.total) } : null;
  return (
    <>
      <Errors list={[failOf("정기배송", s.sub), failOf("VOC", s.voc), detail.error ? `고객: ${detail.error}` : ""].filter(Boolean)} />
      <ScoreActive v={v} />
      <Score label="신규 신청" value={cnt(v.newS?.cur, "건")} delta={pctDelta(v.newS?.cur ?? null, v.newS?.prev ?? null, "up")} note={prevNote(cnt(v.newS?.prev, "건"))} spark={v.sub ? v.win(v.sub.newCnt) : undefined} />
      <Score label="해지" value={cnt(v.cancelS?.cur, "건")} delta={pctDelta(v.cancelS?.cur ?? null, v.cancelS?.prev ?? null, "down")} note={prevNote(cnt(v.cancelS?.prev, "건"))} spark={v.sub ? v.win(v.sub.cancelCnt) : undefined} />
      <ScoreSubRev v={v} />
      <Score label="재구매 고객 비율" value={pct1(rep?.cur)} delta={rep ? ppDelta(rep.cur, rep.prev, "up") : null}
        note={cust ? `신규 ${cust.cur.newCust.toLocaleString()}명 · 재구매 ${cust.cur.repeatCust.toLocaleString()}명` : detail.loading ? "불러오는 중..." : undefined} />
      <Score label="VOC 접수" value={cnt(v.vocS?.cur, "건")} delta={pctDelta(v.vocS?.cur ?? null, v.vocS?.prev ?? null, "down")} note={prevNote(cnt(v.vocS?.prev, "건"))} spark={v.voc ? v.win(v.voc.counts) : undefined} />
      <Card w={6} title="정기배송 회원" right={<ChartLegend items={[["이용중", C_CUR], ["일시정지", C_PREV]]} />}>
        {v.sub ? <LineChart periods={v.labels} unit="명" series={[{ key: "이용중", values: v.win(v.sub.active), color: C_CUR }, { key: "일시정지", values: v.win(v.sub.pause), color: C_PREV, dashed: true }]} />
          : <div className="b2b-empty">정기배송 숫자가 없습니다.</div>}
      </Card>
      <Card w={6} title="신규 신청과 해지" right={<ChartLegend items={[["신규 신청", "var(--sm-success)"], ["해지", "var(--sm-danger)"]]} />}>
        {v.sub ? <StackedBar periods={v.labels} series={[{ key: "신규 신청", values: v.win(v.sub.newCnt) }, { key: "해지", values: v.win(v.sub.cancelCnt) }]} colors={["var(--sm-success)", "var(--sm-danger)"]} />
          : <div className="b2b-empty">정기배송 숫자가 없습니다.</div>}
      </Card>
      <Card w={8} title="VOC 접수 추이" right={v.voc ? <CompareLegend v={v} /> : undefined}>
        {v.voc ? <CompareLine v={v} values={v.voc.counts} unit="건" /> : <div className="b2b-empty">VOC 숫자가 없습니다.</div>}
      </Card>
      <Card w={4} title="신규·재구매 고객">
        {!cust ? <div className={detail.loading ? "b2b-loading" : "b2b-empty"}>{detail.loading ? "불러오는 중..." : "고객 숫자가 없습니다."}</div>
          : <DonutCard data={[["신규", cust.cur.newCust], ["재구매", cust.cur.repeatCust]]} colors={[C_CUR, C_NAVER]} center={cust.cur.total.toLocaleString()} centerSub="명" fmt={(n) => `${n.toLocaleString()}명`} />}
      </Card>
    </>
  );
}

// ── 주제 보고서 ── 조건으로 정의한 주제 하나(예: 체험단)의 매출·고객·페이지·광고를 같은 기간으로 본다.
const mondayOf = (ymd: string) => shiftDay(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));
function buildTopicView(t: TopicSnapshot, sp: Span, salesCh: string[] | null) {
  const N = t.days.length;
  const win = <T,>(xs: T[]): T[] => cut(xs, sp.i0, sp.i1);
  const prevWin = (xs: (number | null)[]): (number | null)[] | null => (sp.prev ? cut(xs, sp.prev.i0, sp.prev.i1) : null);
  const labels = win(t.days).map(md);
  const on = (name: string) => !salesCh || salesCh.includes(name);

  // 매출 — 판매 채널 필터가 걸린다
  const sales = t.sales?.ok ? t.sales : null;
  const chSel = sales ? sales.channels.filter((c) => on(c.name)) : [];
  const rev = addSeries(chSel.map((c) => c.rev), N), orders = addSeries(chSel.map((c) => c.orders), N), qty = addSeries(chSel.map((c) => c.qty), N);
  const revS = sales ? spanSum(rev, sp) : null, ordS = sales ? spanSum(orders, sp) : null, qtyS = sales ? spanSum(qty, sp) : null;
  const itemRows = (sales ? sales.items.filter((x) => on(x.channel)) : []).map((x) => { const r = spanSum(x.rev, sp); return { key: `${x.channel}|${x.name}`, name: x.name, channel: x.channel, rev: r.cur, prevRev: r.prev, qty: sumOf(win(x.qty)), orders: sumOf(win(x.orders)) }; })
    .filter((r) => r.rev !== 0 || r.orders > 0).sort((a, b) => b.rev - a.rev);

  // 고객 — 처음 산 날 기준(채널 필터 없음). 기간이 14일을 넘으면 주(월~일)로 묶는다
  const cust = t.cust?.ok ? t.cust : null;
  const firstS = cust ? spanSum(cust.first, sp) : null, freshS = cust ? spanSum(cust.fresh, sp) : null, convS = cust ? spanSum(cust.conv, sp) : null, convRevS = cust ? spanSum(cust.convRev, sp) : null;
  const byWeek = sp.n > 14;
  const cohort: { key: string; from: string; to: string; first: number; fresh: number; conv: number; convRev: number }[] = [];
  if (cust) for (let i = sp.i0; i <= sp.i1; i++) {
    const d = t.days[i], key = byWeek ? mondayOf(d) : d;
    let row = cohort[cohort.length - 1];
    if (!row || row.key !== key) { row = { key, from: d, to: d, first: 0, fresh: 0, conv: 0, convRev: 0 }; cohort.push(row); }
    row.to = d; row.first += cust.first[i] || 0; row.fresh += cust.fresh[i] || 0; row.conv += cust.conv[i] || 0; row.convRev += cust.convRev[i] || 0;
  }

  // 페이지(GA4) — 조회는 주소별 합, 방문은 소스/매체별 합(한 방문은 소스 하나)
  const ga = t.ga?.ok ? t.ga : null;
  const views = addSeries(ga ? ga.pages.map((x) => x.views) : [], N), sessions = addSeries(ga ? ga.sources.map((x) => x.sessions) : [], N);
  const viewsS = ga ? spanSum(views, sp) : null, sesS = ga ? spanSum(sessions, sp) : null;
  const pageRows = (ga ? ga.pages : []).map((x) => { const r = spanSum(x.views, sp); return { name: x.name, views: r.cur, prevViews: r.prev, sessions: sumOf(win(x.sessions)) }; }).filter((r) => r.views > 0 || r.sessions > 0).sort((a, b) => b.views - a.views);
  const sourceRows = (ga ? ga.sources : []).map((x) => ({ name: x.name, sessions: sumOf(win(x.sessions)) })).filter((r) => r.sessions > 0).sort((a, b) => b.sessions - a.sessions);

  // 메타 광고
  const meta = t.meta?.ok ? t.meta : null;
  const pick = (k: "spend" | "value" | "purchases") => addSeries(meta ? meta.ads.map((a) => a[k]) : [], N);
  const spend = pick("spend"), value = pick("value"), purchases = pick("purchases");
  const spendS = meta ? spanSum(spend, sp) : null, valueS = meta ? spanSum(value, sp) : null, purS = meta ? spanSum(purchases, sp) : null;
  const adRows = (meta ? meta.ads : []).map((a) => {
    const sp1 = sumOf(win(a.spend)), val = sumOf(win(a.value));
    return { id: a.id, name: a.name || a.campaign || a.id, path: [a.campaign, a.adset].filter(Boolean).join(" › "), spend: sp1, impressions: sumOf(win(a.impressions)), clicks: sumOf(win(a.clicks)), purchases: sumOf(win(a.purchases)), value: val, roas: ratio(val, sp1) };
  }).filter((r) => r.spend > 0 || r.impressions > 0).sort((a, b) => b.spend - a.spend);

  return { win, prevWin, hasPrev: !!sp.prev, labels, sales, rev, orders, revS, ordS, qtyS, itemRows, cust, firstS, freshS, convS, convRevS, byWeek, cohort,
    ga, views, viewsS, sesS, pageRows, sourceRows, meta, spend, value, spendS, valueS, purS, adRows };
}
type TopicView = ReturnType<typeof buildTopicView>;

function TopicPage({ tv, t, topic }: { tv: TopicView; t: TopicSnapshot; topic: BoardTopic }) {
  // 숫자가 비는 까닭 — 조건을 안 넣었거나, 연결이 없거나, 조회가 실패했다
  const whyT = (x: { ok: boolean } | null, cond: string) => (x == null ? (cond ? "연결 안 됨" : "조건 없음") : x.ok ? undefined : "조회 실패");
  const convRate = tv.firstS && tv.convS ? ratio(tv.convS.cur * 100, tv.firstS.cur) : null;
  const roas = tv.spendS && tv.valueS ? ratio(tv.valueS.cur, tv.spendS.cur) : null;
  const fresh = tv.freshS?.cur ?? 0, first = tv.firstS?.cur ?? 0;
  type CRow = TopicView["cohort"][number];
  const cCols: Col<CRow>[] = [
    { key: "key", label: tv.byWeek ? "처음 산 주" : "처음 산 날", sort: (r) => r.key, cell: (r) => (tv.byWeek ? `${md(r.from)}~${md(r.to)}` : `${md(r.from)} (${weekday(r.from)})`) },
    { key: "first", label: "처음 산 고객", num: true, bar: true, sort: (r) => r.first, cell: (r) => r.first.toLocaleString() },
    { key: "fresh", label: "신규", num: true, sort: (r) => r.fresh, cell: (r) => r.fresh.toLocaleString() },
    { key: "conv", label: "이후 구매", num: true, sort: (r) => r.conv, cell: (r) => r.conv.toLocaleString() },
    { key: "rate", label: "이후 구매율", num: true, sort: (r) => ratio(r.conv, r.first) ?? -1, cell: (r) => pct1(ratio(r.conv * 100, r.first)) ?? "-" },
    { key: "convRev", label: "이후 구매 매출(원)", num: true, sort: (r) => r.convRev, cell: (r) => won(r.convRev) },
  ];
  type IRow = TopicView["itemRows"][number];
  const iCols: Col<IRow>[] = [
    { key: "name", label: "주문 상품명", w: 45, sort: (r) => r.name, cell: (r) => r.name },
    { key: "channel", label: "채널", sort: (r) => r.channel, cell: (r) => r.channel },
    { key: "rev", label: "매출(원)", num: true, bar: true, sort: (r) => r.rev, cell: (r) => won(r.rev) },
    { key: "qty", label: "수량", num: true, sort: (r) => r.qty, cell: (r) => r.qty.toLocaleString() },
    { key: "orders", label: "주문 건수", num: true, sort: (r) => r.orders, cell: (r) => r.orders.toLocaleString() },
  ];
  type PRow = TopicView["pageRows"][number];
  const pCols: Col<PRow>[] = [
    { key: "name", label: "페이지 주소", w: 45, sort: (r) => r.name, cell: (r) => <span className="bd-path" title={r.name}>{r.name}</span> },
    { key: "views", label: "조회", num: true, bar: true, sort: (r) => r.views, cell: (r) => r.views.toLocaleString() },
    { key: "sessions", label: "방문", num: true, sort: (r) => r.sessions, cell: (r) => r.sessions.toLocaleString() },
    { key: "delta", label: "직전 대비", num: true, sort: (r) => pctChange(r.views, r.prevViews) ?? -Infinity, cell: (r) => <DeltaText d={pctDelta(r.views, r.prevViews, "up")} /> },
  ];
  type SRow = TopicView["sourceRows"][number];
  const sesTotal = tv.sesS?.cur ?? 0;
  const sCols: Col<SRow>[] = [
    { key: "name", label: "소스/매체", sort: (r) => r.name, cell: (r) => r.name },
    { key: "sessions", label: "방문", num: true, bar: true, sort: (r) => r.sessions, cell: (r) => r.sessions.toLocaleString() },
    { key: "share", label: "비중", num: true, sort: (r) => r.sessions, cell: (r) => (sesTotal > 0 ? `${(Math.round((r.sessions / sesTotal) * 1000) / 10).toFixed(1)}%` : "-") },
  ];
  type ARow = TopicView["adRows"][number];
  const aCols: Col<ARow>[] = [
    { key: "name", label: "광고", w: 30, sort: (r) => r.name, cell: (r) => <span title={r.path || undefined}>{r.name}</span> },
    { key: "spend", label: "광고비(원)", num: true, bar: true, sort: (r) => r.spend, cell: (r) => won(r.spend) },
    { key: "imp", label: "노출", num: true, sort: (r) => r.impressions, cell: (r) => r.impressions.toLocaleString() },
    { key: "clicks", label: "클릭", num: true, sort: (r) => r.clicks, cell: (r) => r.clicks.toLocaleString() },
    { key: "purchases", label: "구매", num: true, sort: (r) => r.purchases, cell: (r) => r.purchases.toLocaleString() },
    { key: "value", label: "구매액(원)", num: true, sort: (r) => r.value, cell: (r) => won(r.value) },
    { key: "roas", label: "ROAS", num: true, sort: (r) => r.roas ?? 0, cell: (r) => fix2(r.roas) ?? "-" },
  ];
  const noSales = topic.products ? "조건에 맞는 주문이 없습니다." : "상품 조건이 없습니다.";
  const noPages = topic.pages ? "조건에 맞는 페이지 조회가 없습니다." : "페이지 조건이 없습니다.";
  const noAds = topic.ads ? "조건에 맞는 광고 숫자가 없습니다." : "광고 조건이 없습니다.";
  return (
    <>
      <Errors list={[failOf("매출", t.sales), failOf("고객", t.cust), failOf("GA4", t.ga), failOf("메타 광고", t.meta),
        t.ga?.ok && t.ga.truncated ? "GA4: 행이 많아 일부만 받았습니다. 페이지 조건을 좁히세요." : "",
        t.meta?.ok && t.meta.campaignOnly ? "메타 광고: 광고 단위로 받지 못해 캠페인 이름에만 조건을 적용했습니다." : ""].filter(Boolean)} />
      <Score label="매출" value={wonS(tv.revS?.cur)} delta={pctDelta(tv.revS?.cur ?? null, tv.revS?.prev ?? null, "up")} note={tv.sales ? prevNote(tv.revS?.prev != null ? `${moneyCompact(tv.revS.prev)}원` : null) : whyT(t.sales, topic.products)} spark={tv.sales ? tv.win(tv.rev) : undefined} />
      <Score label="주문 건수" value={cnt(tv.ordS?.cur, "건")} delta={pctDelta(tv.ordS?.cur ?? null, tv.ordS?.prev ?? null, "up")} note={tv.sales ? `수량 ${(tv.qtyS?.cur ?? 0).toLocaleString()}개` : whyT(t.sales, topic.products)} spark={tv.sales ? tv.win(tv.orders) : undefined} />
      <Score label="처음 산 고객" value={cnt(tv.firstS?.cur, "명")} delta={pctDelta(tv.firstS?.cur ?? null, tv.firstS?.prev ?? null, "up")} note={tv.cust ? `신규 ${fresh.toLocaleString()}명` : whyT(t.cust, topic.products)} spark={tv.cust ? tv.win(tv.cust.first) : undefined} />
      <Score label="이후 다른 상품 구매" value={pct1(convRate)} note={tv.cust ? `${(tv.convS?.cur ?? 0).toLocaleString()}명 · ${moneyCompact(tv.convRevS?.cur ?? 0)}원` : whyT(t.cust, topic.products)} />
      <Score label="페이지 조회" value={cnt(tv.viewsS?.cur, "회")} delta={pctDelta(tv.viewsS?.cur ?? null, tv.viewsS?.prev ?? null, "up")} note={tv.ga ? `방문 ${sesTotal.toLocaleString()}회` : whyT(t.ga, topic.pages)} spark={tv.ga ? tv.win(tv.views) : undefined} />
      <Score label="메타 광고비" value={wonS(tv.spendS?.cur)} delta={pctDelta(tv.spendS?.cur ?? null, tv.spendS?.prev ?? null, "none")} note={tv.meta ? `ROAS ${fix2(roas) ?? "-"} · 구매 ${(tv.purS?.cur ?? 0).toLocaleString()}건` : whyT(t.meta, topic.ads)} spark={tv.meta ? tv.win(tv.spend) : undefined} />
      <Card w={8} title="처음 산 고객 추이" right={tv.cust ? <CompareLegend v={tv} /> : undefined}>
        {tv.cust ? <CompareLine v={tv} values={tv.cust.first} unit="명" /> : <div className="b2b-empty">{noSales}</div>}
      </Card>
      <Card w={4} title="신규·기존 고객">
        {first > 0 ? <DonutCard data={[["신규", fresh], ["기존", Math.max(0, first - fresh)]]} colors={[C_CUR, C_NAVER]} center={first.toLocaleString()} centerSub="명" fmt={(n) => `${n.toLocaleString()}명`} />
          : <div className="b2b-empty">{tv.cust ? "이 기간에 처음 산 고객이 없습니다." : noSales}</div>}
      </Card>
      <Card w={6} title="매출 추이" right={tv.sales ? <CompareLegend v={tv} /> : undefined}>
        {tv.sales ? <CompareLine v={tv} values={tv.rev} fmtAxis={moneyCompact} fmtTip={won} unit="원" /> : <div className="b2b-empty">{noSales}</div>}
      </Card>
      <Card w={6} title="페이지 조회 추이" right={tv.ga ? <CompareLegend v={tv} /> : undefined}>
        {tv.ga ? <CompareLine v={tv} values={tv.views} unit="회" /> : <div className="b2b-empty">{noPages}</div>}
      </Card>
      <Card w={6} title={tv.byWeek ? "처음 산 주별 고객" : "처음 산 날별 고객"}>
        <DataTable rows={tv.cohort.filter((r) => r.first > 0)} cols={cCols} rowKey={(r) => r.key} sortKey="key" empty={tv.cust ? "이 기간에 처음 산 고객이 없습니다." : noSales}
          foot={["합계", first.toLocaleString(), fresh.toLocaleString(), (tv.convS?.cur ?? 0).toLocaleString(), pct1(convRate) ?? "-", won(tv.convRevS?.cur ?? 0)]} />
      </Card>
      <Card w={6} title="상품별">
        <DataTable rows={tv.itemRows} cols={iCols} rowKey={(r) => r.key} sortKey="rev" empty={noSales}
          foot={["합계", "", won(tv.revS?.cur ?? 0), (tv.qtyS?.cur ?? 0).toLocaleString(), (tv.ordS?.cur ?? 0).toLocaleString()]} />
      </Card>
      <Card w={8} title="페이지별"><DataTable rows={tv.pageRows} cols={pCols} rowKey={(r) => r.name} sortKey="views" empty={noPages} /></Card>
      <Card w={4} title="유입 경로별"><DataTable rows={tv.sourceRows} cols={sCols} rowKey={(r) => r.name} sortKey="sessions" empty={noPages} /></Card>
      <Card w={6} title="메타 광고비와 구매액" right={tv.meta ? <ChartLegend items={[["광고비", C_CUR], ["구매액", C_NAVER]]} /> : undefined}>
        {tv.meta ? <LineChart periods={tv.labels} fmtAxis={moneyCompact} fmtTip={won} unit="원" series={[{ key: "광고비", values: tv.win(tv.spend), color: C_CUR }, { key: "구매액", values: tv.win(tv.value), color: C_NAVER }]} />
          : <div className="b2b-empty">{noAds}</div>}
      </Card>
      <Card w={6} title="광고별"><DataTable rows={tv.adRows} cols={aCols} rowKey={(r) => r.id} sortKey="spend" empty={noAds} /></Card>
    </>
  );
}

// 주제 만들기·조건 바꾸기 — 조건은 '이름에 든 말'(쉼표로 여러 개 = 그중 하나라도)
function TopicForm({ topic, onClose, onDone }: { topic: BoardTopic | null; onClose: () => void; onDone: (topics: BoardTopic[], saved: BoardTopic | null) => void }) {
  const [f, setF] = useState({ name: topic?.name ?? "", products: topic?.products ?? "", pages: topic?.pages ?? "", ads: topic?.ads ?? "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ask, setAsk] = useState(false); // [주제 삭제]를 한 번 눌러 확인을 기다리는 중
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  async function post(body: Record<string, unknown>, fallback: string) {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/board/topic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; topics?: BoardTopic[]; topic?: BoardTopic };
      if (!r.ok || !j.ok || !j.topics) throw new Error(j.error || fallback);
      onDone(j.topics, j.topic ?? null);
    } catch (e) { setErr(e instanceof Error ? e.message : fallback); setBusy(false); }
  }
  const field = (k: "name" | "products" | "pages" | "ads", label: string, placeholder: string, max: number) => (
    <label className="b2b-field"><span className="b2b-field-label">{label}</span>
      <input className="b2b-input" value={f[k]} maxLength={max} placeholder={placeholder} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} /></label>
  );
  const empty = !f.name.trim() || !(topicWords(f.products).length || topicWords(f.pages).length || topicWords(f.ads).length);
  return (
    <div className="b2b-modal-backdrop">
      <form className="b2b-modal" onSubmit={(e) => { e.preventDefault(); if (!empty && !busy) post({ action: "save", topic: { id: topic?.id, ...f } }, "주제를 저장하지 못했습니다"); }}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">{topic ? "주제 조건 바꾸기" : "주제 추가"}</h2>
          <button type="button" className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {err && <div className="b2b-error">{err}</div>}
          {field("name", "주제 이름", "체험단", 20)}
          {field("products", "상품 이름에 든 말", "쉼표로 여러 개", 220)}
          {field("pages", "페이지 제목·주소에 든 말", "쉼표로 여러 개", 220)}
          {field("ads", "광고 이름에 든 말", "쉼표로 여러 개", 220)}
        </div>
        <div className="b2b-modal-foot">
          {topic ? <button type="button" className="b2b-btn-danger" disabled={busy} onClick={() => (ask ? post({ action: "delete", id: topic.id }, "주제를 삭제하지 못했습니다") : setAsk(true))}>{ask ? "삭제 확인" : "주제 삭제"}</button> : <span />}
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose}>닫기</button>
            <button type="submit" className="b2b-btn-primary" disabled={busy || empty}>{busy ? "저장 중..." : "주제 저장"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default function BoardPage() {
  const [snap, setSnap] = useState<BoardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false); // 서버가 응답 뒤에 새 묶음을 계산하는 중
  const [busy, setBusy] = useState(false);             // [다시 계산] 진행 중
  const [error, setError] = useState("");
  const [page, setPage] = useState<PageKey | `t:${string}`>("summary");   // t:<id> = 주제 보고서
  const [range, setRange] = useState<Range | null>(null);
  const [filters, setFilters] = useState<Filters>({ salesCh: null, media: null, gaCh: null });
  const [detail, setDetail] = useState<DetailState>({ key: "", data: null, loading: false, error: "" });
  const [topics, setTopics] = useState<BoardTopic[]>([]);
  const [topicState, setTopicState] = useState<{ key: string; data: TopicSnapshot | null; loading: boolean; error: string }>({ key: "", data: null, loading: false, error: "" });
  const [form, setForm] = useState<{ topic: BoardTopic | null } | null>(null);   // 주제 추가·조건 바꾸기 창
  const [nonce, setNonce] = useState(0);                                          // 조건을 저장하면 올려 그 주제를 다시 받는다
  const tries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // 주제 목록 — 본 묶음을 받을 때마다 같이(다른 사람이 주제를 만들거나 지워도 따라온다). 실패해도 화면은 그대로
    fetch("/api/board/topic", { cache: "no-store" }).then((r) => r.json()).then((j: { ok?: boolean; topics?: BoardTopic[] }) => { if (j.ok && j.topics) setTopics(j.topics); }).catch(() => {});
    try {
      const r = await fetch("/api/board", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; snapshot?: BoardSnapshot | null; refreshing?: boolean };
      if (!r.ok || !j.ok) throw new Error(j.error || "지표를 불러오지 못했습니다");
      if (j.snapshot) setSnap(j.snapshot);
      setError("");
      // 새 묶음 계산 중이면 40초 뒤 다시 받는다(최대 4번) — 그 밖에는 서버를 다시 부르지 않는다
      const again = !!j.refreshing && tries.current < POLL_MAX;
      setRefreshing(again);
      if (again) { tries.current++; timer.current = setTimeout(load, POLL_MS); } else tries.current = 0;
    } catch (e) {
      setError(e instanceof Error ? e.message : "지표를 불러오지 못했습니다");
      setRefreshing(false);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    // 모니터에 띄워 둔 화면이 날이 바뀐 뒤에도 따라오게 한 시간에 한 번만 다시 받는다
    const hourly = setInterval(() => { tries.current = 0; load(); }, HOURLY_MS);
    return () => { clearInterval(hourly); if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  // 주제 묶음 — 그 주제 탭을 볼 때만. 본 묶음이 새로 계산됐거나(builtAt) 조건을 저장하면(nonce) 다시 받는다
  const topicId = page.startsWith("t:") ? page.slice(2) : "";
  const topicKey = topicId && snap ? `${topicId}|${snap.builtAt}|${nonce}` : "";
  const haveTopicKey = topicState.key;
  useEffect(() => {
    if (!topicKey || haveTopicKey === topicKey) return;
    const ac = new AbortController();
    setTopicState((x) => ({ ...x, loading: true, error: "" }));
    (async () => {
      try {
        const r = await fetch(`/api/board/topic?id=${encodeURIComponent(topicId)}`, { cache: "no-store", signal: ac.signal });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: TopicSnapshot };
        if (!r.ok || !j.ok || !j.data) throw new Error(j.error || "주제 숫자를 불러오지 못했습니다");
        setTopicState({ key: topicKey, data: j.data, loading: false, error: "" });
      } catch (e) {
        if (ac.signal.aborted) return;
        setTopicState({ key: topicKey, data: null, loading: false, error: e instanceof Error ? e.message : "주제 숫자를 불러오지 못했습니다" });
      }
    })();
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicKey, haveTopicKey]);

  // 기간 — 프리셋은 기준일이 바뀌면 따라 움직이고, 직접 고른 기간은 묶음 범위 안으로만 맞춘다
  const base = snap?.base ?? "", minDay = snap?.days[0] ?? "";
  useEffect(() => {
    if (!base) return;
    setRange((cur) => {
      const preset = PRESETS.find((p) => p.key === (cur?.preset ?? "d7"));
      if (preset) { const [f, t] = preset.range(base); return { preset: preset.key, from: f < minDay ? minDay : f, to: t }; }
      if (!cur) return null;
      const to = cur.to > base ? base : cur.to, from = cur.from < minDay ? minDay : cur.from;
      return from > to ? { preset: "d7", from: shiftDay(base, -6), to: base } : { ...cur, from, to };
    });
  }, [base, minDay]);

  const span = useMemo(() => (snap && range ? spanOf(snap.days, range.from, range.to) : null), [snap, range]);
  const view = useMemo(() => (snap && span ? buildView(snap, span, filters) : null), [snap, span, filters]);

  // 기간 상세(상품별 표·신규/재구매) — 그 숫자가 있는 쪽을 볼 때만, 기간·판매 채널이 바뀌면 다시 받는다
  const needDetail = page === "sales" || page === "sub";
  const detailKey = range ? `${range.from}|${range.to}|${(filters.salesCh ?? ["*"]).join(",")}` : "";
  const haveKey = detail.key;
  useEffect(() => {
    if (!needDetail || !range || !detailKey || haveKey === detailKey) return;
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setDetail((d) => ({ ...d, loading: true, error: "" }));
      try {
        const qs = new URLSearchParams({ from: range.from, to: range.to, ...(filters.salesCh ? { ch: filters.salesCh.join(",") } : {}) });
        const r = await fetch(`/api/board/detail?${qs}`, { cache: "no-store", signal: ac.signal });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: BoardDetail };
        if (!r.ok || !j.ok || !j.detail) throw new Error(j.error || "기간 상세를 불러오지 못했습니다");
        setDetail({ key: detailKey, data: j.detail, loading: false, error: "" });
      } catch (e) {
        if (ac.signal.aborted) return;
        setDetail({ key: detailKey, data: null, loading: false, error: e instanceof Error ? e.message : "기간 상세를 불러오지 못했습니다" });
      }
    }, 250);
    return () => { clearTimeout(t); ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needDetail, detailKey, haveKey]);

  async function rebuild() {
    setBusy(true); setError("");
    if (topicId) {
      try {
        const r = await fetch("/api/board/topic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rebuild", id: topicId }) });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: TopicSnapshot };
        if (!r.ok || !j.ok || !j.data) throw new Error(j.error || "주제 숫자를 다시 계산하지 못했습니다");
        setTopicState({ key: topicKey, data: j.data, loading: false, error: "" });
      } catch (e) { setError(e instanceof Error ? e.message : "주제 숫자를 다시 계산하지 못했습니다"); }
      finally { setBusy(false); }
      return;
    }
    try {
      const r = await fetch("/api/board", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rebuild" }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; snapshot?: BoardSnapshot };
      if (!r.ok || !j.ok || !j.snapshot) throw new Error(j.error || "지표를 다시 계산하지 못했습니다");
      setSnap(j.snapshot); setRefreshing(false); tries.current = 0;
      setDetail({ key: "", data: null, loading: false, error: "" });
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    } catch (e) { setError(e instanceof Error ? e.message : "지표를 다시 계산하지 못했습니다"); }
    finally { setBusy(false); }
  }

  const builtAt = snap ? new Date(Date.parse(snap.builtAt) + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "";
  const salesOptions = snap?.sales.ok ? snap.sales.channels.map((c) => c.name) : [];
  const mediaOptions = [...(snap?.meta?.ok ? ["메타"] : []), ...(snap?.naver?.ok ? ["네이버"] : [])];
  const gaOptions = snap?.ga?.ok ? snap.ga.channels.map((c) => c.name) : [];
  const n = range ? daysBetween(range.from, range.to) : 0;
  // 기간이 바뀌어 아직 새 상세를 못 받았으면 옛 상세를 보여 주지 않는다
  const shownDetail: DetailState = detail.key === detailKey ? detail : { key: detailKey, data: null, loading: true, error: "" };
  // 주제 — 다른 주제·옛 조건의 묶음은 보여 주지 않는다
  const curTopic = topicId ? topics.find((t) => t.id === topicId) ?? null : null;
  const tData = topicId && topicState.key === topicKey ? topicState.data : null;
  const tError = topicId && topicState.key === topicKey ? topicState.error : "";
  const tSpan = tData && range ? spanOf(tData.days, range.from, range.to) : null;
  const tView = tData && tSpan ? buildTopicView(tData, tSpan, filters.salesCh) : null;
  const quote = (s: string) => topicWords(s).map((w) => `'${w}'`).join("·");
  const topicBasis = curTopic ? [curTopic.products && `상품 ${quote(curTopic.products)}`, curTopic.pages && `페이지 ${quote(curTopic.pages)}`, curTopic.ads && `광고 ${quote(curTopic.ads)}`].filter(Boolean).join(" · ") : "";
  return (
    <div className="bd-root">
      <header className="bd-bar">
        <div className="bd-bar-row">
          <Link href="/" className="bd-logo" aria-label="업무도우미 홈">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="씨몬스터" />
          </Link>
          <h1 className="bd-title">주요 지표</h1>
          <div className="sm-tabs bd-pages">
            {PAGES.map(([k, label]) => <button key={k} type="button" className={`sm-tab ${page === k ? "is-active" : ""}`} onClick={() => setPage(k)}>{label}</button>)}
            {topics.map((t) => <button key={t.id} type="button" className={`sm-tab ${page === `t:${t.id}` ? "is-active" : ""}`} onClick={() => setPage(`t:${t.id}`)}>{t.name}</button>)}
          </div>
          <button type="button" className="b2b-link-btn" onClick={() => setForm({ topic: null })}>주제 추가</button>
          <div className="bd-bar-right">
            {snap && <span className="bd-state">{refreshing ? "새 숫자 계산 중..." : `${builtAt} 계산`}</span>}
            <button type="button" className="b2b-btn-secondary" onClick={rebuild} disabled={busy || loading}>{busy ? "계산 중..." : "다시 계산"}</button>
          </div>
        </div>
        {snap && range && (
          <div className="bd-controls">
            <DateControl range={range} base={snap.base} min={snap.days[0]} onChange={setRange} />
            <FilterControl label="판매 채널" options={salesOptions} value={filters.salesCh} onChange={(x) => setFilters((f) => ({ ...f, salesCh: x }))} />
            {!topicId && <FilterControl label="광고 매체" options={mediaOptions} value={filters.media} onChange={(x) => setFilters((f) => ({ ...f, media: x }))} />}
            {!topicId && <FilterControl label="유입 채널" options={gaOptions} value={filters.gaCh} onChange={(x) => setFilters((f) => ({ ...f, gaCh: x }))} />}
            {curTopic && <button type="button" className="b2b-btn-secondary" onClick={() => setForm({ topic: curTopic })}>조건 바꾸기</button>}
            {topicId
              ? <span className="bd-basis">기준일 {snap.base} ({weekday(snap.base)}) · {topicBasis ? `${topicBasis} 포함 · ` : ""}고객은 그 상품을 처음 산 날 기준 · 이후 구매는 기준일까지</span>
              : <span className="bd-basis">기준일 {snap.base} ({weekday(snap.base)}) · {span?.prev ? `직전 ${n}일과 비교` : "직전 기간이 조회 범위 밖이라 비교 없음"} · 매출은 주문일 기준 도매 포함 · 광고비는 VAT 제외</span>}
          </div>
        )}
      </header>
      <main className="bd-canvas">
        {error && <div className="b2b-error bd-c12">{error}</div>}
        {loading && !snap ? <div className="b2b-loading bd-c12">불러오는 중...</div>
          : !snap ? (refreshing ? <div className="b2b-loading bd-c12">처음 계산하는 중...</div> : null)
          : topicId ? (
            !curTopic ? <div className="b2b-empty bd-c12">없는 주제입니다.</div>
              : tError ? <div className="b2b-error bd-c12">{tError}</div>
              : !tData ? <div className="b2b-loading bd-c12">주제 숫자를 계산하는 중...</div>
              : !tView ? <div className="b2b-empty bd-c12">고른 기간에 숫자가 없습니다.</div>
              : <TopicPage tv={tView} t={tData} topic={curTopic} />
          )
          : !view ? <div className="b2b-empty bd-c12">고른 기간에 숫자가 없습니다.</div>
          : page === "summary" ? <SummaryPage v={view} s={snap} />
          : page === "sales" ? <SalesPage v={view} s={snap} detail={shownDetail} />
          : page === "ads" ? <AdsPage v={view} s={snap} />
          : <SubPage v={view} s={snap} detail={shownDetail} />}
      </main>
      {form && (
        <TopicForm topic={form.topic} onClose={() => setForm(null)} onDone={(list, saved) => {
          setTopics(list); setForm(null);
          if (saved) { setPage(`t:${saved.id}`); setNonce((x) => x + 1); }   // 저장 = 그 주제로 가서 새 조건으로 다시 받는다
          else setPage((cur) => (cur.startsWith("t:") && !list.some((t) => `t:${t.id}` === cur) ? "summary" : cur));
        }} />
      )}
    </div>
  );
}
