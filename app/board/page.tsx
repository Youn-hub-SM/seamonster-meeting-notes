"use client";

// 주요 지표 — 매출·주문 / 광고·유입 / 정기배송·고객을 한 화면에(메뉴 없는 독립 화면, 2026-11-15).
//  서버가 저장해 둔 하루치 묶음(/api/board, app/lib/board.ts)을 받아, 최근 7일·28일 값과 직전 같은 기간 대비를 여기서 계산한다.
//  계산은 board-types.ts 한 곳 — 비율(객단가·ROAS·전환율)은 기간 합계끼리 나눈다.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { StackedBar, ComboBarLine, TrendChart, BarList, ChartLegend, PIE_COLORS, CHART_LINE, moneyCompact } from "@/app/components/charts";
import { won } from "@/app/lib/format";
import { KPI_TONE_COLOR, type KpiTone } from "@/app/lib/report-kpi";
import { BOARD_WINDOWS, windowSum, tailOf, pctChange, ratio, lastKnown, type BoardSnapshot, type BoardWindow } from "@/app/lib/board-types";

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const weekday = (ymd: string) => WD[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
const POLL_MS = 40_000, POLL_MAX = 4, HOURLY_MS = 60 * 60_000;

// ── 증감 배지 ── good = 어느 쪽이 좋은가(없음 = 판정하지 않는 숫자: 광고비 등)
type Good = "up" | "down" | "none";
type Delta = { text: string; tone: KpiTone } | null;
const toneOf = (diff: number, flat: boolean, good: Good): KpiTone => (good === "none" || flat ? "neutral" : (diff > 0) === (good === "up") ? "success" : "danger");
const sign = (n: number) => (n > 0 ? "+" : "");
function pctDelta(cur: number | null, prev: number | null, good: Good): Delta {
  if (cur == null || prev == null) return null;
  const p = pctChange(cur, prev);
  if (p == null) return null;
  const r = Math.round(p * 10) / 10;
  return { text: `${sign(r)}${r}%`, tone: toneOf(r, Math.abs(r) < 1, good) };
}
function ppDelta(cur: number | null, prev: number | null, good: Good): Delta { // 비율(%)끼리의 차 — %p
  if (cur == null || prev == null) return null;
  const r = Math.round((cur - prev) * 10) / 10;
  return { text: `${sign(r)}${r}%p`, tone: toneOf(r, r === 0, good) };
}
function absDelta(cur: number | null, prev: number | null, unit: string, good: Good): Delta {
  if (cur == null || prev == null) return null;
  const r = cur - prev;
  return { text: `${sign(r)}${r.toLocaleString()}${unit}`, tone: toneOf(r, r === 0, good) };
}

function Tile({ label, value, delta, note }: { label: string; value: string | null; delta?: Delta; note?: string }) {
  return (
    <div className="b2b-stat-card">
      <div className="b2b-stat-card-label">{label}</div>
      <div className={`b2b-stat-card-value b2b-money${value == null ? " is-light" : ""}`}>{value ?? "-"}</div>
      {(delta || note) && (
        <div className="bd-delta">
          {delta && <span className="b2b-status-pill" style={{ background: KPI_TONE_COLOR[delta.tone].bg, color: KPI_TONE_COLOR[delta.tone].fg }}>{delta.text}</span>}
          {note && <span>{note}</span>}
        </div>
      )}
    </div>
  );
}
function Section({ title, basis, children }: { title: string; basis?: string; children: React.ReactNode }) {
  return (
    <section className="b2b-card bd-sec">
      <div className="b2b-card-head"><span className="b2b-card-title">{title}</span></div>
      {basis && <div className="bd-basis">{basis}</div>}
      {children}
    </section>
  );
}
const wonS = (n: number | null) => (n == null ? null : `${won(n)}원`);
const cnt = (n: number | null, unit: string) => (n == null ? null : `${Math.round(n).toLocaleString()}${unit}`);
const prevNote = (text: string | null) => (text ? `직전 ${text}` : undefined);

// ── 매출·주문 ──
function SalesSection({ s, n }: { s: BoardSnapshot; n: BoardWindow }) {
  const sales = s.sales;
  if (!sales.ok) return <Section title="매출·주문"><div className="b2b-error" style={{ marginTop: 16 }}>매출을 불러오지 못했습니다. {sales.error}</div></Section>;
  const rev = windowSum(sales.rev, n), ord = windowSum(sales.orders, n);
  const aov = ratio(rev.cur, ord.cur), aovPrev = ratio(rev.prev, ord.prev);
  const labels = tailOf(s.days, n).map(md);
  // 채널 — 기간 매출이 큰 5곳 + 나머지는 '기타'
  const ranked = sales.channels.map((c) => ({ name: c.name, values: tailOf(c.rev, n), total: windowSum(c.rev, n).cur })).filter((c) => c.total !== 0).sort((a, b) => b.total - a.total);
  const top = ranked.slice(0, 5), rest = ranked.slice(5);
  const series = top.map((c) => ({ key: c.name, values: c.values }));
  if (rest.length) series.push({ key: "기타", values: labels.map((_, i) => rest.reduce((a, c) => a + (c.values[i] || 0), 0)) });
  const m = sales.mtd;
  return (
    <Section title="매출·주문" basis="주문일 기준 · 도매 포함">
      <div className="bd-kpi">
        <Tile label="매출" value={wonS(rev.cur)} delta={pctDelta(rev.cur, rev.prev, "up")} note={prevNote(`${moneyCompact(rev.prev)}원`)} />
        <Tile label="주문 건수" value={cnt(ord.cur, "건")} delta={pctDelta(ord.cur, ord.prev, "up")} note={prevNote(cnt(ord.prev, "건"))} />
        <Tile label="객단가" value={wonS(aov)} delta={pctDelta(aov, aovPrev, "up")} note={prevNote(wonS(aovPrev))} />
        <Tile label={`${Number(m.to.slice(5, 7))}월 누적 매출`} value={wonS(m.rev)} delta={pctDelta(m.rev, m.prevRev, "up")} note={`전월 같은 기간 ${moneyCompact(m.prevRev)}원`} />
      </div>
      <div className="bd-charts">
        <div>
          <div className="b2b-card-head bd-chart-head"><span className="b2b-card-title">일별 매출</span><ChartLegend items={series.map((x, i) => [x.key, PIE_COLORS[i % PIE_COLORS.length]])} /></div>
          <StackedBar periods={labels} series={series} fmtAxis={moneyCompact} unit="원" />
        </div>
        <BarList title="채널별 매출" data={ranked.map((c) => [c.name, c.total])} fmt={(v) => `${won(v)}원`}
          sub={(_, v) => (rev.cur > 0 ? `${Math.round((v / rev.cur) * 1000) / 10}%` : null)} empty="매출이 없습니다." />
      </div>
    </Section>
  );
}

// ── 광고·유입 ──
function AdsSection({ s, n }: { s: BoardSnapshot; n: BoardWindow }) {
  const meta = s.meta?.ok ? s.meta : null, naver = s.naver?.ok ? s.naver : null, ga = s.ga?.ok ? s.ga : null;
  const why = (x: BoardSnapshot["meta"] | BoardSnapshot["naver"] | BoardSnapshot["ga"]) => (x == null ? "연결 안 됨" : x.ok ? undefined : "조회 실패");
  const errors = [s.meta && !s.meta.ok ? `메타 광고: ${s.meta.error}` : "", s.naver && !s.naver.ok ? `네이버 광고: ${s.naver.error}` : "", s.ga && !s.ga.ok ? `GA4: ${s.ga.error}` : ""].filter(Boolean);
  const labels = tailOf(s.days, n).map(md);

  const mSpend = meta ? windowSum(meta.spend, n) : null, mValue = meta ? windowSum(meta.value, n) : null;
  const nCostRaw = naver ? windowSum(naver.cost, n) : null;
  const nCost = nCostRaw ? { cur: nCostRaw.cur / 1.1, prev: nCostRaw.prev / 1.1 } : null; // VAT 제외
  const nSales = naver ? windowSum(naver.purchaseSales, n) : null;
  const spend = mSpend || nCost ? { cur: (mSpend?.cur || 0) + (nCost?.cur || 0), prev: (mSpend?.prev || 0) + (nCost?.prev || 0) } : null;
  const mRoas = mSpend && mValue ? { cur: ratio(mValue.cur, mSpend.cur), prev: ratio(mValue.prev, mSpend.prev) } : null;
  const nRoas = nCost && nSales ? { cur: ratio(nSales.cur, nCost.cur), prev: ratio(nSales.prev, nCost.prev) } : null;
  const ses = ga ? windowSum(ga.sessions, n) : null, pur = ga ? windowSum(ga.purchases, n) : null;
  const rate = ses && pur ? { cur: ratio(pur.cur * 100, ses.cur), prev: ratio(pur.prev * 100, ses.prev) } : null;
  const roasS = (v: number | null | undefined) => (v == null ? null : v.toFixed(2));
  const rateS = (v: number | null | undefined) => (v == null ? null : `${v.toFixed(2)}%`);

  const bars = [
    ...(meta ? [{ key: "메타", values: tailOf(meta.spend, n) }] : []),
    ...(naver ? [{ key: "네이버", values: tailOf(naver.cost, n).map((v) => Math.round(v / 1.1)) }] : []),
  ];
  const barColors = [PIE_COLORS[1], PIE_COLORS[2]].slice(meta ? 0 : 1);
  const chans = ga ? ga.channels[n] : [];
  return (
    <Section title="광고·유입" basis="광고비는 VAT 제외 · 방문과 구매 전환율은 GA4 기준">
      {errors.length > 0 && <div className="b2b-error" style={{ marginTop: 16 }}>{errors.length === 1 ? errors[0] : <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>}</div>}
      <div className="bd-kpi">
        <Tile label="광고비" value={wonS(spend ? spend.cur : null)} delta={spend ? pctDelta(spend.cur, spend.prev, "none") : null} note={spend ? prevNote(`${moneyCompact(Math.round(spend.prev))}원`) : (why(s.meta) ?? why(s.naver))} />
        <Tile label="메타 ROAS" value={roasS(mRoas?.cur)} delta={mRoas ? pctDelta(mRoas.cur, mRoas.prev, "up") : null} note={meta ? prevNote(roasS(mRoas?.prev)) : why(s.meta)} />
        <Tile label="네이버 ROAS" value={roasS(nRoas?.cur)} delta={nRoas && naver?.purchaseOk ? pctDelta(nRoas.cur, nRoas.prev, "up") : null}
          note={naver ? (naver.purchaseOk ? prevNote(roasS(nRoas?.prev)) : "구매 전환 미확정") : why(s.naver)} />
        <Tile label="방문" value={cnt(ses ? ses.cur : null, "회")} delta={ses ? pctDelta(ses.cur, ses.prev, "up") : null} note={ga ? prevNote(cnt(ses!.prev, "회")) : why(s.ga)} />
        <Tile label="구매 전환율" value={rateS(rate?.cur)} delta={rate ? ppDelta(rate.cur, rate.prev, "up") : null} note={ga ? prevNote(rateS(rate?.prev)) : why(s.ga)} />
      </div>
      <div className="bd-charts">
        <div>
          <div className="b2b-card-head bd-chart-head">
            <span className="b2b-card-title">{ga ? "일별 광고비와 방문" : "일별 광고비"}</span>
            {bars.length > 0 && <ChartLegend items={[...bars.map((b, i): [string, string] => [b.key, barColors[i]]), ...(ga ? [["방문", CHART_LINE] as [string, string]] : [])]} />}
          </div>
          {bars.length === 0 ? <div className="b2b-empty">광고 숫자가 없습니다.</div>
            : ga ? <ComboBarLine periods={labels} barSeries={bars} barColors={barColors} lineValues={tailOf(ga.sessions, n)} lineLabel="방문" lineFmt={(v) => v.toLocaleString()} lineUnit="회" barFmt={moneyCompact} barUnit="원" />
            : <StackedBar periods={labels} series={bars} colors={barColors} fmtAxis={moneyCompact} unit="원" />}
        </div>
        <BarList title="유입 채널별 방문" data={chans.map((c) => [c.name, c.sessions])} fmt={(v) => `${v.toLocaleString()}회`}
          sub={(name) => { const c = chans.find((x) => x.name === name); return c && c.sessions > 0 ? `구매 ${c.purchases.toLocaleString()}건 · 전환율 ${((c.purchases / c.sessions) * 100).toFixed(2)}%` : null; }}
          empty="방문 숫자가 없습니다." />
      </div>
    </Section>
  );
}

// ── 정기배송·고객 ──
function CustomerSection({ s, n }: { s: BoardSnapshot; n: BoardWindow }) {
  const sub = s.sub.ok ? s.sub : null, voc = s.voc.ok ? s.voc : null, sales = s.sales.ok ? s.sales : null;
  const errors = [!s.sub.ok ? `정기배송: ${s.sub.error}` : "", !s.voc.ok ? `VOC: ${s.voc.error}` : ""].filter(Boolean);
  const labels = tailOf(s.days, n).map(md);
  const active = sub ? lastKnown(sub.active) : null, activePrev = sub ? lastKnown(sub.active, n) : null;
  const pause = sub ? lastKnown(sub.pause) : null;
  const nw = sub ? windowSum(sub.newCnt, n) : null, cc = sub ? windowSum(sub.cancelCnt, n) : null;
  const sr = sub ? windowSum(sub.subRev, n) : null, rev = sales ? windowSum(sales.rev, n) : null;
  const share = sr && rev ? ratio(sr.cur * 100, rev.cur) : null;
  const cust = sales ? sales.cust[n] : null;
  const rep = cust ? { cur: ratio(cust.cur.repeatCust * 100, cust.cur.total), prev: ratio(cust.prev.repeatCust * 100, cust.prev.total) } : null;
  const vc = voc ? windowSum(voc.counts, n) : null;
  const pctS = (v: number | null | undefined) => (v == null ? null : `${v.toFixed(1)}%`);
  const activeDays = sub ? tailOf(s.days, n).map((d, i) => ({ label: md(d), value: tailOf(sub.active, n)[i] })).filter((x): x is { label: string; value: number } => x.value != null) : [];
  return (
    <Section title="정기배송·고객" basis={`신규 신청과 해지는 신청 단위 · 재구매 고객 = 기간 전에 주문한 적이 있는 고객${sub && sub.asOf !== s.base ? ` · 정기배송 회원 수는 ${sub.asOf.slice(5)} 기준` : ""}`}>
      {errors.length > 0 && <div className="b2b-error" style={{ marginTop: 16 }}>{errors.length === 1 ? errors[0] : <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>}</div>}
      <div className="bd-kpi">
        <Tile label="정기배송 이용중" value={cnt(active, "명")} delta={absDelta(active, activePrev, "명", "up")} note={pause != null ? `일시정지 ${pause.toLocaleString()}명` : undefined} />
        <Tile label="신규 신청" value={cnt(nw ? nw.cur : null, "건")} delta={nw ? pctDelta(nw.cur, nw.prev, "up") : null} note={nw ? prevNote(cnt(nw.prev, "건")) : undefined} />
        <Tile label="해지" value={cnt(cc ? cc.cur : null, "건")} delta={cc ? pctDelta(cc.cur, cc.prev, "down") : null} note={cc ? prevNote(cnt(cc.prev, "건")) : undefined} />
        <Tile label="정기배송 매출" value={wonS(sr ? sr.cur : null)} delta={sr ? pctDelta(sr.cur, sr.prev, "up") : null} note={share != null ? `전체의 ${share.toFixed(1)}%` : undefined} />
        <Tile label="재구매 고객 비율" value={pctS(rep?.cur)} delta={rep ? ppDelta(rep.cur, rep.prev, "up") : null} note={cust ? `신규 ${cust.cur.newCust.toLocaleString()}명 · 재구매 ${cust.cur.repeatCust.toLocaleString()}명` : undefined} />
        <Tile label="VOC 접수" value={cnt(vc ? vc.cur : null, "건")} delta={vc ? pctDelta(vc.cur, vc.prev, "down") : null} note={vc ? prevNote(cnt(vc.prev, "건")) : undefined} />
      </div>
      {sub && (
        <div className="bd-charts is-half">
          <div>
            <div className="b2b-card-head bd-chart-head"><span className="b2b-card-title">정기배송 신규 신청과 해지</span><ChartLegend items={[["신규 신청", "var(--sm-success)"], ["해지", "var(--sm-danger)"]]} /></div>
            <StackedBar periods={labels} series={[{ key: "신규 신청", values: tailOf(sub.newCnt, n) }, { key: "해지", values: tailOf(sub.cancelCnt, n) }]} colors={["var(--sm-success)", "var(--sm-danger)"]} />
          </div>
          <div>
            <div className="b2b-card-head bd-chart-head"><span className="b2b-card-title">정기배송 이용중 회원</span></div>
            <TrendChart data={activeDays} fmtAxis={(v) => v.toLocaleString()} />
          </div>
        </div>
      )}
    </Section>
  );
}

export default function BoardPage() {
  const [snap, setSnap] = useState<BoardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false); // 서버가 응답 뒤에 새 묶음을 계산하는 중
  const [busy, setBusy] = useState(false);             // [다시 계산] 진행 중
  const [error, setError] = useState("");
  const [win, setWin] = useState<BoardWindow>(7);
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

  async function rebuild() {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/board", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rebuild" }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; snapshot?: BoardSnapshot };
      if (!r.ok || !j.ok || !j.snapshot) throw new Error(j.error || "지표를 다시 계산하지 못했습니다");
      setSnap(j.snapshot); setRefreshing(false); tries.current = 0;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    } catch (e) { setError(e instanceof Error ? e.message : "지표를 다시 계산하지 못했습니다"); }
    finally { setBusy(false); }
  }

  const builtAt = snap ? new Date(Date.parse(snap.builtAt) + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "";
  const range = snap ? `${tailOf(snap.days, win)[0].slice(5)} ~ ${snap.base.slice(5)}` : "";
  return (
    <div className="b2b-container">
      <div className="bd-brand">
        <Link href="/" aria-label="업무도우미 홈">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="씨몬스터" />
        </Link>
      </div>
      <div className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">주요 지표</h1>
          {snap && <p className="b2b-page-subtitle">기준일 {snap.base} ({weekday(snap.base)}) · {range} · 직전 {win}일과 비교</p>}
        </div>
        <div className="b2b-page-actions bd-actions">
          {snap && <span className="bd-state">{refreshing ? "새 숫자 계산 중..." : `${builtAt} 계산`}</span>}
          <div className="sm-tabs">
            {BOARD_WINDOWS.map((w) => (
              <button key={w} type="button" className={`sm-tab ${win === w ? "is-active" : ""}`} onClick={() => setWin(w)}>최근 {w}일</button>
            ))}
          </div>
          <button type="button" className="b2b-btn-secondary" onClick={rebuild} disabled={busy || loading}>{busy ? "계산 중..." : "다시 계산"}</button>
        </div>
      </div>
      {error && <div className="b2b-error" style={{ marginBottom: 16 }}>{error}</div>}
      {loading && !snap ? <div className="b2b-loading">불러오는 중...</div>
        : !snap ? (refreshing ? <div className="b2b-loading">처음 계산하는 중...</div> : null)
        : (
          <>
            <SalesSection s={snap} n={win} />
            <AdsSection s={snap} n={win} />
            <CustomerSection s={snap} n={win} />
          </>
        )}
    </div>
  );
}
