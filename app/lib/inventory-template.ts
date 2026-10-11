// 입·출·조정 엑셀 양식에 미리 채워 넣을 품목 목록 + 재고 화면·실사 공용 현재고 읽기(서버 전용).
//  빈 양식에 SKU 를 손으로 옮겨 적는 대신, 전 품목의 SKU·품목명·현재고를 넣어 내려주고
//  사용자는 수량(또는 실사수량) 칸만 채우면 되게 한다. 미입력 행은 업로드 시 건너뛴다.

import type ExcelJS from "exceljs";
import { supabaseAdmin } from "@/app/lib/supabase";
import { getAllBundles, isBundleId } from "@/app/lib/product-bundles";
import { getUntracked } from "@/app/lib/stock-tracked";
import type { InvChannel } from "@/app/lib/inventory";

type Sb = ReturnType<typeof supabaseAdmin>;
type PageRes = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

/** 한 쿼리를 1,000행씩 끝까지 읽는다(S4) — 단발 조회는 서버 Max Rows(1000)에 조용히 잘린다.
 *  page(from, to) 는 안정 정렬(.order)을 건 쿼리에 .range(from, to) 를 붙여 돌려줘야 한다. 오류는 던진다. */
export async function readAll<T>(page: (from: number, to: number) => PageRes): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 2_000_000; i += 1000) {
    const { data, error } = await page(i, i + 999);
    if (error) throw error;
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
  throw new Error("조회 행이 너무 많습니다 — 기간·칸을 좁혀 다시 시도하세요.");
}

/** 현재고 = inventory_stock(asof, chan) 결과를 페이지 끝까지 읽은 품목→수량 맵(S1·S4).
 *  RPC 결과도 Max Rows 에 잘리므로 product_id 순으로 range 페이징한다 — 잘린 품목을 0 으로 보면 실사가 유령 재고를 만든다.
 *  폴백은 (asof, chan) 시그니처가 없을 때(036 미적용, PGRST202)만 — 그때는 칸이 없어 전 칸 합 = 소매다.
 *  그 밖의 오류는 던진다(일시 오류를 4칸 합·0 으로 대체하면 조정 델타·표시가 통째로 틀어진다).
 *  onMissingChan = 036 미적용 때 칸 지정 호출을 어떻게 볼지. "all"(기본) = 전 칸 합(= 소매),
 *  "empty" = 빈 맵 — 확보분 칸(프로모션·도매 대량)을 빼는 계산처럼 '칸이 없으면 그 칸 재고도 없다'가 맞는 곳. */
export async function readStockMap(
  sb: Sb,
  opts: { asof: string | null; chan: InvChannel | null; onMissingChan?: "all" | "empty" },
): Promise<Map<string, number>> {
  type R = { product_id: string; qty: number };
  const run = (withChan: boolean) => readAll<R>((a, b) =>
    sb.rpc("inventory_stock", withChan ? { asof: opts.asof, chan: opts.chan } : { asof: opts.asof })
      .order("product_id", { ascending: true }).range(a, b));
  let rows: R[];
  if (opts.chan) {
    try { rows = await run(true); }
    catch (e) {
      if ((e as { code?: string })?.code !== "PGRST202") throw e;
      if (opts.onMissingChan === "empty") return new Map();
      rows = await run(false);
    }
  } else rows = await run(false);
  const m = new Map<string, number>();
  for (const t of rows) m.set(t.product_id, Number(t.qty) || 0);
  return m;
}

export type ScheduledOut = { first: string; lines: string[]; more: number };
/** 출고 예정 근거 — 오늘(KST) 뒤 거래일로 '완료' 기록된 출고 행(대부분 발송예정일이 미래인 B2B 선점).
 *  수량은 화면에서 '현재고(오늘) − 가용(전체)'로 RPC 두 값의 차로 내고(S1), 이 맵은 가장 이른 날·툴팁 줄만 준다. */
