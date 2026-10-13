// 종합 리포트(일일·주간·월간) 메일 본문 (2026-10-13 대표 요청: "종합리포트도 일일매출리포트와 동일하게 이메일로 발송").
//  analyst.ts sendReport 가 보낸다(수동 [보내기]만 — 2026-10-13 자동 발송·팀즈 중단). buildReportEmail 은 순수 함수(DB·네트워크 없음).
//  모양: 일일 매출 리포트 메일(sales-report-html.ts)의 팔레트(MAIL_COLORS)·구조(600px 테이블·헤더 띠·KPI 칸·섹션 제목)를 따른다 — '같은 회사 메일'.
//   이메일은 CSS 변수를 못 쓴다 → 색은 하드코딩(디자인 토큰 예외, sales-report-html 과 같은 값). 링크·이모지 없음.
//   모든 글은 이스케이프(mailEsc = sales-report-html esc — AI 글·캠페인명·상품명이 들어간다).
//  순서: 헤더(제목·기간) → 핵심 줄(report-kpi teamsLead 의 lead — 2칸씩 KPI 칸, Good/Attention/Warning = C_GOOD/C_BAD/C_WARN)
//   → 한 줄 요약(강조 박스) → 섹션(## 제목·### 소제목·- 글머리·**굵게**·| 표) → 확인할 것(번호 목록 박스).
//  팀즈처럼 줄이지 않는다(메일엔 카드 28KB 한도가 없다). 단 Gmail 은 HTML 이 약 102KB 를 넘으면 본문을 잘라 '전체 메시지 보기'로 숨긴다 —
//   생성한 html 이 REPORT_MAIL_MAX_BYTES(95,000B)를 넘을 때만 단계적으로 줄인다:
//   ① 'campaign-top10' — 캠페인 표만 지출 상위 10 + 합계(나머지 'N개는 업무도우미 › 종합 리포트에서' 한 줄)
//   ② 'no-code-tables' — 코드 표 블록(stripCodeBlocks: 캠페인·추이·재고 주의·고객의 소리)을 빼고 '표는 업무도우미 › 종합 리포트에서' 한 줄
//   ②로도 넘으면 그대로 보낸다(AI 글은 45줄 안팎이라 실제로는 오지 않는다). 단계·최종 바이트는 결과(stage·bytes)로 돌려 sendReport 가 콘솔에 남긴다.
//  2026-10-13 가짜 facts 샘플(실제 render* 표 함수로 만든 md, 캠페인 표 4열 + 지표 한 줄 모양): 일일(캠페인 메타 8 + 네이버 6) 39,458B full ·
//   주간(고객의 소리 표 포함, 12+9) 41,880B full · 월간 30+30 59,779B full · 55+55 90,719B full · 60+60 은 full 이 한도를 넘어 ① 약 35,400B ·
//   큰 추이 표(1,500행)는 ①로 안 줄어 ② 3,008B. 캠페인 표 한 행 ≈ 0.62KB — 메타·네이버 합쳐 약 115개를 넘어야 ① 이 돈다.
//  폭(headless Edge 실측): 375px 화면에서 문서 폭 360px(넘침 없음, 표 7개 모두 312px 안), 데스크톱에서 바깥 표 600px.
import type { LeadLine } from "./briefing"; // 타입만(팀즈 카드 핵심 줄) — 런타임 의존 없음
import { MAIL_COLORS, mailEsc as esc } from "./sales-report-html";
import { defaultRecipients } from "./sales-mailer";
import { pctTone, type KpiPeriod } from "./report-kpi";
import { splitSections, stripCodeBlocks, hasVoiceBlock, tableRow, tableRule, splitRow, tableKindOf, TABLE_KIND, TOTAL_ROW, type SectionKind } from "./report-sections";

const { C_DEEP, C_TIDE, C_FOAM, C_LINE, C_INK, C_MUTED, C_GOOD, C_WARN, C_BAD } = MAIL_COLORS;
// 아래 셋은 sales-report-html 의 헤더 띠·바탕 리터럴과 같은 값
const C_PAGE = "#f7fafb", C_EYEBROW = "#9fc4d2", C_HEADSUB = "#cfe2e9";
const FONT = "'Apple SD Gothic Neo','Malgun Gothic',sans-serif";

export const REPORT_MAIL_MAX_BYTES = 95_000;
export type ReportEmailStage = "full" | "campaign-top10" | "no-code-tables";
export type ReportEmail = { subject: string; html: string; text: string; bytes: number; stage: ReportEmailStage };
export type ReportEmailInput = { title: string; md: string; lead: LeadLine[]; period: KpiPeriod; label: string };

