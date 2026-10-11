import { supabaseAdmin } from "./supabase";
import { signedQty, type InvChannel } from "./inventory";
import { getAllBundles, expandBundleQty, type BundleComponent } from "./product-bundles";
import { getUntracked, EMPTY_UNTRACKED } from "./stock-tracked";
import {
  RecipientInput,
  ShipmentScheduleInput,
  normalizeRecipient,
} from "./b2b-orders";
import { syncOrderSalesSafe, SALES_SYNC_FAILED_MSG } from "./b2b-sales-sync";

// 저장된 발주상품 (폼 인덱스 → DB id + 스냅샷). product_id 는 즉시출고 시 재고원장 기록용.
export type SavedOrderItem = { id: string; product_id: string | null; product_name: string; spec: string | null };

type SbClient = ReturnType<typeof supabaseAdmin>;
// 서버 '오늘'은 KST 로 잡는다(docs/ledger-standard.md S6 — UTC 오늘 금지).
export const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

// 취소 복구·재저장 때 선점을 켜도 되는 발주의 기준일 — 차수별 '재고 차감 대상' 체크박스를 없앤 날(b7174d3).
//  035(2026-06-30) 전 발주는 선점 없이 운영됐고, 06-30~08-04 발주는 체크박스로 일부러 끈 차수(stock_out=false)가 있을 수 있다.
//  이날 이후 만든 발주의 false 는 예전 취소가 남긴 흔적뿐이라(화면에서 끌 방법이 없다) 저장 때마다 켠다.
export const STOCK_OUT_SINCE = "2026-08-05";
export const B2B_SHIP_BY = "B2B 자동출고";          // B2B 선점·출고 유지 행의 created_by(재고 화면이 '발주에서'로 잠근다)
export const B2B_SHIP_SOURCE = "b2b_ship";           // 131: 선점 행 source(source_ref = 발주 id)
export const B2B_CANCEL_KEPT_SOURCE = "b2b_cancel_kept"; // 131: 발송 뒤 취소했지만 물건이 안 돌아온 출고(source_ref = 발주 id)

// 차수 입력 — 재구성 경로가 쓰는 칸(cancelled_with_order: 134, 발주 단위 취소로 같이 취소된 차수)
export type ShipSchedule = ShipmentScheduleInput & { cancelled_with_order?: boolean };
export type ShipRow = Record<string, unknown> & { id: string };

// 라우트가 상태 코드·추가 칸(need_return 등)과 함께 돌려줄 오류 — 쓰기 전에 던지면 아무것도 바뀌지 않는다.
export class ShipChangeError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// 재구성한 뒤 삭제하기 전에 다른 요청이 같은 발주의 차수를 바꾼 경우(409) — 쓰기 전에 던지므로 이 요청은 아무것도 안 바꿨다.
//  부르는 쪽은 차수를 스냅샷으로 되돌리면 안 된다(지금 차수는 다른 요청의 결과다).
export const SHIP_CONFLICT_MSG = "다른 곳에서 발송 일정이 바뀌었습니다 — 새로고침한 뒤 다시 시도하세요.";
export const isShipConflict = (e: unknown) => e instanceof ShipChangeError && e.extra?.conflict === true;
// 차수 지문 — 재저장은 차수 id 를 새로 만들고, 송장·박스 수 PATCH 는 그 칸을 제자리에서 고친다
const shipFingerprint = (rows: Record<string, unknown>[]) =>
  rows
    .map((s) => ["id", "status", "ship_date", "shipped_at", "tracking_no", "box_count"].map((k) => String(s[k] ?? "")).join("|"))
    .sort()
    .join("\n");
// 두 차수 목록이 같은가(지문 비교) — 앞서 읽은 스냅샷 뒤에 다른 요청이 차수를 다시 저장했는지 판정할 때
export const sameShipRows = (a: Record<string, unknown>[], b: Record<string, unknown>[]) => shipFingerprint(a) === shipFingerprint(b);

// 컬럼(마이그레이션) 미적용 오류인가 — 그때만 폴백하고 그 밖의 오류는 던진다(S4: 읽기 실패 ≠ 없음).
export function missingColumn(e: { code?: string; message?: string } | null | undefined, ...cols: string[]): boolean {
  if (!e) return false;
  const msg = (e.message || "").toLowerCase();
  const isMissing = e.code === "42703" || e.code === "PGRST204" || /does not exist|could not find|schema cache/.test(msg);
  return isMissing && cols.some((c) => msg.includes(c.toLowerCase()));
}

// 발송된 차수 = 발송완료이거나 발송 시각이 남은 차수(취소돼도 '안 돌아옴'이면 시각을 남긴다)
export const isShippedSchedule = (s: { status?: string | null; shipped_at?: string | null }) =>
  s.status === "발송완료" || !!s.shipped_at;
// '출고 유지' 행을 차수에 묶는 키 — 발송 시각(재저장해도 그대로 보존된다)
export function shippedKey(shippedAt: string | null | undefined): number | null {
  if (!shippedAt) return null;
  const t = Date.parse(shippedAt);
  return Number.isFinite(t) ? t : null;
}
const keptPrefix = (orderId: string, key: number) => `${B2B_CANCEL_KEPT_SOURCE}:${orderId}:${key}:`;
// '출고 유지' 행이 남은 차수의 발송 시각 키(shippedKey) — 131 미적용이면 그런 행이 있을 수 없다(빈 집합). 그 밖의 조회 오류는 던진다(S4).
export async function keptShipKeys(sb: SbClient, orderId: string): Promise<Set<number>> {
  const out = new Set<number>();
  const k = await sb.from("inventory_txns").select("request_key").eq("source", B2B_CANCEL_KEPT_SOURCE).eq("source_ref", orderId);
  if (k.error) {
    if (missingColumn(k.error, "source", "request_key")) return out;
    throw k.error;
  }
  const head = `${B2B_CANCEL_KEPT_SOURCE}:${orderId}:`;
  for (const r of (k.data ?? []) as { request_key: string | null }[]) {
    const rk = String(r.request_key || "");
    if (!rk.startsWith(head)) continue;
    const key = Number(rk.slice(head.length).split(":")[0]);
    if (Number.isFinite(key)) out.add(key);
  }
  return out;
}

// 발송 재저장은 '전체 삭제 후 재삽입'이라 도중 실패하면 옛 차수·송장·선점출고가 사라진 채 남는다.
//  DB 트랜잭션이 없으므로(마이그레이션 없이) 삭제 전에 스냅샷을 떠 두고, 실패 시 id 그대로 복원해 원자성을 흉내낸다.
export type ShipSnapshot = {
  ships: Record<string, unknown>[];
  items: Record<string, unknown>[];
  txns: Record<string, unknown>[];
  kept: Record<string, unknown>[]; // '출고 유지' 독립 행(shipment_id 없음 — cascade 로 안 지워진다)
  keptAvailable: boolean;          // 131(source 칸) 적용 여부
};
//  조회 오류는 던진다(삭제 전이라 저장이 깨끗이 중단된다) — 빈 스냅샷으로 넘어가면 복원도, 이미 나간 선점의 칸 유지(effChannel)도 조용히 꺼진다.
export async function snapshotOrderShipments(sb: SbClient, orderId: string): Promise<ShipSnapshot> {
  const { data: ships, error: se } = await sb.from("shipments").select("*").eq("order_id", orderId);
  if (se) throw se;
  const ids = (ships ?? []).map((s) => (s as { id: string }).id);
  let items: Record<string, unknown>[] = [];
  if (ids.length) {
    const ir = await sb.from("shipment_items").select("*").in("shipment_id", ids);
    if (ir.error) throw ir.error;
    items = ir.data ?? [];
  }
  let txns: Record<string, unknown>[] = [];
  if (ids.length) {
    const r = await sb.from("inventory_txns").select("*").in("shipment_id", ids);
    if (r.error && !missingColumn(r.error, "shipment_id")) throw r.error;
    txns = r.error ? [] : (r.data ?? []); // shipment_id 컬럼 미적용(035 전) 환경이면 무시
  }
  let kept: Record<string, unknown>[] = [];
  let keptAvailable = true;
  const k = await sb.from("inventory_txns").select("*").eq("source", B2B_CANCEL_KEPT_SOURCE).eq("source_ref", orderId);
  if (k.error) {
    if (!missingColumn(k.error, "source")) throw k.error;
    keptAvailable = false; // 131 미적용 — 출고 유지 행이 있을 수 없다
  } else kept = k.data ?? [];
  return { ships: ships ?? [], items, txns, kept, keptAvailable };
}
// 실패 시 원상복구. 한 단계라도 실패하면 false — 부르는 쪽이 '복원도 실패'를 화면에 알린다(조용히 넘기지 않는다).
export async function restoreOrderShipments(sb: SbClient, orderId: string, snap: ShipSnapshot): Promise<boolean> {
  const errs: string[] = [];
  const step = async (label: string, p: PromiseLike<{ error: { message?: string } | null }>) => {
    const r = await p;
    if (r.error) errs.push(`${label}: ${r.error.message || "오류"}`);
  };
  try {
    // 부분 삽입된 새 데이터를 걷어낸 뒤 옛 데이터를 id 그대로 재삽입 → FK(shipment_id) 관계까지 원상복구.
    await step("차수 정리", sb.from("shipments").delete().eq("order_id", orderId));
    if (snap.ships.length) await step("차수", sb.from("shipments").insert(snap.ships));
    if (snap.items.length) await step("차수 품목", sb.from("shipment_items").insert(snap.items));
    if (snap.txns.length) await step("선점 출고", sb.from("inventory_txns").insert(snap.txns));
    if (snap.keptAvailable) {
      await step("출고 유지 정리", sb.from("inventory_txns").delete().eq("source", B2B_CANCEL_KEPT_SOURCE).eq("source_ref", orderId));
      if (snap.kept.length) await step("출고 유지", sb.from("inventory_txns").insert(snap.kept));
    }
  } catch (e) {
    errs.push(e instanceof Error ? e.message : String(e));
  }
  if (errs.length) {
    console.error("[b2b-shipments] 발송 재저장 실패 후 복원도 실패:", orderId, errs.join(" / "));
    return false;
  }
  return true;
}
const RESTORE_FAILED = " — 원래 상태로 되돌리는 것도 실패했습니다. 발주 목록의 발송일 칸에서 차수·재고를 확인한 뒤 다시 저장하세요.";

