import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_006, applyRrn, parseEmployeeInput, readEmployees, rrnOwner, toEmployee, wagesOf, writeEmployee } from "@/app/lib/hr-employees";
import { dataKeyReady } from "@/app/lib/hr-crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;

// GET /api/hr/employees — 인사대장 전체(재직·퇴사). 주민등록번호는 가림 표기만 나간다.
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const { data, error } = await readEmployees((cols) => hrDb().from("employees").select(cols).order("hire_date", { ascending: true }).order("name", { ascending: true }));
    if (error) throw error;
    const rows = (data || []) as unknown as Row[];
    const wages = await wagesOf(rows.map((r) => String(r.id)));
    return hrJson({ ok: true, employees: rows.map((r) => toEmployee(r, wages.get(String(r.id)) || [])), keyReady: dataKeyReady() });
  } catch (err) {
    return hrError(err, "인사대장을 불러오지 못했습니다.");
  }
}

// POST /api/hr/employees — 직원 등록(+ 첫 임금 줄)
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as Row;
    const input = parseEmployeeInput(body, false);
    if (!input.wage && !input.errors.hourly_wage && !input.errors.monthly_wage && !input.errors.wage_from) {
      input.errors.hourly_wage = "임금을 입력하세요";
    }
    if (Object.keys(input.errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: input.errors }, 400);

    if (input.rrn) {
      if (!dataKeyReady()) return hrJson({ ok: false, error: "주민등록번호를 저장할 수 없습니다. 환경변수 HR_DATA_KEY 를 넣고 다시 배포하세요." }, 503);
      const owner = await rrnOwner(String(input.row.workplace_id), input.rrn.digits);
      if (owner) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { rrn: `이미 등록된 번호입니다(${owner})` } }, 409);
    }
    const row: Row = { ...input.row, created_by: who.name, updated_by: who.name };
    applyRrn(row, input.rrn);

    const { data, error } = await writeEmployee(row, (r, cols) => hrDb().from("employees").insert(r).select(cols).single());
    if (error) {
      if (error.code === "HR006") return hrJson({ ok: false, pending: true, error: HR_PENDING_006 }, 503);
      if (/employees_emp_no_uq/.test(String(error.message))) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { emp_no: "이미 쓰는 사번입니다" } }, 409);
      if (/employees_rrn_uq/.test(String(error.message))) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { rrn: "이미 등록된 번호입니다" } }, 409);
      throw error;
    }
    const saved = data as unknown as Row;
    const id = String(saved.id);

    const w = await hrDb().from("wages").insert({ employee_id: id, ...input.wage, created_by: who.name });
    if (w.error) {
      await hrDb().from("employees").delete().eq("id", id); // 임금 줄 없는 직원이 남지 않게 되돌린다
      throw w.error;
    }
    await hrAudit({ actor: who.name, action: "employee_create", ip: clientIp(req), targetType: "employee", targetId: id, targetName: String(saved.name), detail: { rrn: input.rrn ? "입력" : "없음" } });

    const wages = await wagesOf([id]);
    return hrJson({ ok: true, employee: toEmployee(saved, wages.get(id) || []), rrnWarn: !!input.rrn?.warn });
  } catch (err) {
    return hrError(err, "직원을 등록하지 못했습니다.");
  }
}