// ── 수신자·SMTP(sendReport·설정 API 공용) ──
//  수신자 = kv 'analyst_mail_to'(쉼표 구분) — 비어 있으면 일일 매출 리포트와 같은 수신자(SALES_MAIL_TO).
export const MAIL_ADDR_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
export const splitMailList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
export const reportMailRecipients = (kv: string): string[] => { const own = splitMailList(kv); return own.length ? own : defaultRecipients(); };
export const smtpReady = () => !!(process.env.SALES_SMTP_HOST && process.env.SALES_SMTP_USER && process.env.SALES_SMTP_PASSWORD);

// ── 글자 ──
// **굵게** → <b>, 나머지는 이스케이프(쌍이 안 맞는 별표는 글자 그대로)
const inline = (s: string) => s.split(/\*\*(.+?)\*\*/g).map((seg, k) => (k % 2 ? `<b>${esc(seg)}</b>` : esc(seg))).join("");
const intOf = (s: string): number | null => { const m = s.replace(/,/g, "").match(/-?\d+/); return m ? Number(m[0]) : null; };
const SPACER = `<div style="height:6px;line-height:6px;font-size:6px;">&nbsp;</div>`;

// 코드 표 아래 집계 기준 줄은 12px 흐리게 — 화면(briefing/page.tsx CODE_SUB·BASIS_LINE)과 같은 규칙
const CODE_SUB = /^###\s*(캠페인 전체|광고 추이|재고 주의 품목|고객의 소리 집계)/;
const BASIS_LINE = /^(품절 =|방향 =|문의 =|메타 클릭은|문의 (?:마지막 수집|대장 마지막 저장):)/;

// ── 표 ──
//  머리글 행 배경 C_FOAM, 첫 열 왼쪽·숫자 열 오른쪽('상태'·'구분' 열은 왼쪽 — 화면 Table 과 같은 규칙), 합계 행 굵게 — 화면과 같은 자리만:
//  캠페인 표는 TOTAL_ROW '합계 N개'(화면 캠페인 표), 매출 섹션의 일반 표는 첫 칸 /합계/('소매 합계' — 화면 SalesTable .brf-total).
//  재고 주의 품목·고객의 소리 집계·추이 표는 합계 행 처리 없음(화면 InvTable·VoiceTable 과 같다 — 'VOC 합계'·이름에 '합계'가 든 품목을 굵게 하지 않는다).
//  '상태' 품절 빨강·부족 주황. 화면과 같은 글자 색: 재고 '버티는 날' ≤3 빨강 · 매출 섹션 '증감·대비' 열의 부호 있는 % (|값|<3 중립) ·
//  고객의 소리 '문의 중 미답변' >0 주황 · 'VOC 손해 합계' 전주보다 크면 빨강. 광고는 색 없음.
//  셀 여백은 table cellpadding(셀마다 style 을 늘어놓지 않는다 — 캠페인 30개 표 바이트). 표마다 가로 스크롤 감싸개(좁은 화면 안전망).
const STATUS_COL = /상태|구분/;
const SIGNED_PCT = /^[+\-−]\d{1,3}(\.\d+)?%$/;
const TABLE_OPEN = `<table width="100%" cellpadding="5" cellspacing="0" style="border:1px solid ${C_LINE};border-collapse:collapse;font-size:12px;line-height:1.5;color:${C_INK};"><tr style="background:${C_FOAM};color:${C_DEEP};">`;
const wrapTable = (table: string) => `<div style="margin:6px 0 10px;overflow-x:auto;">${table}</div>`;
const TD_LINE = `style="border-top:1px solid ${C_LINE};"`;
const TOTAL_TR = ` style="font-weight:700;background:${C_PAGE};"`;