async function columnExists(sb: SbClient, table: string, col: string): Promise<boolean> {
  const r = await sb.from(table).select(col).limit(1);
  if (!r.error) return true;
  if (missingColumn(r.error, col)) return false;
  throw r.error;
}

// 즉시출고 컬럼(035) 적용 여부 — shipments.stock_out + inventory_txns.shipment_id 둘 다 있어야 동작.
//  미적용이면 발주 저장은 그대로 되고 재고 차감만 비활성. 그 밖의 조회 오류는 던진다 — 일시 오류를
//  '미적용'으로 보면 옛 선점을 지운 채 새 선점 없이 저장돼 그 발주의 차감이 영영 꺼진다(점검 확정).
async function stockOutAvailable(sb: SbClient): Promise<boolean> {
  return (await columnExists(sb, "shipments", "stock_out")) && (await columnExists(sb, "inventory_txns", "shipment_id"));
}

// ── 발주 수정(PUT)의 라인 수량 ↔ 차수 배분 검사 ──
//  선점·매출·청구는 '발주 수량 − 취소 차수 배분'으로 계산한다. 라인 수량을 배분 합(취소 차수 포함)보다 줄이면
//  실제로 나간 것보다 적게 잡힌다(발주 100·1차 60 발송·2차 40 취소 → 수량 60 으로 고치면 선점·매출이 20, 최종 점검 확정).
//  - 단일 발송 전량: 취소 아닌 차수가 하나뿐이고 이 라인 몫이 전부 거기 있으며(취소 차수 배분 없음) 저장된 수량과 같으면
//    그 차수 배분이 새 수량을 따른다(늘리든 줄이든). 발송된 차수면 발송 수량을 다시 기록하는 것 — 선점·매출이 새 수량을 따른다.
//    화면이 확인을 받고(allow_shipped_qty), 확인 없이 오면 막는다.
//  - 저장된 수량부터 배분보다 작은 라인(예전 버그로 어긋난 데이터): 수량을 그대로 두면 막지 않는다(stale — 화면이 알린다).
//    수량을 고쳤는데 아래 규칙에 걸리면 어긋난 데이터라는 안내로 막는다.
//  - 잠긴 몫(취소 차수 + 발송된 차수)보다 작게: 막는다 — 취소 몫은 이미 재고·매출·청구에서 빠졌고, 발송 몫은 실제로 나갔다.
//  - 잠긴 몫 이상이고 안 나간 차수 하나에만 배분이 있으면: 그 차수 배분을 줄인다.
//  - 안 나간 차수 여럿에 배분이 있으면: 어느 차수를 줄일지 모르므로 막는다(발송일 창에서 먼저 고친다).
//  - 줄이거나 지운 뒤 보낼 수량이 하나도 안 남는 날짜 있는 대기 차수: 막는다(빈 차수는 발송요청 양식이 발주 전체로 찍는다).
//    단 모든 차수의 배분이 비고 날짜 있는 차수가 하나뿐이면 저장 때 자동 전량 배분이 다시 채우므로 막지 않는다.
//  - 지운 라인이 발송된 차수나 발송 뒤 취소(안 돌아옴)한 차수에 배분돼 있으면 막는다(나간 물건·출고 유지의 근거가 사라진다).
//  - 줄 id 를 그대로 둔 채 연결 상품만 바꾼 라인도 지운 라인과 같다 — 재저장이 옛 상품 선점을 지우고 새 상품을 발송일로 뺀다.
//    발송된 차수나 안 돌아옴 취소 차수에 배분이 있으면 막는다(출고 유지 행은 옛 상품으로 남는다).
//    단 미연동 줄(상품 없음)에 상품을 처음 연결하는 것은 '재고 미연동' 정리 경로라 막지 않고 확인을 받는다(relinks — 안 돌아옴 취소는 막는다).
//  지운 라인의 배분은 저장 때 끊기므로(on delete set null) 나머지 검사는 지운 뒤 모습으로 본다 — 재저장 mutate 가 읽는 차수와 같다.
//  쓰기 전에 스냅샷으로 한 번, 재저장 mutate 에서 다시 읽은 차수로 한 번 같은 규칙을 돌린다(OrderForm 에 같은 계산이 있다).
export type AllocShip = {
  id: string; seq?: number; status: string; shipped_at: string | null; ship_date: string | null;
  items: { order_item_id: string; qty: number }[];
};
// prev = 저장된(수정 전) 수량. product·prevProduct = 새·저장된 연결 상품(둘 다 넘길 때만 상품 바꿈을 검사), prevLabel = 저장된 품목명
export type AllocLine = {
  id: string; qty: number; prev?: number | null; label: string;
  product?: string | null; prevProduct?: string | null; prevLabel?: string;
};
// shipped = 발송된 차수의 수량을 다시 기록(단일 발송 전량) — 확인이 필요하다
export type AllocCut = { shipId: string; seq: number | null; lineId: string; label: string; from: number; to: number; shipped: boolean };
// 미연동 줄에 상품을 처음 연결 — 발송된 수량이 그 상품 재고에서 빠진다(확인이 필요하다)
export type AllocRelink = { lineId: string; label: string; qty: number };
export type AllocIssue = { kind: "short" | "split" | "empty" | "removed" | "stale" | "product"; lineId?: string; text: string };
export type AllocPlan = { errors: AllocIssue[]; stale: AllocIssue[]; cuts: AllocCut[]; relinks: AllocRelink[]; multi: boolean };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const ALLOC_EPS = 1e-9;
const allocKind = (s: AllocShip) =>
  s.status === "취소" ? "cancelled" : s.status === "발송완료" || !!s.shipped_at ? "shipped" : "pending";
