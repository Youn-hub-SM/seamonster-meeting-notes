import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { ADJUST_XLSX_HEADERS, ADJUST_XLSX_EXAMPLE } from "@/app/lib/inventory-xlsx";
import { templateProducts, appendExcludedNote } from "@/app/lib/inventory-template";
import { toInvChannelParam } from "@/app/lib/inventory";
import { kstTodayIso } from "@/app/lib/production-schedule";
import { countDateError } from "../count-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/inventory/adjust/template[?fill=1&channel=소매|도매|프로모션|도매 대량&asof=실사일] — 재고 조정(실사) 대량 업로드 양식.
//  fill=1: 전 품목의 SKU·품목명·실사일 기준 현재고를 채워서 내려준다 — 실사수량 칸만 채우면 되고, 빈 행은 업로드 때 건너뛴다.
//   칸은 명시해야 한다(S8) — 모르는 값을 소매로 채워 주면 다른 칸을 센 사람이 소매 현재고를 보고 맞춘다.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const fill = sp.get("fill") === "1";
    const chanParam = toInvChannelParam(sp.get("channel"));
    if (fill && !chanParam) return NextResponse.json({ ok: false, error: "실사할 칸을 고르세요." }, { status: 400 });
    const channel = chanParam ?? "소매"; // 빈 양식(fill 없음)은 칸을 쓰지 않는다 — 타입 맞춤용
    const today = kstTodayIso();
    const asof = sp.get("asof") || today;
    const badDate = countDateError(asof, today);
    if (fill && badDate) return NextResponse.json({ ok: false, error: badDate }, { status: 400 });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("재고 조정");

    if (fill) {
      const { rows, excludedNoSku, excludedBundles } = await templateProducts(channel, asof);
      // 헤더는 '현재고' 로 시작해야 업로드가 채워진 양식으로 알아본다(빈 실사수량 = 건너뜀)
      ws.addRow(["SKU", "품목명", `현재고(${channel} ${asof} 마감)`, "실사수량", "메모"]);
      for (const p of rows) ws.addRow([p.sku, p.spec ? `${p.name} ${p.spec}` : p.name, p.qty, "", ""]);
      // 열 font 는 그 열의 기존 셀(헤더 포함)을 통째로 덮으므로 헤더 스타일보다 반드시 먼저 깐다.
      ws.getColumn(3).font = { color: { argb: "FF8A94A6" } }; // 참고값(현재고)
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
      ws.columns.forEach((c, i) => { c.width = i === 0 ? 20 : i === 1 ? 34 : i === 2 ? 28 : i === 4 ? 24 : 14; });
      ws.views = [{ state: "frozen", ySplit: 1 }];
      appendExcludedNote(ws, excludedNoSku, excludedBundles);
    } else {
      ws.addRow([...ADJUST_XLSX_HEADERS]);
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
      for (const ex of ADJUST_XLSX_EXAMPLE) { const r = ws.addRow(ex); r.font = { italic: true, color: { argb: "FF8A94A6" } }; }
      ws.columns.forEach((c, i) => { c.width = i === 0 ? 18 : i === 2 ? 24 : 12; });
      ws.addRow([]);
      ws.addRow(["", "", "※ '실사수량'은 실제 센 현재 수량(목표). 현재고가 이 값이 되도록 조정합니다. 예시 행은 지우고 입력하세요."]).font = { color: { argb: "FF8A94A6" } };
    }

    const buf = await wb.xlsx.writeBuffer();
    const fname = encodeURIComponent(fill ? `씨몬스터_재고조정_양식_${channel}_${asof}.xlsx` : "씨몬스터_재고조정_양식.xlsx");
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
      },
    });
  } catch (err) {
    console.error("[inventory/adjust/template]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "양식 생성 실패") }, { status: 500 });
  }
}
