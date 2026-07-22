// 일일 매출 리포트 HTML 이메일 — 파이썬 build_daily_html 1:1 이식(테이블 기반, 이메일 안전).
//  이메일은 CSS 변수 불가 → 색상 하드코딩(디자인토큰 예외). DailyStats(sales-report.ts) 소비.
import type { DailyStats, WeeklyStats } from "./sales-report";

const C_DEEP = "#0d3b52", C_TIDE = "#1b6e8c", C_FOAM = "#eef6f8", C_LINE = "#d4e3e8",
  C_INK = "#0a1d2e", C_MUTED = "#5a7480", C_GOOD = "#1a8a5a", C_WARN = "#c2410c",
  C_BAD = "#b91c1c", C_TRACK = "#eef6f8";

// 업로드 원본에서 온 문자열(채널명·SKU·코드·날짜)은 HTML로 렌더되므로 반드시 이스케이프(마크업 깨짐·주입 방지).
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
const won = (v: number) => `${Math.round(v).toLocaleString()}원`;
function wonEok(v: number): string {
  v = Math.round(v);
  const eok = Math.floor(v / 100000000), man = Math.floor((v % 100000000) / 10000);
  return eok > 0 ? `${eok}억 ${man.toLocaleString()}만 원` : `${man.toLocaleString()}만 원`;
}
function pctLabel(p: number | null): [string, string] {
  if (p === null) return ["신규", C_MUTED];
  if (p >= 0) return [`+${p.toFixed(1)}%`, C_GOOD];
  return [`${p.toFixed(1)}%`, p <= -30 ? C_BAD : p <= -10 ? C_WARN : C_GOOD];
}