// 캠페인 표(메타 11열·네이버 12열) — 메일에선 4열: 캠페인 | 지출(광고비) | 구매 | ROAS, 나머지 지표는 캠페인 이름 아래 흐린 한 줄
//  ('노출 95,025 · 링크 클릭 1,202 · CTR 1.26% · …'). 값은 하나도 빼지 않는다(열을 줄로 옮길 뿐).
//  11~12열을 그대로 그리면 표 최소 폭(약 557px)이 600px 바깥 표를 밀어내, 휴대폰(375px)에서 KPI 칸·요약·표가 화면 밖으로 잘렸다(Edge 실측 문서 폭 605px).
const campMain = (h: string, k: number) => k === 1 || h === "구매" || h === "ROAS";
function campaignTableHtml(head: string[], body: string[][]): string {
  const main = head.map((h, k) => k > 0 && campMain(h, k));
  const subCols = head.map((_, k) => k).filter((k) => k > 0 && !main[k]);
  // 숫자 열 머리글은 줄바꿈 금지('구매'가 '구/매'로 갈라지지 않게). 아래 줄은 '라벨 값' 쌍 안에서 끊기지 않게(&nbsp; + keep-all) — ' · ' 에서만 줄이 바뀐다.
  const th = `<th align="left">${inline(head[0] ?? "")}</th>${head.map((h, k) => (main[k] ? `<th align="right" style="white-space:nowrap;">${inline(h)}</th>` : "")).join("")}`;
  const rows = body.map((r) => {
    const sub = subCols.filter((k) => (r[k] ?? "") !== "").map((k) => `${esc(head[k]).replace(/ /g, "&nbsp;")}&nbsp;${inline(r[k])}`).join(" &#183; ");
    const name = `<td ${TD_LINE}>${inline(r[0] ?? "")}${sub ? `<div style="font-size:11px;line-height:1.5;font-weight:400;color:${C_MUTED};margin-top:2px;word-break:keep-all;">${sub}</div>` : ""}</td>`;
    const nums = head.map((_, k) => (main[k] ? `<td align="right" valign="top" ${TD_LINE}>${inline(r[k] ?? "")}</td>` : "")).join("");
    return `<tr${TOTAL_ROW.test(r[0] ?? "") ? TOTAL_TR : ""}>${name}${nums}</tr>`;
  }).join("");
  return wrapTable(`${TABLE_OPEN}${th}</tr>${rows}</table>`);
}

function tableHtml(head: string[], body: string[][], sec: SectionKind): string {
  const kind = tableKindOf(head[0] ?? "");
  if (kind === "campaign") return campaignTableHtml(head, body);
  const numCol = head.map((h, k) => k > 0 && !STATUS_COL.test(h));
  const stateCol = head.findIndex((h) => h === "상태");
  const daysCol = kind === "inventory" ? head.findIndex((h) => /버티는 날/.test(h)) : -1;
  const pctCol = head.map((h, k) => sec === "sales" && k > 0 && /증감|대비/.test(h));
  const isTotal = (r: string[]) => sec === "sales" && !kind && /합계/.test(r[0] ?? "");
  const colorOf = (c: string, k: number, r: string[]): string | null => {
    if (k === stateCol) return c === "품절" ? C_BAD : c === "부족" ? C_WARN : null;
    if (k === daysCol) { const m = c.match(/^(\d+)일$/); return m && Number(m[1]) <= 3 ? C_BAD : null; }
    if (pctCol[k] && SIGNED_PCT.test(c)) { const t = pctTone(parseFloat(c.replace("−", "-"))); return t === "success" ? C_GOOD : t === "danger" ? C_BAD : null; }
    if (k === 1 && r[0] === "문의 중 미답변") { const n = intOf(c); return n != null && n > 0 ? C_WARN : null; }
    if (k === 1 && r[0] === "VOC 손해 합계") { const cur = intOf(c), prev = intOf(r[2] ?? ""); return cur != null && prev != null && cur > prev ? C_BAD : null; }
    return null;
  };
  const n = Math.max(head.length, ...body.map((r) => r.length));
  const th = Array.from({ length: n }, (_, k) => `<th align="${numCol[k] ? "right" : "left"}">${inline(head[k] ?? "")}</th>`).join("");
  const rows = body.map((r) => {
    const tds = Array.from({ length: n }, (_, k) => {
      const c = r[k] ?? "", col = colorOf(c, k, r), v = inline(c);
      return `<td${numCol[k] ? ' align="right"' : ""} ${TD_LINE}>${col ? `<span style="color:${col};font-weight:700;">${v}</span>` : v}</td>`;
    }).join("");
    return `<tr${isTotal(r) ? TOTAL_TR : ""}>${tds}</tr>`;
  }).join("");
  return wrapTable(`${TABLE_OPEN}${th}</tr>${rows}</table>`);
}

