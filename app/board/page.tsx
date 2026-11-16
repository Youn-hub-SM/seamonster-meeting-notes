"use client";

// 주요 지표 — 루커 스튜디오식 보고서 화면(2026-11-15 개편): 위에 기간 선택기·필터, 아래에 스코어카드·선 그래프·표를 칸칸이 배치.
//  서버가 저장해 둔 180일치 묶음(/api/board, app/lib/board.ts)을 한 번 받아, 기간·필터를 바꿔도 여기서 잘라 계산한다(board-types.ts).
//  날마다 더할 수 없는 값(신규·재구매 고객 수)과 상품별 표만 기간이 바뀔 때 /api/board/detail 로 받는다.
//  비율(객단가·ROAS·전환율)은 기간 합계끼리 나눈다. 비교는 언제나 '직전 같은 길이 기간'.
//  주제 보고서(2026-11-16): 고정 네 쪽 뒤에 주제 탭(board-types.ts TOPICS — 대표와 같이 정한 대상) — 그 주제의 묶음을 /api/board/topic 에서 받아 같은 기간으로 자른다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { StackedBar, LineChart, Sparkline, Donut, ChartLegend, PIE_COLORS, moneyCompact } from "@/app/components/charts";
import { won } from "@/app/lib/format";
import { spanOf, spanSum, addSeries, cut, sumOf, pctChange, ratio, lastKnown, shiftDay, daysBetween, TOPICS, TOPIC_REPEAT_DAYS, type BoardSnapshot, type BoardDetail, type Span, type TopicDef, type TopicSnapshot } from "@/app/lib/board-types";

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
const PAGES = [["summary", "요약"], ["sales", "매출"], ["ads", "광고·유입"], ["sub", "정기배송·고객"], ["subx", "정기배송 분석"]] as const;
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