export function buildDailyHtml(s: DailyStats): string {
  const { year, month, day } = s;
  const daysInMonth = new Date(year, month, 0).getDate();

  // KPI 4칸
  const kpiCell = (label: string, value: string, sub: string) => `
    <td width="50%" style="padding:6px;" valign="top">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-radius:8px;">
        <tr><td style="padding:14px 16px;">
          <div style="font-size:12px;color:${C_MUTED};font-weight:600;">${label}</div>
          <div style="font-size:20px;color:${C_INK};font-weight:800;margin-top:4px;">${value}</div>
          <div style="font-size:12px;margin-top:3px;font-weight:600;">${sub}</div>
        </td></tr>
      </table>
    </td>`;

  const windowLabel = s.is_sunday ? "최근 3일(금~일)" : "어제";
  let daySub: string;
  if (!s.is_sunday && s.prevday_sales != null) {
    const diff = s.window_sales - s.prevday_sales;
    daySub = diff > 0 ? `<span style="color:${C_GOOD}">&#9650; ${won(diff)} (전일 대비)</span>`
      : diff < 0 ? `<span style="color:${C_BAD}">&#9660; ${won(-diff)} (전일 대비)</span>`
        : `<span style="color:${C_MUTED}">전일과 동일</span>`;
  } else daySub = `<span style="color:${C_MUTED}">${esc(s.window_start)} ~ ${esc(s.window_end)}</span>`;

  const kpiHtml = `
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>${kpiCell(`${windowLabel} 매출`, won(s.window_sales), daySub)}${kpiCell("객단가", won(s.aov), `<span style="color:${C_MUTED}">주문 ${s.order_count}건</span>`)}</tr>
      <tr>${kpiCell("신규 : 재구매", `${s.new_ratio.toFixed(0)} : ${s.repeat_ratio.toFixed(0)}`, `<span style="color:${C_MUTED}">신규 ${s.new_cust} / 재구매 ${s.repeat_cust}명${s.unclassified_orders > 0 ? ` &middot; 미분류 ${s.unclassified_orders}건` : ""}</span>`)}${kpiCell("최고 / 최저 건", `${won(s.max_order)} / ${won(s.min_order)}`, `<span style="color:${C_MUTED}">${esc(s.max_order_codes)} / ${esc(s.min_order_codes)}</span>`)}</tr>
    </table>`;

  // 누적 2칸
  const [yrLbl, yrCol] = pctLabel(s.year_rr_pct);
  const [moLbl, moCol] = pctLabel(s.month_rr_pct);
  const cumulativeHtml = `
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="50%" style="padding:6px;" valign="top">
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-radius:8px;background:#ffffff;"><tr><td style="padding:14px 16px;">
          <div style="font-size:11px;color:${C_MUTED};font-weight:700;">이번달 누적 · ${month}/1~${month}/${day}</div>
          <div style="font-size:19px;color:${C_INK};font-weight:800;margin-top:6px;">${wonEok(s.this_month_sales)}</div>
          <div style="font-size:12px;color:${C_MUTED};margin-top:4px;line-height:1.5;">같은 기간 환산 전월 대비 <b style="color:${moCol}">${moLbl}</b><br>(30일 환산 약 ${wonEok(s.month_runrate)})</div>
        </td></tr></table>
      </td>
      <td width="50%" style="padding:6px;" valign="top">
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-radius:8px;background:#ffffff;"><tr><td style="padding:14px 16px;">
          <div style="font-size:11px;color:${C_MUTED};font-weight:700;">올해 누적 · 1/1~${month}/${day}</div>
          <div style="font-size:19px;color:${C_INK};font-weight:800;margin-top:6px;">${wonEok(s.this_year_sales)}</div>
          <div style="font-size:12px;color:${C_MUTED};margin-top:4px;line-height:1.5;">전년 대비 페이스 <b style="color:${yrCol}">${yrLbl}</b><br>(연 환산 약 ${wonEok(s.year_runrate)} / 전년 ${wonEok(s.last_year_sales)})</div>
        </td></tr></table>
      </td>
    </tr></table>`;

  // 채널별(월 환산)
  const chSorted = [...s.channels].sort((a, b) => s.channel_summary[b].month - s.channel_summary[a].month);
  const monthTotal = s.this_month_sales || 1;
  const maxCm = Math.max(1, ...s.channels.map((c) => s.channel_summary[c].month));
  const chRows = chSorted.map((ch) => {
    const cs = s.channel_summary[ch];
    const cmRr = day > 0 ? cs.month / day * daysInMonth : 0;
    const p = cs.prev_month === 0 ? null : (cmRr - cs.prev_month) / cs.prev_month * 100;
    const [lbl, col] = cs.month === 0 && cs.prev_month === 0 ? ["매출 없음", C_MUTED] : pctLabel(p);
    const share = cs.month / monthTotal * 100;
    const barPct = cs.month > 0 ? Math.max(1, Math.round(cs.month / maxCm * 100)) : 0;
    const barColor = p != null && p <= -30 ? C_BAD : p != null && p <= -10 ? C_WARN : C_TIDE;
    const bar = cs.month > 0
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr><td width="${barPct}%" bgcolor="${barColor}" style="height:8px;font-size:0;line-height:0;border-radius:4px 0 0 4px;">&nbsp;</td><td bgcolor="${C_TRACK}" style="height:8px;font-size:0;line-height:0;border-radius:0 4px 4px 0;">&nbsp;</td></tr></table>`
      : `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr><td bgcolor="${C_TRACK}" style="height:8px;font-size:0;line-height:0;border-radius:4px;">&nbsp;</td></tr></table>`;
    return `<tr><td style="padding:12px 0;border-bottom:1px solid ${C_LINE};">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:14px;font-weight:700;color:${C_INK};">${esc(ch)} <span style="font-size:12px;color:${C_MUTED};font-weight:600;">비중 ${share.toFixed(1)}%</span></td>
        <td align="right" style="font-size:14px;font-weight:700;color:${C_INK};">${won(cs.month)}</td>
      </tr></table>${bar}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr>
        <td style="font-size:12px;color:${C_MUTED};">월 환산 약 ${wonEok(cmRr)}</td>
        <td align="right" style="font-size:12px;font-weight:700;color:${col};">${lbl}</td>
      </tr></table>
    </td></tr>`;
  }).join("");
  const channelsHtml = `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-radius:8px;"><tr><td style="padding:4px 18px;"><table width="100%" cellpadding="0" cellspacing="0">${chRows}</table></td></tr></table>`;

  // Top10 SKU
  const skuRows = s.top10.map((t) => {
    const isTop3 = t.rank <= 3;
    const badgeBg = isTop3 ? C_DEEP : C_FOAM, badgeCol = isTop3 ? "#ffffff" : C_DEEP;
    return `<tr><td style="padding:11px 18px;border-bottom:1px solid ${C_LINE};">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="28"><div style="width:22px;height:22px;background:${badgeBg};color:${badgeCol};border-radius:6px;font-size:12px;font-weight:800;text-align:center;line-height:22px;">${t.rank}</div></td>
        <td style="font-size:13px;font-weight:600;color:${C_INK};font-family:monospace;padding-left:12px;">${esc(t.code)}</td>
        <td align="right" style="font-size:14px;font-weight:700;color:${C_INK};">${won(t.revenue)}</td>
      </tr></table></td></tr>`;
  }).join("");
  const skuHtml = `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-radius:8px;">${skuRows}</table>`;

  // 요약 한 줄
  let summary: string;
  if (s.year_rr_pct === null) summary = "올해 누적 매출이 집계되었습니다.";
  else if (Math.abs(s.year_rr_pct) < 5) summary = "기간을 맞춰 환산하면 매출 페이스는 <b>전년 수준</b>입니다.";
  else if (s.year_rr_pct >= 5) summary = `기간을 맞춰 환산하면 매출 페이스는 전년보다 <b style="color:${C_GOOD}">약 ${s.year_rr_pct.toFixed(0)}% 높습니다.</b>`;
  else summary = `기간을 맞춰 환산하면 매출 페이스는 전년보다 <b style="color:${C_BAD}">약 ${Math.abs(s.year_rr_pct).toFixed(0)}% 낮습니다.</b>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7fafb;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f7fafb"><tr><td align="center" style="padding:0;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:${C_DEEP};padding:28px 24px;">
    <div style="font-size:11px;letter-spacing:2px;color:#9fc4d2;font-weight:600;">SEAMONSTER &#183; DAILY SALES</div>
    <div style="font-size:22px;color:#ffffff;font-weight:800;margin-top:6px;">일일 매출 보고서</div>
    <div style="font-size:13px;color:#cfe2e9;margin-top:4px;">기준일 ${esc(s.date_str)}</div>
  </td></tr>
  <tr><td style="padding:20px 24px 4px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-left:4px solid ${C_TIDE};border-radius:8px;background:#ffffff;"><tr><td style="padding:16px 18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:${C_TIDE};">요약</div>
      <div style="font-size:15px;font-weight:600;color:${C_INK};margin-top:6px;line-height:1.5;">${summary}</div>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:18px 18px 0;">
    <div style="font-size:13px;font-weight:800;color:${C_DEEP};padding:0 6px 8px;border-bottom:2px solid ${C_LINE};margin:0 6px;">1. ${windowLabel} 실적</div>
    ${kpiHtml}
  </td></tr>
  <tr><td style="padding:14px 18px 0;">
    <div style="font-size:13px;font-weight:800;color:${C_DEEP};padding:0 6px 8px;border-bottom:2px solid ${C_LINE};margin:0 6px;">2. 누적 실적</div>
    ${cumulativeHtml}
  </td></tr>
  <tr><td style="padding:18px 24px 0;">
    <div style="font-size:13px;font-weight:800;color:${C_DEEP};padding-bottom:8px;border-bottom:2px solid ${C_LINE};">3. 채널별 이번달 현황 (월 환산 기준)</div>
    <div style="height:10px;"></div>${channelsHtml}
  </td></tr>
  <tr><td style="padding:18px 24px 0;">
    <div style="font-size:13px;font-weight:800;color:${C_DEEP};padding-bottom:8px;border-bottom:2px solid ${C_LINE};">4. ${windowLabel} 잘 팔린 상품 Top 10</div>
    <div style="height:10px;"></div>${skuHtml}
  </td></tr>
  <tr><td style="padding:24px 24px 40px;">
    <div style="font-size:11px;color:${C_MUTED};line-height:1.6;border-top:1px solid ${C_LINE};padding-top:14px;">
      전월&#183;전년 비교는 각각 전체 기간(전월 전체, 전년 전체) 기준입니다. 같은 길이로 맞추려 30일&#183;연 환산을 적용했습니다.<br>
      30일&#183;연 환산은 단순 비례 추정이며, 월말 정산&#183;시즌성은 반영되지 않습니다.<br>
      씨몬스터 일일 매출 보고서 &#183; 자동 생성
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// 주간 매출 리포트 HTML — 일일과 동일 디자인(표·바). WeeklyStats 소비.
export function buildWeeklyHtml(s: WeeklyStats): string {
  const period = `${esc(s.week_start)} ~ ${esc(s.week_end)}`;

  const kpiCell = (label: string, value: string, sub: string) => `
    <td width="50%" style="padding:6px;" valign="top">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-radius:8px;">
        <tr><td style="padding:14px 16px;">
          <div style="font-size:12px;color:${C_MUTED};font-weight:600;">${label}</div>
          <div style="font-size:20px;color:${C_INK};font-weight:800;margin-top:4px;">${value}</div>
          <div style="font-size:12px;margin-top:3px;font-weight:600;">${sub}</div>
        </td></tr>
      </table>
    </td>`;

  const diff = s.week_sales - s.prev_week_sales;
  const weekSub = diff > 0 ? `<span style="color:${C_GOOD}">&#9650; ${won(diff)} (전주 대비)</span>`
    : diff < 0 ? `<span style="color:${C_BAD}">&#9660; ${won(-diff)} (전주 대비)</span>`
      : `<span style="color:${C_MUTED}">전주와 동일</span>`;

  const kpiHtml = `
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>${kpiCell("주간 매출", won(s.week_sales), weekSub)}${kpiCell("객단가", won(s.aov), `<span style="color:${C_MUTED}">주문 ${s.order_count}건</span>`)}</tr>
      <tr>${kpiCell("신규 : 재구매", `${s.new_ratio.toFixed(0)} : ${s.repeat_ratio.toFixed(0)}`, `<span style="color:${C_MUTED}">신규 ${s.new_cust} / 재구매 ${s.repeat_cust}명${s.unclassified_orders > 0 ? ` &middot; 미분류 ${s.unclassified_orders}건` : ""}</span>`)}${kpiCell("최고 / 최저 건", `${won(s.max_order)} / ${won(s.min_order)}`, `<span style="color:${C_MUTED}">${esc(s.max_codes)} / ${esc(s.min_codes)}</span>`)}</tr>
    </table>`;

  // 채널별 주간(전주 대비)
  const chSorted = [...s.channels].sort((a, b) => b.week - a.week);
  const weekTotal = s.week_sales || 1;
  const maxCw = Math.max(1, ...s.channels.map((c) => c.week));
  const chRows = chSorted.map((c) => {
    const p = c.prev_week === 0 ? null : (c.week - c.prev_week) / c.prev_week * 100;
    const [lbl, col] = c.week === 0 && c.prev_week === 0 ? ["매출 없음", C_MUTED] : pctLabel(p);
    const share = c.week / weekTotal * 100;
    const barPct = c.week > 0 ? Math.max(1, Math.round(c.week / maxCw * 100)) : 0;
    const barColor = p != null && p <= -30 ? C_BAD : p != null && p <= -10 ? C_WARN : C_TIDE;
    const bar = c.week > 0
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr><td width="${barPct}%" bgcolor="${barColor}" style="height:8px;font-size:0;line-height:0;border-radius:4px 0 0 4px;">&nbsp;</td><td bgcolor="${C_TRACK}" style="height:8px;font-size:0;line-height:0;border-radius:0 4px 4px 0;">&nbsp;</td></tr></table>`
      : `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr><td bgcolor="${C_TRACK}" style="height:8px;font-size:0;line-height:0;border-radius:4px;">&nbsp;</td></tr></table>`;
    return `<tr><td style="padding:12px 0;border-bottom:1px solid ${C_LINE};">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:14px;font-weight:700;color:${C_INK};">${esc(c.name)} <span style="font-size:12px;color:${C_MUTED};font-weight:600;">비중 ${share.toFixed(1)}%</span></td>
        <td align="right" style="font-size:14px;font-weight:700;color:${C_INK};">${won(c.week)}</td>
      </tr></table>${bar}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr>
        <td style="font-size:12px;color:${C_MUTED};">전주 ${won(c.prev_week)}</td>
        <td align="right" style="font-size:12px;font-weight:700;color:${col};">${lbl}</td>
      </tr></table>
    </td></tr>`;
  }).join("");
  const channelsHtml = `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-radius:8px;"><tr><td style="padding:4px 18px;"><table width="100%" cellpadding="0" cellspacing="0">${chRows}</table></td></tr></table>`;

  const skuRows = s.top10.map((t) => {
    const isTop3 = t.rank <= 3;
    const badgeBg = isTop3 ? C_DEEP : C_FOAM, badgeCol = isTop3 ? "#ffffff" : C_DEEP;
    return `<tr><td style="padding:11px 18px;border-bottom:1px solid ${C_LINE};">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="28"><div style="width:22px;height:22px;background:${badgeBg};color:${badgeCol};border-radius:6px;font-size:12px;font-weight:800;text-align:center;line-height:22px;">${t.rank}</div></td>
        <td style="font-size:13px;font-weight:600;color:${C_INK};font-family:monospace;padding-left:12px;">${esc(t.code)}</td>
        <td align="right" style="font-size:14px;font-weight:700;color:${C_INK};">${won(t.revenue)}</td>
      </tr></table></td></tr>`;
  }).join("");
  const skuHtml = `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-radius:8px;">${skuRows}</table>`;

  const wp = s.prev_week_sales === 0 ? null : (s.week_sales - s.prev_week_sales) / s.prev_week_sales * 100;
  let summary: string;
  if (wp === null) summary = "이번 주 매출이 집계되었습니다.";
  else if (Math.abs(wp) < 5) summary = "이번 주 매출은 <b>전주 수준</b>입니다.";
  else if (wp >= 5) summary = `이번 주 매출은 전주보다 <b style="color:${C_GOOD}">약 ${wp.toFixed(0)}% 높습니다.</b>`;
  else summary = `이번 주 매출은 전주보다 <b style="color:${C_BAD}">약 ${Math.abs(wp).toFixed(0)}% 낮습니다.</b>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7fafb;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f7fafb"><tr><td align="center" style="padding:0;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:${C_DEEP};padding:28px 24px;">
    <div style="font-size:11px;letter-spacing:2px;color:#9fc4d2;font-weight:600;">SEAMONSTER &#183; WEEKLY SALES</div>
    <div style="font-size:22px;color:#ffffff;font-weight:800;margin-top:6px;">주간 매출 보고서</div>
    <div style="font-size:13px;color:#cfe2e9;margin-top:4px;">${period}</div>
  </td></tr>
  <tr><td style="padding:20px 24px 4px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C_LINE};border-left:4px solid ${C_TIDE};border-radius:8px;background:#ffffff;"><tr><td style="padding:16px 18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:${C_TIDE};">요약</div>
      <div style="font-size:15px;font-weight:600;color:${C_INK};margin-top:6px;line-height:1.5;">${summary} (전주 ${won(s.prev_week_sales)})</div>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:18px 18px 0;">
    <div style="font-size:13px;font-weight:800;color:${C_DEEP};padding:0 6px 8px;border-bottom:2px solid ${C_LINE};margin:0 6px;">1. 주간 실적</div>
    ${kpiHtml}
  </td></tr>
  <tr><td style="padding:18px 24px 0;">
    <div style="font-size:13px;font-weight:800;color:${C_DEEP};padding-bottom:8px;border-bottom:2px solid ${C_LINE};">2. 채널별 주간 현황 (전주 대비)</div>
    <div style="height:10px;"></div>${channelsHtml}
  </td></tr>
  <tr><td style="padding:18px 24px 0;">
    <div style="font-size:13px;font-weight:800;color:${C_DEEP};padding-bottom:8px;border-bottom:2px solid ${C_LINE};">3. 이번 주 잘 팔린 상품 Top 10</div>
    <div style="height:10px;"></div>${skuHtml}
  </td></tr>
  <tr><td style="padding:24px 24px 40px;">
    <div style="font-size:11px;color:${C_MUTED};line-height:1.6;border-top:1px solid ${C_LINE};padding-top:14px;">
      주간은 월&#126;일 기준이며, 전주는 직전 주(월&#126;일) 전체와 비교합니다.<br>
      씨몬스터 주간 매출 보고서 &#183; 자동 생성
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
