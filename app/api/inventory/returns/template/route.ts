import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { fetchQuoteTxns, validMonth } from "../../quote/fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/inventory/returns/template?month=YYYY-MM
//  그 달에 매입한 품목만 SKU·품목명·매입수량이 채워진 양식. 반품수량 칸만 적으면 되고 빈 줄은 건너뛴다.
export async function GET(req: NextRequest) {
  try {
    const month = validMonth(req.nextUrl.searchParams.get("month"));
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)가 필요합니다." }, { status: 400 });

    const txns = await fetchQuoteTxns(month);
    const hasStatus = txns.some((t) => t.status != null);
    const used = hasStatus ? txns.filter((t) => t.status === "완료") : txns;

    const m = new Map<string, { sku: string | null; name: string; qty: number }>();
    for (const t of used) {
      const q = Math.abs(Math.round(Number(t.qty) || 0));
      if (!q) continue;
      const p = t.product;
      const key = t.product_id;
      const cur = m.get(key);
      if (cur) cur.qty += q;
      else m.set(key, {
        sku: p?.sku ?? null,
        name: p?.spec ? `${p.name} ${p.spec}` : (p?.name ?? "(삭제된 품목)"),
        qty: q,
      });
    }
    // SKU 로 품목을 찾으므로 SKU 없는 품목은 양식에서 뺀다(업로드해도 매칭이 안 된다).
    const rows = [...m.values()].filter((r) => r.sku).sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const noSku = [...m.values()].filter((r) => !r.sku);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("제조사 반품");
    ws.addRow(["SKU", "품목명", `매입수량(${month})`, "반품수량", "단가", "메모"]);
    for (const r of rows) ws.addRow([r.sku, r.name, r.qty, "", "", ""]);
    ws.getColumn(3).font = { color: { argb: "FF8A94A6" } }; // 참고값 — 입력칸과 구분
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
    ws.columns.forEach((c, i) => { c.width = i === 0 ? 20 : i === 1 ? 34 : 14; });
    ws.views = [{ state: "frozen", ySplit: 1 }];

    if (noSku.length) {
      ws.addRow([]);
      ws.addRow([`※ SKU 가 없어 제외된 품목 ${noSku.length}종: ${noSku.map((r) => r.name).join(", ")}`]);
    }
    if (rows.length === 0) {
      ws.addRow([]);
      ws.addRow([`※ ${month} 매입 내역이 없습니다.`]);
    }

    const buf = await wb.xlsx.writeBuffer();
    const fname = encodeURIComponent(`씨몬스터_제조사반품_양식_${month}.xlsx`);
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
      },
    });
  } catch (err) {
    console.error("[inventory/returns/template]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "양식 생성 실패") }, { status: 500 });
  }
}
