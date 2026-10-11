// 매출 업로드 미리보기·적용 공용 계획 — 두 라우트가 같은 규칙으로 행을 고른다(미리보기 숫자 = 적용 결과).
//  - 숫자 아닌 금액·수량, 날짜 오류, 오늘(KST) 이후 날짜 = 오류 행(적용은 '오류 행 빼고 적용'을 고른 경우만)
//  - 파일 안 완전 동일 라인: 기본 '중복 제거'(1행만), '따로 넣기'면 2번째부터 row_hash 에 출현 순번을 붙여 별개 행으로
//  - 기간 교체: 교체 기간(기본 = 파일에 실제로 있는 날짜 최소~최대, 31일 넘으면 행이 가장 많은 달 안에서) 안에서,
//    채널마다 '그 채널 파일 날짜 최소~최대'만 교체한다 — 파일에 있는 채널의 기존 행 중 파일에 없는 행을 지운다(도매·b2b 행 제외).
//    파일 날짜 밖까지 교체 기간 전체로 지우는 건 '넓히기'(replace_widen=1)를 명시한 경우만.
//    월 정산 대조용 '그 달 전체'(monthReplacePeriod = 1일~말일 + 넓히기)는 화면에서 사람이 고른 경우만 — 기본값이 아니다.
//    파일에 그 채널 행이 하나도 없는 날(넓히기·파일 중간 빈 날)이나, 지울 행이 그날 파일 행보다 많은 '얇은 날'
//    (내보내기 기준이 달라 낙오 행 몇 개만 섞인 경계일 등)의 기존 행이 지워지면 날짜 목록을 보여 주고,
//    적용은 그 날짜 목록(confirm_uncovered)을 사람이 확인해 보낸 경우만 — 서버가 다시 계산해 확인 안 된 날이 있으면 쓰기 전에 거절.
//    기간 밖 파일 행은 추가만 — 섞인 다른 달 행 하나로 삭제 범위가 넓어지지 않게.
//    파일이 그 채널·기간의 '전부'일 때만 쓴다 — 업로드 뒤 생긴 취소·부분취소·금액 정정을 원장에 반영하는 유일한 길.
//    오류 행이 하나라도 있으면 거절(그 행의 기존 원장 행이 '파일에 없음'으로 지워져 영구 손실 — S4).
//  Node 런타임 전용(sales-normalize 의 crypto).
import { supabaseAdmin } from "./supabase";
import { normalizeRow, type SalesOrderRow, type SalesCustomerRow } from "./sales-normalize";
import { fetchAllPages } from "./sales-paging";

type Sb = ReturnType<typeof supabaseAdmin>;

// replaceWiden = 채널 파일 날짜 밖까지 교체 기간 전체로 지움(명시) · confirmUncovered = 사람이 확인한 '파일 행이 없거나 적은 날' 키(채널|날짜)
export type UploadOptions = { dupMode: "merge" | "separate"; replace: boolean; replaceFrom: string; replaceTo: string; replaceWiden: boolean; confirmUncovered: string[] };
export type DupGroup = { order_date: string; channel: string; order_id: string; product_name: string; option_name: string; quantity: number; subtotal_amount: number; count: number };
export type UploadPlan = {
  totalRows: number;
  orders: SalesOrderRow[];
  customers: SalesCustomerRow[]; // 행마다(apply 가 key별로 병합)
  invalid: number;
  errors: string[];
  dupInFile: number;     // 중복 제거로 뺀 행 수(따로 넣기면 0)
  dupGroups: DupGroup[]; // 파일 안 동일 라인 그룹(최대 50)
  dupGroupCount: number;
};

