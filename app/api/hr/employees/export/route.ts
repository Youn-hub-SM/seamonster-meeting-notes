import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { EMPLOYEE_COLS, toEmployee, wagesOf } from "@/app/lib/hr-employees";
import { decryptRrn } from "@/app/lib/hr-crypto";
import { PAY_TYPE_LABEL, currentWage, formatRrn, isActiveOn, todayKst, workDaysText } from "@/app/lib/hr";
import { EMP_XLSX_LABELS, INS_BASIS_TEXT, LEAVE_BASIS_TEXT } from "@/app/lib/hr-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;

// POST /api/hr/employees/export — 인사대장 엑셀. { workplace_id?, status: active|left|all, rrn: masked|full }
//  rrn=full 이면 주민등록번호 전체가 파일에 들어가고, 내보낸 사실이 이력에 남는다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { workplace_id?: string; status?: string; rrn?: string };
    const full = body.rrn === "full";
    const status = body.status === "left" || body.status === "all" ? body.status : "active";

    const wp = await hrDb().from("workplaces").select("id,name");
    if (wp.error) throw wp.error;
    const wpName = new Map(((wp.data || []) as { id: string; name: string }[]).map((w) => [w.id, w.name]));

    let q = hrDb().from("employees").select(`${EMPLOYEE_COLS},rrn_enc`).order("hire_date").order("name");
    if (body.workplace_id && /^[0-9a-f-]{36}$/i.test(body.workplace_id)) q = q.eq("workplace_id", body.workplace_id);
    const { data, error } = await q;
    if (error) throw error;
    const today = todayKst();
    const rows = ((data || []) as unknown as Row[]).filter((r) => {
      const active = isActiveOn({ hire_date: String(r.hire_date), leave_date: (r.leave_date as string) || null }, today);
      return status === "all" ? true : status === "active" ? active : !active;
    });
    const wages = await wagesOf(rows.map((r) => String(r.id)));

    if (full) {
      const logged = await hrAudit({ actor: who.name, action: "rrn_export", ip: clientIp(req), targetType: "employee", targetName: `${rows.length}명`, detail: { purpose: "excel", count: rows.length } });
      if (!logged) return hrJson({ ok: false, error: "내보내기 이력을 남기지 못해 주민등록번호 전체는 넣을 수 없습니다." }, 500);
    }

    // 칸은 올리는 양식과 같다(app/lib/hr-import.ts) — 받은 파일을 고쳐 [엑셀 올리기]로 그대로 올릴 수 있다
    const HEAD = EMP_XLSX_LABELS;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("인사대장");
    ws.addRow(HEAD);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    const yn = (b: boolean) => (b ? "가입" : "제외");
    for (const r of rows) {
      const e = toEmployee(r, wages.get(String(r.id)) || []);
      const w = currentWage(e.wages);
      const rrn = full && r.rrn_enc ? formatRrn(decryptRrn(String(r.rrn_enc))) : e.rrn_masked;
      const cells: Record<string, string | number> = {
        "사업장": wpName.get(e.workplace_id) || "", "사번": e.emp_no, "성명": e.name, "주민등록번호": rrn, "생년월일": e.birth_date || "", "성별": e.gender,
        "주소": e.address, "연락처": e.phone, "비상 연락처": e.emergency, "입사일": e.hire_date, "퇴사일": e.leave_date || "", "퇴사 사유": e.leave_reason,
        "부서": e.dept, "직위": e.position, "업무": e.job, "고용 형태": e.emp_type, "계약 시작": e.contract_start || "", "계약 종료": e.contract_end || "",
        "급여 형태": PAY_TYPE_LABEL[e.pay_type], "시급": w?.hourly_wage ?? 0, "월급": w?.monthly_wage ?? 0, "임금 적용 시작일": w?.effective_from || "",
        "소정근로 요일": workDaysText(e.work_days), "출근": e.work_start, "퇴근": e.work_end, "휴게(분)": e.break_min, "하루 시간": e.daily_hours,
        "공제대상가족": e.dependents, "8~20세 자녀": e.children, "원천징수(%)": e.tax_rate,
        "국민연금": yn(e.ins_pension), "건강보험": yn(e.ins_health), "고용보험": yn(e.ins_employment),
        "보험 기준": INS_BASIS_TEXT[e.ins_basis], "기준소득월액": e.pension_base, "보수월액": e.health_base,
        "은행": e.bank, "계좌번호": e.account_no, "예금주": e.account_holder, "연차 기준": LEAVE_BASIS_TEXT[e.leave_basis], "이력": e.career, "메모": e.memo,
      };
      ws.addRow(HEAD.map((l) => cells[l] ?? ""));
    }
    ws.columns.forEach((c, i) => { c.width = ["주소", "이력", "메모", "퇴사 사유"].includes(HEAD[i]) ? 30 : HEAD[i] === "주민등록번호" ? 18 : 13; });
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="employees-${today}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return hrError(err, "인사대장을 내보내지 못했습니다.");
  }
}
