import type { supabaseAdmin } from "./supabase";

// 온라인 발주(택배 출고) 서버 공용 — DB 오류 구분·페이지 나눔 읽기·재고 행 저장 폴백. 서버 전용.
//  docs/ledger-standard.md S4: 조회 실패를 '없음'으로 보지 않는다. 미적용(테이블·칸·함수 없음)만 폴백하고
//  나머지 오류는 부르는 쪽이 멈춘다.

type Sb = ReturnType<typeof supabaseAdmin>;
type PgErr = { code?: string; message?: string } | null | undefined;

// 테이블 없음(마이그레이션 미적용) — 일시 오류(PGRST002 등)와 구분
export const missingTable = (e: PgErr): boolean => !!e && (e.code === "42P01" || e.code === "PGRST205");
// 칸 없음 — 에러 메시지에 그 칸 이름이 보일 때만(기존 폴백 관행)
export const missingColumn = (e: PgErr, col: RegExp): boolean =>
  !!e && col.test(e.message || "") && (e.code === "42703" || e.code === "PGRST204" || /does not exist|could not find/i.test(e.message || ""));
// 함수(RPC) 없음
export const missingRpc = (e: PgErr): boolean => !!e && (e.code === "PGRST202" || e.code === "42883");

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const kstToday = (): string => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 상품 마스터(SKU 있는 것) 전량 — 단발 select 는 서버 Max Rows(1000)에 잘려 뒤쪽 SKU 가 '미등록'으로 보인다.
export async function fetchSkuProducts<T>(sb: Sb, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 100000; i += 1000) {
    const { data, error } = await sb.from("products").select(cols).not("sku", "is", null).order("id", { ascending: true }).range(i, i + 999);
    if (error) throw new Error(`상품 마스터를 읽지 못했습니다(${error.message})`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// 중단된 출고 = 출고 이력(fulfill_dispatch)은 있는데 재고 행이 하나도 없는 배치(차감할 품목이 있었고 2분 지남).
//  이력·처리완료 키를 쓴 뒤 재고 기록 전에 끊겼거나, 옛 화면에서 재고만 취소된 것. 2분 안은 진행 중일 수 있어 빼고 본다.
export const INTERRUPT_MS = 120e3;
type DispatchLike = { group_id?: string | null; sku_count?: number | null; created_at?: string | null };
export const maybeInterrupted = (r: DispatchLike): boolean =>
  !!r.group_id && Number(r.sku_count) > 0 && Date.now() - Date.parse(String(r.created_at)) > INTERRUPT_MS;

// 주어진 출고 배치(group_id) 중 '중단된 출고'인 것 → group_id ↔ 그 출고 서명(sig). 조회 실패면 throw(S4 — '없음'으로 보지 않는다).
export async function interruptedGroups(sb: Sb, groupIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const cand: { group_id: string; sig: string }[] = [];
  for (const part of chunks([...new Set(groupIds)], 150)) {
    const { data, error } = await sb.from("fulfill_dispatch").select("group_id, sig, sku_count, created_at").in("group_id", part);
    if (error) { if (missingTable(error)) return out; throw new Error(`출고 이력을 읽지 못했습니다(${error.message})`); }
    for (const r of (data ?? []) as { group_id: string | null; sig: string; sku_count: number | null; created_at: string }[]) {
      if (maybeInterrupted(r) && !cand.some((c) => c.group_id === r.group_id)) cand.push({ group_id: r.group_id!, sig: r.sig });
    }
  }
  for (const part of chunks(cand, 10)) {
    const rs = await Promise.all(part.map((c) => sb.from("inventory_txns").select("id").eq("group_id", c.group_id).limit(1)));
    rs.forEach((r, i) => {
      if (r.error) throw new Error(`재고 기록을 읽지 못했습니다(${r.error.message})`);
      if (!(r.data ?? []).length) out.set(part[i].group_id, part[i].sig);
    });
  }
  return out;
}

// 기준 시점 뒤 그 품목의 소매 재고를 따로 맞춘 기록 — 소급 차감([재고 차감 기록])·중단된 출고 이어서 차감 전에 본다.
//  그 기록이 이미 이 출고분을 반영했으면 또 빼는 것이 이중 차감이다(S8 guard — 사람이 판단).
//   실사 = 소매 조정 중 기준일 이후 날짜이거나 기준 시각 뒤에 입력된 것(날짜를 앞당겨 넣은 실사).
//   직접 출고(opts.manualOut) = 기준 시각 뒤에 [입고 및 출고]·엑셀로 넣은 소매 출고(131 source manual·import).
//    사유 협찬·폐기·제조사 반품은 판매분 정정이 아니라 뺀다.
//  품목·종류당 가장 최근 하나. 페이지 끝까지 읽고 조회 실패면 throw(S4). 미적용 칸만 폴백 —
//  channel(036) 없으면 전부 소매, reason(099) 없으면 사유 구분 없이, source(131) 없으면 직접 출고를 구분할 수 없어 건너뛴다.
export type StockFixHit = { productId: string; name: string; date: string; kind: "실사" | "직접 출고" };
export async function stockFixesAfter(sb: Sb, productIds: string[], sinceDate: string, sinceIso: string, opts: { manualOut?: boolean } = {}): Promise<StockFixHit[]> {
  const NON_SALE = new Set(["협찬", "폐기", "제조사 반품"]);
  const hits = new Map<string, StockFixHit>();
  const kinds: StockFixHit["kind"][] = opts.manualOut ? ["실사", "직접 출고"] : ["실사"];
  type Row = { product_id: string; txn_date: string; reason?: string | null; products?: { name?: string } | { name?: string }[] | null };
  for (const part of chunks([...new Set(productIds)], 100)) {
    for (const kind of kinds) {
      let withChan = true;
      let withReason = kind === "직접 출고";
      for (let off = 0; off < 100000;) {
        const cols = `id, product_id, txn_date${withReason ? ", reason" : ""}, products(name)`;
        let q = sb.from("inventory_txns").select(cols).in("product_id", part);
        q = kind === "실사"
          ? q.eq("type", "조정").or(`txn_date.gte.${sinceDate},created_at.gt."${sinceIso}"`)
          : q.eq("type", "출고").in("source", ["manual", "import"]).gt("created_at", sinceIso);
        if (withChan) q = q.eq("channel", "소매");
        const { data, error } = await q.order("txn_date", { ascending: false }).order("id", { ascending: true }).range(off, off + 999);
        if (error) {
          if (withChan && missingColumn(error, /channel/i)) { withChan = false; continue; }
          if (withReason && missingColumn(error, /reason/i)) { withReason = false; continue; }
          if (kind === "직접 출고" && missingColumn(error, /\bsource\b/i)) break;
          throw new Error(error.message || "재고 기록 조회 실패");
        }
        const rows = (data ?? []) as unknown as Row[];
        for (const t of rows) {
          if (kind === "직접 출고" && t.reason && NON_SALE.has(t.reason)) continue;
          const k = `${kind}:${t.product_id}`;
          if (hits.has(k)) continue;
          const p = Array.isArray(t.products) ? t.products[0] : t.products;
          hits.set(k, { productId: t.product_id, name: p?.name || "(이름 없음)", date: String(t.txn_date).slice(0, 10), kind });
        }
        if (rows.length < 1000) break;
        off += 1000;
      }
    }
  }
  return [...hits.values()];
}

// 재고 행 저장 — 131(request_key·source·source_ref) → 036(channel) → 034(status) 순으로 미적용 칸만 빼고 재시도.
//  반환 error 는 그대로(부르는 쪽이 23505·기타를 판단). 23505 = 같은 request_key 가 이미 있음(이미 기록됨).
export async function insertTxnsWithFallback(sb: Sb, rows: Record<string, unknown>[]): Promise<{ error: { code?: string; message: string } | null }> {
  if (!rows.length) return { error: null };
  let cur = rows;
  let { error } = await sb.from("inventory_txns").insert(cur);
  if (error && missingColumn(error, /request_key|source_ref|source/i)) {
    cur = cur.map(({ request_key, source, source_ref, ...r }) => r);
    ({ error } = await sb.from("inventory_txns").insert(cur));
  }
  if (error && /channel/i.test(error.message)) { cur = cur.map(({ channel, ...r }) => r); ({ error } = await sb.from("inventory_txns").insert(cur)); }
  if (error && /status/i.test(error.message)) { cur = cur.map(({ status, ...r }) => r); ({ error } = await sb.from("inventory_txns").insert(cur)); }
  return { error: error as { code?: string; message: string } | null };
}