export const kstTodayIso = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export function readUploadOptions(form: FormData): UploadOptions {
  let confirmUncovered: string[] = [];
  try {
    const v = JSON.parse(String(form.get("confirm_uncovered") ?? "[]"));
    if (Array.isArray(v)) confirmUncovered = v.filter((x): x is string => typeof x === "string");
  } catch { /* 형식 오류 = 확인 없음(적용이 거절된다) */ }
  return {
    dupMode: form.get("dup_mode") === "separate" ? "separate" : "merge",
    replace: form.get("replace") === "1",
    replaceFrom: String(form.get("replace_from") ?? "").trim(),
    replaceTo: String(form.get("replace_to") ?? "").trim(),
    replaceWiden: form.get("replace_widen") === "1",
    confirmUncovered,
  };
}

export function planUpload(rows: Record<string, unknown>[], opts: UploadOptions, today = kstTodayIso()): UploadPlan {
  const seenCount = new Map<string, number>();         // 기본 해시 → 지금까지 나온 횟수
  const groups = new Map<string, DupGroup>();
  const orders: SalesOrderRow[] = [];
  const customers: SalesCustomerRow[] = [];
  const errors: string[] = [];
  let invalid = 0, dupInFile = 0;
  for (const raw of rows) {
    const nr = normalizeRow(raw);
    if (!nr.ok || !nr.order) { invalid++; if (errors.length < 15) errors.push(nr.error || "정규화 실패"); continue; }
    if (nr.order.order_date > today) {
      invalid++;
      if (errors.length < 15) errors.push(`오늘 이후 날짜: ${nr.order.order_date}${nr.order.order_id ? ` (주문번호 ${nr.order.order_id})` : ""}`);
      continue;
    }
    const base = nr.order.row_hash;
    const n = (seenCount.get(base) || 0) + 1;
    seenCount.set(base, n);
    if (n > 1) {
      const o = nr.order;
      const g = groups.get(base) ?? { order_date: o.order_date, channel: o.channel, order_id: o.order_id, product_name: o.product_name, option_name: o.option_name, quantity: o.quantity, subtotal_amount: o.subtotal_amount, count: 1 };
      g.count = n;
      groups.set(base, g);
      if (opts.dupMode === "merge") { dupInFile++; continue; }
      const again = normalizeRow(raw, { occurrence: n });
      if (!again.ok || !again.order) { invalid++; continue; }
      orders.push(again.order);
      if (again.customer) customers.push(again.customer);
      continue;
    }
    orders.push(nr.order);
    if (nr.customer) customers.push(nr.customer);
  }
  const dupGroupsAll = [...groups.values()];
  return {
    totalRows: rows.length, orders, customers, invalid, errors, dupInFile,
    dupGroups: dupGroupsAll.slice(0, 50), dupGroupCount: dupGroupsAll.length,
  };
}

// 기간 교체 — 도매(B2B 발주가 원장을 직접 맞춤)·빈 채널은 교체하지 않는다.
export type ReplacePeriod = { from: string; to: string };
// rows·amount = 그날 지울 기존 행 · file_rows = 그날 그 채널 파일 행 · partial = 파일 행이 있지만 지울 행보다 적음
export type UncoveredDay = { date: string; rows: number; amount: number; file_rows: number; partial: boolean };
export type ReplaceScope = {
  channel: string; file_rows: number; file_from: string; file_to: string;
  win_from: string; win_to: string;  // 실제로 지우는 날짜(기본 = 그 채널 파일 날짜, 넓히기 = 교체 기간)
  short: boolean;                    // 그 채널 파일 날짜가 교체 기간보다 짧음
  existing: number; to_delete: number; delete_amount: number;
  uncovered: UncoveredDay[];         // 파일에 그 채널 행이 없거나 지울 행보다 적은데 기존 행이 지워지는 날(사람 확인 필요)
};
export const REPLACE_EXCLUDED_CHANNELS = ["도매"];
export const REPLACE_MAX_DAYS = 31;
const replaceable = (channel: string) => !!channel && !REPLACE_EXCLUDED_CHANNELS.includes(channel);
const spanDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000) + 1;
const isIsoDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

