// CRM 주간 브리핑(2026-11-25, 대표: "crm맵에 주간 브리핑 기능을 넣자") — 성과 탭이 이미 불러온 한 주 숫자를 읽을 글로 푼다.
//  규칙으로만 쓴다(AI 호출 없음) — 같은 숫자면 언제 눌러도 같은 글이 나온다. 서버·DB 를 건드리지 않는 순수 계산이라 화면(WeeklyStats)이 그대로 부른다.
//  판정 기준(대표 "권장대로"): 발송 100건 이상인 메시지만, 전주 대비 클릭률이 30% 이상 오르거나 내리면 '크게'.
//  빼는 것: 발송 수가 추정인 메시지(클릭률이 어림값), 링크가 전부 GA 가 못 보는 사이트(설문 폼·가이드)인 메시지 — 점검 구역에 건수만 알린다.
//  진행 중인 주(끝나는 날이 오늘 이후)는 전주와 견주지 않는다 — 날 수가 달라 늘 줄어든 것처럼 보인다.
import { qty, wonText } from "./format";

export const BRIEF_MIN_SENT = 100;   // 이보다 적게 나간 메시지는 클릭률이 몇 건에 출렁여 판정하지 않는다
export const BRIEF_SWING = 0.3;      // 전주 대비 클릭률 변동이 이 비율 이상이면 '크게 오름·떨어짐'
const TOP = 5;                       // 구역마다 보이는 메시지 수(나머지는 '외 n건')
const UNMATCHED_MIN = 5;             // 맵과 이어지지 않은 캠페인은 유입이 이만큼은 돼야 알린다

export type BriefBasis = "solapi" | "datarize" | "manual" | "estimate" | "none";
export type BriefMsg = {
  id: string; title: string; customer: string;
  sent: number | null; sentBasis: BriefBasis; sessions: number | null; ctr: number | null; targetCtr: number | null;
  purchases: number | null; revenue: number | null; landing: "tracked" | "untracked" | "";
  prevSent: number | null; prevCtr: number | null;
};
export type BriefSource = { label: string; sent: number; clicked: number | null; prevSent: number | null };
export type BriefTotals = { sent: number | null; sessions: number | null; ctr: number | null; purchases: number | null; revenue: number | null };
export type BriefInput = {
  week: string; until: string; today: string; channelLabel: string; hasGa: boolean;
  cur: BriefTotals & { sent: number; cost: number | null };
  prev: BriefTotals;
  messages: BriefMsg[];
  sources: BriefSource[];
  missingSources: { label: string; prevSent: number }[];   // 전주에는 기록이 있었는데 이 주에는 없는 수단
  unmatched: { campaign: string; sessions: number }[];     // 유입은 있는데 맵 메시지와 이어지지 않은 캠페인
  noUtm: { name: string; sent: number }[];                 // 링크에 UTM 이 없는 데이터라이즈 캠페인
  notes: string[];                                         // 발송 수를 받아 오다 난 문제
};
export type BriefLine = { text: string; sub?: string; tone?: "good" | "bad" };
export type BriefSection = { key: "summary" | "good" | "watch" | "sources" | "check"; title: string; lines: BriefLine[]; empty: string };
export type Briefing = { heading: string; period: string; partial: boolean; notice: string; lead: string; sections: BriefSection[]; text: string };

const md = (iso: string) => iso.slice(5).replace("-", "/");
const pctDiff = (cur: number, prev: number) => Math.round(((cur - prev) / prev) * 100);
const signed = (n: number, unit: string, digits = 0) => `${n >= 0 ? "+" : ""}${digits ? n.toFixed(digits) : n}${unit}`;
const point = (cur: number, prev: number) => Math.round((cur - prev) * 10) / 10;
const names = (list: string[], n = 3) => (list.length > n ? `${list.slice(0, n).join(", ")} 외 ${list.length - n}건` : list.join(", "));
const isActual = (b: BriefBasis) => b === "solapi" || b === "datarize" || b === "manual";