const isAllocReal = (s: AllocShip) => !!s.ship_date || s.items.some((it) => Number(it.qty) > 0);
function lineAllocOf(ships: AllocShip[], lineId: string) {
  const a = { total: 0, cancelled: 0, kept: 0, shipped: 0, pending: new Map<string, number>() };
  for (const s of ships) {
    const q = s.items.filter((it) => it.order_item_id === lineId).reduce((x, it) => x + (Number(it.qty) || 0), 0);
    if (q <= 0) continue;
    a.total += q;
    const k = allocKind(s);
    if (k === "cancelled") {
      a.cancelled += q;
      if (s.shipped_at) a.kept += q; // 발송 뒤 취소(안 돌아옴) — 돌아온 취소는 발송 시각을 지운다
    } else if (k === "shipped") a.shipped += q;
    else a.pending.set(s.id, (a.pending.get(s.id) || 0) + q);
  }
  return a;
}
export function planLineAllocCut(lines: AllocLine[], removed: AllocLine[], ships: AllocShip[]): AllocPlan {
  const removedIds = new Set(removed.map((l) => l.id));
  const after = ships.map((s) => ({ ...s, items: s.items.filter((it) => !removedIds.has(it.order_item_id)) }));
  const real = after.filter(isAllocReal);
  const live = real.filter((s) => allocKind(s) !== "cancelled");
  const sole = live.length === 1 ? live[0] : null;
  const errors: AllocIssue[] = [];
  const stale: AllocIssue[] = [];
  const cuts: AllocCut[] = [];
  const relinks: AllocRelink[] = [];
  for (const l of lines) {
    const a = lineAllocOf(real, l.id);
    if (a.total <= ALLOC_EPS) continue;
    // 연결 상품을 바꾼 줄 — 발송된·안 돌아옴 배분이 있으면 지운 라인과 같이 막는다(아래 수량 검사는 그대로 이어서 본다)
    if (l.product !== undefined && l.prevProduct !== undefined && (l.product || null) !== (l.prevProduct || null)) {
      if (a.kept > ALLOC_EPS || (a.shipped > ALLOC_EPS && l.prevProduct)) {
        const where = [
          a.shipped > ALLOC_EPS ? `발송된 차수에 ${r3(a.shipped)}` : "",
          a.kept > ALLOC_EPS ? `발송 뒤 취소(안 돌아옴)한 차수에 ${r3(a.kept)}` : "",
        ].filter(Boolean).join(" · ");
        const name = l.prevLabel && l.prevLabel !== l.label ? `${l.prevLabel} → ${l.label}` : l.label;
        errors.push({ kind: "product", lineId: l.id, text: `${name}: ${where} 배분` });
      } else if (a.shipped > ALLOC_EPS) {
        relinks.push({ lineId: l.id, label: l.label, qty: r3(a.shipped) });
      }
    }
    const q = Number(l.qty) || 0;
    const prev = l.prev === undefined || l.prev === null ? null : Number(l.prev) || 0;
    // 단일 발송 전량 — 배분이 수량을 따른다
    if (sole && a.cancelled <= ALLOC_EPS && prev !== null && Math.abs(a.total - prev) <= ALLOC_EPS && q > ALLOC_EPS) {
      if (Math.abs(q - a.total) > ALLOC_EPS) {
        cuts.push({ shipId: sole.id, seq: sole.seq ?? null, lineId: l.id, label: l.label, from: r3(a.total), to: r3(q), shipped: allocKind(sole) === "shipped" });
      }
      continue;
    }
    if (q >= a.total - ALLOC_EPS) continue;
    const parts = [a.shipped > 0 ? `발송 ${r3(a.shipped)}` : "", a.cancelled > 0 ? `취소 ${r3(a.cancelled)}` : ""].filter(Boolean).join(" · ");
    const wasShort = prev !== null && prev < a.total - ALLOC_EPS;
    if (wasShort) {
      const same = Math.abs(q - (prev as number)) <= ALLOC_EPS;
      const issue: AllocIssue = {
        kind: "stale", lineId: l.id,
        text: `${l.label}: 발주 ${r3(q)}${same ? "" : `(저장된 수량 ${r3(prev as number)})`} / 배분 ${r3(a.total)}${parts ? `(${parts})` : ""}`,
      };
      if (same) { stale.push(issue); continue; }
      if (q < a.cancelled + a.shipped - ALLOC_EPS || a.pending.size !== 1) { errors.push(issue); continue; }
    } else if (q < a.cancelled + a.shipped - ALLOC_EPS) {
      errors.push({ kind: "short", lineId: l.id, text: `${l.label}: 발주 ${r3(q)} / 배분 ${r3(a.total)}(${parts} 포함)` });
      continue;
    } else if (a.pending.size !== 1) {
      errors.push({ kind: "split", lineId: l.id, text: `${l.label}: 발주 ${r3(q)} / 배분 ${r3(a.total)} — 안 나간 차수 ${a.pending.size}곳에 나뉘어 있습니다` });
      continue;
    }
    const [shipId, from] = [...a.pending.entries()][0];
    const ship = real.find((s) => s.id === shipId);
    cuts.push({ shipId, seq: ship?.seq ?? null, lineId: l.id, label: l.label, from: r3(from), to: r3(Math.max(0, from - (a.total - q))), shipped: false });
  }
  // 줄이거나 지운 뒤 보낼 수량이 하나도 안 남는 날짜 있는 대기 차수
  const leftOf = (s: AllocShip) => {
    const mine = cuts.filter((c) => c.shipId === s.id);
    return s.items.reduce((x, it) => x + (mine.some((m) => m.lineId === it.order_item_id) ? 0 : Number(it.qty) || 0), 0)
      + mine.reduce((x, c) => x + c.to, 0);
  };
  const lostFrom = new Set(ships.filter((s) => s.items.some((it) => removedIds.has(it.order_item_id) && Number(it.qty) > 0)).map((s) => s.id));
  const autoRefill = !real.some((s) => leftOf(s) > ALLOC_EPS) && live.filter((s) => !!s.ship_date).length <= 1;
  if (!autoRefill) {
    for (const s of real) {
      if (allocKind(s) !== "pending" || !s.ship_date) continue;
      if (!cuts.some((c) => c.shipId === s.id) && !lostFrom.has(s.id)) continue;
      if (leftOf(s) <= ALLOC_EPS) {
        errors.push({ kind: "empty", text: `${s.seq ? `${s.seq}차` : "안 나간 차수"}(${s.ship_date})에 보낼 수량이 0 이 됩니다 — 발송일 창에서 그 차수를 먼저 지우세요` });
      }
    }
  }
  // 지운 라인 — 지우기 전 배분으로 본다
  const realBefore = ships.filter(isAllocReal);
  for (const l of removed) {
    const a = lineAllocOf(realBefore, l.id);
    const where = [
      a.shipped > ALLOC_EPS ? `발송된 차수에 ${r3(a.shipped)}` : "",
      a.kept > ALLOC_EPS ? `발송 뒤 취소(안 돌아옴)한 차수에 ${r3(a.kept)}` : "",
    ].filter(Boolean).join(" · ");
    if (where) errors.push({ kind: "removed", lineId: l.id, text: `${l.label}: ${where} 배분 — 지울 수 없습니다` });
  }
  return { errors, stale, cuts, relinks, multi: real.length >= 2 };
}
export const ALLOC_CUT_GUIDE =
  "취소한 차수 몫은 이미 재고·매출·청구에서 빠져 있으니 수량은 그대로 두세요. 실제로 덜 나갔거나 차수를 나눠 줄여야 하면 발주 목록의 발송일 칸에서 그 차수 수량을 먼저 고치세요.";
export const ALLOC_STALE_GUIDE =
  "배분이 맞으면 수량을 배분 합으로 고치고(취소 몫은 재고·매출에서 자동으로 빠집니다), 수량이 맞으면 발주 목록의 발송일 칸에서 차수 수량을 줄이거나 취소 차수를 지우세요.";
export const ALLOC_PRODUCT_GUIDE =
  "잘못 고른 품목이면 발주 목록에서 그 발송을 '발송대기'로 되돌려 품목을 고친 뒤 다시 '발송완료'로 바꾸세요(취소한 발주는 먼저 복구). 다른 품목을 더 보낸 것이면 줄을 새로 추가하세요.";
export function allocCutError(errors: AllocIssue[]): string {
  const normal = errors.filter((e) => e.kind !== "stale" && e.kind !== "product").map((e) => e.text);
  const stale = errors.filter((e) => e.kind === "stale").map((e) => e.text);
  const product = errors.filter((e) => e.kind === "product").map((e) => e.text);
  return [
    product.length ? `발송된 품목은 바꿀 수 없습니다 — ${product.join(" / ")}. ${ALLOC_PRODUCT_GUIDE}` : "",
    normal.length ? `수량을 차수 배분보다 줄일 수 없습니다 — ${normal.join(" / ")}. ${ALLOC_CUT_GUIDE}` : "",
    stale.length ? `저장된 수량이 이미 차수 배분과 어긋난 품목입니다 — ${stale.join(" / ")}. ${ALLOC_STALE_GUIDE}` : "",
  ].filter(Boolean).join(" ");
}
// 발송된 차수의 수량을 다시 기록·미연동 줄에 상품 연결 — 화면 확인 문구와 같다
export const shippedQtyText = (cuts: AllocCut[], relinks: AllocRelink[] = []) =>
  `${[
    ...cuts.map((c) => `${c.label}: 발송된 수량을 ${c.from} → ${c.to} 으로 고칩니다`),
    ...relinks.map((r) => `${r.label}: 상품을 연결해 발송된 ${r.qty} 이 그 상품 재고에서 빠집니다`),
  ].join(" / ")} — 재고·매출이 함께 바뀝니다`;
// 스냅샷(쓰기 전) → 배분 검사 입력
export function allocShipsFromSnapshot(snap: ShipSnapshot): AllocShip[] {
  return snap.ships.map((s) => ({
    id: String(s.id),
    seq: Number(s.seq) || undefined,
    status: String(s.status || "발송대기"),
    shipped_at: (s.shipped_at as string | null) ?? null,
    ship_date: (s.ship_date as string | null) ?? null,
    items: snap.items
      .filter((it) => String(it.shipment_id) === String(s.id) && !!it.order_item_id)
      .map((it) => ({ order_item_id: String(it.order_item_id), qty: Number(it.qty) || 0 })),
  }));
}
// 재구성한 차수(mutate 안) → 배분 검사 입력. 라인 순번은 savedItems 기준(reconstructSchedules 와 같다)
export function allocShipsFromSchedules(schedules: ShipSchedule[], ships: ShipRow[], savedItems: SavedOrderItem[]): AllocShip[] {
  const seqOf = new Map(ships.map((s) => [String(s.id), Number(s.seq) || undefined]));
  return schedules.map((s, i) => ({
    id: s.id ? String(s.id) : `new-${i}`,
    seq: s.id ? seqOf.get(String(s.id)) : undefined,
    status: s.status || "발송대기",
    shipped_at: s.shipped_at ?? null,
    ship_date: s.ship_date || null,
    items: (s.items || [])
      .filter((it) => savedItems[it.order_item_index])
      .map((it) => ({ order_item_id: savedItems[it.order_item_index].id, qty: Number(it.qty) || 0 })),
  }));
}
// 검사가 정한 대로 차수 배분을 새 수량에 맞춘다 — 안 나간 차수 감축, 단일 발송 전량은 늘리기·줄이기(쓰기 전 mutate 안에서)
export function applyAllocCuts(schedules: ShipSchedule[], savedItems: SavedOrderItem[], cuts: AllocCut[]): void {
  for (const c of cuts) {
    const s = schedules.find((x) => x.id === c.shipId);
    const idx = savedItems.findIndex((l) => l.id === c.lineId);
    if (!s || idx < 0) throw new ShipChangeError(SHIP_CONFLICT_MSG, 409, { conflict: true });
    s.items = (s.items || []).filter((it) => it.order_item_index !== idx);
    if (c.to > 1e-9) s.items.push({ order_item_index: idx, qty: c.to });
  }
}

