import { NextRequest } from "next/server";
import { hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { todayKst } from "@/app/lib/hr";
import { HR_PENDING_003 } from "@/app/lib/hr-pay-db";
import { loadSeverance, severanceEmployees } from "@/app/lib/hr-severance-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;

// GET /api/hr/severance                         — 고를 직원 목록(퇴사자 포함)
// GET /api/hr/severance?employee=<id>[&last=]   — 그 직원의 퇴직금 계산 자료(퇴직 전 1년의 저장된 급여·통상임금).
//  last = 마지막 근무일(없으면 인사대장의 퇴사일, 그것도 없으면 오늘 — 재직자의 예상 금액).
//  읽기만 한다. 금액 계산은 화면이 hr-severance.ts 로 한다(구간 임금을 화면에서 고칠 수 있다).
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const employee = req.nextUrl.searchParams.get("employee") || "";
  try {
    if (!employee) return hrJson({ ok: true, today: todayKst(), employees: await severanceEmployees() });
    if (!UUID.test(employee)) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
    const b = await loadSeverance(employee, req.nextUrl.searchParams.get("last") || "", todayKst());
    if ("error" in b) return hrJson({ ok: false, error: b.error }, b.status);
    return hrJson({ ok: true, ...b });
  } catch (err) {
    return hrError(err, "퇴직금 자료를 불러오지 못했습니다.", HR_PENDING_003);
  }
}
