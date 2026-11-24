import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_003, UUID_RE, fetchPayWorkplaces, fetchPayroll } from "@/app/lib/hr-pay-db";
import { isMonth } from "@/app/lib/hr-work";
import { fetchAffiliationOf } from "@/app/lib/hr-work-db";
import {
  BANK_AMOUNT_FMT, BANK_SHEET, KB_BANKS, KB_BANKS_PER_ROW, KB_BANK_TABLE_ROW, KB_BANK_TITLE, KB_NOTE_LINES, KB_NOTE_TITLE, KB_RECV_LINES, KB_RECV_TITLE,
  bankLabels, bankRowOf, cleanLabels, type BankLine, type BankRow, type BankSource,
} from "@/app/lib/hr-bank";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;

// 양식 오른쪽 구역(I~V열): 유의사항 · 받는분 통장표시 예시 · 주요 은행 코드 표. 글은 hr-bank.ts 에 양식 그대로 있다.
function writeKbNotes(ws: ExcelJS.Worksheet): void {
  const BLUE = "FFEFF3FC", YELLOW = "FFFFF5CC";
  const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const put = (addr: string, text: string, o: { bold?: boolean; size?: number; fill?: string; red?: boolean; center?: boolean } = {}) => {
    const c = ws.getCell(addr);
    c.value = text; c.numFmt = "@";
    c.font = { size: o.size ?? 10, bold: !!o.bold, ...(o.red ? { color: { argb: "FFFF0000" } } : {}) };
    if (o.fill) c.fill = fill(o.fill);
    c.alignment = { vertical: "middle", horizontal: o.center ? "center" : "left" };
  };
  put("I1", KB_NOTE_TITLE, { bold: true, size: 9, fill: BLUE });
  ws.mergeCells("I1:V1");
  for (const [row, col, text] of KB_NOTE_LINES) put(`${col}${row}`, text, { size: col === "J" ? 9 : 10, red: row === 7 && col === "L" });
  put("I11", KB_RECV_TITLE, { bold: true, size: 9, fill: YELLOW });
  ws.mergeCells("I11:V11");
  KB_RECV_LINES.forEach((t, i) => {
    put(`I${12 + i}`, t, { fill: YELLOW });
    for (let c = 10; c <= 22; c++) ws.getRow(12 + i).getCell(c).fill = fill(YELLOW);
  });
  put("I15", KB_BANK_TITLE, { bold: true, size: 9, fill: BLUE });
  Object.entries(KB_BANKS).forEach(([name, code], i) => {
    const row = ws.getRow(KB_BANK_TABLE_ROW + Math.floor(i / KB_BANKS_PER_ROW)), col = 9 + (i % KB_BANKS_PER_ROW) * 2;
    put(row.getCell(col).address, name, { center: true });
    put(row.getCell(col + 1).address, code, { center: true });
  });
}