// 복수 발송(2건 이상) 발주의 상위 발송상태를 하위 차수 발송상태들로부터 도출.
//  전부 취소 → 취소 / 취소 아닌 차수 중 하나라도 발송완료 → 발송완료 / 아직 하나도 안 나감 → 발송대기.
//  첫 차수가 나가면 발송완료 = 매출 인식(발주 전량, 첫 발송일) — 2026-09-28 대표 확인: '첫 발송 시 매출 등록'.
//  재고도 첫 발송일에 발주 전량을 차감하므로 매출과 같은 시점이 된다. 예전(전 차수 발송완료 시 인식)엔
//  1차 발송 뒤 2차를 추가하면 발주가 발송대기로 돌아가 이미 잡힌 매출이 원장에서 지워졌다.
//  남은 차수의 지연·완료 판정은 발주 상태가 아니라 차수로 본다(b2b-orders orderUrgency·isOrderComplete).
//  발송이 2건 미만이면 null(도출 안 함 — 일반 발주는 메인 발송상태를 직접 관리).
export function deriveParentStatus(statuses: string[]): string | null {
  if (statuses.length < 2) return null;
  const nonCancel = statuses.filter((s) => s !== "취소");
  if (nonCancel.length === 0) return "취소";
  return nonCancel.some((s) => s === "발송완료") ? "발송완료" : "발송대기";
}

// ── 재구성(모든 상태 변경 경로 공용) ──
//  재저장은 '전체 삭제 후 재삽입'이라, 빈 배열을 넘기면 자동 차수 생성이 송장·박스 수·재고차감 설정을
//  하드코딩 값으로 덮는다. 상태·발송일만 바꿀 때도 DB 차수를 그대로 재구성해 넘긴다. 조회 오류는 던진다(S4).
export async function loadSavedItems(sb: SbClient, orderId: string): Promise<SavedOrderItem[]> {
  const { data, error } = await sb
    .from("order_items")
    .select("id, product_id, product_name, spec, sort_order")
    .eq("order_id", orderId)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true }); // 같은 순번이면 id 순 — 발송일 창의 라인 순번(order_item_index)과 같은 순서
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    product_id: (r.product_id as string) ?? null,
    product_name: r.product_name as string,
    spec: (r.spec as string) ?? null,
  }));
}
export async function reconstructSchedules(
  sb: SbClient,
  orderId: string,
  savedItems: SavedOrderItem[]
): Promise<{ ships: ShipRow[]; schedules: ShipSchedule[] }> {
  const { data: ships, error } = await sb.from("shipments").select("*").eq("order_id", orderId).order("seq", { ascending: true });
  if (error) throw error;
  const rows = (ships ?? []) as ShipRow[];
  const byShip = new Map<string, { order_item_id: string | null; qty: number }[]>();
  if (rows.length) {
    const r = await sb.from("shipment_items").select("shipment_id, order_item_id, qty").in("shipment_id", rows.map((s) => s.id));
    if (r.error) throw r.error;
    for (const it of (r.data ?? []) as { shipment_id: string; order_item_id: string | null; qty: number }[]) {
      byShip.set(it.shipment_id, [...(byShip.get(it.shipment_id) || []), it]);
    }
  }
  const idxOf = new Map(savedItems.map((s, i) => [s.id, i]));
  const schedules: ShipSchedule[] = rows.map((s) => ({
    id: s.id,
    ship_date: (s.ship_date as string | null) || "",
    status: ((s.status as string) || "발송대기") as ShipmentScheduleInput["status"],
    tracking_no: (s.tracking_no as string | null) || "",
    box_count: Math.max(1, Math.floor(Number(s.box_count) || 1)),
    stock_out: (s as { stock_out?: boolean }).stock_out !== false,
    shipped_at: (s.shipped_at as string | null) ?? null, // 기존 발송 시각 보존(재저장이 now 로 덮지 않게)
    cancelled_with_order: (s as { cancelled_with_order?: boolean }).cancelled_with_order === true,
    items: (byShip.get(s.id) || [])
      .map((r) => ({ order_item_index: idxOf.get(r.order_item_id as string) ?? -1, qty: Number(r.qty) || 0 }))
      .filter((x) => x.order_item_index >= 0 && x.qty > 0),
  }));
  return { ships: rows, schedules };
}
export const recipientOf = (ship0: ShipRow | undefined): RecipientInput =>
  (ship0
    ? { recipient_name: ship0.recipient_name, recipient_phone: ship0.recipient_phone, address: ship0.address, delivery_memo: ship0.delivery_memo, courier: ship0.courier }
    : {}) as RecipientInput;

// 실제 저장될 차수(날짜가 있거나 수량이 담긴 것) — 날짜·수량이 모두 없는 행은 배송정보 전용
const isRealSchedule = (s: ShipmentScheduleInput) =>
  !!s.ship_date || (s.items || []).some((it) => Number(it.qty) > 0);

// 취소하는 차수에 배분이 없을 때(옛 데이터) 그 차수 몫을 정한다 — 모호하면 null.
//  단일 발송이면 발주 전량, 다른 차수가 모두 배분을 가졌으면 그 나머지. 다른 차수도 배분이 없으면 알 수 없다.
function remainderFor(
  schedules: ShipmentScheduleInput[], i: number, orderItems: SavedOrderItem[], orderQtyById: Map<string, number>
): { order_item_index: number; qty: number }[] | null {
  const others = schedules.filter((s, j) => j !== i && isRealSchedule(s));
  if (others.some((s) => !(s.items || []).some((it) => Number(it.qty) > 0))) return null;
  const used = new Map<number, number>();
  for (const s of others) for (const it of s.items || []) used.set(it.order_item_index, (used.get(it.order_item_index) || 0) + (Number(it.qty) || 0));
  const out = orderItems
    .map((line, idx) => ({ order_item_index: idx, qty: Math.max(0, (orderQtyById.get(line.id) || 0) - (used.get(idx) || 0)) }))
    .filter((x) => x.qty > 0);
  return out;
}

export type SaveShipmentsOpts = {
  cancelled?: number[];    // 이번 요청으로 취소하는 차수(schedules index) — 배분이 없으면 그 차수 몫을 채워 감액 근거를 남긴다
  keep?: number[];         // 그중 물건이 안 돌아온 차수 — 그 차수로 나간 수량을 '출고 유지' 독립 행으로 남긴다(대표 결정 D3)
  releaseKeys?: number[];  // 되살리거나 발송 전으로 되돌린 차수의 '출고 유지' 키(shippedKey) — 지우고 일반 선점으로 돌아간다
  expectedShips?: Record<string, unknown>[]; // 재구성 때 읽은 차수(applyOrderShipments 가 채운다) — 삭제 직전 스냅샷과 다르면 409
};
export type SaveShipmentsResult = {
  earliestShipDate: string | null;
  derivedStatus: string | null;
  singleStatus: string | null; // 저장된 차수가 1건이면 그 상태
  totalBoxes: number;
  channelKept: InvChannel | null;
  channelNotice: string | null;
};

/**
 * 발주의 발송 일정(분할 발송)을 통째로 교체 저장.
 * - 기존 shipments 전부 삭제(shipment_items 는 cascade) 후 재삽입
 * - 각 일정: 공통 배송정보 + 발송예정일·상태·운송장 + 담긴 상품/수량(shipment_items)
 * - 반환: 가장 이른 발송예정일 (orders.ship_date 동기화용)
 *  상태 변경 경로는 이 함수를 직접 부르지 말고 applyOrderShipments 를 쓴다(헤더·매출까지 같은 규칙으로 맞춘다).
 */
