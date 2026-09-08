import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SKU 리스팅 찾기 — 검색 결과 엑셀 추출.
//  화면이 이미 받아둔 결과(카탈로그+채널 리스팅)를 그대로 보내면 xlsx 로 만들어 준다
//  (서버 재조회 없음 — 화면에 보이는 것과 파일 내용이 항상 일치).

type CatalogItem = {
  listing_name: string; item_kind: string; item_name: string | null;
  sku_code: string; sale_status: string | null; stock_qty: number | null; via_bundle?: boolean;
};
type Listing = {
  channel: string; product_name: string; option_name: string; sku_code: string;
  qty_7: number; qty_30: number; qty_window: number; last_sale: string | null; via_bundle?: boolean;
};

const KIND_KO: Record<string, string> = { product: "단일", option: "옵션", supplement: "추가상품" };
const SALE_STATUS_KO: Record<string, string> = {
  SALE: "판매중", OUTOFSTOCK: "품절", SUSPENSION: "판매중지", WAIT: "판매대기",
  UNADMISSION: "승인대기", REJECTION: "승인거부", CLOSE: "판매종료", PROHIBITION: "판매금지", UNUSABLE: "사용안함",
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      target?: { sku: string | null; name: string };
      catalog?: CatalogItem[];
      listings?: Listing[];
    };
    const target = body.target;
    const catalog = Array.isArray(body.catalog) ? body.catalog : [];
    const listings = Array.isArray(body.listings) ? body.listings : [];
    if (!target || (catalog.length === 0 && listings.length === 0)) {
      return NextResponse.json({ ok: false, error: "추출할 결과가 없습니다." }, { status: 400 });
    }

    const wb = new ExcelJS.Workbook();

    if (catalog.length > 0) {
      const ws = wb.addWorksheet("네이버 등록 카탈로그");
      ws.addRow(["등록 상품명(어미상품)", "구분", "옵션·추가상품명", "관리코드", "묶음", "판매상태", "재고"]);
      ws.getRow(1).font = { bold: true };
      for (const c of catalog) {
        ws.addRow([
          c.listing_name,
          KIND_KO[c.item_kind] || c.item_kind,
          c.item_name || "",
          c.sku_code || "",
          c.via_bundle ? "묶음" : "",
          c.sale_status ? (SALE_STATUS_KO[c.sale_status] || c.sale_status) : "",
          c.stock_qty ?? "",
        ]);
      }
      ws.columns.forEach((col, i) => { col.width = [40, 8, 30, 16, 6, 10, 8][i] || 12; });
    }

    if (listings.length > 0) {
      const ws = wb.addWorksheet("채널별 매출 리스팅");
      ws.addRow(["채널", "상품명", "옵션명", "관리코드", "묶음", "7일 판매", "30일 판매", "1년 판매", "마지막 판매일"]);
      ws.getRow(1).font = { bold: true };
      for (const l of listings) {
        ws.addRow([
          l.channel, l.product_name, l.option_name || "", l.sku_code || "",
          l.via_bundle ? "묶음" : "", l.qty_7, l.qty_30, l.qty_window, l.last_sale || "",
        ]);
      }
      ws.columns.forEach((col, i) => { col.width = [12, 40, 24, 16, 6, 10, 10, 10, 12][i] || 12; });
    }

    const buf = await wb.xlsx.writeBuffer();
    const fname = `sku_listings_${(target.sku || "unknown").replace(/[^\w-]/g, "_")}.xlsx`;
    return new NextResponse(Buffer.from(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fname}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[sales/listings/export]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "xlsx 생성 실패") }, { status: 500 });
  }
}
