// 실사(재고 조정) 전 점검 — 실사 화면(엑셀·미리보기)과 /api/inventory/adjust/precheck 가 같이 쓴다(서버 전용).
//  실사 = '실사일 마감 기준 장부'를 센 수량에 맞추는 일이라, 장부와 선반이 원래부터 어긋나 있는 자리를 먼저 드러낸다(S8·D4a).
//   ① B2B 선점: 발주 전량이 가장 이른 발송일에 이미 빠졌는데(대표 결정) 아직 안 나간 발주 — 물건은 선반에 있다(일부 발송이면 안 나간 수량 remaining 만).
//      세어 넣으면 그만큼 유령 재고가 생기고, 나중에 발송해도 다시 빠지지 않는다.
//   ② 대기 행: 현재고에 안 들어간 입출고 — 실물이 이미 움직였다면 실사 뒤에 처리할 때 이중 반영된다.
//   ③ 실사일 당일·이후 입출고: 당일 기록은 실사 전 움직임인지 사람이 확인해야 한다(이후 기록은 조정 뒤에 그대로 남는다).
//  읽기 실패는 던진다 — 점검을 못 했는데 '경고 없음'으로 보여 주면 확인 없이 반영된다(S4).

import type { supabaseAdmin } from "@/app/lib/supabase";
import { readAll } from "@/app/lib/inventory-template";
import { getAllBundles, expandBundleQty } from "@/app/lib/product-bundles";
import type { InvChannel } from "@/app/lib/inventory";

type Sb = ReturnType<typeof supabaseAdmin>;

export type B2bHold = {
  order_id: string; order_no: string | null; company: string | null;
  deduct_date: string;   // 선점 출고 거래일(= 가장 이른 발송일)
  open_dates: string[];  // 아직 안 나간 차수의 발송예정일
  partial: boolean;      // 실사일까지 일부 차수가 나감 — 선점은 발주 전량이라 선반에는 remaining 만 남아 있다
  qty: number;           // 선점(차감)된 수량 합
  remaining: number | null; // 선반에 남은(안 나간) 수량 합. null = 나간 차수에 품목 배분이 없어 계산할 수 없음
  items: { product_id: string; qty: number; remaining: number | null }[]; // remaining 0(다 나감) 품목은 뺀다
};
export type CheckTxn = { id: string; product_id: string; type: string; qty: number; txn_date: string; partner: string | null };
export type CountChecks = {
  date: string;              // 실사일
  b2b: B2bHold[];
  pending: CheckTxn[];       // 이 칸의 '대기' 행(앞 100건)
  pendingTotal: number;
  pendingBy: Record<string, number>; // 품목별 대기 행 수(전체)
  formDate?: string;         // 엑셀 미리보기: 양식 헤더의 기준일이 실사일과 다를 때만 — 확인 대상
  sameDay: number;           // 실사일 당일 완료 입출고 수
  after: number;             // 실사일 다음날~오늘 완료 입출고 수
  moved: CheckTxn[];         // 위 둘 중 앞 50건(실사일 당일 먼저)
  names: Record<string, string>; // 위 목록의 품목명
};

const CHUNK = 100;
async function inChunks<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}
const isChanErr = (e: unknown) => /channel/i.test(String((e as { message?: string })?.message ?? ""));
// 036(channel) 미적용 환경만 칸 필터 없이 다시 읽는다 — 그 밖의 오류는 그대로 던진다
async function withChanFallback<T>(run: (withChan: boolean) => Promise<T>): Promise<T> {
  try { return await run(true); } catch (e) { if (isChanErr(e)) return run(false); throw e; }
}

type Ship = { id: string; order_id: string; ship_date: string | null; status: string | null; shipped_at: string | null };
const shipped = (s: Ship) => s.status === "발송완료" || !!s.shipped_at;
const kstDay = (ts: string) => { const t = Date.parse(ts); return Number.isFinite(t) ? new Date(t + 9 * 3600_000).toISOString().slice(0, 10) : ""; };
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** 장부에서 이미 빠졌지만(선점 거래일 ≤ 실사일) 아직 안 나간 B2B 발주. 선점은 도매·도매 대량 칸에만 있다.
 *  실사 화면(엑셀·미리보기)과 단건 조정 창(TxnModal)이 모두 precheck → 이 함수 한 곳을 쓴다(S1). */
