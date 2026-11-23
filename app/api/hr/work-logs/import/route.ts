import { NextRequest } from "next/server";
import { HR_PENDING_002, clientIp, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { ImportError, applyWork, loadSheets, planWork, uploadProblem, workReport } from "@/app/lib/hr-import-db";
import { isMonth } from "@/app/lib/hr-work";
import { refusal } from "@/app/lib/hr-pay-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/hr/work-logs/import — 근무대장 엑셀 올리기(한 달)
//   { month, name, file(base64 .xlsx) }  → 미리보기(직원마다 새로·고침·같음, 읽지 못한 줄)
//   { …, apply: true }                  → 파일을 다시 읽어 대조한 뒤 저장
//  양식 = 그 달의 [엑셀 내려받기] 파일(직원마다 한 시트). 한 시트에 성명 칸이 있는 목록도 읽는다.
//  파일에 있는 날짜만 넣거나 고친다 — 파일에 없는 날은 지우지 않는다. 급여가 확정된 달은 넣지 않는다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { month?: string; name?: string; file?: string; apply?: boolean };
    const month = String(body.month ?? "");
    if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
    const name = String(body.name ?? "").trim().slice(0, 200);
    const b64 = String(body.file ?? "");
    const problem = uploadProblem(name, b64);
    if (problem) return hrJson({ ok: false, error: problem }, 400);

    const plan = await planWork(await loadSheets(b64), month);
    if (body.apply !== true) return hrJson({ ok: true, month, ...workReport(plan) });
    const done = await applyWork(plan, who.name, clientIp(req), name);
    return hrJson({ ok: true, month, ...workReport(plan, done), saved: done.saved });
  } catch (err) {
    if (err instanceof ImportError) return hrJson({ ok: false, error: err.message }, 400);
    return refusal(err) || hrError(err, "근무대장 엑셀을 올리지 못했습니다.", HR_PENDING_002);
  }
}