export async function readScheduledOut(sb: Sb, today: string, chan: InvChannel | null): Promise<Map<string, ScheduledOut>> {
  type R = { product_id: string; qty: number; txn_date: string; partner: string | null };
  const run = (withChan: boolean) => readAll<R>((a, b) => {
    let q = sb.from("inventory_txns").select("product_id, qty, txn_date, partner")
      .eq("status", "완료").gt("txn_date", today).lt("qty", 0)
      .order("txn_date", { ascending: true }).order("id", { ascending: true });
    if (withChan && chan) q = q.eq("channel", chan);
    return q.range(a, b);
  });
  let rows: R[];
  try { rows = await run(true); }
  catch (e) { if (chan && /channel/i.test(String((e as { message?: string })?.message))) rows = await run(false); else throw e; } // 036 미적용
  const m = new Map<string, ScheduledOut>();
  for (const t of rows) {
    const cur = m.get(t.product_id) ?? { first: t.txn_date, lines: [], more: 0 };
    if (cur.lines.length < 8) cur.lines.push(`${t.txn_date.slice(5)} ${t.partner || "-"} ${Math.abs(Number(t.qty) || 0).toLocaleString()}`);
    else cur.more++;
    m.set(t.product_id, cur);
  }
  return m;
}

export type TemplateProduct = { sku: string; name: string; spec: string | null; qty: number };
/** 양식에 넣지 못한 품목 — 빠진 이유를 사용자에게 알리기 위해 함께 돌려준다(모르면 실사에서 통째로 누락된다). */
export type TemplateResult = { rows: TemplateProduct[]; excludedNoSku: string[]; excludedBundles: number };

/** 활성 품목(세트·SKU 없는 품목 제외) + 그 채널 현재고. 품목명 오름차순.
 *  asof = 기준일(실사일). 생략하면 오늘(KST). */
export async function templateProducts(channel: InvChannel, asof?: string): Promise<TemplateResult> {
  const sb = supabaseAdmin();
  // 현재고 = 기준일(기본 오늘, KST)까지의 원장 — 실사 미리보기·반영(adjust/import)과 같은 기준이어야 양식의 '현재고'가 델타 기준값과 일치한다.
  //  asof=null 이면 발송예정일이 미래인 선점 출고까지 빠져, 선반 실물을 적으면 선점분만큼 유령 재고가 생긴다.
  const day = asof || new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  type P = { id: string; sku: string | null; name: string; spec: string | null };
  const [products, stock, bundles, untracked] = await Promise.all([
    readAll<P>((a, b) => sb.from("products").select("id, sku, name, spec").eq("active", true)
      .order("name", { ascending: true }).order("id", { ascending: true }).range(a, b)),
    readStockMap(sb, { asof: day, chan: channel }), // 현재고를 못 읽으면 던진다 — 0 으로 채워 내보내지 않는다(실사 기준값이라 위험)
    getAllBundles(sb),
    getUntracked(sb),
  ]);

  // SKU 가 없으면 업로드 때 매칭이 안 되고, 세트는 자체 재고가 없어 입출고는 구성품으로 전개·조정은 불가 → 양식에서 뺀다.
  const rows: TemplateProduct[] = [];
  const excludedNoSku: string[] = [];
  let excludedBundles = 0;
  for (const p of products) {
    if (isBundleId(bundles, p.id)) { excludedBundles++; continue; }
    if (untracked.ids.has(p.id)) continue; // '재고 관리 사용 안함'(121) — 양식에 넣지 않는다
    const sku = p.sku ? String(p.sku).trim() : "";
    if (!sku) { excludedNoSku.push(p.name); continue; }
    rows.push({ sku, name: p.name, spec: p.spec, qty: stock.get(p.id) || 0 });
  }
  return { rows, excludedNoSku, excludedBundles };
}

/** 양식 맨 아래에 '빠진 품목' 안내를 남긴다 — SKU·수량 칸이 비어 있어 그대로 다시 올려도 무시된다. */
export function appendExcludedNote(ws: ExcelJS.Worksheet, noSku: string[], bundles: number) {
  if (!noSku.length && !bundles) return;
  const parts: string[] = [];
  if (noSku.length) parts.push(`SKU 미등록 ${noSku.length}종(${noSku.slice(0, 5).join(", ")}${noSku.length > 5 ? " 외" : ""}) — 상품 마스터에서 SKU 를 넣은 뒤 양식을 다시 받으세요`);
  if (bundles) parts.push(`묶음(세트) ${bundles}종 — 세트는 자체 재고가 없어 구성품으로 처리합니다`);
  ws.addRow([]);
  ws.addRow(["", `※ 이 양식에서 빠진 품목: ${parts.join(" / ")}`]).font = { color: { argb: "FF8A94A6" } };
}