async function b2bHolds(sb: Sb, chan: InvChannel, date: string): Promise<B2bHold[]> {
  if (chan !== "도매" && chan !== "도매 대량") return [];
  const open = await readAll<Ship>((a, b) => sb.from("shipments").select("id, order_id, ship_date, status, shipped_at")
    .not("status", "in", '("발송완료","취소")').is("shipped_at", null)
    .order("id", { ascending: true }).range(a, b));
  const orderIds = [...new Set(open.map((s) => s.order_id))];
  if (!orderIds.length) return [];
  type O = { id: string; order_no: string | null; status: string | null; companies: { name?: string | null } | { name?: string | null }[] | null };
  const orders = await inChunks(orderIds, (c) => readAll<O>((a, b) => sb.from("orders").select("id, order_no, status, companies(name)")
    .in("id", c).order("id", { ascending: true }).range(a, b)));
  const live = new Map(orders.filter((o) => o.status !== "발송완료" && o.status !== "취소").map((o) => [o.id, o]));
  if (!live.size) return [];
  const ships = await inChunks([...live.keys()], (c) => readAll<Ship>((a, b) => sb.from("shipments").select("id, order_id, ship_date, status, shipped_at")
    .in("order_id", c).order("id", { ascending: true }).range(a, b)));
  const shipOrder = new Map(ships.map((s) => [s.id, s.order_id]));
  type T = { product_id: string; qty: number; txn_date: string; shipment_id: string };
  const txns = await withChanFallback((withChan) => inChunks([...shipOrder.keys()], (c) => readAll<T>((a, b) => {
    let q = sb.from("inventory_txns").select("product_id, qty, txn_date, shipment_id")
      .in("shipment_id", c).eq("status", "완료").lte("txn_date", date).lt("qty", 0);
    if (withChan) q = q.eq("channel", chan);
    return q.order("id", { ascending: true }).range(a, b);
  })));

  const by = new Map<string, B2bHold>();
  for (const t of txns) {
    const oid = shipOrder.get(t.shipment_id);
    const o = oid ? live.get(oid) : undefined;
    if (!oid || !o) continue;
    let h = by.get(oid);
    if (!h) {
      const co = Array.isArray(o.companies) ? o.companies[0] : o.companies;
      h = { order_id: oid, order_no: o.order_no, company: co?.name ?? null, deduct_date: t.txn_date, open_dates: [], partial: false, qty: 0, remaining: null, items: [] };
      by.set(oid, h);
    }
    if (t.txn_date < h.deduct_date) h.deduct_date = t.txn_date;
    const q = Math.abs(Number(t.qty) || 0);
    h.qty += q;
    const it = h.items.find((x) => x.product_id === t.product_id);
    if (it) it.qty += q; else h.items.push({ product_id: t.product_id, qty: q, remaining: null });
  }

  // 남은(안 나간) 수량 — 선점은 발주 전량이라, 일부 차수가 나간 발주는 선반에 그 나머지만 있다(대표 결정 0절).
  //  남은 = 차감량 − 실사일까지 나간 차수(발송완료 또는 shipped_at, 취소 제외)의 배분(shipment_items → 품목, 세트는 구성품 전개).
  //  0~차감량으로 자른다. 나간 차수에 배분이 하나도 없으면(옛 데이터) 얼마가 나갔는지 알 수 없어 null — 사람이 발주에서 확인한다.
  //  '실사일까지' = 차수 발송일(D2 이후 실제 발송일)과 shipped_at 의 KST 날짜 중 이른 쪽 ≤ 실사일(둘 다 없으면 나간 것으로 본다).
  const goneDay = (s: Ship) => [s.ship_date || "", s.shipped_at ? kstDay(s.shipped_at) : ""].filter(Boolean).sort()[0] || "";
  const goneBy = (s: Ship) => s.status !== "취소" && shipped(s) && goneDay(s) <= date;
  const gone = ships.filter((s) => by.has(s.order_id) && goneBy(s));
  const outBy = new Map<string, Map<string, number>>(); // 발주 → 품목 → 나간 수량
  const unknown = new Set<string>();
  if (gone.length) {
    type SI = { id: string; shipment_id: string; order_item_id: string | null; qty: number };
    type L = { id: string; product_id: string | null };
    const [sis, lines, bundles] = await Promise.all([
      inChunks(gone.map((s) => s.id), (c) => readAll<SI>((a, b) => sb.from("shipment_items").select("id, shipment_id, order_item_id, qty")
        .in("shipment_id", c).order("id", { ascending: true }).range(a, b))),
      inChunks([...new Set(gone.map((s) => s.order_id))], (c) => readAll<L>((a, b) => sb.from("order_items").select("id, product_id")
        .in("order_id", c).order("id", { ascending: true }).range(a, b))),
      getAllBundles(sb), // 조회 오류는 던진다 — '세트 없음'으로 보면 세트 라인이 구성품만큼 안 빠져 남은 수량이 부풀려진다
    ]);
    const productOf = new Map(lines.map((l) => [l.id, l.product_id]));
    const allocated = new Set(sis.filter((x) => Number(x.qty) > 0).map((x) => x.shipment_id));
    for (const s of gone) if (!allocated.has(s.id)) unknown.add(s.order_id);
    for (const x of sis) {
      const q = Number(x.qty) || 0;
      const pid = x.order_item_id ? productOf.get(x.order_item_id) : null;
      const oid = shipOrder.get(x.shipment_id);
      if (q <= 0 || !pid || !oid) continue;
      const m = outBy.get(oid) ?? new Map<string, number>();
      outBy.set(oid, m);
      expandBundleQty(bundles, pid, q, m);
    }
  }
  const out: B2bHold[] = [];
  for (const h of by.values()) {
    const os = ships.filter((s) => s.order_id === h.order_id && s.status !== "취소");
    h.partial = os.some(goneBy);
    h.open_dates = os.filter((s) => !shipped(s)).map((s) => s.ship_date || "").filter(Boolean).sort();
    const unk = unknown.has(h.order_id);
    const sent = outBy.get(h.order_id);
    for (const it of h.items) it.remaining = unk ? null : r3(Math.min(it.qty, Math.max(0, it.qty - (sent?.get(it.product_id) || 0))));
    h.items = h.items.filter((x) => x.remaining !== 0); // 다 나간 품목은 선반에 없다 — 경고 대상 아님
    if (!h.items.length) continue;
    h.qty = r3(h.items.reduce((a, x) => a + x.qty, 0));
    h.remaining = unk ? null : r3(h.items.reduce((a, x) => a + (x.remaining || 0), 0));
    out.push(h);
  }
  return out.sort((a, b) => a.deduct_date.localeCompare(b.deduct_date));
}

