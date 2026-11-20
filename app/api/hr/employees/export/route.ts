import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { EMPLOYEE_COLS, toEmployee, wagesOf } from "@/app/lib/hr-employees";
import { decryptRrn } from "@/app/lib/hr-crypto";
import { PAY_TYPE_LABEL, currentWage, formatRrn, isActiveOn, todayKst, workDaysText } from "@/app/lib/hr";

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

    const HEAD = ["사업장", "사번", "성명", "주민등록번호", "생년월일", "성별", "주소", "연락처", "비상 연락처", "입사일", "퇴사일", "퇴사 사유",
      "부서", "직위", "업무", "고용 형태", "계약 시작", "계약 종료", "급여 형태", "시급", "월급", "소정근로 요일", "출근", "퇴근", "휴게(분)", "하루 시간",
      "공제대상가족", "8~20세 자녀", "원천징수(%)", "국민연금", "건강보험", "고용보험", "기준소득월액", "보수월액", "은행", "계좌번호", "예금주", "이력", "메모"];
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
      ws.addRow([wpName.get(e.workplace_id) || "", e.emp_no, e.name, rrn, e.birth_date || "", e.gender, e.address, e.phone, e.emergency,
        e.hire_date, e.leave_date || "", e.leave_reason, e.dept, e.position, e.job, e.emp_type, e.contract_start || "", e.contract_end || "",
        PAY_TYPE_LABEL[e.pay_type], w?.hourly_wage ?? 0, w?.monthly_wage ?? 0, workDaysText(e.work_days), e.work_start, e.work_end, e.break_min, e.daily_hours,
        e.dependents, e.children, e.tax_rate, yn(e.ins_pension), yn(e.ins_health), yn(e.ins_employment), e.pension_base, e.health_base,
        e.bank, e.account_no, e.account_holder, e.career, e.memo]);
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
