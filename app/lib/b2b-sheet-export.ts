import { supabaseAdmin } from "./supabase";

// 발주가 '발송완료' 되면 매출 행을 기존 구글시트(Apps Script 웹앱)에 append.
//  - 양식: 매출집계 엑셀(/api/b2b/reports/export)과 동일한 13컬럼, 라인아이템 1개당 1행
//  - 1회 가드: orders.exported_at 이 차 있으면 재전송 안 함
//  - Apps Script URL 은 b2b_settings 'sales_sheet_url' 에 저장 (없으면 조용히 패스)

const SHEET_URL_KEY = "sales_sheet_url";

export async function getSalesSheetUrl(): Promise<string> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("b2b_settings")
      .select("value")
      .eq("key", SHEET_URL_KEY)
      .maybeSingle();
    if (error || !data) return "";
    const v = data.value as string | { url?: string } | null;
    const url = typeof v === "string" ? v : v?.url;
    return (url || "").trim();
  } catch {
    return "";
  }
}

export async function setSalesSheetUrl(url: string): Promise<void> {
  const sb = supabaseAdmin();
  if (!url || !url.trim()) {
    const { error } = await sb.from("b2b_settings").delete().eq("key", SHEET_URL_KEY);
    if (error) throw error;
    return;
  }
  const { error } = await sb
    .from("b2b_settings")
    .upsert({ key: SHEET_URL_KEY, value: url.trim(), updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

// 매출집계 export 와 동일한 13컬럼 행 빌드 (라인아이템 1개당 1행)
type CompanyJoin = { name?: string; contact_phone?: string };
type ProductJoin = { sku?: string | null };
type ItemJoin = {
  product_name: string;
  option_label: string | null;
  spec: string | null;
  qty: number;
  unit_price: number;
  sort_order: number;
  product?: ProductJoin | ProductJoin[] | null;
};
type OrderJoin = {
  id: string;
  order_no: string;
  order_date: string;
  status: string;
  exported_at: string | null;
  company: CompanyJoin | CompanyJoin[] | null;
  order_items: ItemJoin[];
};

function buildSalesRows(o: OrderJoin): (string | number)[][] {
  const company = Array.isArray(o.company) ? o.company[0] : o.company;
  const customerName = company?.name ?? "";
  const customerPhone = company?.contact_phone ?? "";
  const orderDateYmd = (o.order_date ?? "").replace(/-/g, ""); // YYYY-MM-DD → YYYYMMDD
  const items = (o.order_items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  return items.map((it) => {
    const product = Array.isArray(it.product) ? it.product[0] : it.product;
    const sku = product?.sku ?? "";
    const qty = Number(it.qty) || 0;
    const price = Number(it.unit_price) || 0;
    return [
      "도매",
      orderDateYmd,
      o.order_no,
      it.product_name ?? "",
      it.spec || it.option_label || "",
      sku,
      qty,
      price,
      0, // option_price
      qty * price, // subtotal_amount
      0, // shipping_fee
      customerName,
      customerPhone,
    ];
  });
}

// 발주 1건을 시트로 전송. status==='발송완료' & 미전송일 때만 실제 전송.
// 결과: 전송함 true / 스킵(미설정·미완료·이미전송·라인없음) false. 실패 시 throw.
export async function exportOrderToSheet(orderId: string): Promise<boolean> {
  const url = await getSalesSheetUrl();
  if (!url) return false; // 연동 미설정 → 패스

  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("orders")
    .select(
      "id, order_no, order_date, status, exported_at, " +
        "company:company_id(name, contact_phone), " +
        "order_items(product_name, option_label, spec, qty, unit_price, sort_order, product:product_id(sku))"
    )
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  const o = data as unknown as OrderJoin | null;
  if (!o) return false;
  if (o.status !== "발송완료" || o.exported_at) return false; // 완료 아니거나 이미 전송됨

  const rows = buildSalesRows(o);
  if (!rows.length) return false;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) throw new Error(`시트 전송 실패 (HTTP ${res.status})`);
  const text = await res.text();
  if (/"ok"\s*:\s*false/.test(text)) throw new Error(`시트 전송 거부: ${text.slice(0, 200)}`);

  await sb.from("orders").update({ exported_at: new Date().toISOString() }).eq("id", orderId);
  return true;
}

// 상태 변경 핸들러에서 fire-and-forget 로 호출 (응답 지연 없이).
export function exportOrderToSheetSafe(orderId: string): void {
  exportOrderToSheet(orderId).catch((e) => {
    console.error("[b2b/sheet-export] 발주 시트 전송 실패:", orderId, e);
  });
}
