// 입·출·조정 엑셀 양식에 미리 채워 넣을 품목 목록.
//  빈 양식에 SKU 를 손으로 옮겨 적는 대신, 전 품목의 SKU·품목명·현재고를 넣어 내려주고
//  사용자는 수량(또는 실사수량) 칸만 채우면 되게 한다. 미입력 행은 업로드 시 건너뛴다.

import type ExcelJS from "exceljs";
import { supabaseAdmin } from "@/app/lib/supabase";
import { getAllBundles, isBundleId } from "@/app/lib/product-bundles";
import type { InvChannel } from "@/app/lib/inventory";

export type TemplateProduct = { sku: string; name: string; spec: string | null; qty: number };
/** 양식에 넣지 못한 품목 — 빠진 이유를 사용자에게 알리기 위해 함께 돌려준다(모르면 실사에서 통째로 누락된다). */
export type TemplateResult = { rows: TemplateProduct[]; excludedNoSku: string[]; excludedBundles: number };

/** 활성 품목(세트·SKU 없는 품목 제외) + 그 채널 현재고. 품목명 오름차순. */
export async function templateProducts(channel: InvChannel): Promise<TemplateResult> {
  const sb = supabaseAdmin();
  const stockRpc = async () => {
    const res = await sb.rpc("inventory_stock", { asof: null, chan: channel });
    if (!res.error) return res;
    return sb.rpc("inventory_stock", { asof: null }); // 036 미적용 폴백(채널 구분 없는 전체 합산)
  };
  const [pr, tr, bundles] = await Promise.all([
    sb.from("products").select("id, sku, name, spec").eq("active", true).order("name", { ascending: true }),
    stockRpc(),
    getAllBundles(sb),
  ]);
  if (pr.error) throw pr.error;
  if (tr.error) throw tr.error; // 현재고를 못 읽으면 0 으로 채워 내보내지 않는다(실사 기준값이라 위험)

  const stock = new Map<string, number>();
  for (const t of (tr.data as { product_id: string; qty: number }[] | null) ?? []) stock.set(t.product_id, Number(t.qty) || 0);

  // SKU 가 없으면 업로드 때 매칭이 안 되고, 세트는 자체 재고가 없어 입출고는 구성품으로 전개·조정은 불가 → 양식에서 뺀다.
  const rows: TemplateProduct[] = [];
  const excludedNoSku: string[] = [];
  let excludedBundles = 0;
  for (const p of pr.data ?? []) {
    if (isBundleId(bundles, p.id)) { excludedBundles++; continue; }
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
