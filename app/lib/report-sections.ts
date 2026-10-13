// 종합 리포트(일일·주간·월간) 구성 — 섹션 순서·코드 표 끼우기·재고 표·팀즈 축약(순수 함수, DB 코드 없음).
//  2026-10-01 대표 결정: 데이터(1. 매출 → 2. 광고 → 3. 재고) → 4. 눈에 띄는 변화와 원인 → 5. 확인할 것. '한 줄 요약'은 맨 위 유지.
//  AI 는 각 섹션의 글만 쓰고, 숫자 표(광고 추이·캠페인·재고 주의 품목)는 코드가 그 섹션 끝에 끼운다.
//  2026-10-12 대표 요청: 주간만 3. 재고 다음에 '4. 고객의 소리'(스마트스토어 문의·VOC, report-voice.ts) — 변화와 원인·확인할 것은 5·6.
//   그 섹션 끝의 '고객의 소리 집계' 표는 주간 명세가 Built.sectionBlocks 로 넘기고 runReport 가 끼운다(일일·월간은 그대로).

// ── 재고 사실(analyst-inventory 가 모은다) ──
export type InvFlowRow = { kind: string; qty: number; net: number; items: number; cost: number };
export type InvWatchRow = { name: string; stock: number; daily: number; days: number | null; inbound: number; due: string | null; state: "품절" | "부족" };
export type InventoryFacts = {
  ok: boolean;
  note?: string;                 // 실패·생략 사유
  basis: string;                 // 기준 설명(AI·표 아래 한 줄)
  now: null | {                  // 지금(리포트를 만든 시각) 기준 — 끝난 지 7일 넘은 기간은 null
    at: string;
    soldout: number;             // 품절 = 소매 현재고 0 이하 + 최근 30일 출고 있음
    short: number;               // 부족 = 현재고 + 입고 예정 < 부족 기준(생산요청 화면과 같은 기준), 품절 제외
    soldout_top: string[];
    urgent_top: { name: string; days: number | null; request_by_days: number | null }[];
    inbound_total: number;       // 오는 중 = 열린 제조사 요청서(재고 보충) 잔여 합
    inbound_overdue: number;     // 그중 마감 지난 잔여
    overdue_requests: number | null; // 마감 지난 열린 요청서 수(집계 실패 시 null)
    watch: InvWatchRow[];        // 재고 주의 품목 표(최대 6행)
  };
  flow?: { cur: InvFlowRow[]; prev?: InvFlowRow[] }; // 기간 원장 합계(완료분, 칸 이동 제외) — 입고·판매 출고·B2B 출고·폐기·협찬·기타·조정
  zeroed?: { name: string; zero_days: number; first_zero: string }[];   // 주간·월간: 기간 중 원장상 소매 재고 0 이하였던 품목과 달력 일수
  value?: { end: number; prev_end: number; neg_items: number };         // 월간: 월말·전월말 재고 금액(현재 원가)
  purchase?: { amount: number; basis: "확정" | "잠정"; no_price_qty?: number }; // 월간: 매입액
};

const won = (n: number | null | undefined) => (n == null ? "-" : Math.round(n).toLocaleString("ko-KR"));
const qty = (n: number) => (Math.round(n * 10) / 10).toLocaleString("ko-KR");
const cell = (s: string) => s.replace(/[|\r\n]+/g, "/").replace(/\s+/g, " ").trim().slice(0, 40) || "-";

// '재고 주의 품목' 표 — 머리 첫 칸이 '… 품목'이라 팀즈에선 adTablesForTeams 가 한 줄씩으로 바꾼다.
//  머리·행 칸은 화면(/briefing)이 facts.inventory.now.watch 로 같은 표를 직접 그릴 때도 쓴다(상태 배지·data-label 을 정확히).
export const INV_WATCH_HEAD = ["재고 품목", "현재고", "하루 출고", "버티는 날", "입고 예정", "상태"] as const;
export function watchCells(r: InvWatchRow): string[] {
  const due = r.inbound > 0 ? `${qty(r.inbound)}${r.due ? ` (${r.due.slice(5)})` : ""}` : "-";
  return [cell(r.name), qty(r.stock), qty(r.daily), r.days == null ? "-" : `${r.days}일`, due, r.state];
}
export function renderInventoryTable(inv: InventoryFacts | null | undefined): string {
  const w = inv?.ok ? inv.now?.watch ?? [] : [];
  if (!inv?.ok || !inv.now) return "";
  const out = [`### 재고 주의 품목 (지금 기준)`];
  if (!w.length) out.push("- 품절·부족 품목 없음");
  else {
    out.push(`| ${INV_WATCH_HEAD.join(" | ")} |`, `|${INV_WATCH_HEAD.map(() => "---").join("|")}|`);
    for (const r of w) out.push(`| ${watchCells(r).join(" | ")} |`);
  }
  out.push("", `- ${inv.basis}`);
  if (inv.note) out.push(`- 주의: ${inv.note}`);
  return out.join("\n");
}