/** 실사 전 점검. productIds 가 있으면 그 품목만(엑셀 미리보기), 없으면 칸 전체(실사 화면 진입 시). */
export async function countChecks(sb: Sb, opts: { chan: InvChannel; date: string; today: string; productIds?: Set<string>; names?: Map<string, string> }): Promise<CountChecks> {
  const { chan, date, today, productIds } = opts;
  const keep = (pid: string) => !productIds || productIds.has(pid);
  const cols = "id, product_id, type, qty, txn_date, partner";
  const [b2bAll, pendingAll, movedAll] = await Promise.all([
    b2bHolds(sb, chan, date),
    withChanFallback((withChan) => readAll<CheckTxn>((a, b) => {
      let q = sb.from("inventory_txns").select(cols).eq("status", "대기");
      if (withChan) q = q.eq("channel", chan);
      return q.order("txn_date", { ascending: true }).order("id", { ascending: true }).range(a, b);
    })),
    // 조정은 실물 움직임이 아니라 뺀다(방금 반영한 실사가 다시 경고로 뜨지 않게)
    withChanFallback((withChan) => readAll<CheckTxn>((a, b) => {
      let q = sb.from("inventory_txns").select(cols).eq("status", "완료").in("type", ["입고", "출고"])
        .gte("txn_date", date).lte("txn_date", today);
      if (withChan) q = q.eq("channel", chan);
      return q.order("txn_date", { ascending: true }).order("id", { ascending: true }).range(a, b);
    })),
  ]);
  const b2b = b2bAll
    .map((h) => (productIds ? { ...h, items: h.items.filter((x) => keep(x.product_id)) } : h))
    .filter((h) => h.items.length > 0)
    .map((h) => ({
      ...h,
      qty: r3(h.items.reduce((s, x) => s + x.qty, 0)),
      remaining: h.items.some((x) => x.remaining === null) ? null : r3(h.items.reduce((s, x) => s + (x.remaining || 0), 0)),
    }));
  const pending = pendingAll.filter((t) => keep(t.product_id));
  const moved = movedAll.filter((t) => keep(t.product_id));
  const sameDayRows = moved.filter((t) => t.txn_date === date);
  const afterRows = moved.filter((t) => t.txn_date > date);

  // 목록에 나오는 품목명 — 호출부가 가진 이름을 먼저 쓰고, 모르는 것만 읽는다
  const shownMoved = [...sameDayRows, ...afterRows].slice(0, 50);
  const shownPending = pending.slice(0, 100);
  const ids = new Set<string>([...b2b.flatMap((h) => h.items.map((x) => x.product_id)), ...shownPending.map((t) => t.product_id), ...shownMoved.map((t) => t.product_id)]);
  const names: Record<string, string> = {};
  const missing: string[] = [];
  for (const id of ids) { const n = opts.names?.get(id); if (n) names[id] = n; else missing.push(id); }
  if (missing.length) {
    type P = { id: string; name: string; spec: string | null };
    const ps = await inChunks(missing, (c) => readAll<P>((a, b) => sb.from("products").select("id, name, spec").in("id", c).order("id", { ascending: true }).range(a, b)));
    for (const p of ps) names[p.id] = p.spec ? `${p.name} ${p.spec}` : p.name;
  }
  const pendingBy: Record<string, number> = {};
  for (const t of pending) pendingBy[t.product_id] = (pendingBy[t.product_id] || 0) + 1;
  return { date, b2b, pending: shownPending, pendingTotal: pending.length, pendingBy, sameDay: sameDayRows.length, after: afterRows.length, moved: shownMoved, names };
}

/** 실사일 검사 — 형식·오늘 이후 금지·최근 31일 안. 오류 문구(없으면 null). */
export function countDateError(date: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "실사일이 올바르지 않습니다.";
  if (date > today) return "실사일은 오늘 이후로 할 수 없습니다.";
  const min = new Date(Date.parse(today + "T00:00:00Z") - 31 * 86400_000).toISOString().slice(0, 10);
  if (date < min) return "실사일은 최근 31일 안에서 고르세요.";
  return null;
}