// 교체 대상 채널 파일 행의 날짜(오늘 이하) · 그중 행이 가장 많은 달 'YYYY-MM'(동률이면 늦은 달)
const replaceableDates = (orders: SalesOrderRow[], today: string) => orders.filter((o) => replaceable(o.channel) && o.order_date <= today).map((o) => o.order_date);
function busiestMonth(dates: string[]): string {
  const perMonth = new Map<string, number>();
  for (const d of dates) perMonth.set(d.slice(0, 7), (perMonth.get(d.slice(0, 7)) || 0) + 1);
  let best = "", bestN = 0;
  for (const [m, n] of perMonth) if (n > bestN || (n === bestN && m > best)) { best = m; bestN = n; }
  return best;
}

// 기본 교체 기간 — 교체 대상 채널 파일 행에 실제로 있는 날짜 최소~최대(오늘 이하). 31일을 넘으면 행이 가장 많은 달
//  (동률이면 늦은 달) 안의 최소~최대. 그 달 1일~말일처럼 파일에 없는 날을 기본으로 잡지 않는다. 대상 행이 없으면 null.
export function defaultReplacePeriod(orders: SalesOrderRow[], today = kstTodayIso()): ReplacePeriod | null {
  const dates = replaceableDates(orders, today);
  if (!dates.length) return null;
  const range = (ds: string[]) => ds.reduce((r, d) => ({ from: d < r.from ? d : r.from, to: d > r.to ? d : r.to }), { from: ds[0], to: ds[0] });
  const all = range(dates);
  if (spanDays(all.from, all.to) <= REPLACE_MAX_DAYS) return all;
  const best = busiestMonth(dates);
  return range(dates.filter((d) => d.startsWith(best)));
}

// '그 달 전체' 기간 — 월 정산 대조(docs/ledger-standard.md §3.9: 취소·정정이 반영된 그 달 전체 파일을 기간 교체로).
//  교체 대상 채널 파일 행이 가장 많은 달의 1일~말일(이번 달이면 오늘까지). 기본값이 아니다 — 화면에서 사람이 골라야만 쓰이고,
//  넓히기(widen)와 함께 보내 파일에 행이 없는 날도 지운다(그 날은 planReplace 의 uncovered 확인 체크를 거친다). 대상 행이 없으면 null.
export function monthReplacePeriod(orders: SalesOrderRow[], today = kstTodayIso()): ReplacePeriod | null {
  const dates = replaceableDates(orders, today);
  if (!dates.length) return null;
  const ym = busiestMonth(dates);
  const [y, m] = ym.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // 그 달 말일
  return { from: `${ym}-01`, to: end > today ? today : end };
}

// 기간 교체를 막는 이유(없으면 null) — 미리보기·적용 공용, 적용은 이게 있으면 아무것도 쓰지 않는다.
export function replaceBlockReason(plan: UploadPlan, period: ReplacePeriod | null, today = kstTodayIso()): string | null {
  if (plan.invalid > 0) return `기간 교체는 오류 행이 없는 파일로만 할 수 있습니다(오류 ${plan.invalid.toLocaleString()}건) — 파일을 고친 뒤 다시 올리세요.`;
  if (!period || !period.from || !period.to) return "교체 기간이 없습니다 — 미리보기를 다시 하세요.";
  if (!isIsoDate(period.from) || !isIsoDate(period.to)) return "교체 기간 날짜가 올바르지 않습니다.";
  if (period.from > period.to) return "교체 기간 시작일이 종료일보다 늦습니다.";
  if (period.to > today) return "교체 기간은 오늘 이후로 잡을 수 없습니다.";
  if (spanDays(period.from, period.to) > REPLACE_MAX_DAYS) return `교체 기간은 ${REPLACE_MAX_DAYS}일 이내로 잡으세요 — 여러 달이면 달마다 따로 적용하세요.`;
  if (!plan.orders.some((o) => replaceable(o.channel) && o.order_date >= period.from && o.order_date <= period.to)) return "교체 기간 안에 교체할 파일 행이 없습니다.";
  return null;
}