// ── 섹션 본문(줄 → html) — 화면 renderBody 와 같은 줄 규칙: 연속된 | 행 = 표(구분선 건너뜀), ### 소제목, - 글머리, --- 구분선 ──
function bodyHtml(lines: string[], sec: SectionKind): string {
  const out: string[] = [];
  let codeSub = false, gap = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (tableRow(t)) {
      const rows: string[][] = [];
      for (; i < lines.length && tableRow(lines[i].trim()); i++) { const raw = lines[i].trim(); if (!tableRule(raw)) rows.push(splitRow(raw)); }
      i--;
      if (rows.length) { const [head, ...body] = rows; out.push(tableHtml(head, body, sec)); }
      gap = false;
      continue;
    }
    if (!t) { if (out.length && !gap) { out.push(SPACER); gap = true; } continue; }
    gap = false;
    if (t === "---") { out.push(`<div style="border-top:1px solid ${C_LINE};margin:10px 0;font-size:0;line-height:0;">&nbsp;</div>`); continue; }
    if (/^###\s/.test(t)) {
      codeSub = CODE_SUB.test(t);
      out.push(`<div style="font-size:14px;font-weight:700;color:${C_DEEP};margin:12px 0 4px;">${inline(t.replace(/^###\s*/, ""))}</div>`);
      continue;
    }
    if (/^-\s/.test(t)) {
      const b = t.replace(/^-\s*/, "");
      const small = codeSub && BASIS_LINE.test(b);
      out.push(`<div style="padding-left:14px;text-indent:-10px;${small ? `font-size:12px;line-height:1.6;color:${C_MUTED};` : ""}">&#183; ${inline(b)}</div>`);
      continue;
    }
    out.push(`<div>${inline(t)}</div>`);
  }
  while (out.length && out[out.length - 1] === SPACER) out.pop();
  return out.join("");
}

// ── 핵심 줄(lead) → KPI 칸 ──
//  lead 글자 = report-kpi leadText: '{라벨} {값} · {비교 기준 증감} · {배지} · {힌트}'. 라벨은 KPI 타일 라벨(아래 목록) — 맞는 라벨이 없으면 줄 전체를 값 칸에.
//  값에 ' · ' 가 든 타일(재고 '품절 N · 부족 M', 고객의 소리 '문의 N · VOC M')은 앞 두 조각이 값.
//  색: 증감(%)·'미답변 N' 조각이 있으면 그 조각만, 없으면 값(재고 품절·부족) — 화면 KPI 띠(배지·값 색)와 같은 자리.
const KPI_LABELS = ["광고비(VAT 제외)", "월말 재고 금액", "고객의 소리", "소매 매출", "월 누적", "재고"];
const LEAD_COLOR: Record<string, string> = { Good: C_GOOD, Attention: C_BAD, Warning: C_WARN };
const COLOR_PART = /([+\-]\d+(\.\d+)?%|^미답변 \d+)$/;
function leadCell(l: LeadLine): string {
  const label = KPI_LABELS.find((x) => l.text.startsWith(`${x} `)) ?? "";
  const parts = (label ? l.text.slice(label.length + 1) : l.text).split(" · ");
  const two = !!label && /^(품절|문의) /.test(parts[0]) && parts.length > 1;
  const value = label ? (two ? parts.slice(0, 2).join(" · ") : parts[0]) : l.text;
  const rest = label ? parts.slice(two ? 2 : 1) : [];
  const color = l.color ? LEAD_COLOR[l.color] ?? null : null;
  const hit = color ? rest.findIndex((p) => COLOR_PART.test(p)) : -1;
  const sub = rest.map((p, k) => (k === hit ? `<b style="color:${color};">${esc(p)}</b>` : esc(p))).join(" &#183; ");
  return `<td width="50%" style="padding:6px;" valign="top"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-radius:8px;background:#ffffff;"><tr><td style="padding:14px 16px;">`
    + (label ? `<div style="font-size:12px;color:${C_MUTED};font-weight:600;">${esc(label)}</div>` : "")
    + `<div style="font-size:${label ? 20 : 14}px;color:${color && hit < 0 ? color : C_INK};font-weight:${label ? 800 : 600};margin-top:4px;line-height:1.4;">${esc(value)}</div>`
    + (sub ? `<div style="font-size:12px;color:${C_MUTED};margin-top:4px;line-height:1.5;">${sub}</div>` : "")
    + `</td></tr></table></td>`;
}
function leadHtml(lead: LeadLine[]): string {
  if (!lead.length) return "";
  const rows: string[] = [];
  for (let i = 0; i < lead.length; i += 2) rows.push(`<tr>${leadCell(lead[i])}${lead[i + 1] ? leadCell(lead[i + 1]) : `<td width="50%" style="padding:6px;"></td>`}</tr>`);
  return `<tr><td style="padding:14px 18px 0;"><table width="100%" cellpadding="0" cellspacing="0">${rows.join("")}</table></td></tr>`;
}

