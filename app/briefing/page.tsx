"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfirm } from "@/app/components/Feedback";
import { ComboBarLine, TrendChart, PIE_COLORS, moneyCompact } from "@/app/components/charts";
import { splitSections, tableKindOf, TOTAL_ROW, CAMPAIGN_TOP, VOICE_HEAD, INV_WATCH_HEAD, watchCells, tableRow, tableRule, splitRow, type ReportSection, type SectionKind } from "@/app/lib/report-sections";
import { KPI_TONE_COLOR, pctTone, type ReportKpi, type KpiPill, type KpiTile } from "@/app/lib/report-kpi";
import { INV_WATCH_COLOR, type InvWatchState } from "@/app/lib/inventory";

// 종합 리포트(2026-09-30, 메뉴 기타) — 매출·광고 분석 에이전트(app/lib/analyst.ts, 주간·월간은 analyst-period.ts)의 리포트.
//  일일·주간·월간 탭. 로그인한 모두가 보고 만들고 보낸다.
//  흐름: 담당자가 매출 업로드 → 안내 창 '... 종합 리포트 생성'(?period=&date=&run=1) → 여기서 자동 분석 → 확인 후 [보내기](메일, 2026-10-13 — 자동 발송·팀즈 없음).
//  (매출 › 리포트의 '일일 매출 리포트'·'주간 매출 리포트'(메일)와 별개 메일 — 수신자를 비우면 그 리포트와 같은 사람들)
//  14:30(운영) — 매출이 다 들어왔는데 아직 발송 전이면 자동 생성·발송(일일 매일, 주간 월~수, 월간 1~5일). 06:30 업무 브리핑은 중단.
//  [다시 분석](매출이 그대로여도 새로)과 하단 설정은 관리자만 — 서버가 판정한다(/api/analyst, /api/briefing/settings).
//  2026-10-13 가시성 개선(docs/report-visibility-plan.md) — 코드 렌더만: KPI 띠(report.kpi = facts, report-kpi.ts)·섹션 카드·
//   한 줄 요약/확인할 것 테두리 카드·코드 표 접기(캠페인 합계+상위 5, 추이 표는 그래프 뒤)·배지(재고 상태·확인됨/추정·미답변)·
//   매출 표 증감 색·섹션 이동 바·매출 추이 막대. 프롬프트·AI 호출·저장 변경 없음. 글은 한 글자도 줄지 않는다(접히는 건 코드 표뿐).
//   폴백 = 지금 모양: facts 없으면 띠 생략, ## 헤딩 없으면 평탄 렌더, 표 규칙에 안 맞으면 색 없이 글자 그대로.

type AnalystUsage = { input: number; cache_read: number; cache_write: number; output: number; iterations: number; tool_calls: number; est_usd: number };
type TrendPts = { title: string; summary: string; points: { b: string; spend?: number; cost?: number; roas?: number | null; roas_all?: number | null }[] } | null;
type SendRes = { ok: boolean; error?: string; mail: { ok: boolean; error?: string; to?: number } | null };
type AnalystReport = { report_date: string; status: string; running?: boolean; sent_current?: boolean; trend_meta?: TrendPts; trend_naver?: TrendPts; kpi?: ReportKpi | null; sales_ready: boolean; report_md: string | null; model: string | null; usage: AnalystUsage | null; trigger: string | null; error: string | null; sent_at: string | null; created_at: string; updated_at: string };
const kstYesterday = () => new Date(Date.now() + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10);
const TRIGGER_LABEL: Record<string, string> = { manual: "생성", cron: "자동 발송", upload: "매출 업로드 직후", rerun: "매출 변경 재분석" };
const SKIP_MSG: Record<string, string> = {
  "이미 분석됨": "매출이 그대로라 기존 리포트를 유지합니다.",
  "매출 업로드 대기": "매출이 아직 없어 기존 리포트를 유지합니다.",
  "분석 진행 중": "분석이 진행 중입니다. 잠시 뒤 새로고침하세요.",
};

const dtKst = (iso: string) => {
  try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16); }
  catch { return iso.slice(0, 16).replace("T", " "); }
};

// ── 공용 조각 ──
const Pill = ({ p, className }: { p: KpiPill; className?: string }) => (
  <span className={`b2b-status-pill${className ? ` ${className}` : ""}`} style={{ background: KPI_TONE_COLOR[p.tone].bg, color: KPI_TONE_COLOR[p.tone].fg }}>{p.text}</span>
);
const bold = (txt: string) => txt.split(/\*\*(.+?)\*\*/g).map((seg, k) => (k % 2 ? <strong key={k}>{seg}</strong> : seg));

