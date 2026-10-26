// 종합 리포트 KPI 띠(2026-10-13 가시성 개선, docs/report-visibility-plan.md §4-2) — 저장된 facts 의 기간별 칸 이름 차이를
//  한 곳에서 흡수해 화면(/briefing)이 그대로 그리는 타일 4개(소매 매출·광고비·재고·기간 고유) + 매출 추이(주간 요일별·월간 주차별)
//  + 재고 주의 품목 행(화면이 표를 facts 로 그린다) + 전주보다 늘어난 VOC 유형. 순수 함수(DB·AI 없음), GET /api/analyst 가 report.kpi 로 넘긴다.
//  폴백: 칸이 없으면 그 타일은 null(0 으로 그리지 않음), 타일이 하나도 없으면 null(띠 생략). 옛 리포트(facts 없음)는 null.
import { won, moneyCompact } from "./format";
import type { InvWatchRow } from "./report-sections";
// 팀즈 카드 핵심 줄 타입 — 옛 업무 브리핑 엔진(briefing.ts, 2026-10-20 삭제)에서 옮겨 옴. 종합 리포트 화면·메일이 쓴다.
export type TeamsColor = "Good" | "Attention" | "Warning" | "Default";
export type LeadLine = { text: string; color?: TeamsColor };

export type KpiPeriod = "daily" | "weekly" | "monthly";
export type KpiTone = "success" | "danger" | "warning" | "info" | "neutral";
export type KpiPill = { text: string; tone: KpiTone };
export type KpiTile = {
  label: string;
  value: string;                                    // 표시 글자(금액은 won()+'원')
  amount?: number;                                  // 금액 타일의 원 값(팀즈 제목 헤드라인 축약용) — 글자 타일(재고·고객의 소리)은 없음
  valueTone?: "danger" | "warning" | "light";       // 재고: 재고 없음>0 danger · 부족만 warning / 매출 없음 light
  delta?: { pill: KpiPill; basis: string; pct: number } | null; // 증감 pill + 비교 기준(주 비교 하나만) + 원 % 값
  hint: string;                                     // 집계 기준 한 줄(빈 문자열 = 없음)
  hintPills?: KpiPill[];                            // 힌트 앞 배지(주간 '미답변 N')
};
export type SalesTrendChart = { title: string; data: { label: string; value: number }[] };
export type ReportKpi = {
  sales: KpiTile | null; ads: KpiTile | null; inventory: KpiTile | null; extra: KpiTile | null;
  charts: { sales: SalesTrendChart | null };
  watch: InvWatchRow[] | null;                                           // 재고 주의 품목(지금 기준) — 없으면 마크다운 표 파싱
  rising: { category: string; count: number; prev: number }[] | null;   // 주간: 전주보다 늘어난 VOC 유형
};
export type KpiParts = { sales?: unknown; ads?: unknown; inventory?: unknown; voice?: unknown };

