import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { EMPLOYEE_COLS, applyRrn, parseEmployeeInput, rrnOwner, toEmployee, wagesOf } from "@/app/lib/hr-employees";
import { dataKeyReady } from "@/app/lib/hr-crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;
type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f-]{36}$/i;

// 이력에 값까지 남기지 않는 칸(바뀌었다는 사실만 남긴다)
const QUIET = new Set(["account_no", "rrn_enc", "rrn_hash", "rrn_masked"]);

// GET /api/hr/employees/[id] — 인사기록카드 한 장
export async function GET(req: NextRequest, { params }: Ctx) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const { id } = await params;
  if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
  try {
    const { data, error } = await hrDb().from("employees").select(EMPLOYEE_COLS).eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
    const wages = await wagesOf([id]);
    return hrJson({ ok: true, employee: toEmployee(data as unknown as Row, wages.get(id) || []), keyReady: dataKeyReady() });
  } catch (err) {
    return hrError(err, "직원 정보를 불러오지 못했습니다.");
  }
}

// PATCH /api/hr/employees/[id] — 정보 수정. 임금 칸이 오면 그 적용 시작일의 임금 줄을 넣거나 고친다.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const { id } = await params;
  if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
  try {
    const body = (await req.json()) as Row;
    const before = await hrDb().from("employees").select(EMPLOYEE_COLS).eq("id", id).maybeSingle();
    if (before.error) throw before.error;
    if (!before.data) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
    const old = before.data as unknown as Row;

    const input = parseEmployeeInput(body, true);
    // 보낸 칸만 검증했으므로, 날짜 앞뒤는 저장돼 있던 값과 합쳐서 한 번 더 본다
    const hire = String(input.row.hire_date ?? old.hire_date ?? "");
    const leave = "leave_date" in input.row ? input.row.leave_date : old.leave_date;
    if (typeof leave === "string" && leave && hire && leave < hire) input.errors.leave_date = "퇴사일이 입사일보다 앞입니다";
    if (Object.keys(input.errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: input.errors }, 400);

    const workplaceId = String(input.row.workplace_id ?? old.workplace_id);
    if (input.rrn) {
      if (!dataKeyReady()) return hrJson({ ok: false, error: "주민등록번호를 저장할 수 없습니다. 환경변수 HR_DATA_KEY 를 넣고 다시 배포하세요." }, 503);
      const owner = await rrnOwner(workplaceId, input.rrn.digits, id);
      if (owner) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { rrn: `이미 등록된 번호입니다(${owner})` } }, 409);
    }
    const row: Row = { ...input.row };
    applyRrn(row, input.rrn);

    // 바뀐 칸만 추린다(이력용)
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === "rrn_enc" || k === "rrn_hash") continue;
      const a = JSON.stringify(old[k] ?? null), b = JSON.stringify(v ?? null);
      if (a !== b) changed[k] = QUIET.has(k) ? "변경" : [old[k] ?? null, v ?? null];
    }
    if (input.rrn !== undefined) changed.rrn = input.rrn === null ? "삭제" : "변경";
    delete changed.rrn_masked;

    if (Object.keys(row).length > 0) {
      const { error } = await hrDb().from("employees").update({ ...row, updated_by: who.name, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) {
        if (/employees_emp_no_uq/.test(error.message)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { emp_no: "이미 쓰는 사번입니다" } }, 409);
        if (/employees_rrn_uq/.test(error.message)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { rrn: "이미 등록된 번호입니다" } }, 409);
        throw error;
      }
    }
    if (input.wage) {
      const { error } = await hrDb().from("wages").upsert({ employee_id: id, ...input.wage, created_by: who.name }, { onConflict: "employee_id,effective_from" });
      if (error) throw error;
      changed.wage = input.wage;
    }
    if (Object.keys(changed).length > 0) {
      await hrAudit({ actor: who.name, action: "employee_update", ip: clientIp(req), targetType: "employee", targetId: id, targetName: String(row.name ?? old.name), detail: { changed } });
    }

    const after = await hrDb().from("employees").select(EMPLOYEE_COLS).eq("id", id).single();
    if (after.error) throw after.error;
    const wages = await wagesOf([id]);
    return hrJson({ ok: true, employee: toEmployee(after.data as unknown as Row, wages.get(id) || []), rrnWarn: !!input.rrn?.warn });
  } catch (err) {
    return hrError(err, "직원 정보를 저장하지 못했습니다.");
  }
}

// DELETE /api/hr/employees/[id]?wage=<임금 줄 id> — 잘못 넣은 임금 줄 하나를 지운다(마지막 한 줄은 못 지운다).
//  직원 자체는 지우지 않는다 — 퇴사일을 넣는다(근로자 명부는 퇴직 뒤 3년 보존).
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const { id } = await params;
  const wageId = req.nextUrl.searchParams.get("wage") || "";
  if (!UUID.test(id) || !UUID.test(wageId)) return hrJson({ ok: false, error: "지울 임금 줄을 고르세요." }, 400);
  try {
    const { data, error } = await hrDb().from("wages").select("id,effective_from,hourly_wage,monthly_wage").eq("employee_id", id);
    if (error) throw error;
    const rows = (data || []) as Row[];
    const hit = rows.find((r) => String(r.id) === wageId);
    if (!hit) return hrJson({ ok: false, error: "없는 임금 줄입니다." }, 404);
    if (rows.length <= 1) return hrJson({ ok: false, error: "임금 줄이 하나뿐이라 지울 수 없습니다. 금액을 고치세요." }, 400);
    const del = await hrDb().from("wages").delete().eq("id", wageId).eq("employee_id", id);
    if (del.error) throw del.error;
    await hrAudit({ actor: who.name, action: "wage_delete", ip: clientIp(req), targetType: "employee", targetId: id, detail: { wage: hit } });
    return hrJson({ ok: true });
  } catch (err) {
    return hrError(err, "임금 줄을 지우지 못했습니다.");
  }
}