export async function saveOrderShipments(
  orderId: string,
  recipient: RecipientInput,
  schedules: ShipSchedule[],
  orderItems: SavedOrderItem[],
  orderBoxCount = 1,
  headerShipDate?: string | null,
  headerStatus?: ShipmentScheduleInput["status"] | null,
  opts: SaveShipmentsOpts = {}
): Promise<SaveShipmentsResult> {
  const sb = supabaseAdmin();
  const expectedShips = opts.expectedShips; // 아래 자동 차수 분기가 opts 를 비워도 경합 검사는 그대로

  // 발주 헤더의 '발송예정일'만 입력하고 발송 차수를 따로 만들지 않은 단일 발송 발주 —
  //  그 발송예정일로 차수 하나를 만들어 재고 차감·발송 관리가 동작하게 한다(가장 흔한 사용 흐름).
  //  차수를 이미 하나라도 만든 경우(분할발송)엔 손대지 않는다.
  if (headerShipDate && !(schedules || []).some((s) => s.ship_date || (s.items || []).some((it) => Number(it.qty) > 0))) {
    schedules = [{ ship_date: headerShipDate, status: headerStatus || "발송대기", tracking_no: "", box_count: 1, stock_out: true, items: [] }];
    opts = {}; // 차수 index 는 넘겨받은 배열 기준이라 새 배열엔 맞지 않는다(취소·유지는 차수가 있을 때만 온다)
  }
  schedules = schedules || [];

  // 즉시출고(재고 선점) 가능 여부 + 거래처명(원장 표시용)·대량 발주 여부(차감할 칸)·등록일(차감 기준일) 준비.
  //  조회 오류는 던진다 — 이 값들은 아래 삭제 전에 읽으므로 던지면 아무것도 바뀌지 않는다(S4).
  const canDeduct = await stockOutAvailable(sb);
  const withCancelFlag = await columnExists(sb, "shipments", "cancelled_with_order"); // 134
  type OrdRes = {
    data: { is_bulk?: boolean; created_at?: string | null; companies?: { name?: string } | { name?: string }[] } | null;
    error: { code?: string; message?: string } | null;
  };
  let ordRes = (await sb.from("orders").select("is_bulk, created_at, companies:company_id(name)").eq("id", orderId).maybeSingle()) as unknown as OrdRes;
  //  115 미적용 환경이면 에러 메시지에 컬럼명이 보인다 — 그 컬럼만 빼고 재조회(전건 '도매'로 차감, 종전 동작).
  if (ordRes.error && missingColumn(ordRes.error, "is_bulk")) {
    ordRes = (await sb.from("orders").select("created_at, companies:company_id(name)").eq("id", orderId).maybeSingle()) as unknown as OrdRes;
  }
  if (ordRes.error) throw ordRes.error;
  if (!ordRes.data) throw new ShipChangeError("발주를 찾을 수 없습니다.", 404);
  const c = ordRes.data.companies;
  const partner = (Array.isArray(c) ? c[0]?.name : c?.name) ?? null;
  const isBulk = ordRes.data.is_bulk === true; // 115: 대량 발주(선결제)면 선점 출고를 '도매 대량' 칸에서 뺀다
  const createdAt = String(ordRes.data.created_at ?? "");
  const stockOutEra = !createdAt || createdAt.slice(0, 10) >= STOCK_OUT_SINCE;
  //  기준일 이후 발주는 차수 재고차감이 항상 켜진다 — 옛 취소가 남긴 false 를 읽어 차감이 영영 꺼지지 않게(점검 확정).
  const stockOn = (s: ShipmentScheduleInput) => stockOutEra || s.stock_out !== false;

  // 이 발주의 선점 출고가 빠질 칸. '도매 대량'은 이동(소매→도매 대량)으로만 채워지는 보호 칸이고
  //  나가는 길은 이 B2B 발송뿐이다 — 자동 합류는 없다(RESERVED_CHANNELS 주석과 같은 규칙).
  const deductChannel: InvChannel = isBulk ? "도매 대량" : "도매";
  // 번들(묶음) 정의 — 발주 라인이 번들이면 즉시출고를 구성품으로 전개(번들은 자체 재고 없음).
  //  getAllBundles 는 조회 오류를 던진다(테이블 없음만 빈 맵) — '세트 없음'으로 보고 세트 id 로 차감하지 않게.
  //  '재고 관리 사용 안함'(121) 품목은 전개 뒤 빼서 선점 행을 남기지 않는다(드라이아이스 등 — 발송·매출은 그대로).
  //  getUntracked 는 조회 오류를 던진다(121 미적용 = 컬럼 없음만 빈 집합, S4) — 그러면 이 저장은 스냅샷·선점 쓰기 전에 멈춘다.
  const [bundles, untracked] = canDeduct
    ? await Promise.all([getAllBundles(sb), getUntracked(sb)])
    : [new Map<string, BundleComponent[]>(), EMPTY_UNTRACKED()];
  const today = kstToday();

  // 발주 라인별 주문 수량 — 재고 차감은 '발주 전량' 기준이라 항상 필요하다. 조회 오류면 멈춘다(차감 0 으로 저장 금지).
  const orderQtyById = new Map<string, number>();
  {
    const { data: oi, error: oiErr } = await sb.from("order_items").select("id, qty").eq("order_id", orderId);
    if (oiErr) throw oiErr;
    for (const r of oi || []) orderQtyById.set(r.id as string, Number(r.qty) || 0);
  }

  // 이번에 취소하는 차수에 배분이 없으면(옛 데이터) 그 차수 몫을 채운다 — 매출·재고·청구가 '취소 차수 배분'을
  //  주문에서 빠진 양으로 읽으므로, 비어 있으면 취소해도 아무것도 안 빠진다. 몫이 모호하면 그대로 둔다.
  for (const i of opts.cancelled ?? []) {
    const s = schedules[i];
    // 날짜 없는 배송정보 전용 행은 차수가 아니다 — 채우면 '발송일 미정' 차수로 바뀌어 복구 때 선점이 생긴다
    if (!s || s.status !== "취소" || !s.ship_date || (s.items || []).some((it) => Number(it.qty) > 0)) continue;
    const fill = remainderFor(schedules, i, orderItems, orderQtyById);
    if (fill && fill.length) s.items = fill;
  }

  // 차수에 상품 수량이 하나도 배정되지 않았으면(분할발송 미사용) 발주 전량을 첫 차수에 자동 배분한다.
  //  이 배분은 shipment_items(발송요청 양식·재고 대사의 '팔린 수'·발송일 미정 잔여 계산) 기준이고,
  //  재고 차감량과는 별개다 — 차감은 아래에서 발주 전량으로 따로 계산한다. 매출은 취소 차수 배분만 읽는다.
  if (canDeduct) {
    const anyAssigned = schedules.some((s) => (s.items || []).some((it) => Number(it.qty) > 0));
    if (!anyAssigned) {
      const target = schedules.find((s) => s.ship_date && s.status !== "취소" && stockOn(s));
      if (target) {
        target.items = orderItems
          .map((it, idx) => ({ order_item_index: idx, qty: orderQtyById.get(it.id) || 0 }))
          .filter((x) => x.qty > 0);
      }
    }
  }

  // ── 재고 차감은 '첫 발송일에 발주 전량' 1회 ──
  //  선결제 대량 발주를 나눠 받는 거래라, 첫 발송일 전까지 전 물량을 생산해 두고 그때 재고에서 뺀다.
  //  차수별로 나눠 찍지 않는 이유: 차수에 수량을 일부만 배정하면 나머지가 영영 차감되지 않았다.
  //  대상 = 실제로 저장되는 차수 중 취소가 아니고 재고차감이 켜진 것, 그중 발송예정일이 가장 이른 것.
  //  (발송예정일이 있는 차수가 없으면 첫 차수에 붙이고 날짜는 헤더 발송예정일 → 오늘 순으로 잡는다.)
  const willInsert = (s: ShipmentScheduleInput) =>
    !!s.ship_date || (s.items || []).some((it) => Number(it.qty) > 0 && orderItems[it.order_item_index]);
  let deductIdx = -1;
  if (canDeduct) {
    const eligible = schedules
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => willInsert(s) && s.status !== "취소" && stockOn(s));
    const dated = eligible.filter(({ s }) => !!s.ship_date);
    deductIdx = dated.length
      ? dated.reduce((a, b) => ((a.s.ship_date as string) <= (b.s.ship_date as string) ? a : b)).i
      : (eligible[0]?.i ?? -1);
  }

  // 차감할 품목·수량 — 발주 전량에서 '취소 차수에 배정된 수량'만 뺀다(매출 리포트와 같은 규칙).
  //  번들 라인은 구성품으로 전개(번들은 자체 재고가 없음).
  const deductPerProduct = new Map<string, number>();
  if (canDeduct && deductIdx >= 0) {
    const effQty = new Map(orderQtyById);
    for (const s of schedules) {
      if (s.status !== "취소") continue;
      for (const it of s.items || []) {
        const line = orderItems[it.order_item_index];
        if (!line) continue;
        effQty.set(line.id, Math.max(0, (effQty.get(line.id) || 0) - (Number(it.qty) || 0)));
      }
    }
    for (const line of orderItems) {
      const q = effQty.get(line.id) || 0;
      if (line.product_id && q > 0) expandBundleQty(bundles, line.product_id, q, deductPerProduct);
    }
  }

  // 재저장 도중 실패 시 복원할 수 있도록 옛 발송 상태를 먼저 스냅샷(아래 catch 에서 사용).
  const snap = await snapshotOrderShipments(sb, orderId);
  // 재구성(이 요청이 차수를 읽은 때)과 지금 사이에 다른 요청이 차수를 다시 저장했으면 멈춘다 — 그대로 지우고 넣으면
  //  그 요청의 발송완료·취소·선점이 오류 없이 사라지거나, 두 요청의 삽입이 겹쳐 차수·선점이 두 벌 생긴다.
  //  DB 트랜잭션이 없어 남는 창은 이 스냅샷과 아래 삭제 사이(수 ms)뿐이다 — 화면은 발주별로 요청을 하나씩 보낸다.
  if (expectedShips && shipFingerprint(snap.ships) !== shipFingerprint(expectedShips)) {
    throw new ShipChangeError(SHIP_CONFLICT_MSG, 409, { conflict: true });
  }

  // '재고 관리 사용 안함'(121) 품목은 선점 행을 남기지 않는다 — 구성품 단위로(세트 안의 관리 대상 구성품은 계속 빠진다).
  //  단 이 발주에 이미 선점 행이 있던 품목(표시 전에 차감됨)은 계속 차감한다 — 재저장은 옛 행을 지우고 다시 쓰므로,
  //  빼 버리면 표시 전의 실제 출고 기록이 조용히 사라진다(최종 점검 확정).
  if (untracked.ids.size && deductPerProduct.size) {
    const prevDeducted = new Set(snap.txns.filter((t) => t.created_by === B2B_SHIP_BY).map((t) => String(t.product_id)));
    for (const pid of [...deductPerProduct.keys()]) if (untracked.ids.has(pid) && !prevDeducted.has(pid)) deductPerProduct.delete(pid);
  }

  // 실제 차감 칸 — 이미 나간 옛 선점 출고가 있으면 그 칸을 이어 쓴다(기획 6절).
  //  재저장은 옛 선점을 cascade 로 지우고 다시 찍으므로, is_bulk 만 따르면 발송이 끝난 발주를
  //  소급 체크(또는 메모 수정 같은 무관한 재저장)할 때 옛 칸의 출고가 되살아나고 새 칸이 빠진다(유령 재고).
  //  '나갔다' = 차수가 발송완료(또는 shipped_at 보유), 또는 옛 선점일과 새 차감일이 모두 오늘보다 앞(엄격히 과거).
  //  오늘 날짜 선점(당일 정정)과, 밀린 발송대기를 오늘·미래로 다시 잡는 저장은 아직 안 나간 것으로 보고 is_bulk 를 따른다(기획 6절 '과거 날짜').
  const shippedIds = new Set(
    snap.ships
      .filter((s) => (s as { status?: string }).status === "발송완료" || !!(s as { shipped_at?: string | null }).shipped_at)
      .map((s) => (s as { id: string }).id)
  );
  const newDeductDate = deductIdx >= 0
    ? (schedules[deductIdx].ship_date || headerShipDate || today)
    : today;
  const prevOut = snap.txns.find((t) =>
    t.created_by === B2B_SHIP_BY && typeof t.channel === "string" &&
    (shippedIds.has(t.shipment_id as string) || (String(t.txn_date) < today && newDeductDate < today))
  );
  const effChannel: InvChannel = prevOut ? (prevOut.channel as InvChannel) : deductChannel;
  // is_bulk 와 다른 칸을 유지했으면 화면이 알린다 — 유지 이유(발송완료 / 지난 발송예정일)에 따라 할 일이 다르다
  const channelKept: InvChannel | null = prevOut && effChannel !== deductChannel ? effChannel : null;
  const keptShipped = !!prevOut && shippedIds.has(String(prevOut.shipment_id));
  // 저장 전 선점 칸 — 이번 저장으로 칸이 바뀌면(발송일을 다시 잡거나 대량 체크를 바꿈) 옮길 방향을 알린다
  const prevChannel = (snap.txns.find((t) => t.created_by === B2B_SHIP_BY && typeof t.channel === "string")?.channel as InvChannel | undefined) ?? null;
  let writtenChannel: InvChannel | null = null;

  // ── '출고 유지' 행(대표 결정 D3) — 발송 뒤 취소했지만 물건이 안 돌아온 차수 ──
  //  그 차수로 나간 수량(배분, 구성품 전개)을 shipment_id 없는 독립 출고로 남긴다 — 재저장 cascade 에 안 지워지고
  //  복구 때만 지운다. 이 발주에서 실제로 빠져 있던 수량(이전 선점)까지만 — 차감된 적 없는 것을 새로 빼지 않는다.
  const keptRows: Record<string, unknown>[] = [];
  const keepIdx = (opts.keep ?? []).filter((i) => schedules[i]);
  let keptNothing = false;
  if (keepIdx.length && canDeduct) {
    const room = new Map<string, number>();
    for (const t of snap.txns) {
      if (t.created_by !== B2B_SHIP_BY) continue;
      room.set(String(t.product_id), (room.get(String(t.product_id)) || 0) + Math.abs(Number(t.qty) || 0));
    }
    for (const i of keepIdx) {
      const s = schedules[i];
      const key = shippedKey(s.shipped_at);
      if (key === null) throw new ShipChangeError("발송 시각이 없는 차수라 출고를 유지할 수 없습니다 — 새로고침 후 다시 시도하세요.", 409);
      const lines = (s.items || []).filter((it) => Number(it.qty) > 0 && orderItems[it.order_item_index]);
      if (!lines.length) {
        throw new ShipChangeError("이 차수에 보낸 수량이 없어 출고를 유지할 수 없습니다 — 발송일 창에서 차수별 보낼 수량을 넣은 뒤 다시 취소하세요.", 400);
      }
      const perProduct = new Map<string, number>();
      for (const it of lines) {
        const line = orderItems[it.order_item_index];
        if (line.product_id) expandBundleQty(bundles, line.product_id, Number(it.qty) || 0, perProduct);
      }
      for (const [pid, want] of perProduct) {
        const q = Math.min(want, room.get(pid) || 0);
        if (q <= 0) continue;
        room.set(pid, (room.get(pid) || 0) - q);
        // 같은 키(같은 발송 시각·품목)가 겹치면 한 행으로 합친다 — 요청 키 유니크에 걸려 한쪽 수량이 사라지지 않게
        const rk = `${keptPrefix(orderId, key)}${pid}`;
        const dup = keptRows.find((r) => r.request_key === rk);
        if (dup) { dup.qty = Number(dup.qty) + signedQty("출고", q); continue; }
        keptRows.push({
          product_id: pid,
          type: "출고",
          channel: prevChannel ?? deductChannel,
          qty: signedQty("출고", q),
          unit_amount: null,
          txn_date: s.ship_date || today,
          partner,
          memo: "B2B 발송 후 취소 — 물건 안 돌아옴(출고 유지)",
          created_by: B2B_SHIP_BY,
          reason: "기타", // 판매가 아닌 출고 — 대사에서 판매와 따로 본다(099)
          source: B2B_CANCEL_KEPT_SOURCE,
          source_ref: orderId,
          request_key: rk,
        });
      }
    }
    keptNothing = keptRows.length === 0;
    if (keptRows.length && !snap.keptAvailable) {
      throw new ShipChangeError("'안 돌아옴(출고 유지)'은 DB 업데이트(131) 적용 후에 쓸 수 있습니다 — 반품으로 돌아왔으면 '돌아왔음'을 고르세요.", 400);
    }
  }
  const releasing = snap.keptAvailable ? [...new Set(opts.releaseKeys ?? [])] : [];

  // 기존 발송 일정 전체 삭제 (PUT 재저장 대비).
  //  inventory_txns.shipment_id 는 on delete cascade → 이 차수들의 옛 즉시출고가 함께 삭제되어 재고가 원복됨.
  const del = await sb.from("shipments").delete().eq("order_id", orderId);
  if (del.error) throw del.error;

  try {
  // 되살린 차수의 '출고 유지' 행 정리 — 아래에서 일반 선점이 그 수량을 다시 기록한다
  for (const key of releasing) {
    const r = await sb.from("inventory_txns").delete()
      .eq("source", B2B_CANCEL_KEPT_SOURCE).eq("source_ref", orderId).like("request_key", `${keptPrefix(orderId, key)}%`);
    if (r.error) throw r.error;
  }

  const rec = normalizeRecipient(recipient || ({} as RecipientInput));
  const hasRecipient = !!(
    rec.recipient_name || rec.recipient_phone || rec.address || rec.delivery_memo || rec.courier
  );
  let earliest: string | null = null;
  let seq = 1;
  let inserted = 0;
  let totalBoxes = 0;
  const insertedStatuses: string[] = [];
  const writtenPerProduct = new Map<string, number>(); // 이번에 쓴 선점(품목별) — 도매 대량 잔여 안내용

  for (let si = 0; si < schedules.length; si++) {
    const sch = schedules[si];
    // 이 일정에 담긴 상품 (수량>0, 유효 인덱스만)
    const items = (sch.items || [])
      .map((it) => ({ idx: it.order_item_index, qty: Number(it.qty) || 0 }))
      .filter((it) => it.qty > 0 && orderItems[it.idx]);

    // 날짜·상품 둘 다 없는 빈 일정은 스킵
    if (!sch.ship_date && items.length === 0) continue;

    const boxCount = Math.max(1, Math.floor(Number(sch.box_count) || 1));
    const shipInsert: Record<string, unknown> = {
      order_id: orderId,
      seq: seq++,
      ship_date: sch.ship_date || null,
      status: sch.status || "발송대기",
      recipient_name: rec.recipient_name || "(미지정)",
      recipient_phone: rec.recipient_phone || "",
      address: rec.address || "(주소 미입력)",
      delivery_memo: rec.delivery_memo,
      courier: rec.courier,
      tracking_no: (sch.tracking_no || "").trim() || null,
      box_count: boxCount,
      // 발송 시각: 재저장 경로가 넘긴 기존 값을 보존(없으면 지금). 취소 차수도 기존 발송 시각을
      //  이력으로 유지 — '안 돌아옴' 취소의 출고 유지 키이자 복구 때 '이미 나갔던 차수'를 구분하는 근거.
      //  (반품으로 돌아온 취소는 부르는 쪽이 시각을 지운다 — 나간 적 없는 차수와 같아진다)
      shipped_at: sch.status === "발송완료"
        ? (sch.shipped_at ?? new Date().toISOString())
        : (sch.status === "취소" ? sch.shipped_at ?? null : null),
    };
    // 저장하는 값은 '요청한 선점 설정' — 취소 차수라서 이번에 안 빼는 것을 false 로 적으면
    //  취소 복구 때 그 false 를 다시 읽어 선점이 영영 되살아나지 않는다(최종 점검 확정). 차감 여부는 deductIdx 가 정한다.
    if (canDeduct) shipInsert.stock_out = stockOn(sch);
    // 발주 단위 취소로 같이 취소된 차수 표식(134) — 발주 복구가 이것만 되살린다(먼저 따로 취소한 차수는 취소 유지)
    if (withCancelFlag) shipInsert.cancelled_with_order = (sch.status || "발송대기") === "취소" && sch.cancelled_with_order === true;
    const { data: shipRow, error: shipErr } = await sb
      .from("shipments")
      .insert(shipInsert)
      .select("id")
      .single();
    if (shipErr) throw shipErr;
    inserted++;
    // 취소 차수의 박스는 빼고 센다 — 이 합이 orders.box_count 가 되고 이익률 배송비를 정하는데,
    //  안 보낸 박스까지 세면 부분 취소 발주의 배송비가 과대 계산된다.
    if ((sch.status || "발송대기") !== "취소") totalBoxes += boxCount;
    insertedStatuses.push(sch.status || "발송대기");

    if (items.length > 0) {
      const rows = items.map((it) => ({
        shipment_id: shipRow.id,
        order_item_id: orderItems[it.idx].id,
        product_name: orderItems[it.idx].product_name,
        spec: orderItems[it.idx].spec,
        qty: it.qty,
      }));
      const { error: siErr } = await sb.from("shipment_items").insert(rows);
      if (siErr) throw siErr;
    }

    // 재고 차감(선점) — 발주 전량을 이 차수(가장 이른 발송일) 하나에만 기록한다.
    //  shipment_id 로 묶여 있어 재저장·발주 삭제 시 cascade 로 함께 지워지며 재고가 원복된다.
    //  차감 칸 = 대량 발주면 '도매 대량'(115), 아니면 '도매'(036) — 단, 이미 나간 옛 선점이 있으면 그 칸(effChannel).
    //  칸 제약이 맞지 않는 옛 환경용 폴백(channel 을 빼고 재시도)은 지웠다 — 기본값 '소매'로 떨어져 도매 판매가 소매 재고를 깎았다.
    if (canDeduct && si === deductIdx && deductPerProduct.size > 0) {
      const txns: Record<string, unknown>[] = [...deductPerProduct.entries()].map(([product_id, qty]) => ({
        product_id,
        type: "출고",
        channel: effChannel,
        qty: signedQty("출고", qty),
        unit_amount: null,
        txn_date: sch.ship_date || headerShipDate || today,
        partner,
        memo: effChannel === "도매 대량" ? "B2B 대량 발송 선점(발주 전량)" : "B2B 발송 선점(발주 전량)",
        shipment_id: shipRow.id,
        created_by: B2B_SHIP_BY,
        source: B2B_SHIP_SOURCE, // 131 — 원천 식별(메모·거래처 글자로 판정하지 않는다)
        source_ref: orderId,
      }));
      let txr = await sb.from("inventory_txns").insert(txns);
      if (txr.error && /source/i.test(txr.error.message || "")) {
        // 131 미적용 — 출처 칸 없이 다시(종전과 같은 행)
        for (const t of txns) { delete t.source; delete t.source_ref; }
        txr = await sb.from("inventory_txns").insert(txns);
      }
      if (txr.error) throw txr.error;
      writtenChannel = effChannel;
      for (const [pid, q] of deductPerProduct) writtenPerProduct.set(pid, q);
    }

    // 취소 차수는 발송일 후보에서 제외 — earliest 는 orders.ship_date 가 되어 매출 인식일(발송일 기준)의
    //  근거가 되므로, 아무것도 나가지 않은 취소 차수의 날짜가 잡히면 매출 귀속 월이 틀어진다.
    if (sch.ship_date && (sch.status || "발송대기") !== "취소" && (!earliest || sch.ship_date < earliest)) earliest = sch.ship_date;
  }

  // 발송 일정이 하나도 없지만 배송 정보가 있으면, 배송 정보만 담은 기본 행을 생성해 보존.
  // (편집 화면에서는 날짜·상품이 없는 이 행을 발송 일정 카드로 노출하지 않음)
  //  박스 수는 발주 단위 box_count 를 물려받음 → 일정 없이 박스만 늘려도 송장 출력이 박스 수만큼 펼쳐짐.
  if (inserted === 0 && hasRecipient) {
    const fallbackBoxes = Math.max(1, Math.floor(Number(orderBoxCount) || 1));
    const { error: recErr } = await sb.from("shipments").insert({
      order_id: orderId,
      seq: 1,
      ship_date: null,
      status: "발송대기",
      recipient_name: rec.recipient_name || "(미지정)",
      recipient_phone: rec.recipient_phone || "",
      address: rec.address || "(주소 미입력)",
      delivery_memo: rec.delivery_memo,
      courier: rec.courier,
      tracking_no: null,
      box_count: fallbackBoxes,
      shipped_at: null,
    });
    if (recErr) throw recErr;
    totalBoxes += fallbackBoxes;
  }

  // 출고 유지 행 — 같은 요청이 이미 남긴 행(요청 키 중복)은 건너뛴다(재시도·더블클릭에도 한 번만, S2)
  if (keptRows.length) {
    let kr = await sb.from("inventory_txns").insert(keptRows);
    if (kr.error && missingColumn(kr.error, "reason")) {
      for (const r of keptRows) delete r.reason;
      kr = await sb.from("inventory_txns").insert(keptRows);
    }
    if (kr.error && kr.error.code === "23505") {
      for (const r of keptRows) {
        const one = await sb.from("inventory_txns").insert(r);
        if (one.error && one.error.code !== "23505") throw one.error;
      }
    } else if (kr.error) throw kr.error;
  }

  // 복수 발송(2건 이상)이면 상위발주 발송상태를 하위 차수들로부터 자동 도출.
  //  - 전부 취소 → 취소 / 취소 제외 전부 발송완료 → 발송완료 / 하나라도 미발송 → 발송대기.
  //  화면엔 상위 발송상태를 표시하지 않지만, 매출집계·필터가 동작하도록 DB 값은 일관되게 유지.
  const derivedStatus = deriveParentStatus(insertedStatuses);

  // 화면 안내 — 칸 유지(이유별) 또는 칸 바뀜(옮길 방향). 발송된 적 있는 발주를 선점 없이 복구한 경우도 확인을 권한다.
  //  '유지'는 실제로 차감을 다시 기록했을 때만(취소·일정 삭제·재고차감 끔은 차감이 없으니 유지가 아니다).
  const keptOut: InvChannel | null = channelKept && writtenChannel ? channelKept : null;
  const notices: string[] = [];
  const nameMap = async (ids: string[]) => {
    try {
      const { data: ps } = await sb.from("products").select("id, name").in("id", ids.slice(0, 100));
      return new Map((ps ?? []).map((p) => [String(p.id), String(p.name || "품목")]));
    } catch { return new Map<string, string>(); }
  };
  const qtyList = async (m: Map<string, number>) => {
    if (!m.size) return "";
    const nm = await nameMap([...m.keys()]);
    return ` (${[...m.entries()].slice(0, 10).map(([pid, q]) => `${nm.get(pid) || "품목"} ${q.toLocaleString()}`).join(", ")}${m.size > 10 ? ` 외 ${m.size - 10}종` : ""})`;
  };
  if (keptOut) {
    notices.push(keptShipped
      ? `이미 발송완료된 발주라 재고 차감 칸은 '${keptOut}'(으)로 유지됐습니다 — 이 발주 때문에 재고 이동을 하지 마세요.`
      : `발송예정일이 지나 이미 나간 것으로 보고 재고 차감 칸 '${keptOut}'을(를) 유지했습니다 — 아직 안 나갔다면 발주 목록의 발송일 칸(날짜 또는 'N차 · 수정')을 눌러 오늘이나 그 뒤 날짜로 다시 잡으세요(그때 칸이 바뀌고 옮길 방법이 안내됩니다).`);
  } else if (prevChannel && writtenChannel && prevChannel !== writtenChannel) {
    // 옮길 수량(구성품 기준 — 세트는 구성품으로 빠진다)
    const qtyText = await qtyList(deductPerProduct);
    notices.push(writtenChannel === "도매 대량"
      ? prevChannel === "도매"
        ? `재고 차감 칸이 '도매' → '도매 대량'으로 바뀌었습니다${qtyText} — 이 발주 몫으로 도매 칸에 옮겨 둔 수량은 [재고 이동]에서 도매 → 소매, 소매 → 도매 대량 두 번으로 옮기세요(아직 도매로 확보 전이면 소매 → 도매 대량만).`
        : `재고 차감 칸이 '${prevChannel}' → '도매 대량'으로 바뀌었습니다${qtyText} — [재고 이동]에서 소매 → 도매 대량으로 옮겨 두세요.`
      : prevChannel === "도매 대량"
        ? `재고 차감 칸이 '도매 대량' → '${writtenChannel}'(으)로 바뀌었습니다${qtyText} — 이 발주 몫으로 옮겨 둔 도매 대량 재고는 [재고 이동]에서 도매 대량 → 소매로 되돌리세요.`
        : `재고 차감 칸이 '${prevChannel}' → '${writtenChannel}'(으)로 바뀌었습니다${qtyText}.`);
  } else if (!prevChannel && writtenChannel && snap.ships.length > 0 && snap.ships.every((s) => (s as { status?: string }).status === "취소")) {
    // 취소 복구로 선점을 다시 기록 — 취소 때 칸을 되돌려 뒀으면 다시 채워야 한다
    notices.push(writtenChannel === "도매 대량"
      ? `취소를 되돌려 '도매 대량' 칸에서 다시 차감했습니다${await qtyList(deductPerProduct)} — 취소 때 소매로 되돌려 뒀으면 [재고 이동]에서 소매 → 도매 대량으로 다시 옮기세요.`
      : `취소를 되돌려 재고 차감을 '${writtenChannel}' 칸으로 다시 기록했습니다 — 처음 발송 때와 같은 칸인지 확인하세요.`);
  } else if (!prevChannel && writtenChannel && snap.ships.some((s) => !!(s as { shipped_at?: string | null }).shipped_at)) {
    notices.push(`발송된 적 있는 발주의 재고 차감을 '${writtenChannel}' 칸으로 다시 기록했습니다 — 처음 발송 때와 같은 칸인지 확인하세요.`);
  }
  // '도매 대량' 선점이 줄었으면(취소·수량 감소·대량 해제) 그 몫이 칸에 주인 없이 남는다 — 자동 합류가 없으므로 사람이 옮긴다.
  //  위 칸 변경 안내가 이미 '도매 대량 → 소매'를 말했으면 겹쳐 띄우지 않는다.
  if (!notices.some((n) => n.includes("도매 대량 → 소매"))) {
    const bulkPrev = new Map<string, number>();
    const bulkNow = new Map<string, number>();
    const add = (m: Map<string, number>, pid: string, q: number) => m.set(pid, (m.get(pid) || 0) + q);
    for (const t of snap.txns) if (t.created_by === B2B_SHIP_BY && t.channel === "도매 대량") add(bulkPrev, String(t.product_id), Math.abs(Number(t.qty) || 0));
    const releasedKeys = new Set(releasing.map((k) => keptPrefix(orderId, k)));
    for (const t of snap.kept) {
      if (t.channel !== "도매 대량") continue;
      add(bulkPrev, String(t.product_id), Math.abs(Number(t.qty) || 0));
      const rk = String(t.request_key || "");
      if (![...releasedKeys].some((p) => rk.startsWith(p))) add(bulkNow, String(t.product_id), Math.abs(Number(t.qty) || 0));
    }
    if (writtenChannel === "도매 대량") for (const [pid, q] of writtenPerProduct) add(bulkNow, pid, q);
    for (const r of keptRows) if (r.channel === "도매 대량") add(bulkNow, String(r.product_id), Math.abs(Number(r.qty) || 0));
    const left = new Map<string, number>();
    for (const [pid, q] of bulkPrev) { const d = Math.round((q - (bulkNow.get(pid) || 0)) * 1000) / 1000; if (d > 0) left.set(pid, d); }
    if (left.size) notices.push(`'도매 대량' 칸에 이 발주 몫이 남습니다${await qtyList(left)} — 다른 대량 발주에 쓸 게 아니면 [재고 이동]에서 도매 대량 → 소매로 되돌리세요.`);
  }
  if (keptNothing) notices.push("이 발주는 재고 차감 기록이 없어 유지할 출고가 없습니다 — 재고는 바뀌지 않았습니다.");

  const singleStatus = insertedStatuses.length === 1 ? insertedStatuses[0] : null;
  return { earliestShipDate: earliest, derivedStatus, singleStatus, totalBoxes, channelKept: keptOut, channelNotice: notices.join("\n") || null };
  } catch (err) {
    // 재저장 도중 실패 → delete 로 사라진 옛 발송·송장·선점출고를 스냅샷에서 복원(부분 상태 방지) 후 재던짐.
    const ok = await restoreOrderShipments(sb, orderId, snap);
    if (!ok) {
      const base = err instanceof Error ? err.message : (err as { message?: string })?.message || "발송 저장 실패";
      throw new Error(base + RESTORE_FAILED);
    }
    throw err;
  }
}