// ── 섹션 끝에 블록 끼우기 ──
//  heading 이 '## 2. 광고'·'## 광고' 둘 다 맞게 번호는 선택. 섹션이 없으면 fallbacks 순서로 그 헤딩 앞, 다 없으면 맨 끝.
//  summary·sales 는 화면(/briefing) 섹션 분할용(2026-10-13) — 끼우기엔 쓰지 않는다.
export const SEC = {
  summary: /^##\s*(\d+\.\s*)?한 줄 요약/,
  sales: /^##\s*(\d+\.\s*)?매출/,
  ad: /^##\s*(\d+\.\s*)?광고/,
  inv: /^##\s*(\d+\.\s*)?재고/,
  voice: /^##\s*(\d+\.\s*)?고객의 소리/, // 주간만
  change: /^##\s*(\d+\.\s*)?눈에 띄는/,
  todo: /^##\s*(\d+\.\s*)?(오늘\s*)?확인할 것/,
};
export type SectionKind = keyof typeof SEC | "other" | "pre";
export type ReportSection = { kind: SectionKind; heading: string; lines: string[] }; // lines = 헤딩 줄 뺀 본문(원문 그대로)
const SEC_ORDER = Object.keys(SEC) as (keyof typeof SEC)[];
export const sectionKindOf = (heading: string): SectionKind => SEC_ORDER.find((k) => SEC[k].test(heading)) ?? "other";
// '## ' 헤딩마다 섹션으로 나눈다(순수 함수, 재배열 없음). 첫 헤딩 앞 글은 kind 'pre'(헤딩이 하나도 없으면 전체가 'pre' 하나 = 평탄 렌더 폴백).
export function splitSections(md: string): ReportSection[] {
  const out: ReportSection[] = [];
  let cur: ReportSection = { kind: "pre", heading: "", lines: [] };
  for (const l of md.split("\n")) {
    const t = l.trim();
    if (/^##\s/.test(t)) {
      if (cur.kind !== "pre" || cur.lines.some((x) => x.trim())) out.push(cur);
      cur = { kind: sectionKindOf(t), heading: t.replace(/^##\s*/, ""), lines: [] };
      continue;
    }
    cur.lines.push(l);
  }
  if (cur.kind !== "pre" || cur.lines.some((x) => x.trim()) || !out.length) out.push(cur);
  return out;
}

// ── 코드 표 식별 — 화면(접기·배지)과 팀즈 축약(adTablesForTeams)이 같은 규칙을 쓴다 ──
//  머리 첫 칸: '메타 캠페인'·'네이버 캠페인'(캠페인 전체) / '메타 추이'·'네이버 추이'(광고 추이) / '재고 품목'(재고 주의 품목).
//  합계 행 = renderAdTables 의 '합계 N개'('합계세일' 같은 캠페인 이름은 제외).
export const TABLE_KIND = { campaign: /캠페인$/, trend: /추이$/, inventory: /품목$/ } as const;
export type TableKind = keyof typeof TABLE_KIND;
export const tableKindOf = (head0: string): TableKind | null => (Object.keys(TABLE_KIND) as TableKind[]).find((k) => TABLE_KIND[k].test(head0)) ?? null;
export const TOTAL_ROW = /^합계 \d+개/;
export const CAMPAIGN_TOP = 5; // 캠페인 전체 표 기본 표시 = 합계 + 지출 상위 N(대표 결정 4)
export function insertAtSectionEnd(md: string, section: RegExp, block: string, fallbacks: RegExp[]): string {
  if (!block) return md;
  const lines = md.split("\n");
  const at0 = lines.findIndex((l) => section.test(l.trim()));
  let at = -1;
  if (at0 >= 0) { at = lines.findIndex((l, i) => i > at0 && /^##\s/.test(l.trim())); if (at < 0) at = lines.length; }
  else for (const f of fallbacks) { at = lines.findIndex((l) => f.test(l.trim())); if (at >= 0) break; }
  if (at < 0) return `${md.trimEnd()}\n\n${block}`;
  return [...lines.slice(0, at), block, "", ...lines.slice(at)].join("\n");
}

// 광고(추이 → 캠페인 상세) + 재고 표를 각 섹션 끝에. 광고 섹션이 없으면 재고·(주간)고객의 소리·변화 앞, 재고 섹션이 없으면 (주간)고객의 소리·변화·확인 앞.
//  고객의 소리 헤딩은 주간에만 있어 일일·월간은 종전 순서(변화·확인 앞) 그대로다.
export function withCodeTables(md: string, adBlocks: { trend: string; campaigns: string }, invBlock: string): string {
  const ad = [adBlocks.trend, adBlocks.campaigns].filter(Boolean).join("\n\n");
  let out = insertAtSectionEnd(md, SEC.ad, ad, [SEC.inv, SEC.voice, SEC.change, SEC.todo]);
  out = insertAtSectionEnd(out, SEC.inv, invBlock, [SEC.voice, SEC.change, SEC.todo]);
  return out;
}

// ── 팀즈 축약 ──
//  '고객의 소리 집계'(주간만) — 적응형 카드에서 표 한 행이 ColumnSet 이라 줄글보다 훨씬 크다. 카드 한도를 넘으면
//  sendReport(analyst.ts, 팀즈 본문) 가 ① 이 표만 한 줄씩 → ② 이 블록만 빼기 → ③ 코드 표 전부 빼기 순으로 줄인다(블록이 없는 일일·월간은 ①② 건너뜀).
export const VOICE_BLOCK = "고객의 소리 집계";
export const VOICE_HEAD = new RegExp(`^###\\s*${VOICE_BLOCK}`);
// 마크다운 표 줄 — 화면 렌더러·팀즈 축약 공용('| … |' 한 줄, 구분선 |---| 은 건너뛴다)
export const tableRow = (t: string) => /^\|.*\|$/.test(t);
export const tableRule = (t: string) => /^\|[\s|:-]+\|$/.test(t);
export const splitRow = (t: string) => t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
export const hasVoiceBlock = (md: string) => md.split("\n").some((l) => VOICE_HEAD.test(l.trim()));
// ① '고객의 소리 집계' 표만 '- 구분 · {기간} N · 전주 M' 한 줄씩으로(표 아래 기준·주의 줄은 그대로). 다른 표는 건드리지 않는다.
export function voiceTableAsLines(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inVoice = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^##/.test(t)) inVoice = VOICE_HEAD.test(t); // 다음 헤딩(## · ###)에서 블록이 끝난다
    if (!inVoice || !tableRow(t)) { out.push(lines[i]); continue; }
    const rows: string[][] = [];
    for (; i < lines.length && tableRow(lines[i].trim()); i++) {
      const raw = lines[i].trim();
      if (!/^\|[\s|:-]+\|$/.test(raw)) rows.push(splitRow(raw));
    }
    i--;
    const [head = [], ...body] = rows;
    for (const r of body) out.push(`- ${r[0]} · ${r.slice(1).map((c, k) => `${head[k + 1] ?? ""} ${c}`.trim()).join(" · ")}`);
  }
  return out.join("\n");
}

// 팀즈 마지막 안전장치 — 코드 표 블록(### 캠페인 전체·광고 추이·재고 주의 품목·고객의 소리 집계)을 통째로 빼고 AI 글만 남긴다.
//  예전엔 한도를 넘으면 본문 전체를 안내 한 줄로 바꿔 AI 분석까지 사라졌다. names 를 주면 그 블록만 뺀다(② 단계).
const CODE_BLOCKS = ["캠페인 전체", "광고 추이", "재고 주의 품목", VOICE_BLOCK] as const;
export function stripCodeBlocks(md: string, names: readonly string[] = CODE_BLOCKS): string {
  const head = new RegExp(`^###\\s*(${names.join("|")})`);
  const lines = md.split("\n");
  const out: string[] = [];
  let skip = false;
  for (const l of lines) {
    const t = l.trim();
    if (head.test(t)) { skip = true; continue; }
    if (skip && /^##/.test(t)) skip = false;
    if (!skip) out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

// AI 용 재고 사실 — 표 행(watch)은 코드가 그리므로 빼고 짧게. 비교(전기 수량·증감률·재고 금액 차이)는 코드가 계산해 넣는다
//  (프롬프트 규칙: AI 는 새로 계산하지 않고 facts 의 값만 인용).
const pctOf = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
export function inventoryForAi(inv: InventoryFacts | null | undefined): Record<string, unknown> | null {
  if (!inv) return null;
  if (!inv.ok) return { ok: false, note: inv.note };
  const { now, flow, value, ...rest } = inv;
  const flowAi = flow && {
    cur: flow.prev
      ? flow.cur.map((r) => { const p = flow.prev!.find((x) => x.kind === r.kind)?.qty ?? 0; return { ...r, prev_qty: p, qty_vs_prev_pct: pctOf(r.qty, p) }; })
      : flow.cur,
    ...(flow.prev ? { prev: flow.prev } : {}),
  };
  const valueAi = value && { ...value, diff: value.end - value.prev_end, vs_prev_pct: pctOf(value.end, value.prev_end) };
  return { ...rest, ...(flowAi ? { flow: flowAi } : {}), ...(valueAi ? { value: valueAi } : {}), now: now ? { ...now, watch: undefined, watch_rows: now.watch.length } : null };
}
