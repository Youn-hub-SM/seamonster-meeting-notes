import { NextRequest } from "next/server";
import { clientIp, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { ImportError, applyPayroll, loadSheets, payrollReport, planPayroll, uploadProblem } from "@/app/lib/hr-import-db";
import { HR_PENDING_003, UUID_RE, refusal } from "@/app/lib/hr-pay-db";
import { isMonth } from "@/app/lib/hr-work";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/hr/payroll/import — 급여대장 엑셀 올리기(한 사업장의 한 달)
//   { workplace_id, month, name, file(base64 .xlsx) }  → 미리보기(직원마다 고친 칸·다시 계산된 칸·합계가 어떻게 바뀌는지)
//   { …, apply: true }                                 → 파일을 다시 읽어 대조한 뒤 저장([변경 저장]과 같다 — 확정은 하지 않는다)
//  양식 = 그 달의 [엑셀 내려받기] 파일. 저장된 급여와 다른 칸만 반영한다(손대지 않은 칸은 자동 계산을 따른다).
//  확정된 달·다른 달이나 사업장의 파일은 받지 않는다. 오류가 한 줄이라도 있으면 아무것도 저장하지 않는다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { workplace_id?: string; month?: string; name?: string; file?: string; apply?: boolean };
    const workplaceId = String(body.workplace_id ?? ""), month = String(body.month ?? "");
    if (!UUID_RE.test(workplaceId)) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
    if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
    const name = String(body.name ?? "").trim().slice(0, 200);
    const b64 = String(body.file ?? "");
    const problem = uploadProblem(name, b64);
    if (problem) return hrJson({ ok: false, error: problem }, 400);

    const plan = await planPayroll(await loadSheets(b64), workplaceId, month);
    if (body.apply !== true) return hrJson({ ok: true, month, ...payrollReport(plan) });
    const done = await applyPayroll(plan, who.name, clientIp(req), name);
    return hrJson({ ok: true, month, ...payrollReport(plan, done), saved: done.saved });
  } catch (err) {
    if (err instanceof ImportError) return hrJson({ ok: false, error: err.message }, 400);
    return refusal(err) || hrError(err, "급여대장 엑셀을 올리지 못했습니다.", HR_PENDING_003);
  }
}