// 배지 색 — 시맨틱 3종 세트(design-system §3). 중립 = bg-subtle/text-mid(대표 결정 2: |증감|<3% 중립).
export const KPI_TONE_COLOR: Record<KpiTone, { bg: string; fg: string }> = {
  success: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  danger: { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
  warning: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  info: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },
  neutral: { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
};
export const NEUTRAL_PCT = 3;
/** 증감 % 의 톤 — ≥+3 success · ≤−3 danger · 그 사이 중립. 매출 표의 증감 열(화면)도 같은 규칙. */
export const pctTone = (v: number): KpiTone => (Math.abs(v) < NEUTRAL_PCT ? "neutral" : v > 0 ? "success" : "danger");
export const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v}%`;

// ── facts 읽기(모양을 믿지 않는다 — 옛 리포트·실패 리포트는 칸이 비어 있다) ──
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const numOf = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const x2 = (n: number | null) => (n == null ? "-" : n.toFixed(2));
const pill = (pct: number | null): KpiPill | null => (pct == null ? null : { text: fmtPct(pct), tone: pctTone(pct) });
const neutralPill = (pct: number | null): KpiPill | null => (pct == null ? null : { text: fmtPct(pct), tone: "neutral" });
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const join = (xs: (string | null | undefined)[]) => xs.filter((s): s is string => !!s).join(" · ");
const wonS = (n: number) => `${won(n)}원`;

const SALES_BASIS: Record<KpiPeriod, string> = { daily: "4주 같은 요일 평균 대비", weekly: "전주 대비", monthly: "전월 대비(하루 평균)" };

function salesTile(period: KpiPeriod, sales: Record<string, unknown> | null): KpiTile | null {
  if (!sales) return null;
  if (sales.ready === false) return { label: "소매 매출", value: "매출 없음", valueTone: "light", hint: "" };
  const rt = obj(sales.retail_total);
  const rev = numOf(rt?.rev);
  if (!rt || rev == null) return null;
  const tentative = period !== "daily" && sales.complete === false ? "잠정" : null; // 마지막 날 매출 미반영
  let pct: number | null, hint: string;
  if (period === "daily") {
    pct = numOf(rt.vs_base_pct);
    const prev = numOf(rt.prev_day_rev), orders = numOf(rt.orders);
    hint = join([prev == null ? null : `전일 ${wonS(prev)}`, orders == null ? null : `주문 ${orders.toLocaleString("ko-KR")}건`]);
  } else if (period === "weekly") {
    pct = numOf(rt.vs_prev_pct);
    const base = numOf(rt.vs_base_pct), pd = numOf(rt.per_day_rev);
    hint = join([tentative, base == null ? null : `4주 평균 대비 ${fmtPct(base)}`, pd == null ? null : `하루 평균 ${wonS(pd)}`]);
  } else {
    pct = numOf(rt.per_day_vs_prev_pct);
    const ly = numOf(rt.vs_last_year_pct), pd = numOf(rt.per_day_rev);
    hint = join([tentative, ly == null ? null : `작년 같은 달 대비 ${fmtPct(ly)}`, pd == null ? null : `하루 평균 ${wonS(pd)}`]);
  }
  const p = pill(pct);
  return { label: "소매 매출", value: wonS(rev), amount: rev, delta: p && pct != null ? { pill: p, basis: SALES_BASIS[period], pct } : null, hint };
}

// 광고비(VAT 제외) — 판정 색 없음(2026-09-30 대표 원칙). 힌트 = 매체별 ROAS(네이버 구매 미확정이면 '미확정', 조회 실패면 '조회 실패').
function adsTile(ads: Record<string, unknown> | null): KpiTile | null {
  const total = numOf(ads?.spend_ex_vat_total);
  if (!ads || total == null) return null;
  const meta = obj(ads.meta), naver = obj(ads.naver);
  const roas = (m: Record<string, unknown> | null, name: string, unconfirmed: boolean) =>
    !m ? null : m.ok === false ? `${name} 조회 실패` : unconfirmed ? `${name} 미확정` : `${name} ${x2(numOf(m.roas))}`;
  const parts = join([roas(meta, "메타", false), roas(naver, "네이버", !!naver && naver.ok !== false && naver.purchases == null)]);
  return { label: "광고비(VAT 제외)", value: wonS(total), amount: total, hint: parts ? `ROAS ${parts}` : "" };
}

// 재고(지금 기준) — 재고 없음>0 danger, 부족만 >0 warning. now 가 없으면(집계 실패·끝난 지 7일 넘은 기간 재생성) 타일 생략.
function inventoryTile(inv: Record<string, unknown> | null): KpiTile | null {
  const now = inv && inv.ok !== false ? obj(inv.now) : null;
  const soldout = numOf(now?.soldout), short = numOf(now?.short);
  if (!now || soldout == null || short == null) return null;
  const urgent = obj(arr(now.urgent_top)[0]);
  const uName = typeof urgent?.name === "string" ? urgent.name : null, uDays = numOf(urgent?.days);
  const inbound = numOf(now.inbound_total), overdue = numOf(now.inbound_overdue);
  const hint = join([
    uName ? `${uName}${uDays == null ? "" : ` ${uDays}일`}` : null,
    inbound == null ? null : `오는 중 ${inbound.toLocaleString("ko-KR")}${overdue ? `(마감 지남 ${overdue.toLocaleString("ko-KR")})` : ""}`,
  ]);
  return { label: "재고", value: `재고 없음 ${soldout} · 부족 ${short}`, valueTone: soldout > 0 ? "danger" : short > 0 ? "warning" : undefined, hint };
}

// 기간 고유 타일(대표 결정 1) — 일일 '월 누적' / 주간 '고객의 소리' / 월간 '월말 재고 금액'
function extraTile(period: KpiPeriod, p: { sales: Record<string, unknown> | null; inventory: Record<string, unknown> | null; voice: Record<string, unknown> | null }): KpiTile | null {
  if (period === "daily") {
    const mtd = obj(p.sales?.mtd);
    const rev = numOf(mtd?.rev);
    if (!mtd || rev == null) return null;
    const mp = numOf(mtd.vs_prev_pct), pl = pill(mp);
    return { label: "월 누적", value: wonS(rev), amount: rev, delta: pl && mp != null ? { pill: pl, basis: "전월 같은 기간 대비", pct: mp } : null, hint: typeof mtd.note === "string" && mtd.note ? mtd.note : "도매 포함" };
  }
  if (period === "weekly") {
    const naver = obj(p.voice?.naver), voc = obj(p.voice?.voc);
    if (!naver && !voc) return null;
    const nOk = !!naver && naver.ok !== false, vOk = !!voc && voc.ok !== false;
    const nTotal = numOf(naver?.total), vTotal = numOf(voc?.total);
    if ((!nOk || nTotal == null) && (!vOk || vTotal == null)) return null;
    const unanswered = nOk ? numOf(naver!.unanswered) : null;
    const rising = obj(arr(voc?.rising)[0]);
    return {
      label: "고객의 소리",
      value: `문의 ${nOk && nTotal != null ? nTotal : "-"} · VOC ${vOk && vTotal != null ? vTotal : "-"}`,
      hintPills: unanswered == null ? [] : [{ text: `미답변 ${unanswered}`, tone: unanswered > 0 ? "warning" : "neutral" }],
      hint: typeof rising?.category === "string" ? `늘어난 유형 ${rising.category}` : "",
    };
  }
  const value = obj(p.inventory?.value);
  const end = numOf(value?.end), prevEnd = numOf(value?.prev_end);
  if (!value || end == null) return null;
  const pur = obj(p.inventory?.purchase);
  const amount = numOf(pur?.amount);
  const pct = prevEnd != null && prevEnd > 0 ? Math.round(((end - prevEnd) / prevEnd) * 1000) / 10 : null;
  const pl = neutralPill(pct); // 재고 금액 증감은 좋다/나쁘다가 아니다 — 중립색
  return { label: "월말 재고 금액", value: wonS(end), amount: end, delta: pl && pct != null ? { pill: pl, basis: "전월말 대비", pct } : null, hint: amount == null ? "" : `매입 ${wonS(amount)}${typeof pur?.basis === "string" ? `(${pur.basis})` : ""}` };
}

// 매출 추이(대표 결정 9) — 주간 요일별 7막대 / 월간 주차별, facts.sales.trend 에 이미 있다(AI 비용 0). 일일은 시계열이 없다.
function salesChart(period: KpiPeriod, sales: Record<string, unknown> | null): SalesTrendChart | null {
  if (!sales || sales.ready === false) return null;
  if (period === "weekly") {
    const rows = arr(sales.trend).map(obj).filter((r): r is Record<string, unknown> => !!r && typeof r.d === "string" && numOf(r.rev) != null);
    if (!rows.length) return null;
    return { title: "요일별 소매 매출", data: rows.map((r) => ({ label: `${md(String(r.d))}(${typeof r.weekday === "string" ? r.weekday : ""})`, value: numOf(r.rev) as number })) };
  }
  if (period === "monthly") {
    const rows = arr(obj(sales.trend)?.by_week).map(obj).filter((r): r is Record<string, unknown> => !!r && typeof r.range === "string" && numOf(r.rev) != null);
    if (!rows.length) return null;
    return { title: "주차별 소매 매출", data: rows.map((r) => ({ label: String(r.range), value: numOf(r.rev) as number })) };
  }
  return null;
}

const watchRows = (inv: Record<string, unknown> | null): InvWatchRow[] | null => {
  const now = inv && inv.ok !== false ? obj(inv.now) : null;
  if (!now || !Array.isArray(now.watch)) return null;
  const rows = now.watch.map(obj).filter((r): r is Record<string, unknown> => !!r && typeof r.name === "string" && (r.state === "재고 없음" || r.state === "품절" || r.state === "부족"));
  return rows.map((r) => ({
    name: String(r.name), stock: numOf(r.stock) ?? 0, daily: numOf(r.daily) ?? 0, days: numOf(r.days),
    inbound: numOf(r.inbound) ?? 0, due: typeof r.due === "string" ? r.due : null, state: r.state as InvWatchRow["state"],
  }));
};

export function reportKpi(period: KpiPeriod, parts: KpiParts | null | undefined): ReportKpi | null {
  if (!parts) return null;
  const sales = obj(parts.sales), ads = obj(parts.ads), inventory = obj(parts.inventory), voice = obj(parts.voice);
  const k: ReportKpi = {
    sales: salesTile(period, sales), ads: adsTile(ads), inventory: inventoryTile(inventory), extra: extraTile(period, { sales, inventory, voice }),
    charts: { sales: salesChart(period, sales) },
    watch: watchRows(inventory),
    rising: (() => {
      const voc = obj(voice?.voc);
      if (!voc || voc.ok === false) return null;
      const rows = arr(voc.rising).map(obj).filter((r): r is Record<string, unknown> => !!r && typeof r.category === "string" && numOf(r.count) != null);
      return rows.map((r) => ({ category: String(r.category), count: numOf(r.count) as number, prev: numOf(r.prev) ?? 0 }));
    })(),
  };
  if (!k.sales && !k.ads && !k.inventory && !k.extra && !k.charts.sales && !k.watch && !k.rising) return null;
  return k;
}

// ── DB 에서 KPI 재료만 꺼내는 select 별칭 — GET /api/analyst(화면)와 sendReport(팀즈·메일)가 같은 경로를 쓴다 ──
//  facts 안에서 이 경로만(캠페인 배열·tool_log 는 꺼내지 않는다). 옛 리포트는 facts 가 비어 전부 null → reportKpi null.
export const KPI_FACTS_SELECT = [
  "k_sales:facts->sales, k_inventory:facts->inventory, k_voice:facts->voice, k_ads_total:facts->ads->spend_ex_vat_total",
  "k_meta_ok:facts->ads->meta->ok, k_meta_roas:facts->ads->meta->roas, k_naver_ok:facts->ads->naver->ok, k_naver_roas:facts->ads->naver->roas, k_naver_purchases:facts->ads->naver->purchases",
].join(", ");
/** select 결과 행에서 k_* 별칭을 떼어 reportKpi 입력(parts)으로, 나머지 칸은 row 로 돌려준다. */
export function takeKpiParts(data: Record<string, unknown>): { parts: KpiParts; row: Record<string, unknown> } {
  const { k_sales, k_inventory, k_voice, k_ads_total, k_meta_ok, k_meta_roas, k_naver_ok, k_naver_roas, k_naver_purchases, ...row } = data;
  const ads = k_ads_total == null && k_meta_ok == null && k_naver_ok == null ? null : {
    spend_ex_vat_total: k_ads_total,
    ...(k_meta_ok == null ? {} : { meta: { ok: k_meta_ok, roas: k_meta_roas } }),
    ...(k_naver_ok == null ? {} : { naver: { ok: k_naver_ok, roas: k_naver_roas, purchases: k_naver_purchases } }),
  };
  return { parts: { sales: k_sales, ads, inventory: k_inventory, voice: k_voice }, row };
}

// ── 팀즈 카드(docs/report-visibility-plan.md §5 2차) — 제목 헤드라인 + 제목 아래 핵심 줄 3~4개 ──
//  headline = '소매 2,140만(-5%)'(moneyCompact 축약, 증감은 정수 %) — 매출 타일이 없거나 '매출 없음'이면 null(제목은 종전 noSalesSuffix 규칙).
//  lead = 매출(증감 ≥+3 Good · ≤−3 Attention · 그 사이 Default) · 광고비(Default, 판정 색 없음) · 재고(재고 없음>0 Attention · 부족만 Warning)
//   · 주간 고객의 소리(미답변>0 Warning). 줄 글자 = 타일 라벨·값·증감 기준·배지·힌트를 ' · ' 로 이은 것(화면 타일과 같은 숫자).
//  일일 '월 누적'·월간 '월말 재고 금액' 타일은 팀즈 줄에 넣지 않는다(§5 목록대로 — 휴대폰 미리보기에 매출·광고·재고가 먼저 보이게).
const TONE_COLOR: Record<KpiTone, TeamsColor> = { success: "Good", danger: "Attention", warning: "Warning", info: "Default", neutral: "Default" };
const leadText = (t: KpiTile) => [`${t.label} ${t.value}`, t.delta ? `${t.delta.basis} ${t.delta.pill.text}` : null, ...(t.hintPills ?? []).map((p) => p.text), t.hint || null].filter((s): s is string => !!s).join(" · ");
export function teamsLead(period: KpiPeriod, kpi: ReportKpi | null): { headline: string | null; lead: LeadLine[] } {
  if (!kpi) return { headline: null, lead: [] };
  const lead: LeadLine[] = [];
  const s = kpi.sales;
  const headline = s && s.amount != null ? `소매 ${moneyCompact(s.amount)}${s.delta ? `(${fmtPct(Math.round(s.delta.pct))})` : ""}` : null;
  if (s && s.amount != null) lead.push({ text: leadText(s), color: s.delta ? TONE_COLOR[s.delta.pill.tone] : "Default" });
  if (kpi.ads) lead.push({ text: leadText(kpi.ads), color: "Default" });
  if (kpi.inventory) lead.push({ text: leadText(kpi.inventory), color: kpi.inventory.valueTone === "danger" ? "Attention" : kpi.inventory.valueTone === "warning" ? "Warning" : "Default" });
  if (period === "weekly" && kpi.extra) lead.push({ text: leadText(kpi.extra), color: (kpi.extra.hintPills ?? []).some((p) => p.tone === "warning") ? "Warning" : "Default" });
  return { headline, lead };
}
