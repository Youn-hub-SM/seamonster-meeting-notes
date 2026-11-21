import { NextRequest } from "next/server";
import { HR_PENDING_002, clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { fetchLogs, fetchRoster, fetchWorkplaces } from "@/app/lib/hr-work-db";
import { isMonth, monthRange, normalizeLog, type WorkLog } from "@/app/lib/hr-work";
import { confirmedWorkplaces, refusal } from "@/app/lib/hr-pay-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;

// GET /api/hr/work-logs?month=YYYY-MM[&employee=<id>] — 그 달의 근무대장.
//  직원(그 달 재직자 또는 지정한 한 명)·사업장·기록(그 달과 겹치는 주를 덮는 범위)을 준다. 주휴·연장 계산은 화면이 같은 함수(hr-work.ts)로 한다.
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const month = req.nextUrl.searchParams.get("month") || "";
  const employee = req.nextUrl.searchParams.get("employee") || "";
  if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
  if (employee && !UUID.test(employee)) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
  try {
    const [workplaces, employees] = await Promise.all([fetchWorkplaces(), fetchRoster(month, employee || undefined)]);
    if (employee && employees.length === 0) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
    // locked = 그 달 급여가 확정된 사업장 — 그 사업장 직원의 근무대장은 고칠 수 없다(hr/003)
    const [logs, locked] = await Promise.all([fetchLogs(month, employees.map((e) => e.id)), confirmedWorkplaces(month)]);
    return hrJson({ ok: true, month, workplaces, employees, logs, locked });
  } catch (err) {
    return hrError(err, "근무대장을 불러오지 못했습니다.", HR_PENDING_002);
  }
}

// PUT /api/hr/work-logs — 한 직원의 한 달을 통째로 저장. { employee_id, month, rows: [...] }
//  보낸 날짜는 넣거나 고치고, 그 달에서 보내지 않은 날짜는 지운다(hr.save_work_logs 한 트랜잭션).
//  시각이 있으면 일한 시간은 서버가 다시 계산한다 — 화면이 보낸 시간을 그대로 믿지 않는다.
export async function PUT(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { employee_id?: string; month?: string; rows?: unknown };
    const employeeId = String(body.employee_id ?? "");
    const month = String(body.month ?? "");
    if (!UUID.test(employeeId)) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
    if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
    if (!Array.isArray(body.rows) || body.rows.length > 31) return hrJson({ ok: false, error: "줄 목록이 올바르지 않습니다." }, 400);

    const [employee] = await fetchRoster(month, employeeId);
    if (!employee) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
    // 급여가 확정된 달은 고치지 않는다(DB 함수도 같은 것을 한 번 더 본다)
    if ((await confirmedWorkplaces(month)).includes(employee.workplace_id)) {
      return hrJson({ ok: false, error: "급여가 확정된 달입니다. 근무대장을 고치려면 급여 확정을 취소하세요." }, 409);
    }

    const { from, to } = monthRange(month);
    const seen = new Set<string>();
    const rows: WorkLog[] = [];
    const rowErrors: Record<string, string> = {}; // 날짜 → 문장
    for (const raw of body.rows as Record<string, unknown>[]) {
      const date = String(raw?.work_date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) return hrJson({ ok: false, error: "이 달 밖의 날짜가 들어 있습니다." }, 400);
      if (seen.has(date)) return hrJson({ ok: false, error: `${date} 이 두 번 들어 있습니다.` }, 400);
      seen.add(date);
      if (date < employee.hire_date) { rowErrors[date] = "입사 전 날짜입니다"; continue; }
      if (employee.leave_date && date > employee.leave_date) { rowErrors[date] = "퇴사 뒤 날짜입니다"; continue; }
      const n = normalizeLog({ ...(raw as Partial<WorkLog>), work_date: date });
      if (!n.ok) rowErrors[date] = n.error; else rows.push(n.log);
    }
    if (Object.keys(rowErrors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", rows: rowErrors }, 400);

    const { data, error } = await hrDb().rpc("save_work_logs", { p_employee: employeeId, p_from: from, p_to: to, p_rows: rows, p_actor: who.name });
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "work_save", ip: clientIp(req), targetType: "employee", targetId: employeeId, targetName: employee.name, detail: { month, rows: rows.length } });

    const logs = await fetchLogs(month, [employeeId]);
    return hrJson({ ok: true, saved: Number(data) || 0, logs });
  } catch (err) {
    return refusal(err) || hrError(err, "근무대장을 저장하지 못했습니다.", HR_PENDING_002);
  }
}