// ── 강조 박스(한 줄 요약·확인할 것) — sales-report-html '요약' 박스와 같은 모양(왼쪽 C_TIDE 띠) ──
const box = (label: string, inner: string) =>
  `<tr><td style="padding:16px 24px 4px;"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-left:4px solid ${C_TIDE};border-radius:8px;background:#ffffff;"><tr><td style="padding:16px 18px;">`
  + `<div style="font-size:11px;font-weight:700;letter-spacing:1px;color:${C_TIDE};">${esc(label)}</div>${inner}</td></tr></table></td></tr>`;
const ITEM = /^(-|\d+\.)\s+/;
function todoBox(heading: string, lines: string[]): string {
  const items = lines.map((l) => l.trim()).filter((l) => ITEM.test(l)).map((l) => l.replace(ITEM, ""));
  const rest = lines.map((l) => l.trim()).filter((l) => l && !ITEM.test(l));
  const ol = items.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">${items.map((t, k) => `<tr><td width="24" valign="top" style="font-size:14px;line-height:1.7;font-weight:800;color:${C_TIDE};">${k + 1}.</td><td style="font-size:14px;line-height:1.7;color:${C_INK};">${inline(t)}</td></tr>`).join("")}</table>`
    : "";
  const tail = rest.map((t) => `<div style="font-size:14px;line-height:1.7;color:${C_INK};margin-top:4px;">${inline(t)}</div>`).join("");
  return box(`${heading}${items.length ? ` · ${items.length}건` : ""}`, ol + tail);
}

function renderHtml(p: ReportEmailInput, md: string, note?: string): string {
  // 헤더: 큰 제목 = 팀즈 제목의 앞 조각('일일 종합 리포트'), 아랫줄 = 나머지('10/12 · 소매 2,140만(-5%)' / '10/12 (매출 미반영)')
  const cut = p.title.indexOf(" · ");
  const name = cut > 0 ? p.title.slice(0, cut) : p.title;
  const sub = cut > 0 ? p.title.slice(cut + 3) : p.label;
  const eyebrow = p.period === "weekly" ? "WEEKLY REPORT" : p.period === "monthly" ? "MONTHLY REPORT" : "DAILY REPORT";
  const parts: string[] = [];
  for (const s of splitSections(md)) {
    if (s.kind === "summary") {
      const text = s.lines.map((l) => l.trim()).filter(Boolean).map((l) => inline(l.replace(/^-\s*/, ""))).join("<br>");
      parts.push(box(s.heading, `<div style="font-size:15px;font-weight:600;color:${C_INK};margin-top:6px;line-height:1.6;">${text}</div>`));
      continue;
    }
    if (s.kind === "todo") { parts.push(todoBox(s.heading, s.lines)); continue; }
    const inner = bodyHtml(s.lines, s.kind);
    if (!inner && s.kind === "pre") continue;
    const title = s.kind === "pre" ? "" : `<div style="font-size:15px;font-weight:800;color:${C_DEEP};padding-bottom:8px;border-bottom:2px solid ${C_LINE};">${inline(s.heading)}</div>`;
    parts.push(`<tr><td style="padding:20px 24px 0;">${title}<div style="padding-top:8px;font-size:14px;line-height:1.7;color:${C_INK};">${inner}</div></td></tr>`);
  }
  if (note) parts.push(`<tr><td style="padding:16px 24px 0;"><div style="font-size:13px;color:${C_MUTED};line-height:1.6;">${esc(note)}</div></td></tr>`);
  // 꼬리: 누가 무엇을 만들었나 — '1. 매출' 채널 표는 AI 가 facts 값으로 쓰고(프롬프트 지시), 코드가 붙이는 표는 광고(추이·캠페인)·재고 주의 품목·고객의 소리 집계뿐.
  //  이 메일에 실제로 든 코드 표만 이름을 대고(② 단계·옛 리포트는 없다), 그래프 안내는 광고 추이 표가 있을 때만.
  const subs = md.split("\n").map((l) => l.trim()).filter((l) => CODE_SUB.test(l));
  const has = (re: RegExp) => subs.some((l) => re.test(l));
  const codeNames = [has(/캠페인 전체|광고 추이/) ? "광고" : "", has(/재고 주의 품목/) ? "재고" : "", has(/고객의 소리 집계/) ? "고객의 소리" : ""].filter(Boolean);
  const credit = `${codeNames.length ? `${codeNames.join("·")} 표는 코드가 만들었고, ` : ""}글과 매출 표는 코드 계산값을 바탕으로 AI가 썼습니다.`
    + (has(/광고 추이/) ? " 광고 추이 그래프는 업무도우미 &#8250; 종합 리포트에서 볼 수 있습니다." : "");
  // 600px 바깥 표는 table-layout:fixed — 안쪽 표가 넓어도 바깥 폭(휴대폰은 화면 폭)을 밀어내지 않고 그 표의 감싸개 안에서만 가로 스크롤
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${C_PAGE};font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="${C_PAGE}"><tr><td align="center" style="padding:0;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;table-layout:fixed;">
<tr><td style="background:${C_DEEP};padding:28px 24px;">
<div style="font-size:11px;letter-spacing:2px;color:${C_EYEBROW};font-weight:600;">SEAMONSTER &#183; ${eyebrow}</div>
<div style="font-size:22px;color:#ffffff;font-weight:800;margin-top:6px;">${esc(name)}</div>
<div style="font-size:13px;color:${C_HEADSUB};margin-top:4px;">${p.period === "daily" ? "기준일" : "기간"} ${esc(sub)}</div>
</td></tr>
${leadHtml(p.lead)}
${parts.join("\n")}
<tr><td style="padding:24px 24px 40px;">
<div style="font-size:11px;color:${C_MUTED};line-height:1.6;border-top:1px solid ${C_LINE};padding-top:14px;">
${credit}<br>
씨몬스터 ${esc(name)} &#183; 자동 생성
</div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ① 캠페인 표(머리 첫 칸 '… 캠페인' — report-sections TABLE_KIND)만 지출 상위 limit 개 + 합계 행(TOTAL_ROW). 다른 표·글은 그대로.
export function campaignTablesTop(md: string, limit: number): string {
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const head = tableRow(t) ? splitRow(t) : null;
    if (!head || !TABLE_KIND.campaign.test(head[0] ?? "")) { out.push(lines[i]); continue; }
    out.push(t);
    const rows: string[] = [];
    for (i++; i < lines.length && tableRow(lines[i].trim()); i++) { const raw = lines[i].trim(); if (tableRule(raw)) out.push(raw); else rows.push(raw); }
    i--;
    const isTotal = (raw: string) => TOTAL_ROW.test(splitRow(raw)[0] ?? "");
    const body = rows.filter((r) => !isTotal(r)), total = rows.filter(isTotal);
    out.push(...body.slice(0, limit), ...total);
    if (body.length > limit) out.push(`- 외 ${body.length - limit}개는 업무도우미 › 종합 리포트에서 볼 수 있습니다`);
  }
  return out.join("\n");
}