// ── 주제 보고서 ── 주제 하나(예: 체험단)의 구매·광고 효율·페이지 전환·재구매를 같은 기간으로 본다.
const mondayOf = (ymd: string) => shiftDay(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));
function buildTopicView(t: TopicSnapshot, sp: Span, salesCh: string[] | null) {
  const N = t.days.length;
  const win = <T,>(xs: T[]): T[] => cut(xs, sp.i0, sp.i1);
  const prevWin = (xs: (number | null)[]): (number | null)[] | null => (sp.prev ? cut(xs, sp.prev.i0, sp.prev.i1) : null);
  const labels = win(t.days).map(md);
  const on = (name: string) => !salesCh || salesCh.includes(name);

  // ① 구매 — 판매 채널 필터가 걸린다
  const sales = t.sales.ok ? t.sales : null;
  const chSel = sales ? sales.channels.filter((c) => on(c.name)) : [];
  const rev = addSeries(chSel.map((c) => c.rev), N), orders = addSeries(chSel.map((c) => c.orders), N), qty = addSeries(chSel.map((c) => c.qty), N);
  const revS = sales ? spanSum(rev, sp) : null, ordS = sales ? spanSum(orders, sp) : null, qtyS = sales ? spanSum(qty, sp) : null;
  const itemRows = (sales ? sales.items.filter((x) => on(x.channel)) : []).map((x) => ({ key: `${x.channel}|${x.name}`, name: x.name, channel: x.channel, rev: sumOf(win(x.rev)), qty: sumOf(win(x.qty)), orders: sumOf(win(x.orders)) }))
    .filter((r) => r.rev !== 0 || r.orders > 0).sort((a, b) => b.rev - a.rev);

  // ④ 고객·재구매 — 처음 산 날 기준(채널 필터 없음). 30일 재구매율은 처음 산 지 30일이 지난 고객만으로 잰다
  const cust = t.cust.ok ? t.cust : null;
  const firstS = cust ? spanSum(cust.first, sp) : null, freshS = cust ? spanSum(cust.fresh, sp) : null;
  const lastMature = N - 1 - TOPIC_REPEAT_DAYS;   // 이 자리까지가 30일을 다 채운 고객
  const mEnd = Math.min(sp.i1, lastMature);
  const matureFirst = cust && mEnd >= sp.i0 ? sumOf(cut(cust.first, sp.i0, mEnd)) : 0, matureConv30 = cust && mEnd >= sp.i0 ? sumOf(cut(cust.conv30, sp.i0, mEnd)) : 0;
  const rate30 = ratio(matureConv30 * 100, matureFirst);
  const byWeek = sp.n > 14;
  const cohort: { key: string; from: string; to: string; mature: boolean; first: number; conv30: number; conv: number; convRev: number }[] = [];
  if (cust) for (let i = sp.i0; i <= sp.i1; i++) {
    const d = t.days[i], key = byWeek ? mondayOf(d) : d;
    let row = cohort[cohort.length - 1];
    if (!row || row.key !== key) { row = { key, from: d, to: d, mature: true, first: 0, conv30: 0, conv: 0, convRev: 0 }; cohort.push(row); }
    row.to = d; row.mature = i <= lastMature;   // 그 줄의 마지막 날까지 30일이 지났는가
    row.first += cust.first[i] || 0; row.conv30 += cust.conv30[i] || 0; row.conv += cust.conv[i] || 0; row.convRev += cust.convRev[i] || 0;
  }
  const afterRows = (cust ? cust.after : []).map((a) => ({ name: a.name, customers: sumOf(win(a.customers)), rev: sumOf(win(a.rev)) })).filter((r) => r.customers > 0).sort((a, b) => b.customers - a.customers || b.rev - a.rev);

  // ③ 페이지 — 방문·스크롤은 GA4 세션, 주문서 진입은 GA4 상품 수량, 구매는 주문 원장
  const ga = t.ga?.ok ? t.ga : null;
  const visitS = ga ? spanSum(ga.visits, sp) : null, checkoutS = ga ? spanSum(ga.checkout, sp) : null;
  const convRate = visitS && ordS ? { cur: ratio(ordS.cur * 100, visitS.cur), prev: ratio(ordS.prev == null ? null : ordS.prev * 100, visitS.prev) } : null;
  const funnel: { idx: number; label: string; n: number; from: string; rate: number | null; ofVisit: number | null }[] = [];
  if (ga && visitS) {
    const v = visitS.cur;
    let prevLabel = "방문", prevN = v;
    funnel.push({ idx: 0, label: "방문", n: v, from: "", rate: null, ofVisit: null });
    for (const x of ga.scroll) { const n = sumOf(win(x.sessions)); funnel.push({ idx: funnel.length, label: x.label, n, from: prevLabel, rate: ratio(n * 100, prevN), ofVisit: ratio(n * 100, v) }); prevLabel = x.label; prevN = n; }
    const co = checkoutS?.cur ?? 0;
    funnel.push({ idx: funnel.length, label: "주문서 진입", n: co, from: "방문", rate: ratio(co * 100, v), ofVisit: ratio(co * 100, v) });
    if (ordS) funnel.push({ idx: funnel.length, label: "구매", n: ordS.cur, from: "주문서 진입", rate: ratio(ordS.cur * 100, co), ofVisit: ratio(ordS.cur * 100, v) });
  }
  const sesTotal = ga ? sumOf(ga.sources.flatMap((x) => win(x.sessions))) : 0;
  const sourceRows = (ga ? ga.sources : []).map((x) => { const r = spanSum(x.sessions, sp); return { name: x.name, sessions: r.cur, prevSessions: r.prev }; }).filter((r) => r.sessions > 0).sort((a, b) => b.sessions - a.sessions);

  // ② 메타 광고
  const meta = t.meta?.ok ? t.meta : null;
  const pick = (k: "spend" | "value" | "purchases" | "clicks" | "impressions") => addSeries(meta ? meta.ads.map((a) => a[k]) : [], N);
  const spend = pick("spend"), value = pick("value");
  const spendS = meta ? spanSum(spend, sp) : null, valueS = meta ? spanSum(value, sp) : null, purS = meta ? spanSum(pick("purchases"), sp) : null;
  const clickS = meta ? spanSum(pick("clicks"), sp) : null, impS = meta ? spanSum(pick("impressions"), sp) : null;
  const cpa = spendS && ordS ? { cur: ratio(spendS.cur, ordS.cur), prev: ratio(spendS.prev, ordS.prev) } : null;   // 주문 1건당 광고비(주문 원장 기준)
  const adRows = (meta ? meta.ads : []).map((a) => {
    const sp1 = sumOf(win(a.spend)), val = sumOf(win(a.value)), imp = sumOf(win(a.impressions)), clk = sumOf(win(a.clicks));
    return { id: a.id, name: a.name || a.campaign || a.id, path: [a.campaign, a.adset].filter(Boolean).join(" › "), spend: sp1, impressions: imp, clicks: clk, ctr: ratio(clk * 100, imp), purchases: sumOf(win(a.purchases)), value: val, roas: ratio(val, sp1) };
  }).filter((r) => r.spend > 0 || r.impressions > 0).sort((a, b) => b.spend - a.spend);

  return { win, prevWin, hasPrev: !!sp.prev, labels, sales, rev, orders, revS, ordS, qtyS, itemRows, cust, firstS, freshS, matureFirst, matureConv30, rate30, byWeek, cohort, afterRows,
    ga, visitS, checkoutS, convRate, funnel, sesTotal, sourceRows, meta, spend, value, spendS, valueS, purS, clickS, impS, cpa, adRows };
}
type TopicView = ReturnType<typeof buildTopicView>;

