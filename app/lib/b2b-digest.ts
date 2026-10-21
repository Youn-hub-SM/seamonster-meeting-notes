import { supabaseAdmin } from "./supabase";
import { getAppBaseUrl, getKv, setKv } from "./b2b-settings";
import { buildProductionTodo } from "./production-digest";
import { cancelledDeductionByOrder } from "./b2b-cancel";
import { reconcileB2BSales, SALES_MISMATCH_LABEL } from "./b2b-sales-sync";
import { fetchAllPages, fetchInChunks } from "./sales-paging";

// B2B '전후 N일 미완료 업무' 다이제스트 — 매일 지정 시각 Flow 챗봇 발송용. 내용·시간·기간은 설정에서 커스텀.
//  섹션: ① 발송일 지남(과거 N일 미처리) ② 발송 예정(향후 N일) ③ 발송일정 미등록 ④ 계산서 미발행 ⑤ 입금 대기
//   ⑥ 생산 요청 할 일(2026-10-06 — 확인 안 된 요청서·행사일이 된 프로모션·목표일 지난 요청서·내일 행사, production-digest.ts)
//   ⑦ 매출 원장 불일치(최근 30일 발송분 — 발송완료인데 매출 원장에 없거나 다르게 남은 발주, 2026-10-11)
//  창(days)은 발송 건(shipments)에만 적용 — 계산서·입금은 날짜 무관 전체를 본다(오래된 미발행이 조용히 빠지면 안 됨).
//  금액은 입금 확인 화면과 같은 규칙(부분취소 감액·입금 차감).

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const kst = () => new Date(Date.now() + 9 * 3600e3);
export const kstDateStr = () => kst().toISOString().slice(0, 10);
export const kstHour = () => kst().getUTCHours();
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const won = (n: unknown) => Math.round(Number(n) || 0).toLocaleString();
function weekday(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// ── 설정 ──
export type DigestSections = { ship: boolean; unscheduled: boolean; invoice: boolean; payment: boolean; prod: boolean };
// times: 자동 발송 시각(KST HH:MM, 5분 단위, 최대 6개) — pg_cron 틱(migration 092)이 5분마다
//  이 목록과 대조해 정각 발송한다. hour 는 구 버전(gate=hour) 호환용으로만 남아 있다.
export type DigestConfig = { enabled: boolean; hour: number; days: number; times: string[]; sections: DigestSections; title: string };
export const DIGEST_DEFAULTS: DigestConfig = {
  enabled: true, hour: 8, days: 7,
  times: ["06:00", "16:00"],
  sections: { ship: true, unscheduled: true, invoice: true, payment: true, prod: true },
  title: "씨몬스터 B2B 오늘의 할 일",
};
export async function getDigestConfig(): Promise<DigestConfig> {
  try {
    const raw = await getKv("digest_config");
    if (!raw) return { ...DIGEST_DEFAULTS };
    const v = JSON.parse(raw) as Partial<DigestConfig>;
    return { ...DIGEST_DEFAULTS, ...v, sections: { ...DIGEST_DEFAULTS.sections, ...(v.sections || {}) } };
  } catch { return { ...DIGEST_DEFAULTS }; }
}
export async function saveDigestConfig(patch: Partial<DigestConfig>): Promise<DigestConfig> {
  const cur = await getDigestConfig();
  const merged: DigestConfig = { ...cur, ...patch, sections: { ...cur.sections, ...(patch.sections || {}) } };
  merged.enabled = !!merged.enabled;
  merged.hour = Math.min(23, Math.max(0, Math.round(Number(merged.hour) || 8)));
  merged.days = Math.min(31, Math.max(1, Math.round(Number(merged.days) || 7)));
  merged.title = String(merged.title || DIGEST_DEFAULTS.title).slice(0, 60);
  // 발송 시각 정규화 — HH:MM 형식만, 분은 5분 단위로 내림(틱이 5분 간격이라 그 사이 시각은 영영 안 울린다),
  //  중복 제거·정렬·최대 6개. 전부 무효면 기본값으로 되돌린다(빈 목록이면 알림이 소리 없이 죽는다).
  const validTimes = (Array.isArray(merged.times) ? merged.times : [])
    .map((t) => String(t).trim())
    .filter((t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t))
    .map((t) => { const [h, m] = t.split(":").map(Number); return `${String(h).padStart(2, "0")}:${String(Math.floor(m / 5) * 5).padStart(2, "0")}`; });
  merged.times = [...new Set(validTimes)].sort().slice(0, 6);
  if (!merged.times.length) merged.times = [...DIGEST_DEFAULTS.times];
  await setKv("digest_config", JSON.stringify(merged));
  return merged;
}
// 마지막 자동 발송(날짜 시각) — digest_last_auto(2026-10-21~), 없으면 옛 날짜 표시(digest_last_sent, 중복 방지 겸용)
export const getDigestLastSent = async () => (await getKv("digest_last_auto")) || (await getKv("digest_last_sent"));
export const setDigestLastSent = (d: string) => setKv("digest_last_sent", d);

type OrderRow = { id: string; order_no: string; company_id: string; status: string; tax_invoice_status: string; payment_status: string; total: number };
type ShipRow = { ship_date: string; status: string; box_count: number; order_id: string };
// failed: 조회에 실패해 '확인 못 함'으로 표시한 항목(켜진 섹션만) — 0건과 다르다
export type B2BDigest = { text: string; counts: { ship: number; unscheduled: number; invoice: number; payment: number; prod: number; ledger: number }; hasTasks: boolean; failed: string[] };

// 조회 하나가 실패해도 알림 전체를 막지 않는다 — null(=확인 못 함)을 돌려주고 기록만 남긴다.
//  null 을 빈 목록으로 바꿔 쓰지 않는다(그러면 '없음'으로 읽힌다 — 원장 기준 S4).
async function tryRead<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e) { console.warn(`[b2b-digest] ${label} 조회 실패`, e); return null; }
}