// 광고 추이 그래프를 끼울 줄 — '### 광고 추이' 아래 요약 줄(-) 다음, 추이 표 앞. 그 제목이 없으면(옛 리포트)
//  '## (2.) 광고' 섹션 끝(다음 ## 앞 또는 맨 끝). 광고 섹션도 없으면 -1(그래프는 리포트 아래 카드로).
function trendSlotAt(lines: string[]): number {
  const h = lines.findIndex((l) => /^###\s*광고 추이/.test(l.trim()));
  if (h >= 0) {
    let i = h + 1;
    while (i < lines.length && (/^-\s/.test(lines[i].trim()) || !lines[i].trim())) i++;
    return i;
  }
  const a = lines.findIndex((l) => /^##\s*(\d+\.\s*)?광고/.test(l.trim()));
  if (a < 0) return -1;
  const e = lines.findIndex((l, i) => i > a && /^##\s/.test(l.trim()));
  return e < 0 ? lines.length : e;
}
// 광고 섹션 안(헤딩 줄 없음)에서의 같은 자리 — 제목이 없으면 섹션 끝
const adSlotAt = (lines: string[]): number => { const at = trendSlotAt(lines); return at < 0 ? lines.length : at; };

// ── 줄 → 블록(표는 한 블록) — 줄 렌더러는 그대로, 바깥만 감싼다 ──
type Block = { t: "table"; i: number; head: string[]; body: string[][] } | { t: "line"; i: number; s: string };
function toBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // 연속된 | 행 → 표 (구분선 |---| 은 건너뜀)
    if (tableRow(t)) {
      const rows: string[][] = [];
      const start = i;
      while (i < lines.length && tableRow(lines[i].trim())) { const raw = lines[i].trim(); if (!tableRule(raw)) rows.push(splitRow(raw)); i++; }
      i--;
      if (rows.length) { const [head, ...body] = rows; out.push({ t: "table", i: start, head, body }); }
      continue;
    }
    out.push({ t: "line", i, s: t });
  }
  return out;
}

// 표 — .b2b-table-wrap > .b2b-table, 숫자 열(첫 열·'상태' 열 제외)은 .num(우측 정렬, design-system §10). 열 ≤6 이면 모바일 카드(data-label).
//  '상태'(배지) 열 머리는 다른 화면과 같은 공용 상태 열 폭(.b2b-col-status).
type CellFn = (c: string, k: number, r: string[]) => ReactNode;
const STATUS_COL = /상태|구분/;
function Table({ head, body, rowClass, cellClass, cell }: { head: string[]; body: string[][]; rowClass?: (r: string[]) => string | undefined; cellClass?: (c: string, k: number, r: string[]) => string | undefined; cell?: CellFn }) {
  const responsive = head.length <= 6;
  const numCol = head.map((h, k) => k > 0 && !STATUS_COL.test(h));
  const cls = (k: number, extra?: string) => [numCol[k] ? "num" : "", extra || ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="b2b-table-wrap brf-tbl">
      <table className={`b2b-table${responsive ? " is-responsive" : ""}`}>
        <thead><tr>{head.map((c, k) => <th key={k} className={cls(k, k > 0 && STATUS_COL.test(c) ? "b2b-col-status" : undefined)}>{c}</th>)}</tr></thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className={rowClass?.(r)}>
              {r.map((c, k) => <td key={k} className={cls(k, cellClass?.(c, k, r))} data-label={responsive ? head[k] : undefined}>{cell ? cell(c, k, r) : bold(c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 매출 표(AI): 머리글에 '증감'·'대비' 가 든 열의 셀이 부호 있는 % 전체 일치일 때만 색(|값|<3 중립). 첫 칸 /합계/ 행은 .brf-total.
const SIGNED_PCT = /^[+\-−]\d{1,3}(\.\d+)?%$/;
const pctClass = (c: string): string | undefined => {
  if (!SIGNED_PCT.test(c)) return undefined;
  const t = pctTone(parseFloat(c.replace("−", "-")));
  return t === "success" ? "brf-pos" : t === "danger" ? "brf-neg" : undefined;
};
const SalesTable = ({ head, body }: { head: string[]; body: string[][] }) => {
  const pctCol = head.map((h, k) => k > 0 && /증감|대비/.test(h));
  return <Table head={head} body={body} rowClass={(r) => (/합계/.test(r[0]) ? "brf-total" : undefined)} cellClass={(c, k) => (pctCol[k] ? pctClass(c) : undefined)} />;
};
// 재고 주의 품목 표: '상태' 셀 → 배지(INV_WATCH_COLOR) + 행 톤, '버티는 날' ≤3 은 danger 글자
const InvTable = ({ head, body }: { head: string[]; body: string[][] }) => {
  const stateCol = head.findIndex((h) => h === "상태"), daysCol = head.findIndex((h) => /버티는 날/.test(h));
  const stateOf = (r: string[]): InvWatchState | null => { const s = r[stateCol]; return s === "품절" || s === "부족" ? s : null; };
  return (
    <Table head={head} body={body}
      rowClass={(r) => { const s = stateOf(r); return s ? INV_WATCH_COLOR[s].row : undefined; }}
      cellClass={(c, k) => { if (k !== daysCol) return undefined; const m = c.match(/^(\d+)일$/); return m && Number(m[1]) <= 3 ? "brf-neg" : undefined; }}
      cell={(c, k) => { if (k !== stateCol) return bold(c); const s = c === "품절" || c === "부족" ? INV_WATCH_COLOR[c] : null; return s ? <span className="b2b-status-pill" style={{ background: s.bg, color: s.fg }}>{c}</span> : bold(c); }}
    />
  );
};
// 고객의 소리 집계 표: '문의 중 미답변' >0 warning pill, 'VOC 손해 합계' 는 전주보다 크면 danger 글자
const intOf = (s: string): number | null => { const m = s.replace(/,/g, "").match(/-?\d+/); return m ? Number(m[0]) : null; };
const VoiceTable = ({ head, body }: { head: string[]; body: string[][] }) => (
  <Table head={head} body={body}
    cellClass={(c, k, r) => { if (k !== 1 || r[0] !== "VOC 손해 합계") return undefined; const cur = intOf(c), prev = intOf(r[2] || ""); return cur != null && prev != null && cur > prev ? "brf-neg" : undefined; }}
    cell={(c, k, r) => { if (k === 1 && r[0] === "문의 중 미답변") { const n = intOf(c); if (n != null && n > 0) return <Pill p={{ text: c, tone: "warning" }} />; } return bold(c); }}
  />
);

// 캠페인 전체 표 — 합계 + 지출 상위 5 기본, 나머지는 <details>(펼치면 지금과 똑같은 전체 표). 광고는 어디에도 판정 색 없음.
function CampaignTable({ head, body }: { head: string[]; body: string[][] }) {
  const rows = body.filter((r) => !TOTAL_ROW.test(r[0])), total = body.filter((r) => TOTAL_ROW.test(r[0]));
  const totalCls = (r: string[]) => (TOTAL_ROW.test(r[0]) ? "brf-total" : undefined);
  if (rows.length <= CAMPAIGN_TOP) return <Table head={head} body={body} rowClass={totalCls} />;
  return (
    <div className="brf-camp">
      <div className="brf-short"><Table head={head} body={[...rows.slice(0, CAMPAIGN_TOP), ...total]} rowClass={totalCls} /></div>
      <details className="brf-fold">
        <summary>캠페인 전체 {rows.length}개</summary>
        <Table head={head} body={body} rowClass={totalCls} />
      </details>
    </div>
  );
}

// 변화 → 원인: '(원인: 확인됨/추정)' 또는 '(확인됨,' 정확 패턴 우선, 없으면 단어 경계 토큰('추정된다' 같은 일반 용법 제외).
//  바로 뒤에 부정어가 오면('추정 불가'·'추정 어려움') 원인을 추정한 게 아니다 — 배지 없음.
const TAG_NOT_NEG = "(?!\\s*(?:불가|어렵|어려|못|안\\s|없))";
const TAG_RE = [
  new RegExp(`\\(원인[:：]?\\s*(확인됨|추정)${TAG_NOT_NEG}`),
  new RegExp(`\\((확인됨|추정)(?=[,)·\\s])${TAG_NOT_NEG}`),
  new RegExp(`(?:^|[\\s(,·—-])(확인됨|추정)(?=$|[\\s),.·:;—-])${TAG_NOT_NEG}`),
];
function tagOf(s: string): "확인됨" | "추정" | null {
  for (const re of TAG_RE) { const m = s.match(re); if (m) return m[1] as "확인됨" | "추정"; }
  return null;
}
// '**' 쌍이 화살표를 가로지르면(**변화 → 원인**) 나누지 않고 줄 전체를 bold() 한 덩어리로
const boldBalanced = (t: string) => (t.split("**").length - 1) % 2 === 0;
const ChangeLine = ({ s }: { s: string }) => {
  const tag = tagOf(s);
  const arrow = s.match(/^(.+?)\s*(→|->)\s*(.+)$/);
  const m = arrow && boldBalanced(arrow[1]) && boldBalanced(arrow[3]) ? arrow : null;
  return (
    <div className="brf-li">
      {"· "}
      {tag && <Pill p={{ text: tag, tone: tag === "확인됨" ? "success" : "warning" }} className="brf-tag" />}
      {m ? <><span className="brf-change-head">{bold(m[1])}</span><div className="brf-cause">{m[2]} {bold(m[3])}</div></> : bold(s)}
    </div>
  );
};
// 고객의 소리 줄: 끝의 '(미답변)' 은 warning pill, '(답변 N시간)' 은 중립 pill
const VoiceLine = ({ s }: { s: string }) => {
  const m = s.match(/^(.*?)\s*\((미답변|답변 \d+(?:\.\d+)?시간)\)$/);
  if (!m) return <div className="brf-li">{"· "}{bold(s)}</div>;
  return <div className="brf-li">{"· "}{bold(m[1])}<Pill p={{ text: m[2], tone: m[2] === "미답변" ? "warning" : "neutral" }} className="brf-tag-after" /></div>;
};

// 섹션 본문 — 줄 렌더러(표·글머리·굵게)는 그대로, 종류별로 표 접기·배지만 얹는다.
//  코드 표 아래 집계 기준 줄(- 품절 = ... / - 방향 = ... / - 문의 = ... / - 메타 클릭은 ... / - 문의 마지막 수집: ...)만 12px 흐리게.
//  같은 자리의 경고 줄(- 주의: / - 참고: / - 메타: ...지출 없는 캠페인 / - 네이버: 광고그룹 조회에 실패해 ...)은 본문 15px 그대로.
const CODE_SUB = /^###\s*(캠페인 전체|광고 추이|재고 주의 품목|고객의 소리 집계)/;
const BASIS_LINE = /^(품절 =|방향 =|문의 =|메타 클릭은|문의 (?:마지막 수집|대장 마지막 저장):)/;
type BodyOpts = { kind: SectionKind; slot?: ReactNode; hasCharts: boolean; watch?: ReportKpi["watch"]; rising?: ReportKpi["rising"]; chart?: ReactNode };
function renderBody(lines: string[], o: BodyOpts): ReactNode[] {
  const out: ReactNode[] = [];
  const blocks = toBlocks(lines);
  const slotAt = o.kind === "ad" && o.slot ? adSlotAt(lines) : o.kind === "pre" && o.slot ? trendSlotAt(lines) : -1;
  let placed = false, codeSub = false, voiceSub = false;
  const usedWatch = !!o.watch?.length; // 재고 주의 품목은 facts 로 그린다(상태·data-label 정확) — 마크다운 표는 건너뛴다
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b];
    if (slotAt >= 0 && !placed && blk.i >= slotAt) { out.push(<div key="trend-slot" className="brf-chart">{o.slot}</div>); placed = true; }
    if (blk.t === "table") {
      const kind = tableKindOf(blk.head[0]);
      if (kind === "trend") {
        // 광고 추이 구간별 표(메타·네이버)는 그래프 뒤로 접는다 — 그래프 없는 옛 리포트는 펼침
        const group: Block[] = [blk];
        let j = b + 1;
        for (; j < blocks.length; j++) { const n = blocks[j]; if (n.t === "table" && tableKindOf(n.head[0]) === "trend") group.push(n); else if (!(n.t === "line" && !n.s)) break; }
        b = j - 1;
        out.push(
          <details key={`fold${blk.i}`} className="brf-fold" open={!o.hasCharts}>
            <summary>구간별 표 {blk.body.length}구간</summary>
            {group.map((g) => (g.t === "table" ? <Table key={g.i} head={g.head} body={g.body} /> : null))}
          </details>
        );
        continue;
      }
      if (kind === "campaign") { out.push(<CampaignTable key={blk.i} head={blk.head} body={blk.body} />); continue; }
      if (kind === "inventory") { if (!usedWatch) out.push(<InvTable key={blk.i} head={blk.head} body={blk.body} />); continue; }
      if (voiceSub) {
        out.push(<VoiceTable key={blk.i} head={blk.head} body={blk.body} />);
        if (o.rising?.length) out.push(<div key={`rising${blk.i}`} className="brf-rising"><span>늘어난 유형</span>{o.rising.map((r) => <Pill key={r.category} p={{ text: `${r.category} ${r.count}(전주 ${r.prev})`, tone: "warning" }} />)}</div>);
        continue;
      }
      if (o.kind === "sales") { out.push(<SalesTable key={blk.i} head={blk.head} body={blk.body} />); continue; }
      out.push(<Table key={blk.i} head={blk.head} body={blk.body} />);
      continue;
    }
    const { s, i } = blk;
    if (!s) { out.push(<div key={i} className="brf-gap" />); continue; }
    if (s === "---") { out.push(<hr key={i} className="brf-hr" />); continue; }
    // ('## ' 줄은 splitSections 가 전부 섹션 헤딩으로 소비하므로 여기 오지 않는다 — 섹션 제목은 .b2b-card-title)
    if (/^###\s/.test(s)) {
      codeSub = CODE_SUB.test(s); voiceSub = VOICE_HEAD.test(s);
      out.push(<div key={i} className="brf-h3">{s.replace(/^###\s*/, "")}</div>);
      if (/^###\s*재고 주의 품목/.test(s) && usedWatch) out.push(<InvTable key={`watch${i}`} head={[...INV_WATCH_HEAD]} body={o.watch!.map(watchCells)} />);
      continue;
    }
    if (/^-\s/.test(s)) {
      const body = s.replace(/^-\s*/, "");
      if (codeSub && BASIS_LINE.test(body)) { out.push(<div key={i} className="brf-li brf-basis">{"· "}{bold(body)}</div>); continue; }
      if (o.kind === "change") { out.push(<ChangeLine key={i} s={body} />); continue; }
      if (o.kind === "voice") { out.push(<VoiceLine key={i} s={body} />); continue; }
      out.push(<div key={i} className="brf-li">{"· "}{bold(body)}</div>);
      continue;
    }
    out.push(<div key={i}>{bold(s)}</div>);
  }
  if (slotAt >= 0 && !placed) out.push(<div key="trend-slot" className="brf-chart">{o.slot}</div>);
  if (o.chart) out.push(<div key="sales-chart" className="brf-chart">{o.chart}</div>);
  return out;
}

// 광고 추이 그래프(메타·네이버) — 리포트 안에 끼울 땐 요약 줄이 바로 위에 있으므로 summary 를 다시 쓰지 않는다
function trendCharts(report: AnalystReport | null, showSummary: boolean): ReactNode {
  const items = [
    { t: report?.trend_meta, name: "메타", bar: "지출", line: "ROAS", val: (p: NonNullable<TrendPts>["points"][number]) => [p.spend || 0, p.roas] as const },
    { t: report?.trend_naver, name: "네이버", bar: "광고비", line: "전환 ROAS", val: (p: NonNullable<TrendPts>["points"][number]) => [p.cost || 0, p.roas_all] as const },
  ].filter((x) => x.t?.points?.length);
  if (!items.length) return null;
  return items.map((x) => (
    <div key={x.name} className="brf-chart">
      <div className="brf-h3">{x.name} — {x.bar}(막대) · {x.line}(선)</div>
      {showSummary && x.t?.summary && <div className="sm-faint brf-chart-sub">{x.t.summary}</div>}
      <ComboBarLine
        periods={x.t!.points.map((p) => p.b)}
        barSeries={[{ key: x.bar, values: x.t!.points.map((p) => x.val(p)[0]) }]}
        barColors={[PIE_COLORS[0]]}
        lineValues={x.t!.points.map((p) => { const v = x.val(p)[1]; return v == null ? null : Math.round(v * 100); })}
        lineLabel={x.line} lineFmt={(n) => `${n}%`} lineUnit=""
        barFmt={moneyCompact} barUnit="원"
      />
    </div>
  ));
}

// KPI 띠 — 4타일(소매 매출·광고비·재고·기간 고유). 값은 report-kpi.ts 가 만든 글자 그대로, 없는 타일은 숨긴다.
//  열 수는 뷰포트가 아니라 띠 자체 폭(.brf-kpi-wrap 컨테이너 쿼리)으로 — 사이드바·토글 버튼이 폭을 나눠 쓴다.
//  값이 12자 이상(9자리 금액 '123,456,789원')이면 is-long — 모바일에서 한 단계 작게(한 줄 유지).
const KPI_LONG = 12;
function KpiBand({ kpi }: { kpi: ReportKpi }) {
  const tiles = [kpi.sales, kpi.ads, kpi.inventory, kpi.extra].filter((t): t is KpiTile => !!t);
  if (!tiles.length) return null;
  return (
    <div className="b2b-dash-grid brf-kpi">
      {tiles.map((t) => (
        <div key={t.label} className="b2b-stat-card">
          <div className="b2b-stat-card-label">{t.label}</div>
          <div className={`b2b-stat-card-value b2b-money${t.valueTone ? ` is-${t.valueTone}` : ""}${t.value.length >= KPI_LONG ? " is-long" : ""}`}>{t.value}</div>
          {t.delta && <div className="brf-kpi-delta"><Pill p={t.delta.pill} /><span>{t.delta.basis}</span></div>}
          {(t.hint || t.hintPills?.length) ? (
            <div className="b2b-stat-card-hint">{t.hintPills?.map((p) => <Pill key={p.text} p={p} />)}{t.hint && <span>{t.hint}</span>}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const NAV_LABEL: Partial<Record<SectionKind, string>> = { summary: "요약", sales: "매출", ad: "광고", inv: "재고", voice: "고객의 소리", change: "변화", todo: "확인" };
const secId = (s: ReportSection, idx: number) => (s.kind === "other" || s.kind === "pre" ? `brf-${s.kind}-${idx}` : `brf-${s.kind}`);
const todoLines = (s: ReportSection | undefined) => (s ? s.lines.map((l) => l.trim()).filter((l) => /^-\s/.test(l)).map((l) => l.replace(/^-\s*/, "")) : []);
// 리포트 본문 — KPI 띠 → 이동 바 → 한 줄 요약(테두리) → 섹션 카드들 → 확인할 것(테두리). ## 헤딩이 없는 옛 리포트는 평탄 렌더.
//  접힌 표(캠페인 전체·추이 구간별)는 각자 눌러 펼친다 — [전부 펼치기] 버튼은 쓸모없다는 대표 피드백(2026-10-13)으로 뺐다.
function ReportView({ md, kpi, charts }: { md: string; kpi: ReportKpi | null; charts: ReactNode }) {
  const sections = useMemo(() => splitSections(md), [md]);
  const flat = sections.length === 1 && sections[0].kind === "pre";
  const hasCharts = !!charts;
  const todo = sections.find((s) => s.kind === "todo");
  const todos = todoLines(todo);
  const navItems = sections.map((s, i) => ({ s, i })).filter(({ s }) => NAV_LABEL[s.kind]);
  const [active, setActive] = useState("");
  const navKey = navItems.map(({ s, i }) => secId(s, i)).join(",");
  useEffect(() => {
    if (navItems.length <= 2 || typeof IntersectionObserver === "undefined") return;
    const els = navKey.split(",").map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: "-15% 0px -70% 0px", threshold: 0 });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKey, navItems.length]);
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const body = flat
    ? <div className="brf-md">{renderBody(sections[0].lines, { kind: "pre", slot: charts ?? undefined, hasCharts })}</div>
    : sections.map((s, i) => {
      const id = secId(s, i);
      if (s.kind === "summary") {
        return (
          <section key={id} id={id} className="b2b-stat-card brf-box brf-sec">
            <span className="brf-box-label">{s.heading}</span>
            <div className="brf-box-text brf-summary-text">{s.lines.map((l) => l.trim()).filter(Boolean).map((l, k) => <div key={k}>{bold(l.replace(/^-\s*/, ""))}</div>)}</div>
            {todo && todos.length > 0 && (
              <button type="button" className="b2b-status-pill brf-pill-btn brf-box-pill" style={{ background: KPI_TONE_COLOR.info.bg, color: KPI_TONE_COLOR.info.fg }} onClick={() => go(secId(todo, sections.indexOf(todo)))}>
                확인할 것 {todos.length}건
              </button>
            )}
          </section>
        );
      }
      if (s.kind === "todo") {
        const rest = s.lines.map((l) => l.trim()).filter((l) => l && !/^-\s/.test(l));
        return (
          <section key={id} id={id} className="b2b-stat-card brf-box brf-sec">
            <span className="brf-box-label">{s.heading} · {todos.length}건</span>
            <div className="brf-box-text brf-md">
              {todos.length > 0 && <ol className="brf-todo-list">{todos.map((l, k) => <li key={k}>{bold(l)}</li>)}</ol>}
              {rest.map((l, k) => <div key={`r${k}`}>{bold(l)}</div>)}
            </div>
          </section>
        );
      }
      const pre = s.kind === "pre";
      return (
        <section key={id} id={id} className={`b2b-card brf-sec`}>
          {!pre && <div className="b2b-card-head"><span className="b2b-card-title">{s.heading}</span></div>}
          <div className="brf-md">
            {renderBody(s.lines, {
              kind: s.kind, hasCharts,
              slot: s.kind === "ad" ? charts ?? undefined : undefined,
              watch: s.kind === "inv" ? kpi?.watch : undefined,
              rising: s.kind === "voice" ? kpi?.rising : undefined,
              chart: s.kind === "sales" && kpi?.charts.sales ? <><div className="brf-h3">{kpi.charts.sales.title}</div><TrendChart data={kpi.charts.sales.data} fmtAxis={moneyCompact} accent="var(--sm-orange)" /></> : undefined,
            })}
          </div>
        </section>
      );
    });

  return (
    <div>
      {kpi && (
        <div className="brf-kpi-row">
          <div className="brf-kpi-wrap"><KpiBand kpi={kpi} /></div>
        </div>
      )}
      {!flat && navItems.length > 2 && (
        <div className="sm-tabs brf-nav">
          {navItems.map(({ s, i }) => {
            const id = secId(s, i);
            return (
              <button key={id} type="button" className={`sm-tab ${active === id ? "is-active" : ""}`} onClick={() => go(id)}>
                {NAV_LABEL[s.kind]}{s.kind === "todo" && todos.length > 0 && <span className="sm-tab-count">{todos.length}</span>}
              </button>
            );
          })}
        </div>
      )}
      {body}
    </div>
  );
}

type Period = "daily" | "weekly" | "monthly";
const TABS: { key: Period; label: string }[] = [{ key: "daily", label: "일일" }, { key: "weekly", label: "주간" }, { key: "monthly", label: "월간" }];
// 기간 고르기(KST) — 주간·월간은 끝난 기간만 최근 12개
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const shiftD = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (ymd: string) => shiftD(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));
const mdS = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const recentWeeks = () => { const last = shiftD(mondayOf(kstToday()), -7); return Array.from({ length: 12 }, (_, k) => { const s = shiftD(last, -7 * k); return { value: s, label: `${mdS(s)}~${mdS(shiftD(s, 6))}` }; }); };
const recentMonths = () => Array.from({ length: 12 }, (_, k) => {
  const d = new Date(`${kstToday().slice(0, 8)}01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1 - k);
  const s = d.toISOString().slice(0, 10); return { value: s, label: `${s.slice(0, 4)}년 ${Number(s.slice(5, 7))}월` };
});
const defaultKey = (p: Period) => (p === "weekly" ? recentWeeks()[0].value : p === "monthly" ? recentMonths()[0].value : kstYesterday());

export default function SummaryReportPage() {
  const [period, setPeriod] = useState<Period>("daily");
  const [date, setDate] = useState(kstYesterday()); // 기간 키(일일 = 그날, 주간 = 월요일, 월간 = 1일)
  const [label, setLabel] = useState("");
  const [ready, setReady] = useState(false); // 주소(?period·?date·?run) 읽은 뒤에 불러온다
  const [report, setReport] = useState<AnalystReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState<"" | "run" | "send">("");
  const [error, setError] = useState("");
  const confirmModal = useConfirm();
  const [info, setInfo] = useState("");
  const autoRun = useRef(false); // 매출 업로드 안내 창에서 넘어오면(?run=1) 한 번 자동 분석
  const viewRef = useRef(`${period}:${date}`); // 늦게 도착한 다른 기간 응답은 버린다
  useEffect(() => { viewRef.current = `${period}:${date}`; }, [period, date]);
  // 설정(관리자) — 로드 성공 전에는 저장을 막는다(기존 수신자가 빈 값으로 덮이지 않게)
  const [mailTo, setMailTo] = useState("");
  const [mailDefault, setMailDefault] = useState<string[]>([]);
  const [smtpReady, setSmtpReady] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState("");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const p = sp.get("period");
    const per: Period = p === "weekly" || p === "monthly" ? p : "daily";
    const d = sp.get("date");
    setPeriod(per);
    setDate(d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : defaultKey(per));
    if (sp.get("run") === "1") {
      autoRun.current = true;
      window.history.replaceState(null, "", `${window.location.pathname}?period=${per}${d ? `&date=${d}` : ""}`); // 새로고침 때 다시 돌지 않게
    }
    setReady(true);
  }, []);

  // 오류는 지우지 않는다(발송 실패 메시지가 다시 불러오기에 가려지지 않게) — 지우는 건 기간 변경·새 실행 때
  const load = useCallback(async (p: Period, d: string): Promise<AnalystReport | null> => {
    const key = `${p}:${d}`;
    const stale = () => key !== viewRef.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/analyst?period=${p}&date=${d}`, { cache: "no-store" });
      const j = await r.json();
      if (stale()) return null;
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setReport(j.report || null);
      setPending(typeof j.pending_migration === "string" ? j.pending_migration : j.pending_migration ? "마이그레이션" : "");
      setAdmin(!!j.admin);
      setLabel(j.label || "");
      return j.report || null;
    } catch (e) { if (!stale()) setError(e instanceof Error ? e.message : "조회 오류"); return null; }
    finally { if (!stale()) setLoading(false); }
  }, []);

  // 분석 — force(매출이 그대로여도 새로)는 관리자만 서버가 받아 준다
  const run = useCallback(async (p: Period, d: string, force: boolean) => {
    setBusy("run"); setError(""); setInfo("");
    try {
      const r = await fetch("/api/analyst", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: p, date: d, force, send: false }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || (r.status === 504 ? "시간이 초과됐습니다 — 잠시 뒤 다시 시도하세요." : "분석 실패"));
      if (j.skipped) setInfo(p !== "daily" && j.skipped === "매출 업로드 대기" ? "마지막 날 매출이 아직 없어 기존 리포트를 유지합니다." : SKIP_MSG[j.skipped] || j.skipped);
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    await load(p, d); // 실패해도 최신 상태(진행 중·이전 리포트)를 다시 보여 준다
    setBusy("");
  }, [load]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    (async () => {
      let rep = await load(period, date);
      if (!autoRun.current) return;
      autoRun.current = false;
      // 다른 분석이 돌고 있으면 끝날 때까지 기다렸다가(최대 6분) 한 번 — 그 사이 올린 매출까지 반영되게. 매출이 그대로면 서버가 건너뛴다.
      for (let i = 0; alive && rep?.running && i < 36; i++) { await new Promise((r) => setTimeout(r, 10_000)); if (!alive) break; rep = await load(period, date); }
      if (alive && !rep?.running) await run(period, date, false);
    })();
    return () => { alive = false; };
  }, [ready, period, date, load, run]);

  // 보내기 — 메일(서버 sendReport, 일일 매출 리포트와 같은 수동 발송).
  async function send() {
    if (report?.sent_current && report.sent_at && !(await confirmModal({ title: "리포트 다시 보내기", body: `이미 ${dtKst(report.sent_at)}에 보냈습니다. 같은 리포트가 메일로 한 번 더 나갑니다.`, action: "다시 보내기", danger: false }))) return;
    setBusy("send"); setError(""); setInfo("");
    try {
      const r = await fetch("/api/analyst", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, date, send: true }),
      });
      const j = await r.json().catch(() => null);
      const s = (j?.sent ?? null) as SendRes | null;
      if (!r.ok || !j?.ok) throw new Error(j?.error || s?.error || "발송 실패");
      if (s?.mail?.ok) setInfo(`메일로 보냈습니다${s.mail.to ? `(${s.mail.to}명)` : ""}.`);
    } catch (e) { setError(e instanceof Error ? e.message : "발송 실패"); }
    await load(period, date);
    setBusy("");
  }

  useEffect(() => {
    if (!admin) return;
    (async () => {
      try {
        const j = await (await fetch("/api/briefing/settings", { cache: "no-store" })).json();
        if (j.ok) {
          setMailTo(j.mailTo || ""); setMailDefault(Array.isArray(j.mailDefault) ? j.mailDefault : []); setSmtpReady(j.smtpReady !== false);
          setSettingsLoaded(true);
        }
      } catch { /* 로드 실패 시 저장 버튼 비활성 유지 */ }
    })();
  }, [admin]);

  async function saveSettings() {
    setSettingsMsg("");
    try {
      const r = await fetch("/api/briefing/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailTo }),
      });
      const j = await r.json().catch(() => null);
      setSettingsMsg(r.ok && j?.ok ? "저장됐습니다." : `저장 실패: ${j?.error || "서버 오류"}`);
    } catch { setSettingsMsg("저장 실패: 네트워크 오류"); }
  }

  const switchTo = (p: Period) => { if (p === period || busy !== "") return; setPeriod(p); setDate(defaultKey(p)); setReport(null); setError(""); setInfo(""); };
  const pickDate = (d: string) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { setDate(d); setError(""); setInfo(""); } };
  const hasReport = !!report?.report_md;
  const md = report?.report_md || "";
  const charts = hasReport ? trendCharts(report, false) : null;
  // 그래프 자리: ## 광고 섹션(또는 헤딩 없는 옛 리포트의 광고 자리)이 있으면 리포트 안, 없으면 아래 별도 카드
  const placed = hasReport && (splitSections(md).some((s) => s.kind === "ad") || trendSlotAt(md.split("\n")) >= 0);
  const unsent = hasReport && !report?.sent_current && !report?.running; // 지금 버전을 아직 안 보냈다(보낸 뒤 다시 분석한 경우 포함)
  const options = period === "weekly" ? recentWeeks() : period === "monthly" ? recentMonths() : [];
  const sentPill: KpiPill = report?.sent_at
    ? (report.sent_current ? { text: `발송 ${dtKst(report.sent_at)}`, tone: "success" } : { text: `이전 버전 발송 ${dtKst(report.sent_at)}`, tone: "warning" })
    : { text: "발송 전", tone: "warning" };

  return (
    <div className="b2b-container brf-page">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">종합 리포트</h1></div>
        <div className="b2b-page-actions">
          {period === "daily" ? (
            <input type="date" className="b2b-input brf-input-auto" value={date} max={kstYesterday()} disabled={busy !== ""} onChange={(e) => pickDate(e.target.value)} />
          ) : (
            <select className="b2b-input brf-input-auto" value={date} disabled={busy !== ""} onChange={(e) => pickDate(e.target.value)}>
              {!options.some((o) => o.value === date) && <option value={date}>{label || date}</option>}
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          <button className={hasReport ? "b2b-btn-secondary" : "b2b-btn-primary"} onClick={() => run(period, date, admin)} disabled={busy !== "" || loading || !!report?.running}>
            {busy === "run" ? "분석 중... (1~4분)" : hasReport ? "다시 분석" : "분석하기"}
          </button>
          <button className={hasReport ? "b2b-btn-primary" : "b2b-btn-secondary"} onClick={send} disabled={busy !== "" || loading || !hasReport || !!report?.running}>
            {busy === "send" ? "보내는 중..." : "보내기"}
          </button>
        </div>
      </header>

      <div className="sm-tabbar brf-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`sm-tab ${period === t.key ? "is-active" : ""}`} onClick={() => switchTo(t.key)} disabled={busy !== ""}>{t.label}</button>
        ))}
      </div>

      {pending && <div className="sm-warn brf-banner">리포트 보관에는 마이그레이션 <code>{pending}</code> 적용이 필요합니다.</div>}
      {error && <div className="b2b-error brf-banner">{error}</div>}
      {info && <div className="sm-success brf-banner">{info}</div>}
      {report?.running && busy !== "run" && <div className="sm-warn brf-banner">분석이 진행 중입니다. 잠시 뒤 새로고침하세요.</div>}
      {unsent && busy === "" && <div className="sm-warn brf-banner">{report?.sent_at ? "보낸 뒤 다시 분석했습니다." : "아직 발송 전입니다."} 확인 후 [보내기]를 누르세요.</div>}
      {hasReport && report?.error && <div className="sm-warn brf-banner">{report.error} — 아래는 이전 리포트입니다.</div>}

      {loading && !report ? <div className="b2b-loading">불러오는 중...</div> : !report || (report.status === "running" && !hasReport) ? (
        <div className="b2b-empty">아직 이 기간의 종합 리포트가 없습니다.</div>
      ) : (
        <section className="b2b-card">
          <div className="sm-faint brf-meta">
            <span>{label || report.report_date} · {report.sales_ready ? "매출 반영" : period === "daily" ? "매출 없음(광고만)" : "마지막 날 매출 미반영"} · {TRIGGER_LABEL[report.trigger || ""] || report.trigger || ""} {dtKst(report.updated_at)}</span>
            <Pill p={sentPill} />
            {admin && report.model ? <span>{report.model}</span> : null}
            {admin && report.usage ? <span>조회 {report.usage.tool_calls}회 · 약 ${report.usage.est_usd}</span> : null}
          </div>
          {hasReport ? (
            <ReportView md={md} kpi={report.kpi ?? null} charts={placed ? charts : null} />
          ) : (
            <div className="sm-warn">분석에 실패했습니다{report.error ? `: ${report.error}` : ""} — [분석하기]를 다시 눌러 주세요.</div>
          )}
        </section>
      )}

      {hasReport && charts && !placed ? (
        <section className="b2b-card brf-sec">
          <div className="b2b-card-head">
            <h2 className="b2b-card-title">광고 추이 · {report?.trend_meta?.title || report?.trend_naver?.title}</h2>
          </div>
          {trendCharts(report, true)}
        </section>
      ) : null}

      {admin && (
        <section className="b2b-card brf-settings">
          <div className="b2b-card-head">
            <h2 className="b2b-card-title">리포트 설정</h2>
          </div>
          <label className="b2b-field brf-settings-field">
            <span className="b2b-field-label">메일 수신자</span>
            <input className="b2b-input" value={mailTo} onChange={(e) => setMailTo(e.target.value)} placeholder={mailDefault.join(", ")} />
            <span className="sm-faint brf-xs">비우면 일일 매출 리포트 수신자({mailDefault.length}명)</span>
          </label>
          {settingsLoaded && !smtpReady && <div className="sm-warn brf-banner">메일 서버(SALES_SMTP_*) 설정이 없습니다</div>}
          <div className="sm-row brf-settings-row">
            <button className="b2b-btn-primary" onClick={saveSettings} disabled={!settingsLoaded}>설정 저장</button>
            {settingsMsg && <span className="sm-faint brf-xs">{settingsMsg}</span>}
          </div>
        </section>
      )}
    </div>
  );
}