// POST /api/hr/payroll/bank — 급여 이체 파일(국민은행 급여이체 엑셀)
//   { workplace_id, month }                                        → 목록: 직원마다 은행·가린 계좌·예금주·실수령액과 이체할 수 없는 까닭
//   { …, download: true, employee_ids: [...], labels?: { recv, mine, memo } } → 고른 직원의 이체 파일(.xlsx)
//  금액은 저장된 급여의 실수령액이다(화면은 저장한 뒤에만 열게 한다). 계좌번호 전체는 파일에만 들어가고 목록·이력에는 싣지 않는다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { workplace_id?: string; month?: string; download?: boolean; employee_ids?: unknown; labels?: Record<string, unknown> };
    const workplaceId = String(body.workplace_id ?? ""), month = String(body.month ?? "");
    if (!UUID_RE.test(workplaceId)) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
    if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
    const [workplaces, saved, affOf] = await Promise.all([fetchPayWorkplaces(), fetchPayroll(workplaceId, month), fetchAffiliationOf(workplaceId)]);
    const wp = workplaces.find((w) => w.id === workplaceId);
    const lines = (saved?.lines || []).filter((l) => l.result);
    if (!wp || !saved || lines.length === 0) return hrJson({ ok: false, error: "저장된 급여가 없습니다. 먼저 저장하세요." }, 404);

    // 계좌는 지금 인사대장의 값(저장된 급여에는 계좌가 들어 있지 않다)
    const ids = lines.map((l) => l.employee_id);
    const acct = new Map<string, Row>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await hrDb().from("employees").select("id,bank,account_no,account_holder").in("id", ids.slice(i, i + 200));
      if (error) throw error;
      for (const r of (data || []) as Row[]) acct.set(String(r.id), r);
    }
    const built = lines.map((l) => {
      const a = acct.get(l.employee_id) || {};
      const src: BankSource = {
        employee_id: l.employee_id, name: l.snapshot.name || "", affiliation: affOf[l.employee_id] || "",
        bank: String(a.bank ?? ""), account_no: String(a.account_no ?? ""), account_holder: String(a.account_holder ?? ""), net_pay: l.result!.net_pay,
      };
      return bankRowOf(src);
    });

    if (body.download !== true) {
      const rows: BankRow[] = built.map((b) => b.row);
      return hrJson({ ok: true, month, workplace: wp.name, status: saved.head.status, pay_date: saved.head.pay_date, labels: bankLabels(month), rows });
    }

    const want = new Set(Array.isArray(body.employee_ids) ? (body.employee_ids as unknown[]).map(String) : []);
    if (want.size === 0) return hrJson({ ok: false, error: "이체할 직원을 고르세요." }, 400);
    const picked = built.filter((b) => want.has(b.row.employee_id));
    const broken = picked.filter((b) => !b.line);
    if (broken.length > 0) return hrJson({ ok: false, error: `이체할 수 없는 직원이 들어 있습니다(${broken.slice(0, 3).map((b) => `${b.row.name}: ${b.row.problems[0]}`).join(", ")}).` }, 400);
    if (picked.length !== want.size) return hrJson({ ok: false, error: "이 달 급여에 없는 직원이 들어 있습니다. 창을 다시 여세요." }, 400);
    const labels = cleanLabels(body.labels as Partial<{ recv: string; mine: string; memo: string }>, month);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(BANK_SHEET);
    // 은행 양식 그대로: 머리 줄 없이 1줄부터. 은행·계좌·예금주·메모는 글자 서식(계좌의 앞자리 0 이 지워지지 않게), 금액만 숫자
    //  오른쪽(I~V열)에는 양식의 유의사항과 은행 코드 표를 그대로 둔다 — 은행 이름이 틀린 줄을 표를 보고 고치려는 것(대표)
    ws.columns = [{ width: 11 }, { width: 22 }, { width: 15 }, { width: 12 }, { width: 10 }, { width: 13 }, { width: 13 }, { width: 3 },
      ...Array.from({ length: 14 }, (_, i) => ({ width: i === 0 ? 7.6 : i % 2 === 1 ? 6.1 : 8.6 }))];
    for (const b of picked) {
      const l = b.line as BankLine;
      const row = ws.addRow([l.bank, l.account, l.amount, l.holder, labels.recv, labels.mine, labels.memo]);
      row.eachCell({ includeEmpty: true }, (c, col) => { c.numFmt = col === 3 ? BANK_AMOUNT_FMT : "@"; });
    }
    writeKbNotes(ws);
    const total = picked.reduce((t, b) => t + b.row.amount, 0);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    // 이력에는 사람 수·합계만 남긴다(계좌번호를 싣지 않는다)
    await hrAudit({
      actor: who.name, action: "payroll_bank_export", ip: clientIp(req), targetType: "payroll", targetId: saved.head.id, targetName: `${wp.name} ${month}`,
      detail: { people: picked.length, of: lines.length, total, status: saved.head.status },
    });
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="bank-${month}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return hrError(err, "이체 파일을 만들지 못했습니다.", HR_PENDING_003);
  }
}