// 교체 계획 — 채널마다 지울 날짜(기본 = 그 채널 파일 날짜 최소~최대, widen = 교체 기간 전체) 안의 기존 행 중 파일에 없는 행.
//  파일에 그 채널 행이 없거나 지울 행보다 적은 날의 삭제는 uncovered 로 따로 센다(적용은 사람이 그 날짜를 확인한 경우만).
//  조회 실패·상한 초과는 throw(지울 범위를 모른 채 진행하지 않는다).
export async function planReplace(sb: Sb, orders: SalesOrderRow[], period: ReplacePeriod, widen = false): Promise<{ scopes: ReplaceScope[]; skipped: string[]; outside: number; staleIds: string[] }> {
  const inFile = new Map<string, { n: number; from: string; to: string; days: Map<string, number> }>(); // days = 날짜 → 그 채널 파일 행 수
  const skipped = new Set<string>();
  let outside = 0;   // 기간 밖 파일 행(추가만)
  for (const o of orders) {
    if (!replaceable(o.channel)) { skipped.add(o.channel || "(채널 없음)"); continue; }
    if (o.order_date < period.from || o.order_date > period.to) { outside++; continue; }
    const r = inFile.get(o.channel);
    if (!r) inFile.set(o.channel, { n: 1, from: o.order_date, to: o.order_date, days: new Map([[o.order_date, 1]]) });
    else { r.n++; r.days.set(o.order_date, (r.days.get(o.order_date) || 0) + 1); if (o.order_date < r.from) r.from = o.order_date; if (o.order_date > r.to) r.to = o.order_date; }
  }
  const keep = new Set(orders.map((o) => o.row_hash));
  const scopes: ReplaceScope[] = [];
  const staleIds: string[] = [];
  for (const [channel, r] of inFile) {
    const win = widen ? { from: period.from, to: period.to } : { from: r.from, to: r.to };
    const existing = await fetchAllPages<{ id: string; row_hash: string; subtotal_amount: number; order_date: string }>((lo, hi) =>
      sb.from("sales_orders").select("id, row_hash, subtotal_amount, order_date")
        .eq("channel", channel).gte("order_date", win.from).lte("order_date", win.to).neq("source", "b2b")
        .order("id").range(lo, hi), { cap: 200000, label: `${channel} 기존 매출` });
    const stale = existing.filter((x) => !keep.has(x.row_hash));
    staleIds.push(...stale.map((x) => x.id));
    // 날짜별 지울 행 — (a) 파일에 그 채널 행이 없는 날, (b) 지울 행이 그날 파일 행보다 많은 '얇은 날'(낙오 행 몇 개뿐인 경계일 등)만
    //  사람 확인 대상. 정정 파일은 하루 수백 행 중 몇 행만 지우므로 (b)에 걸리지 않는다.
    const byDay = new Map<string, UncoveredDay>();
    for (const x of stale) {
      const d = String(x.order_date).slice(0, 10);
      const fileRows = r.days.get(d) || 0;
      const u = byDay.get(d) ?? { date: d, rows: 0, amount: 0, file_rows: fileRows, partial: fileRows > 0 };
      u.rows++; u.amount += Number(x.subtotal_amount) || 0;
      byDay.set(d, u);
    }
    const unc = [...byDay.values()].filter((u) => u.file_rows === 0 || u.rows > u.file_rows);
    scopes.push({
      channel, file_rows: r.n, file_from: r.from, file_to: r.to, win_from: win.from, win_to: win.to,
      short: r.from > period.from || r.to < period.to,
      existing: existing.length, to_delete: stale.length,
      delete_amount: stale.reduce((s, x) => s + (Number(x.subtotal_amount) || 0), 0),
      uncovered: unc.sort((a, b) => a.date.localeCompare(b.date)),
    });
  }
  scopes.sort((a, b) => a.channel.localeCompare(b.channel, "ko"));
  return { scopes, skipped: [...skipped], outside, staleIds };
}

