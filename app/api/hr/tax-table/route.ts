import { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_003, fetchTaxTable } from "@/app/lib/hr-pay-db";
import { parseTaxSheet } from "@/app/lib/hr-pay";
import { isDate } from "@/app/lib/hr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;
const MAX_BYTES = 3 * 1024 * 1024;

// 근로소득 간이세액표 — 국세청 원본 엑셀을 올려 데이터로 둔다(산식으로 흉내 내지 않는다).
//  급여 계산은 지급일에 유효한 표(적용 시작일이 지급일 이전인 것 중 가장 늦은 것)에서 과세 급여·공제대상가족 수로 세액을 찾는다.

// GET /api/hr/tax-table — 올려 둔 표 목록(줄은 싣지 않는다). ?on=YYYY-MM-DD 면 그 지급일에 유효한 표 하나(줄 포함, 없으면 null)
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const on = req.nextUrl.searchParams.get("on");
    if (on != null) {
      if (!isDate(on)) return hrJson({ ok: false, error: "날짜가 올바르지 않습니다." }, 400);
      return hrJson({ ok: true, table: await fetchTaxTable(on) });
    }
    const { data, error } = await hrDb().from("tax_tables").select("effective_from,row_count,source,uploaded_by,uploaded_at").order("effective_from", { ascending: false });
    if (error) throw error;
    return hrJson({ ok: true, tables: data || [] });
  } catch (err) {
    return hrError(err, "간이세액표를 불러오지 못했습니다.", HR_PENDING_003);
  }
}

// POST /api/hr/tax-table — { effective_from, name, file(base64 xlsx) } 표 하나를 올린다(같은 적용 시작일이면 바꾼다).
//  모든 시트에서 [이상, 미만, 1명 … 11명] 모양의 숫자 줄을 찾아 가장 많이 나온 시트를 쓴다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { effective_from?: string; name?: string; file?: string };
    const from = String(body.effective_from ?? "").trim();
    const name = String(body.name ?? "").trim().slice(0, 200);
    if (!isDate(from)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { effective_from: "적용 시작일을 입력하세요" } }, 400);
    const b64 = String(body.file ?? "");
    if (!b64) return hrJson({ ok: false, error: "엑셀 파일을 고르세요." }, 400);
    if (b64.length > MAX_BYTES * 1.4) return hrJson({ ok: false, error: "파일이 너무 큽니다(3MB 이하)." }, 400);
    if (/\.xls$/i.test(name)) return hrJson({ ok: false, error: "옛 엑셀 형식(.xls)은 읽지 못합니다. 엑셀에서 .xlsx 로 다시 저장해 올리세요." }, 400);

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(Buffer.from(b64, "base64") as unknown as ArrayBuffer);
    } catch {
      return hrJson({ ok: false, error: "엑셀 파일(.xlsx)을 읽지 못했습니다." }, 400);
    }
    let best: { rows: number[][]; error: string; sheet: string } = { rows: [], error: "세액표 줄을 찾지 못했습니다. 국세청 근로소득 간이세액표(조견표) 엑셀인지 확인하세요.", sheet: "" };
    wb.eachSheet((ws) => {
      const cells: unknown[][] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const line: unknown[] = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => {
          const v = cell.value as unknown;
          // 수식·서식 있는 글자 칸은 결과·글자만 꺼낸다
          const plain = v && typeof v === "object"
            ? ("result" in (v as Row) ? (v as Row).result : "richText" in (v as Row) ? ((v as { richText: { text: string }[] }).richText || []).map((t) => t.text).join("") : "text" in (v as Row) ? (v as Row).text : null)
            : v;
          line[col - 1] = plain;
        });
        cells.push(line);
      });
      const p = parseTaxSheet(cells);
      if (p.rows.length > best.rows.length || (best.rows.length === 0 && p.error && cells.length > 50)) best = { ...p, sheet: ws.name };
    });
    if (best.rows.length === 0) return hrJson({ ok: false, error: best.error }, 400);

    const { error } = await hrDb().from("tax_tables").upsert(
      { effective_from: from, rows: best.rows, row_count: best.rows.length, source: name, uploaded_by: who.name, uploaded_at: new Date().toISOString() },
      { onConflict: "effective_from" },
    );
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "tax_table_upload", ip: clientIp(req), targetType: "tax_table", targetId: from, targetName: from, detail: { rows: best.rows.length, source: name, sheet: best.sheet } });
    const first = best.rows[0], last = best.rows[best.rows.length - 1];
    return hrJson({ ok: true, effective_from: from, row_count: best.rows.length, sheet: best.sheet, first, last });
  } catch (err) {
    return hrError(err, "간이세액표를 올리지 못했습니다.", HR_PENDING_003);
  }
}

// DELETE /api/hr/tax-table?effective_from=YYYY-MM-DD — 표 하나 삭제(확정한 급여는 그때 금액을 따로 보관하므로 바뀌지 않는다)
export async function DELETE(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const from = req.nextUrl.searchParams.get("effective_from") || "";
  if (!isDate(from)) return hrJson({ ok: false, error: "없는 세액표입니다." }, 404);
  try {
    const { data, error } = await hrDb().from("tax_tables").delete().eq("effective_from", from).select("effective_from");
    if (error) throw error;
    if (!data || data.length === 0) return hrJson({ ok: false, error: "없는 세액표입니다." }, 404);
    await hrAudit({ actor: who.name, action: "tax_table_delete", ip: clientIp(req), targetType: "tax_table", targetId: from, targetName: from });
    return hrJson({ ok: true });
  } catch (err) {
    return hrError(err, "간이세액표를 지우지 못했습니다.", HR_PENDING_003);
  }
}
