import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { BOX_CATEGORIES } from "@/app/lib/order-fulfill";
import { normalizeHistory, ratesFor } from "@/app/lib/fulfill-rates";
import { mergeDeliveryRow } from "@/app/lib/delivery-log";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const n = (v: unknown) => Number(v) || 0;
const boxSum = (o: unknown) => (o && typeof o === "object" ? Object.values(o as Record<string, unknown>).reduce((a: number, b) => a + n(b), 0) : 0);

type LogRow = {
  log_date: string; boxes_normal: Record<string, number> | null; boxes_guar: Record<string, number> | null;
  base_fee_normal: number; base_fee_guar: number; extra_fee: number; guar_extra_fee: number;
  pado_fee: number; pado_extra: number; pado_cod: number; dryice_full: number; dryice_half: number; memo: string | null;
};

// GET ?from=&to= — 배송일지 기간을 xlsx 로 다운로드(요약 + 박스종류별 2시트)
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let from = (sp.get("from") || "").trim(), to = (sp.get("to") || "").trim();
    if (!DATE_RE.test(to)) { const d = new Date(Date.now() + 9 * 3600e3); to = d.toISOString().slice(0, 10); }
    if (!DATE_RE.test(from)) { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - 60); from = d.toISOString().slice(0, 10); }

    const sb = supabaseAdmin();
    const { data, error } = await sb.from("delivery_log").select("*").gte("log_date", from).lte("log_date", to).order("log_date", { ascending: true });
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (055 적용 확인)` }, { status: 500 });

    // 드라이 단가는 날짜별로 소급 적용 안 함 → 각 행 날짜에 유효했던 단가 사용
    const { data: rateRow } = await sb.from("b2b_settings").select("value").eq("key", "fulfill_rates").maybeSingle();
    const history = normalizeHistory(rateRow?.value ?? {});
    // 자동+직접수정 병합 → 최종값으로 추출(화면·통계와 일치)
    const rows = (data ?? []).map((r) => mergeDeliveryRow(r as Record<string, unknown>, history)) as unknown as LogRow[];
    const weekday = (iso: string) => WD[new Date(`${iso}T00:00:00Z`).getUTCDay()];

    const wb = new ExcelJS.Workbook();

    // ── 시트1: 배송일지(요약 + 채널 상세) ──
    const ws = wb.addWorksheet("배송일지");
    const cols = [
      { header: "날짜", key: "date", width: 12 },
      { header: "요일", key: "wd", width: 6 },
      { header: "일반 택배량", key: "cN", width: 11 },
      { header: "도착보장 택배량", key: "cG", width: 14 },
      { header: "일반 기본운임", key: "bfn", width: 13 },
      { header: "일반 추가", key: "ef", width: 10 },
      { header: "일반운임 합", key: "nf", width: 12 },
      { header: "도착보장 기본", key: "bfg", width: 13 },
      { header: "도착보장 추가", key: "gxf", width: 13 },
      { header: "도착보장 운임 합", key: "gf", width: 15 },
      { header: "파도 기본", key: "pf", width: 10 },
      { header: "파도 추가", key: "pe", width: 10 },
      { header: "파도 착불", key: "pc", width: 10 },
      { header: "파도 운임 합", key: "pff", width: 12 },
      { header: "총 운임", key: "tot", width: 12 },
      { header: "드라이 풀", key: "df", width: 9 },
      { header: "드라이 반", key: "dh", width: 9 },
      { header: "드라이 금액", key: "da", width: 12 },
      { header: "비고", key: "memo", width: 26 },
    ];
    ws.columns = cols;
    const MONEY = ["cN", "cG", "bfn", "ef", "nf", "bfg", "gxf", "gf", "pf", "pe", "pc", "pff", "tot", "df", "dh", "da"];
    for (const k of MONEY) ws.getColumn(k).numFmt = "#,##0";

    const sumAcc: Record<string, number> = {};
    for (const r of rows) {
      const rt = ratesFor(history, r.log_date);
      const nf = n(r.base_fee_normal) + n(r.extra_fee);
      const gf = n(r.base_fee_guar) + n(r.guar_extra_fee);
      const pff = n(r.pado_fee) + n(r.pado_extra) + n(r.pado_cod);
      const da = n(r.dryice_full) * rt.dryFull + n(r.dryice_half) * rt.dryHalf;
      const rowVals: Record<string, unknown> = {
        date: r.log_date, wd: weekday(r.log_date),
        cN: boxSum(r.boxes_normal), cG: boxSum(r.boxes_guar),
        bfn: n(r.base_fee_normal), ef: n(r.extra_fee), nf,
        bfg: n(r.base_fee_guar), gxf: n(r.guar_extra_fee), gf,
        pf: n(r.pado_fee), pe: n(r.pado_extra), pc: n(r.pado_cod), pff,
        tot: nf + gf + pff, df: n(r.dryice_full), dh: n(r.dryice_half), da, memo: r.memo || "",
      };
      ws.addRow(rowVals);
      for (const k of MONEY) sumAcc[k] = (sumAcc[k] || 0) + n(rowVals[k]);
    }
    ws.getRow(1).font = { bold: true };
    if (rows.length) {
      const totalRow = ws.addRow({ date: "합계", wd: "", memo: `${rows.length}일`, ...sumAcc });
      totalRow.font = { bold: true };
    }

    // ── 시트2: 박스종류별(날짜×구분×박스종류) ──
    const ws2 = wb.addWorksheet("박스종류별");
    const bcols = [
      { header: "날짜", key: "date", width: 12 },
      { header: "구분", key: "kind", width: 10 },
      ...BOX_CATEGORIES.map((c) => ({ header: c, key: `b_${c}`, width: 8 })),
      { header: "합계", key: "sum", width: 8 },
    ];
    ws2.columns = bcols;
    for (const c of BOX_CATEGORIES) ws2.getColumn(`b_${c}`).numFmt = "#,##0";
    ws2.getColumn("sum").numFmt = "#,##0";
    const catAcc: Record<string, number> = {};
    for (const r of rows) {
      for (const [kind, boxes] of [["일반", r.boxes_normal], ["도착보장", r.boxes_guar]] as const) {
        const tot = boxSum(boxes);
        if (!tot) continue;
        const rv: Record<string, unknown> = { date: r.log_date, kind, sum: tot };
        for (const c of BOX_CATEGORIES) { const v = n((boxes as Record<string, number> | null)?.[c]); rv[`b_${c}`] = v; catAcc[c] = (catAcc[c] || 0) + v; }
        ws2.addRow(rv);
      }
    }
    ws2.getRow(1).font = { bold: true };
    const catTotal = Object.values(catAcc).reduce((a, b) => a + b, 0);
    if (catTotal) {
      const tr: Record<string, unknown> = { date: "합계", kind: "", sum: catTotal };
      for (const c of BOX_CATEGORIES) tr[`b_${c}`] = catAcc[c] || 0;
      ws2.addRow(tr).font = { bold: true };
    }

    const buf = await wb.xlsx.writeBuffer();
    const fname = `배송일지_${from}_${to}.xlsx`;
    return new NextResponse(Buffer.from(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="delivery-log_${from}_${to}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "추출 실패") }, { status: 500 });
  }
}