function TopicPage({ tv, t, def }: { tv: TopicView; t: TopicSnapshot; def: TopicDef }) {
  const whyX = (x: { ok: boolean } | null) => (x == null ? "연결 안 됨" : x.ok ? undefined : "조회 실패");
  const roas = tv.spendS && tv.valueS ? ratio(tv.valueS.cur, tv.spendS.cur) : null;
  const ctr = tv.clickS && tv.impS ? ratio(tv.clickS.cur * 100, tv.impS.cur) : null;
  const fresh = tv.freshS?.cur ?? 0, first = tv.firstS?.cur ?? 0;
  const pctOf = (v: number | null) => (v == null ? "-" : `${v.toFixed(1)}%`);
  type FRow = TopicView["funnel"][number];
  const fCols: Col<FRow>[] = [
    { key: "idx", label: "단계", sort: (r) => -r.idx, cell: (r) => r.label },
    { key: "n", label: "수", num: true, bar: true, sort: (r) => r.n, cell: (r) => r.n.toLocaleString() },
    { key: "ofVisit", label: "방문 대비", num: true, sort: (r) => r.ofVisit ?? 101, cell: (r) => (r.idx === 0 ? "-" : pctOf(r.ofVisit)) },
    { key: "rate", label: "앞 단계 대비", num: true, w: 30, sort: (r) => r.rate ?? 101, cell: (r) => (r.from ? `${r.from}의 ${pctOf(r.rate)}` : "-") },
  ];
  type SRow = TopicView["sourceRows"][number];
  const sCols: Col<SRow>[] = [
    { key: "name", label: "소스/매체", w: 45, sort: (r) => r.name, cell: (r) => r.name },
    { key: "sessions", label: "방문", num: true, bar: true, sort: (r) => r.sessions, cell: (r) => r.sessions.toLocaleString() },
    { key: "share", label: "비중", num: true, sort: (r) => r.sessions, cell: (r) => (tv.sesTotal > 0 ? `${(Math.round((r.sessions / tv.sesTotal) * 1000) / 10).toFixed(1)}%` : "-") },
    { key: "delta", label: "직전 대비", num: true, sort: (r) => pctChange(r.sessions, r.prevSessions) ?? -Infinity, cell: (r) => <DeltaText d={pctDelta(r.sessions, r.prevSessions, "up")} /> },
  ];
  type ARow = TopicView["adRows"][number];
  const aCols: Col<ARow>[] = [
    { key: "name", label: "광고", w: 30, sort: (r) => r.name, cell: (r) => <span title={r.path || undefined}>{r.name}</span> },
    { key: "spend", label: "광고비(원)", num: true, bar: true, sort: (r) => r.spend, cell: (r) => won(r.spend) },
    { key: "imp", label: "노출", num: true, sort: (r) => r.impressions, cell: (r) => r.impressions.toLocaleString() },
    { key: "clicks", label: "클릭", num: true, sort: (r) => r.clicks, cell: (r) => r.clicks.toLocaleString() },
    { key: "ctr", label: "CTR", num: true, sort: (r) => r.ctr ?? 0, cell: (r) => pct2(r.ctr) ?? "-" },
    { key: "purchases", label: "구매", num: true, sort: (r) => r.purchases, cell: (r) => r.purchases.toLocaleString() },
    { key: "roas", label: "ROAS", num: true, sort: (r) => r.roas ?? 0, cell: (r) => fix2(r.roas) ?? "-" },
  ];
  type CRow = TopicView["cohort"][number];
  const cCols: Col<CRow>[] = [
    { key: "key", label: tv.byWeek ? "처음 산 주" : "처음 산 날", sort: (r) => r.key, cell: (r) => (tv.byWeek ? `${md(r.from)}~${md(r.to)}` : `${md(r.from)} (${weekday(r.from)})`) },
    { key: "first", label: "처음 산 고객", num: true, bar: true, sort: (r) => r.first, cell: (r) => r.first.toLocaleString() },
    { key: "conv30", label: `${TOPIC_REPEAT_DAYS}일 안 재구매`, num: true, sort: (r) => (r.mature ? r.conv30 : -1), cell: (r) => (r.mature ? r.conv30.toLocaleString() : "집계 중") },
    { key: "rate30", label: "재구매율", num: true, sort: (r) => (r.mature ? ratio(r.conv30, r.first) ?? -1 : -1), cell: (r) => (r.mature ? pct1(ratio(r.conv30 * 100, r.first)) ?? "-" : "집계 중") },
    { key: "conv", label: "지금까지 재구매", num: true, sort: (r) => r.conv, cell: (r) => r.conv.toLocaleString() },
    { key: "convRev", label: "재구매 매출(원)", num: true, sort: (r) => r.convRev, cell: (r) => won(r.convRev) },
  ];
  type NRow = TopicView["afterRows"][number];
  const nCols: Col<NRow>[] = [
    { key: "name", label: "주문 상품명", w: 45, sort: (r) => r.name, cell: (r) => r.name },
    { key: "customers", label: "고객 수", num: true, bar: true, sort: (r) => r.customers, cell: (r) => r.customers.toLocaleString() },
    { key: "rev", label: "매출(원)", num: true, sort: (r) => r.rev, cell: (r) => won(r.rev) },
  ];
  type IRow = TopicView["itemRows"][number];
  const iCols: Col<IRow>[] = [
    { key: "name", label: "주문 상품명 / 옵션", w: 45, sort: (r) => r.name, cell: (r) => r.name },
    { key: "channel", label: "채널", sort: (r) => r.channel, cell: (r) => r.channel },
    { key: "rev", label: "매출(원)", num: true, bar: true, sort: (r) => r.rev, cell: (r) => won(r.rev) },
    { key: "orders", label: "주문 건수", num: true, sort: (r) => r.orders, cell: (r) => r.orders.toLocaleString() },
  ];
  const noSales = "이 기간에 주문이 없습니다.", noGa = whyX(t.ga) === "연결 안 됨" ? "GA4가 연결되지 않았습니다." : "페이지 숫자가 없습니다.", noAds = whyX(t.meta) === "연결 안 됨" ? "메타 광고가 연결되지 않았습니다." : "이 기간에 광고 숫자가 없습니다.";
  const cohortRows = tv.cohort.filter((r) => r.first > 0);
  return (
    <>
      <Errors list={[failOf("매출", t.sales), failOf("고객", t.cust), failOf("GA4", t.ga), failOf("메타 광고", t.meta),
        t.ga?.ok && t.ga.truncated ? "GA4: 행이 많아 일부만 받았습니다." : "",
        t.meta?.ok && t.meta.campaignOnly ? "메타 광고: 광고 단위로 받지 못해 캠페인 단위로 보여 줍니다." : ""].filter(Boolean)} />
      <Score label="주문 건수" value={cnt(tv.ordS?.cur, "건")} delta={pctDelta(tv.ordS?.cur ?? null, tv.ordS?.prev ?? null, "up")} note={tv.sales ? `매출 ${moneyCompact(tv.revS?.cur ?? 0)}원` : "조회 실패"} spark={tv.sales ? tv.win(tv.orders) : undefined} />
      <Score label="처음 산 고객" value={cnt(tv.firstS?.cur, "명")} delta={pctDelta(tv.firstS?.cur ?? null, tv.firstS?.prev ?? null, "up")} note={tv.cust ? `신규 ${fresh.toLocaleString()}명` : "조회 실패"} spark={tv.cust ? tv.win(tv.cust.first) : undefined} />
      <Score label="페이지 전환율" value={pct2(tv.convRate?.cur)} delta={ppDelta(tv.convRate?.cur ?? null, tv.convRate?.prev ?? null, "up")} note={tv.ga ? `방문 ${(tv.visitS?.cur ?? 0).toLocaleString()}회` : whyX(t.ga)} spark={tv.ga ? tv.win(tv.ga.visits) : undefined} />
      <Score label="메타 광고비" value={wonS(tv.spendS?.cur)} delta={pctDelta(tv.spendS?.cur ?? null, tv.spendS?.prev ?? null, "none")} note={tv.meta ? `클릭 ${(tv.clickS?.cur ?? 0).toLocaleString()}회 · CTR ${pct2(ctr) ?? "-"}` : whyX(t.meta)} spark={tv.meta ? tv.win(tv.spend) : undefined} />
      <Score label="주문 1건당 광고비" value={wonS(tv.cpa?.cur == null ? null : Math.round(tv.cpa.cur))} delta={pctDelta(tv.cpa?.cur ?? null, tv.cpa?.prev ?? null, "down")} note={tv.meta ? `메타 집계 구매 ${(tv.purS?.cur ?? 0).toLocaleString()}건 · ROAS ${fix2(roas) ?? "-"}` : whyX(t.meta)} />
      <Score label={`${TOPIC_REPEAT_DAYS}일 안 재구매율`} value={pct1(tv.rate30)} note={tv.cust ? (tv.matureFirst > 0 ? `${TOPIC_REPEAT_DAYS}일 지난 ${tv.matureFirst.toLocaleString()}명 중 ${tv.matureConv30.toLocaleString()}명` : `${TOPIC_REPEAT_DAYS}일 지난 고객 없음`) : "조회 실패"} />
      <Card w={8} title="주문 추이" right={tv.sales ? <CompareLegend v={tv} /> : undefined}>
        {tv.sales ? <CompareLine v={tv} values={tv.orders} unit="건" /> : <div className="b2b-empty">{noSales}</div>}
      </Card>
      <Card w={4} title="신규·기존 고객">
        {first > 0 ? <DonutCard data={[["신규", fresh], ["기존", Math.max(0, first - fresh)]]} colors={[C_CUR, C_NAVER]} center={first.toLocaleString()} centerSub="명" fmt={(n) => `${n.toLocaleString()}명`} />
          : <div className="b2b-empty">이 기간에 처음 산 고객이 없습니다.</div>}
      </Card>
      <Card w={6} title={`${def.landing?.label ?? "페이지"} 단계별 전환`}><DataTable rows={tv.funnel} cols={fCols} rowKey={(r) => r.label} sortKey="idx" empty={noGa} /></Card>
      <Card w={6} title="유입 경로별 방문"><DataTable rows={tv.sourceRows} cols={sCols} rowKey={(r) => r.name} sortKey="sessions" empty={noGa} /></Card>
      <Card w={6} title="메타 광고비와 구매액" right={tv.meta ? <ChartLegend items={[["광고비", C_CUR], ["구매액", C_NAVER]]} /> : undefined}>
        {tv.meta ? <LineChart periods={tv.labels} fmtAxis={moneyCompact} fmtTip={won} unit="원" series={[{ key: "광고비", values: tv.win(tv.spend), color: C_CUR }, { key: "구매액", values: tv.win(tv.value), color: C_NAVER }]} />
          : <div className="b2b-empty">{noAds}</div>}
      </Card>
      <Card w={6} title="광고별"><DataTable rows={tv.adRows} cols={aCols} rowKey={(r) => r.id} sortKey="spend" empty={noAds} /></Card>
      <Card w={6} title={tv.byWeek ? "처음 산 주별 재구매" : "처음 산 날별 재구매"}>
        <DataTable rows={cohortRows} cols={cCols} rowKey={(r) => r.key} sortKey="key" empty="이 기간에 처음 산 고객이 없습니다."
          foot={["합계", first.toLocaleString(), tv.matureConv30.toLocaleString(), pct1(tv.rate30) ?? "-", cohortRows.reduce((a, r) => a + r.conv, 0).toLocaleString(), won(cohortRows.reduce((a, r) => a + r.convRev, 0))]} />
      </Card>
      <Card w={6} title="재구매한 상품 상위 15"><DataTable rows={tv.afterRows} cols={nCols} rowKey={(r) => r.name} sortKey="customers" empty="이 기간에 처음 산 고객의 재구매가 없습니다." /></Card>
      <Card w={6} title="페이지 방문 추이" right={tv.ga ? <CompareLegend v={tv} /> : undefined}>
        {tv.ga ? <CompareLine v={tv} values={tv.ga.visits} unit="회" /> : <div className="b2b-empty">{noGa}</div>}
      </Card>
      <Card w={6} title="상품·옵션별 주문">
        <DataTable rows={tv.itemRows} cols={iCols} rowKey={(r) => r.key} sortKey="rev" empty={noSales}
          foot={["합계", "", won(tv.revS?.cur ?? 0), (tv.ordS?.cur ?? 0).toLocaleString()]} />
      </Card>
    </>
  );
}