type Judged = { m: BriefMsg; good: string[]; bad: string[] };
// 메시지 하나의 판정 — 나쁜 이유가 하나라도 있으면 '살펴볼 메시지'(좋은 이유도 함께 적는다), 좋은 이유만 있으면 '잘된 메시지'.
function judge(m: BriefMsg, partial: boolean): Judged | null {
  if (!isActual(m.sentBasis) || m.sent == null || m.sent < BRIEF_MIN_SENT || m.ctr == null || m.landing === "untracked") return null;
  const good: string[] = [], bad: string[] = [];
  if (m.targetCtr != null) (m.ctr >= m.targetCtr ? good : bad).push(`목표 ${m.targetCtr}% ${m.ctr >= m.targetCtr ? "달성" : "미달"}`);
  if (m.sessions === 0 && m.landing === "tracked") bad.push("유입 0");
  else if (!partial && m.prevCtr != null && m.prevCtr > 0 && m.prevSent != null && m.prevSent >= BRIEF_MIN_SENT) {
    const change = (m.ctr - m.prevCtr) / m.prevCtr;
    if (Math.abs(change) >= BRIEF_SWING) (change > 0 ? good : bad).push(`전주 ${m.prevCtr}%에서 ${signed(point(m.ctr, m.prevCtr), "%p", 1)}`);
  }
  return good.length || bad.length ? { m, good, bad } : null;
}
const msgLine = (j: Judged, showCustomer: boolean): BriefLine => {
  const { m } = j;
  const bits = [`클릭률 ${m.ctr}%`, ...j.bad, ...j.good, `발송 ${qty(m.sent)}`, `클릭 ${qty(m.sessions)}`];
  if (m.purchases) bits.push(`구매 ${qty(m.purchases)}`);
  if (m.revenue) bits.push(`매출 ${wonText(m.revenue)}`);
  return { text: showCustomer && m.customer ? `${m.title} (${m.customer})` : m.title, sub: bits.join(" · "), tone: j.bad.length ? "bad" : "good" };
};
const withRest = (lines: BriefLine[], total: number): BriefLine[] => (total > lines.length ? [...lines, { text: `외 ${total - lines.length}건` }] : lines);