// ── 상태 변경·재저장 공용 경로(S7) ──
//  발주 PUT/PATCH/일괄, 차수 PATCH, 취소·복구, 발송일 창이 모두 이 함수로 재고(선점·출고 유지)·헤더·매출을 다시 맞춘다.
//  순서: DB 차수 재구성 → mutate(대상 차수 상태·송장·날짜 반영, 검증은 ShipChangeError 로 — 쓰기 전) →
//        saveOrderShipments → 헤더(상태·발송일·박스 수) → 매출 원장 동기화.
//  재저장은 차수 id 를 새로 만든다 — 화면은 응답 뒤 그 발주를 다시 읽는다.
//  재구성과 삭제 사이에 다른 요청이 차수를 바꿨으면 쓰기 전에 409(isShipConflict) — 이 요청은 아무것도 안 바꿨다.
export type ShipChange = {
  savedItems?: SavedOrderItem[];       // PUT: 방금 저장한 라인(없으면 DB 에서 읽는다)
  recipient?: RecipientInput;          // PUT: 폼의 배송정보(없으면 첫 차수의 것을 물려받는다)
  boxCount?: number;                   // 배송정보 전용 행의 박스 수(없으면 첫 차수의 것)
  headerShipDate?: string | null;      // 차수가 하나도 없을 때 자동 차수를 만들 날짜(saveOrderShipments 와 같음)
  headerStatus?: ShipmentScheduleInput["status"] | null;
  mutate?: (schedules: ShipSchedule[], ships: ShipRow[]) => SaveShipmentsOpts | void;
  status?: string | (() => string | undefined); // 단일·무차수 발주의 헤더 상태(복수 발송은 차수에서 도출 — 이 값 무시). 함수면 mutate 뒤에 읽는다
  statusFromSingle?: boolean;          // 단일 발송이면 그 차수 상태를 헤더 상태로(상태 변경 경로). 아니면 헤더 상태를 건드리지 않는다(편집 경로)
  noDateShipDate?: string | null;      // 날짜 있는 비취소 차수가 없을 때 헤더 발송일(undefined = 그대로)
  extra?: Record<string, unknown>;     // 같은 update 로 쓸 헤더 칸(입금·계산서·송장 등)
};
export async function applyOrderShipments(orderId: string, change: ShipChange): Promise<SaveShipmentsResult & {
  order: Record<string, unknown>;
  savedItems: SavedOrderItem[];
  headerStatus: string | null;
  salesSyncFailed: boolean;      // 매출 원장 동기화 실패 — 라우트가 sales_sync_failed 로 싣고 화면이 경고 배너를 띄운다
  salesSyncError: string | null;
}> {
  const sb = supabaseAdmin();
  const savedItems = change.savedItems ?? (await loadSavedItems(sb, orderId));
  const { ships, schedules } = await reconstructSchedules(sb, orderId, savedItems);
  // 재구성한 차수(읽은 그대로)를 함께 넘긴다 — 삭제 직전에 DB 가 그대로인지 확인한다(그 사이 다른 요청이 바꿨으면 409)
  const expectedShips = ships.map((s) => ({ ...s }));
  const opts: SaveShipmentsOpts = { ...(change.mutate?.(schedules, ships) || {}), expectedShips };
  const ship0 = ships[0];
  const recipient = change.recipient ?? recipientOf(ship0);
  const boxCount = change.boxCount ?? Math.max(1, Math.floor(Number(ship0?.box_count) || 1));
  const res = await saveOrderShipments(orderId, recipient, schedules, savedItems, boxCount, change.headerShipDate ?? null, change.headerStatus ?? null, opts);

  const header: Record<string, unknown> = { ...(change.extra || {}) };
  const asked = typeof change.status === "function" ? change.status() : change.status;
  const st = res.derivedStatus ?? (change.statusFromSingle && res.singleStatus ? res.singleStatus : null) ?? asked ?? null;
  if (st) header.status = st;
  // 발송일 = 가장 이른 비취소 차수일(매출 인식일·선점일과 같은 날). 없으면 부르는 쪽 값(또는 그대로)
  if (res.earliestShipDate) header.ship_date = res.earliestShipDate;
  else if (change.noDateShipDate !== undefined) header.ship_date = change.noDateShipDate;
  if (res.totalBoxes > 0) header.box_count = res.totalBoxes; // 이익률·송장 칸 수가 쓰는 발주 박스 수 = 차수 합
  header.updated_at = new Date().toISOString(); // 차수만 바뀌어도 발주가 바뀐 것으로 — 수정 화면의 '다른 곳에서 바뀜' 검사 근거
  const { data: order, error } = await sb.from("orders").update(header).eq("id", orderId).select().single();
  if (error) throw error;
  // 매출원장 — 발송완료면 반영, 취소·되돌림이면 옛 행 정리. 상태·발송일(인식일)·취소 차수 배분이 모두 여기서 맞춰진다.
  //  실패하면 화면에 알린다(조용히 넘기지 않는다) — 재고·차수는 이미 저장됐으므로 다시 저장하면 맞춰진다.
  //  안내 문구(channelNotice)에 섞지 않고 따로 돌려준다 — 화면이 창(alert)이 아닌 남는 경고 배너로 띄운다.
  const sync = await syncOrderSalesSafe(orderId);
  return {
    ...res,
    order: order as Record<string, unknown>,
    savedItems,
    headerStatus: st,
    salesSyncFailed: !sync.ok,
    salesSyncError: sync.ok ? null : sync.error,
  };
}

// 응답에 싣는 매출 반영 결과 — 실패면 화면이 SALES_SYNC_FAILED_MSG 를 경고 배너(.sm-warn)로 띄운다.
//  문구는 서버에서 보낸다(b2b-sales-sync 는 서버 전용 모듈이라 화면에서 가져올 수 없다).
export function salesSyncFields(r: { salesSyncFailed: boolean; salesSyncError: string | null } | { ok: boolean; error?: string }): {
  sales_sync_failed: boolean;
  sales_sync_error?: string;
  sales_sync_message?: string;
} {
  const failed = "salesSyncFailed" in r ? r.salesSyncFailed : !r.ok;
  if (!failed) return { sales_sync_failed: false };
  const error = ("salesSyncFailed" in r ? r.salesSyncError : r.error) || undefined;
  return { sales_sync_failed: true, sales_sync_error: error, sales_sync_message: SALES_SYNC_FAILED_MSG };
}