const SHOW = 8; // 섹션별로 이름·금액을 보여 주는 건수(나머지는 '외 N건')

export async function buildB2BDigest(cfg?: DigestConfig): Promise<B2BDigest> {
  const c = cfg ?? (await getDigestConfig());
  const sb = supabaseAdmin();
  const now = kst();
  const today = ymd(now);
  const inN = ymd(new Date(now.getTime() + c.days * 864e5));
  // 과거 N일 — 발송일이 지났는데 발송완료 처리가 안 된 건을 계속 리마인드하기 위한 창.
  //  이게 없으면 그 발주는 어디에도 안 나온다: 예정(미래)도 아니고, 완료가 아니라 계산서·입금 섹션에도 못 간다.
  const pastN = ymd(new Date(now.getTime() - c.days * 864e5));

  // 매출 원장 대조·생산 요청 할 일은 발주 조회와 무관 — 먼저 띄워 함께 기다린다(함수 시간 30초).
  const ledgerP = tryRead("매출 원장 대조", () => reconcileB2BSales(ymd(new Date(now.getTime() - 30 * 864e5)), today));
  const prodP = c.sections.prod ? tryRead("생산 요청 할 일", () => buildProductionTodo(sb, today)) : Promise.resolve(null);

  // 조회는 모두 1,000행 상한 없이 끝까지 읽는다. 실패한 조회의 섹션만 '확인 못 함'으로 표시하고 나머지는 그대로 보낸다.
  //  세 본 조회(발송 일정·발송대기·발송완료 발주)가 모두 실패하면 보낼 내용이 없으니 throw — 라우트가 발송 완료로
  //  기록하지 않고 다음 틱(정각 뒤 15분 안)·예비 크론이 다시 시도하며, 마지막 시도에서도 실패하면 실패 알림을 보낸다.
  const ORDER_COLS = "id, order_no, company_id, status, tax_invoice_status, payment_status, total";
  const [ships, pendingOrders, doneOrders, comps] = await Promise.all([
    tryRead("발송 일정", () => fetchAllPages<ShipRow>((lo, hi) =>
      sb.from("shipments").select("id, ship_date, status, box_count, order_id").gte("ship_date", pastN).lte("ship_date", inN)
        .in("status", ["발송대기", "발송중"]).order("ship_date").order("id").range(lo, hi), { label: "발송 일정" })),
    tryRead("발송대기 발주", () => fetchAllPages<OrderRow>((lo, hi) =>
      sb.from("orders").select(ORDER_COLS).eq("status", "발송대기").order("id").range(lo, hi), { label: "발송대기 발주" })),
    // 발송완료 중 계산서 미발행 또는 입금전·일부입금만 — 다 끝난 발주 이력은 읽지 않는다
    tryRead("발송완료 발주", () => fetchAllPages<OrderRow>((lo, hi) =>
      sb.from("orders").select(ORDER_COLS).eq("status", "발송완료")
        .or("tax_invoice_status.eq.미발행,payment_status.in.(입금전,일부입금)").order("id").range(lo, hi), { label: "발송완료 발주" })),
    // 실패하면 거래처 이름 대신 발주번호로 표시(표시 전용)
    tryRead("거래처", () => fetchAllPages<{ id: string; name: string }>((lo, hi) => sb.from("companies").select("id, name").order("id").range(lo, hi), { label: "거래처" })),
  ]);
  if (!ships && !pendingOrders && !doneOrders) throw new Error("발송 일정·발주 조회가 모두 실패했습니다.");

  const orders = [...(pendingOrders ?? []), ...(doneOrders ?? [])];
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const compName = new Map((comps ?? []).map((x) => [x.id, x.name]));
  const nameOf = (o?: OrderRow) => (o ? compName.get(o.company_id) || o.order_no : "(?)");
  const needInvoice = orders.filter((o) => o.status === "발송완료" && o.tax_invoice_status === "미발행");
  const needPay = orders.filter((o) => o.status === "발송완료" && (o.payment_status === "입금전" || o.payment_status === "일부입금"));

  // 금액 = 입금 확인 화면(/api/b2b/payments/unpaid)과 같은 규칙 — 실효 청구액(total − 취소 차수 감액), 입금 대기는 그 잔액(− 입금 합).
  //  알림에 이름·금액이 나가는 앞 SHOW 건(켜진 섹션)만 조회한다 — 건수는 금액이 필요 없다.
  const invoiceShown = c.sections.invoice ? needInvoice.slice(0, SHOW) : [];
  const payShown = c.sections.payment ? needPay.slice(0, SHOW) : [];
  const dedIds = [...new Set([...invoiceShown, ...payShown].map((o) => o.id))];
  // 발송 건의 발주가 위 목록에 없으면(드물게 다른 상태) 이름 표시용으로 따로 읽는다 — 실패하면 '(?)'
  const missingIds = [...new Set((ships ?? []).map((s) => s.order_id).filter((id) => id && !orderById.has(id)))];
  const pendingIds = (pendingOrders ?? []).map((o) => o.id);
  const [extra, scheduledRows, dedMap, pays] = await Promise.all([
    missingIds.length
      ? tryRead("발송 건 발주 이름", () => fetchInChunks<OrderRow>(missingIds, (part, lo, hi) =>
        sb.from("orders").select(ORDER_COLS).in("id", part).order("id").range(lo, hi)))
      : Promise.resolve([] as OrderRow[]),
    // 발송일정 등록 여부 — 발송대기 발주의 차수만 본다. 실패하면 미등록 섹션 '확인 못 함'(빈 목록으로 보면 발송대기 전부가 미등록으로 나간다)
    pendingOrders
      ? tryRead("발송일정 등록 여부", () => fetchInChunks<{ order_id: string }>(pendingIds, (part, lo, hi) =>
        sb.from("shipments").select("id, order_id").in("order_id", part).not("ship_date", "is", null).order("id").range(lo, hi)))
      : Promise.resolve(null),
    dedIds.length ? tryRead("취소 차수 감액", () => cancelledDeductionByOrder(sb, dedIds)) : Promise.resolve(new Map<string, number>()),
    payShown.length
      ? tryRead("입금 합", () => fetchInChunks<{ order_id: string; amount: number }>(payShown.map((o) => o.id), (part, lo, hi) =>
        sb.from("payments").select("id, order_id, amount").in("order_id", part).order("id").range(lo, hi)))
      : Promise.resolve([] as { order_id: string; amount: number }[]),
  ]);
  for (const o of extra ?? []) orderById.set(o.id, o);
  const scheduled = scheduledRows ? new Set(scheduledRows.map((s) => s.order_id)) : null;
  const unscheduled = pendingOrders && scheduled ? pendingOrders.filter((o) => !scheduled.has(o.id)) : [];
  const paidMap = new Map<string, number>();
  for (const p of pays ?? []) paidMap.set(p.order_id, (paidMap.get(p.order_id) || 0) + (Number(p.amount) || 0));
  const effTotal = (o: OrderRow) => Math.max(0, (Number(o.total) || 0) - (dedMap?.get(o.id) || 0));
  const remaining = (o: OrderRow) => effTotal(o) - (paidMap.get(o.id) || 0);
  const invoiceAmtOk = !!dedMap;
  const payAmtOk = !!dedMap && !!pays;

  const groupShips = (rows: ShipRow[]) => {
    const m = new Map<string, { name: string; box: number }[]>();
    for (const s of rows) {
      const arr = m.get(s.ship_date) || [];
      arr.push({ name: nameOf(orderById.get(s.order_id)), box: Number(s.box_count) || 0 });
      m.set(s.ship_date, arr);
    }
    return m;
  };
  const shipRows = ships ?? [];
  const overdue = shipRows.filter((s) => s.ship_date < today);   // 지났는데 발송대기/발송중 그대로
  const byDateOver = groupShips(overdue);
  const byDate = groupShips(shipRows.filter((s) => s.ship_date >= today));

  // 매출 원장 대조(최근 30일 발송분) — 발송완료인데 원장에 없거나 다르게 남은 발주. 끌 수 없다(매출이 빠진 채 남지 않게).
  // 생산 요청 할 일 — 조회 실패는 '확인 못 함'(조용히 빠지면 '없음'으로 읽힌다)
  const [ledger, prod] = await Promise.all([ledgerP, prodP]);
  const ledgerCount = ledger?.mismatches.length ?? 0;
  let ledgerLines: string[] = [];
  if (ledger && ledgerCount) {
    const items = ledger.mismatches.map((m) => `${m.order_no} ${SALES_MISMATCH_LABEL[m.kind]}`);
    ledgerLines = ["", `매출 원장 불일치 (${ledgerCount}건) — 매출 집계 › 원장 대조에서 다시 맞추기`,
      ` · ${items.length > 8 ? `${items.slice(0, 8).join(", ")} 외 ${items.length - 8}건` : items.join(", ")}`];
  }
  const prodLines = prod?.lines ?? [];
  const prodCount = prod?.count ?? 0;

  // 켜진 섹션 중 확인 못 한 것
  const fail = {
    ship: c.sections.ship && !ships,
    unscheduled: c.sections.unscheduled && !scheduled,
    invoice: c.sections.invoice && !doneOrders,
    payment: c.sections.payment && !doneOrders,
    prod: c.sections.prod && !prod,
    ledger: !ledger,
  };
  const failed = [
    fail.ship && "발송 일정", fail.unscheduled && "발송일정 미등록", fail.invoice && "계산서 미발행", fail.payment && "입금 대기",
    fail.prod && "생산 요청 할 일", fail.ledger && "매출 원장 대조",
    ((invoiceShown.length && !invoiceAmtOk) || (payShown.length && !payAmtOk)) && "금액(취소 감액·입금)",
  ].filter((x): x is string => !!x);

  const counts = { ship: shipRows.length, unscheduled: unscheduled.length, invoice: needInvoice.length, payment: needPay.length, prod: prodCount, ledger: ledgerCount };
  // 켜진 섹션만 '할 일'로 집계(매출 원장 불일치는 끌 수 없다 — 매출이 빠진 채 남지 않게)
  const active = [c.sections.ship && counts.ship, c.sections.unscheduled && counts.unscheduled, c.sections.invoice && counts.invoice, c.sections.payment && counts.payment, c.sections.prod && counts.prod, counts.ledger];
  const hasTasks = active.some((n) => n);

  const cut = (arr: string[], n: number) => (arr.length > n ? `${arr.slice(0, n).join(", ")} 외 ${arr.length - n}건` : arr.join(", "));
  const L: string[] = [`${c.title} — ${today.slice(5)}(${weekday(today)}) 기준 · 전후 ${c.days}일`];
  const pushFail = (what: string, where: string) => L.push("", `${what} — 확인 못 함(조회 실패). ${where}에서 확인하세요`);
  const AMT_FAIL = " · 금액 확인 못 함(조회 실패) — B2B › 입금 확인에서 확인하세요";

  if (!hasTasks && !failed.length) {
    L.push("", "처리할 미완료 업무가 없습니다. 좋은 하루 되세요");
  } else {
    if (!hasTasks) L.push("", "확인된 미완료 업무는 없습니다. 아래 항목은 확인하지 못했습니다");
    const pushShipDates = (m: Map<string, { name: string; box: number }[]>) => {
      [...m.keys()].sort().forEach((d) => {
        const items = m.get(d)!;
        const head = items.slice(0, 6).map((i) => `${i.name}${i.box ? ` ${i.box}박스` : ""}`);
        L.push(` · ${d.slice(5)}(${weekday(d)}): ${items.length > 6 ? `${head.join(", ")} 외 ${items.length - 6}건` : head.join(", ")}`);
      });
    };
    if (fail.ship) pushFail("발송 일정(발송일 지남·발송 예정)", "B2B › 발주");
    if (c.sections.ship && byDateOver.size) {
      L.push("", `발송일 지남 (${overdue.length}건) — 발송완료 처리 또는 일정 변경 필요`);
      pushShipDates(byDateOver);
    }
    if (c.sections.ship && byDate.size) {
      L.push("", `발송 예정 (${counts.ship - overdue.length}건)`);
      pushShipDates(byDate);
    }
    if (fail.unscheduled) pushFail("발송일정 미등록", "B2B › 발주");
    else if (c.sections.unscheduled && unscheduled.length) L.push("", `발송일정 미등록 (${unscheduled.length}건) — 일정 잡아야 함`, ` · ${cut(unscheduled.map((o) => nameOf(o)), SHOW)}`);
    if (fail.invoice) pushFail("계산서 미발행", "B2B › 발주");
    else if (c.sections.invoice && needInvoice.length) {
      L.push("", `계산서 미발행 (${needInvoice.length}건)`, ` · ${cut(needInvoice.map((o) => (invoiceAmtOk ? `${nameOf(o)} ${won(effTotal(o))}원` : nameOf(o))), SHOW)}`);
      if (!invoiceAmtOk) L.push(AMT_FAIL);
    }
    if (fail.payment) pushFail("입금 대기", "B2B › 입금 확인");
    else if (c.sections.payment && needPay.length) {
      L.push("", `입금 대기 (${needPay.length}건)`, ` · ${cut(needPay.map((o) => (payAmtOk ? `${nameOf(o)} ${won(remaining(o))}원` : nameOf(o))), SHOW)}`);
      if (!payAmtOk) L.push(AMT_FAIL);
    }
    if (fail.prod) pushFail("생산 요청 할 일", "업무도우미 › 생산 요청");
    else if (c.sections.prod && prodLines.length) L.push(...prodLines);
    if (fail.ledger) pushFail("매출 원장 대조", "매출 집계 › 원장 대조");
    else if (ledgerLines.length) L.push(...ledgerLines);
  }
  const base = await getAppBaseUrl();
  if (base) L.push("", `→ ${base}/b2b/orders`);
  return { text: L.join("\n"), counts, hasTasks, failed };
}