// '파일 행이 없거나 적은 날' 확인 키(채널|날짜) — 미리보기가 돌려주고 화면이 확인 후 그대로 보낸다. 적용은 다시 계산한 키가 전부 확인됐을 때만.
export const uncoveredKeys = (scopes: ReplaceScope[]): string[] =>
  scopes.flatMap((s) => s.uncovered.map((u) => `${s.channel}|${u.date}`)).sort();

// 확인 안 된 '파일 행이 없거나 적은 날' — 있으면 적용 거절 이유(쓰기 전에 판정), 없으면 null.
export function uncoveredBlockReason(scopes: ReplaceScope[], confirmed: string[]): string | null {
  const ok = new Set(confirmed);
  const missing = scopes.flatMap((s) => s.uncovered.filter((u) => !ok.has(`${s.channel}|${u.date}`)).map((u) => ({ ch: s.channel, ...u })));
  if (!missing.length) return null;
  const rows = missing.reduce((n, m) => n + m.rows, 0);
  const list = missing.slice(0, 6).map((m) => `${m.ch} ${m.date.slice(5)}`).join(", ") + (missing.length > 6 ? ` 외 ${missing.length - 6}일` : "");
  return `파일 행이 없거나 적은 날짜의 기존 ${rows.toLocaleString()}행을 지우게 됩니다(${list}) — 미리보기를 다시 해 날짜를 확인·체크한 뒤 적용하세요.`;
}

// 변경 의심 — 파일의 새 행(원장에 같은 해시 없음) 중 같은 채널·주문번호·관리코드·옵션의 기존 행이 이미 있는 것.
//  업로드 뒤 부분취소·금액 정정이 반영된 파일을 다시 올린 경우로, 그대로 적용하면 옛 행과 새 행이 둘 다 남는다(이중집계).
//  자동으로 고르지 않는다 — 화면이 보여 주고 사람이 '기간 교체'를 고른다.
export type ChangedRow = { channel: string; order_id: string; product_name: string; option_name: string; old_qty: number; old_amount: number; new_qty: number; new_amount: number };
export async function findChangedRows(sb: Sb, orders: SalesOrderRow[], existingHashes: Set<string>): Promise<{ count: number; examples: ChangedRow[] }> {
  const fresh = orders.filter((o) => !existingHashes.has(o.row_hash) && o.order_id && !REPLACE_EXCLUDED_CHANNELS.includes(o.channel));
  if (!fresh.length) return { count: 0, examples: [] };
  const keyOf = (r: { channel: string; order_id: string; sku_code: string; option_name: string }) => [r.channel, r.order_id, r.sku_code, r.option_name].join("\u0001");
  const ids = [...new Set(fresh.map((o) => o.order_id))];
  const old = new Map<string, { qty: number; amount: number }>();
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const rows = await fetchAllPages<{ channel: string; order_id: string; sku_code: string; option_name: string; quantity: number; subtotal_amount: number }>((lo, hi) =>
      sb.from("sales_orders").select("id, channel, order_id, sku_code, option_name, quantity, subtotal_amount")
        .in("order_id", part).neq("source", "b2b").order("id").range(lo, hi));
    for (const r of rows) {
      const k = keyOf(r);
      const v = old.get(k) || { qty: 0, amount: 0 };
      v.qty += Number(r.quantity) || 0; v.amount += Number(r.subtotal_amount) || 0;
      old.set(k, v);
    }
  }
  const changed = fresh.filter((o) => old.has(keyOf(o)));
  return {
    count: changed.length,
    examples: changed.slice(0, 30).map((o) => {
      const v = old.get(keyOf(o))!;
      return { channel: o.channel, order_id: o.order_id, product_name: o.product_name, option_name: o.option_name, old_qty: v.qty, old_amount: v.amount, new_qty: o.quantity, new_amount: o.subtotal_amount };
    }),
  };
}