// ── 정기배송 분석 탭 — 정기배송 분석 화면(public/subscription-dashboard.html)을 주요 지표용 보기(?board=1)로 그대로 넣는다(2026-11-16 대표:
//   "정기배송 분석도 주요지표로 — 이미 있는 정기배송 필드와 별개로 넣고 비교, 전부 들어가 있어야, 가독성 주의").
//  계산을 다시 짜지 않는 까닭: 두 화면의 숫자가 한 글자도 다르지 않아야 비교가 된다. 그 화면이 스스로 문서 높이와 구역 위치를 알려 오므로
//  안쪽 스크롤 없이 한 장으로 이어지고, 위 띠의 구역 버튼이 그 자리로 옮겨 준다.
type SubNav = { id: string; label: string; top: number };
const SUB_SRC = `/subscription-dashboard.html?board=1&v=${process.env.NEXT_PUBLIC_BUILD || "dev"}`;
function useSubEmbed() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);
  const [nav, setNav] = useState<SubNav[]>([]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; height?: number; sections?: SubNav[] } | null;
      if (!d || d.type !== "sm-sub-board") return;
      if (typeof d.height === "number" && d.height > 0) setHeight(d.height);
      if (Array.isArray(d.sections)) setNav(d.sections);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  // 구역으로 옮기기 — 붙어 있는 위 띠(.bd-bar)에 가리지 않게 그 높이만큼 덜 내린다
  const go = (top: number) => {
    const f = frame.current; if (!f) return;
    const bar = document.querySelector(".bd-bar");
    const barH = bar && getComputedStyle(bar).position === "sticky" ? bar.getBoundingClientRect().height : 0;
    window.scrollTo({ top: f.getBoundingClientRect().top + window.scrollY + top - barH - 12, behavior: "smooth" });
  };
  return { frame, height, nav, go };
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
  const [topicState, setTopicState] = useState<{ key: string; data: TopicSnapshot | null; loading: boolean; error: string }>({ key: "", data: null, loading: false, error: "" });
  const tries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
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

  // 주제 묶음 — 그 주제 탭을 볼 때만. 본 묶음이 새로 계산되면(builtAt) 다시 받는다
  const topicId = page.startsWith("t:") ? page.slice(2) : "";
  const isSubx = page === "subx";   // 정기배송 분석 탭 — 주요 지표 묶음과 무관하게 그 화면이 스스로 불러온다
  const sub = useSubEmbed();
  const topicKey = topicId && snap ? `${topicId}|${snap.builtAt}` : "";
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
  // 주제 — 다른 주제의 묶음은 보여 주지 않는다
  const curTopic = topicId ? TOPICS.find((t) => t.id === topicId) ?? null : null;
  const tData = topicId && topicState.key === topicKey ? topicState.data : null;
  const tError = topicId && topicState.key === topicKey ? topicState.error : "";
  const tSpan = tData && range ? spanOf(tData.days, range.from, range.to) : null;
  const tView = tData && tSpan ? buildTopicView(tData, tSpan, filters.salesCh) : null;
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
            {TOPICS.map((t) => <button key={t.id} type="button" className={`sm-tab ${page === `t:${t.id}` ? "is-active" : ""}`} onClick={() => setPage(`t:${t.id}`)}>{t.name}</button>)}
          </div>
          <div className="bd-bar-right">
            {!isSubx && snap && <span className="bd-state">{refreshing ? "새 숫자 계산 중..." : `${builtAt} 계산`}</span>}
            {!isSubx && <button type="button" className="b2b-btn-secondary" onClick={rebuild} disabled={busy || loading}>{busy ? "계산 중..." : "다시 계산"}</button>}
          </div>
        </div>
        {isSubx && (
          <div className="bd-controls">
            <div className="sm-tabs bd-secnav" role="group" aria-label="구역으로 이동">
              {sub.nav.map((s) => <button key={s.id} type="button" className="sm-tab" onClick={() => sub.go(s.top)}>{s.label}</button>)}
            </div>
            <span className="bd-basis">카페24 정기배송 신청 전체 · 매일 23:59 수집 · 정기배송 분석 화면과 같은 계산 · 회원 수는 사람 기준</span>
          </div>
        )}
        {!isSubx && snap && range && (
          <div className="bd-controls">
            <DateControl range={range} base={snap.base} min={snap.days[0]} onChange={setRange} />
            <FilterControl label="판매 채널" options={salesOptions} value={filters.salesCh} onChange={(x) => setFilters((f) => ({ ...f, salesCh: x }))} />
            {!topicId && <FilterControl label="광고 매체" options={mediaOptions} value={filters.media} onChange={(x) => setFilters((f) => ({ ...f, media: x }))} />}
            {!topicId && <FilterControl label="유입 채널" options={gaOptions} value={filters.gaCh} onChange={(x) => setFilters((f) => ({ ...f, gaCh: x }))} />}
            {topicId
              ? <span className="bd-basis">기준일 {snap.base} ({weekday(snap.base)}) · {curTopic ? `${curTopic.basis} · ` : ""}고객은 처음 산 날 기준 · 방문·스크롤은 GA4 세션, 주문서 진입은 GA4 상품 수량, 구매는 주문 원장</span>
              : <span className="bd-basis">기준일 {snap.base} ({weekday(snap.base)}) · {span?.prev ? `직전 ${n}일과 비교` : "직전 기간이 조회 범위 밖이라 비교 없음"} · 매출은 주문일 기준 도매 포함 · 광고비는 VAT 제외</span>}
          </div>
        )}
      </header>
      <main className="bd-canvas">
        {!isSubx && error && <div className="b2b-error bd-c12">{error}</div>}
        {isSubx ? <iframe ref={sub.frame} src={SUB_SRC} title="정기배송 분석" className="bd-embed bd-c12" style={sub.height ? { height: sub.height } : undefined} />
          : loading && !snap ? <div className="b2b-loading bd-c12">불러오는 중...</div>
          : !snap ? (refreshing ? <div className="b2b-loading bd-c12">처음 계산하는 중...</div> : null)
          : topicId ? (
            !curTopic ? <div className="b2b-empty bd-c12">없는 주제입니다.</div>
              : tError ? <div className="b2b-error bd-c12">{tError}</div>
              : !tData ? <div className="b2b-loading bd-c12">주제 숫자를 계산하는 중...</div>
              : !tView ? <div className="b2b-empty bd-c12">고른 기간에 숫자가 없습니다.</div>
              : <TopicPage tv={tView} t={tData} def={curTopic} />
          )
          : !view ? <div className="b2b-empty bd-c12">고른 기간에 숫자가 없습니다.</div>
          : page === "summary" ? <SummaryPage v={view} s={snap} />
          : page === "sales" ? <SalesPage v={view} s={snap} detail={shownDetail} />
          : page === "ads" ? <AdsPage v={view} s={snap} />
          : <SubPage v={view} s={snap} detail={shownDetail} />}
      </main>
    </div>
  );
}
