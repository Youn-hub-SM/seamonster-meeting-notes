import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_003, UUID_RE, fetchPayWorkplaces, fetchPayroll } from "@/app/lib/hr-pay-db";
import { SYSTEM_DEDUCT, SYSTEM_LABEL, SYSTEM_PAY, itemAmount, type PayResult } from "@/app/lib/hr-pay";
import { isMonth } from "@/app/lib/hr-work";
import { fetchAffiliationOf } from "@/app/lib/hr-work-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/hr/payroll/export — 급여대장 엑셀. { workplace_id, month }
//  저장된 줄을 그대로 내보낸다(작성 중이면 마지막으로 저장한 금액 — 화면은 저장한 뒤에만 내려받게 한다).
//  이 파일이 [엑셀 올리기](/api/hr/payroll/import)의 양식이다 — 칸 이름을 바꾸면 hr-import.ts 의 급여대장 읽기도 같이 고친다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { workplace_id?: string; month?: string; affiliation?: string };
    const workplaceId = String(body.workplace_id ?? ""), month = String(body.month ?? "");
    const affiliation = String(body.affiliation ?? "").trim();   // 화면에서 소속을 골랐으면 그 소속 직원만
    if (!UUID_RE.test(workplaceId)) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
    if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
    const [workplaces, saved, affOf] = await Promise.all([fetchPayWorkplaces(), fetchPayroll(workplaceId, month), affiliation ? fetchAffiliationOf(workplaceId) : Promise.resolve({} as Record<string, string>)]);
    const wp = workplaces.find((w) => w.id === workplaceId);
    const all = (saved?.lines || []).filter((l) => l.result);
    if (!wp || !saved || all.length === 0) return hrJson({ ok: false, error: "저장된 급여가 없습니다. 먼저 저장하세요." }, 404);
    const lines = affiliation ? all.filter((l) => (affOf[l.employee_id] || "") === affiliation) : all;
    if (lines.length === 0) return hrJson({ ok: false, error: "그 소속의 급여가 없습니다." }, 404);

    // 직접 넣는 항목은 그 달에 금액이 있는 것만 열로 둔다(이름은 저장된 줄의 것 — 뒤에 항목 이름을 바꿔도 그때 이름 그대로)
    const extra = (kind: "pay" | "deduct") => {
      const seen = new Map<string, string>();
      for (const l of lines) for (const i of l.result!.items) if (i.kind === kind && i.code.startsWith("x:") && !seen.has(i.code)) seen.set(i.code, i.name);
      return [...seen];
    };
    const payX = extra("pay"), dedX = extra("deduct");
    const head = ["사번", "성명", "생년월일", "입사일", "부서", "직위", "업무", "급여 형태", "시급·월급", "근무 일수", "근무 시간", "연장", "야간", "휴일 근무", "주휴 시간",
      ...SYSTEM_PAY.map((c) => SYSTEM_LABEL[c]), ...payX.map(([, n]) => n), "지급 합계", "비과세", "과세 급여",
      ...SYSTEM_DEDUCT.map((c) => SYSTEM_LABEL[c]), ...dedX.map(([, n]) => n), "공제 합계", "실수령액",
      "회사 국민연금", "회사 건강보험", "회사 장기요양", "회사 고용보험", "회사 산재보험", "비고"];
    const rowOf = (r: PayResult) => [
      r.basis.pay_type === "hourly" ? "시급" : "월급", r.basis.wage, r.basis.workDays, r.basis.worked, r.basis.overtime, r.basis.night, r.basis.holiday, r.basis.weeklyHours,
      ...SYSTEM_PAY.map((c) => itemAmount(r, c)), ...payX.map(([c]) => itemAmount(r, c)), r.pay_total, r.exempt_total, r.taxable_total,
      ...SYSTEM_DEDUCT.map((c) => itemAmount(r, c)), ...dedX.map(([c]) => itemAmount(r, c)), r.deduct_total, r.net_pay,
      r.employer.pension, r.employer.health, r.employer.ltc, r.employer.employment, r.employer.accident,
    ];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("급여대장");
    // 첫 줄은 [엑셀 올리기]가 다시 읽는다(hr-import.ts readPaySheet): 귀속월 · 사업장 · '저장 <시각>'(내려받은 뒤 다시 저장됐는지 본다)
    ws.addRow([`급여대장 ${month}`, "", affiliation ? `${wp.name} ${affiliation}` : wp.name, "", `지급일 ${saved.head.pay_date}`, "", saved.head.status === "confirmed" ? "확정" : "작성 중",
      "", saved.head.updated_at ? `저장 ${saved.head.updated_at}` : ""]);
    ws.getRow(1).font = { bold: true };
    ws.addRow(head);
    ws.getRow(2).font = { bold: true };
    ws.getRow(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    const numFrom = 9; // '시급·월급' 열부터 숫자
    const totals: number[] = [];
    for (const l of lines) {
      const s = l.snapshot, vals = rowOf(l.result!);
      ws.addRow([s.emp_no || "", s.name || "", s.birth_date || "", s.hire_date || "", s.dept || "", s.position || "", s.job || "", ...vals, l.inputs?.memo || ""]);
      vals.forEach((v, i) => { if (typeof v === "number" && i >= 2) totals[i] = (totals[i] || 0) + v; });
    }
    const sumRow = ws.addRow(["합계", `${lines.length}명`, "", "", "", "", "", "", "", ...Array.from({ length: rowOf(lines[0].result!).length - 2 }, (_, i) => Math.round((totals[i + 2] || 0) * 100) / 100), ""]);
    sumRow.font = { bold: true };
    ws.columns.forEach((c, i) => { c.width = i === 1 ? 12 : i < 9 ? 11 : 13; if (i + 1 >= numFrom) c.numFmt = "#,##0.##"; });
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: 2 }];

    // 계산 방법 — 명세서에 찍히는 문장 그대로
    const cs = wb.addWorksheet("계산 방법");
    cs.addRow(["사번", "성명", "구분", "항목", "금액", "계산 방법", "직접 고침"]);
    cs.getRow(1).font = { bold: true };
    for (const l of lines) for (const i of l.result!.items) {
      if (!i.amount && !i.edited) continue;
      cs.addRow([l.snapshot.emp_no || "", l.snapshot.name || "", i.kind === "pay" ? "지급" : "공제", i.name, i.amount, i.calc, i.edited ? "예" : ""]);
    }
    cs.columns.forEach((c, i) => { c.width = i === 5 ? 70 : 13; if (i === 4) c.numFmt = "#,##0"; });

    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="payroll-${month}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return hrError(err, "급여대장을 내보내지 못했습니다.", HR_PENDING_003);
  }
}