/** 종합 리포트 메일 — subject = 팀즈 카드 제목, html = 600px 테이블 메일, text = 마크다운 그대로(굵게 기호만 제거). md 는 팀즈 축약 전 원본. */
export function buildReportEmail(p: ReportEmailInput): ReportEmail {
  const voice = hasVoiceBlock(p.md);
  const stages: { stage: ReportEmailStage; md: () => string; note?: string }[] = [
    { stage: "full", md: () => p.md },
    { stage: "campaign-top10", md: () => campaignTablesTop(p.md, 10) },
    { stage: "no-code-tables", md: () => stripCodeBlocks(p.md), note: `${voice ? "광고·재고·고객의 소리" : "광고·재고"} 표는 업무도우미 › 종합 리포트에서 볼 수 있습니다.` },
  ];
  let pick: { stage: ReportEmailStage; md: string; note?: string; html: string; bytes: number } | null = null;
  for (const s of stages) {
    const md = s.md();
    if (pick && md === pick.md && s.note === pick.note) continue; // 이 단계로 줄어드는 게 없다(캠페인 10개 이하)
    const html = renderHtml(p, md, s.note);
    pick = { stage: s.stage, md, note: s.note, html, bytes: Buffer.byteLength(html, "utf8") };
    if (pick.bytes <= REPORT_MAIL_MAX_BYTES) break;
  }
  const f = pick!;
  const text = [p.title, "", ...p.lead.map((l) => `- ${l.text}`), ...(p.lead.length ? [""] : []), f.md.replace(/\*\*/g, ""), ...(f.note ? ["", f.note] : [])].join("\n");
  return { subject: p.title, html: f.html, text, bytes: f.bytes, stage: f.stage };
}