export function buildBriefing(inp: BriefInput): Briefing {
  const partial = inp.until >= inp.today;
  const period = `${md(inp.week)} ~ ${md(inp.until)}`;
  const { cur, prev } = inp;
  const cmp = !partial; // 전주와 견줄 수 있는 주인가

  // ── 한 주 요약 ──
  const summary: BriefLine[] = [];
  summary.push({ text: `발송 ${qty(cur.sent)}건${cmp && prev.sent ? ` · 전주 ${qty(prev.sent)}건 (${signed(pctDiff(cur.sent, prev.sent), "%")})` : ""}` });
  if (inp.hasGa && cur.sessions != null) {
    summary.push({ text: `클릭(GA 유입) ${qty(cur.sessions)}회${cmp && prev.sessions ? ` · 전주 ${qty(prev.sessions)}회 (${signed(pctDiff(cur.sessions, prev.sessions), "%")})` : ""}` });
    if (cur.ctr != null) summary.push({ text: `클릭률 ${cur.ctr}%${cmp && prev.ctr != null ? ` · 전주 ${prev.ctr}% (${signed(point(cur.ctr, prev.ctr), "%p", 1)})` : ""}` });
    if (cur.purchases != null) summary.push({ text: `구매 ${qty(cur.purchases)}건 · 매출 ${wonText(cur.revenue ?? 0)}${cmp && prev.purchases != null ? ` · 전주 ${qty(prev.purchases)}건 · ${wonText(prev.revenue ?? 0)}` : ""}` });
  }
  if (cur.cost) summary.push({ text: `발송 비용 ${wonText(Math.round(cur.cost))} (데이터라이즈)` });

  // ── 메시지 판정 ──
  const judged = inp.messages.map((m) => judge(m, partial)).filter((x): x is Judged => !!x);
  const goodAll = judged.filter((j) => !j.bad.length).sort((a, b) => (b.m.sessions ?? 0) - (a.m.sessions ?? 0));
  const watchAll = judged.filter((j) => j.bad.length).sort((a, b) => (b.m.sent ?? 0) - (a.m.sent ?? 0));
  const showCustomer = !inp.channelLabel;
  const good = withRest(goodAll.slice(0, TOP).map((j) => msgLine(j, showCustomer)), goodAll.length);
  const watch = withRest(watchAll.slice(0, TOP).map((j) => msgLine(j, showCustomer)), watchAll.length);

  // ── 수단별 ──
  const sources: BriefLine[] = inp.sources.map((s) => {
    const bits = [`발송 ${qty(s.sent)}건${cmp && s.prevSent ? ` (전주 ${qty(s.prevSent)}건, ${signed(pctDiff(s.sent, s.prevSent), "%")})` : ""}`];
    if (s.clicked != null) { bits.push(`클릭 ${qty(s.clicked)}회`); if (s.sent) bits.push(`클릭률 ${(Math.round((s.clicked / s.sent) * 1000) / 10).toFixed(1)}%`); }
    return { text: s.label, sub: bits.join(" · ") };
  });

  // ── 점검 ──
  const check: BriefLine[] = inp.notes.map((t) => ({ text: t, tone: "bad" as const }));
  if (!inp.hasGa) check.push({ text: "GA 가 연결되지 않아 클릭·구매를 세지 못했습니다", tone: "bad" });
  for (const s of inp.missingSources) check.push({ text: `${s.label}: 이 주 발송 기록이 없습니다`, sub: `전주 ${qty(s.prevSent)}건 · 직접 입력이 빠졌는지 확인하세요` });
  const noSent = inp.messages.filter((m) => m.sentBasis === "none" && (m.sessions ?? 0) > 0);
  if (noSent.length) check.push({ text: `발송 수가 없는 메시지 ${noSent.length}건`, sub: `${names(noSent.map((m) => m.title))} · 유입은 있는데 클릭률을 계산하지 못했습니다` });
  const est = inp.messages.filter((m) => m.sentBasis === "estimate");
  if (est.length) check.push({ text: `발송 수가 추정인 메시지 ${est.length}건은 판정에서 뺐습니다`, sub: names(est.map((m) => m.title)) });
  const blind = inp.messages.filter((m) => m.landing === "untracked" && (m.sent ?? 0) > 0);
  if (blind.length) check.push({ text: `클릭을 셀 수 없는 메시지 ${blind.length}건`, sub: `${names(blind.map((m) => m.title))} · 링크가 설문 폼·가이드처럼 GA 가 없는 사이트입니다` });
  const un = inp.unmatched.filter((u) => u.sessions >= UNMATCHED_MIN);
  if (un.length) check.push({ text: `맵과 이어지지 않은 캠페인 ${un.length}개`, sub: names(un.map((u) => `${u.campaign}(유입 ${qty(u.sessions)})`), TOP) });
  if (inp.noUtm.length) check.push({ text: `링크에 UTM 이 없는 데이터라이즈 캠페인 ${inp.noUtm.length}개`, sub: names(inp.noUtm.map((u) => `${u.name}(발송 ${qty(u.sent)})`), TOP) });

  // ── 첫 문장 ──
  let lead = "";
  if (cur.sent || cur.sessions) {
    const tail = ` 잘된 메시지 ${goodAll.length}건, 살펴볼 메시지 ${watchAll.length}건입니다.`;
    if (cmp && prev.sent && cur.ctr != null && prev.ctr != null) {
      const ds = pctDiff(cur.sent, prev.sent), dc = point(cur.ctr, prev.ctr);
      const a = ds >= 5 ? `발송은 ${ds}% 늘었고` : ds <= -5 ? `발송은 ${Math.abs(ds)}% 줄었고` : "발송은 비슷하고";
      const b = dc >= 0.1 ? `클릭률은 ${dc.toFixed(1)}%p 올랐습니다` : dc <= -0.1 ? `클릭률은 ${Math.abs(dc).toFixed(1)}%p 내렸습니다` : Math.abs(ds) < 5 ? "클릭률도 비슷합니다" : "클릭률은 비슷합니다";
      lead = `전주와 견줘 ${a} ${b}.${tail}`;
    } else lead = `발송 ${qty(cur.sent)}건${cur.ctr != null ? `, 클릭률 ${cur.ctr}%` : ""}입니다.${tail}`;
  } else lead = "이 주에는 발송 기록과 유입이 없습니다.";

  const sections: BriefSection[] = [
    { key: "summary", title: "한 주 요약", lines: summary, empty: "" },
    { key: "good", title: "잘된 메시지", lines: good, empty: "기준을 넘은 메시지가 없습니다." },
    { key: "watch", title: "살펴볼 메시지", lines: watch, empty: "살펴볼 메시지가 없습니다." },
    { key: "sources", title: "수단별", lines: sources, empty: "이 주의 발송 기록이 없습니다." },
    { key: "check", title: "점검", lines: check, empty: "점검할 것이 없습니다." },
  ];
  const heading = `CRM 주간 브리핑 · ${period}${inp.channelLabel ? ` · ${inp.channelLabel}` : ""}`;
  const notice = partial ? "진행 중인 주입니다. 전주 대비는 주가 끝난 뒤에 판정합니다." : "";
  const text = [
    heading, ...(notice ? [notice] : []), lead,
    ...sections.flatMap((s) => ["", `[${s.title}]`, ...(s.lines.length ? s.lines.map((l) => `- ${l.text}${l.sub ? `: ${l.sub}` : ""}`) : [`- ${s.empty}`])]),
  ].join("\n");
  return { heading, period, partial, notice, lead, sections, text };
}
