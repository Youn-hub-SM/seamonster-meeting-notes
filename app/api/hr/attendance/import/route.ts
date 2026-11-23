import { NextRequest } from "next/server";
import { clientIp, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { ImportError, loadSheets, uploadProblem } from "@/app/lib/hr-import-db";
import { isMonth } from "@/app/lib/hr-work";
import { refusal } from "@/app/lib/hr-pay-db";
import { HR_PENDING_010, applyPunch, planPunch } from "@/app/lib/hr-punch-db";
import { PUNCH_ACTIONS, type PunchDecision } from "@/app/lib/hr-punch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// 화면이 보낸 '처리 고르기'만 받는다(키 = 직원|날짜). 모양이 맞지 않는 것은 버린다 — 시각·종류는 서버가 다시 검사한다.
function readDecisions(raw: unknown): Record<string, PunchDecision> {
  const out: Record<string, PunchDecision> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 5000)) {
    if (!/^[0-9a-f-]{36}\|\d{4}-\d{2}-\d{2}$/i.test(k) || !v || typeof v !== "object") continue;
    const d = v as Record<string, unknown>;
    if (!(PUNCH_ACTIONS as readonly string[]).includes(String(d.action))) continue;
    out[k] = {
      action: d.action as PunchDecision["action"],
      start: typeof d.start === "string" ? d.start : undefined, end: typeof d.end === "string" ? d.end : undefined,
      break_min: d.break_min == null || d.break_min === "" ? undefined : Number(d.break_min),
    };
  }
  return out;
}

// POST /api/hr/attendance/import — 세콤 출근 기록 넣기(한 달)
//   { month, name, file(base64 .xlsx), overwrite?, decisions? }  → 미리보기: 이름 짝, 자동으로 넣을 날, 확인할 줄
//   { …, apply: true }                                           → 파일을 다시 읽어 다시 계산한 뒤 근무대장에 넣는다
//  짝을 정하지 않은 이름이나 정하지 않은 확인할 줄이 있으면 넣지 않는다(blocked). 이미 적힌 날은 그대로 둔다(overwrite 면 덮는다 — 연차는 그대로).
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { month?: string; name?: string; file?: string; apply?: boolean; overwrite?: boolean; decisions?: unknown };
    const month = String(body.month ?? "");
    if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
    const name = String(body.name ?? "").trim().slice(0, 200);
    const b64 = String(body.file ?? "");
    const problem = uploadProblem(name, b64);
    if (problem) return hrJson({ ok: false, error: problem }, 400);

    const plan = await planPunch(await loadSheets(b64), month, { overwrite: body.overwrite === true, decisions: readDecisions(body.decisions) });
    if (body.apply !== true) return hrJson({ ok: true, ...plan.report });
    if (plan.report.blocked) return hrJson({ ok: false, error: plan.report.blocked }, 400);
    const done = await applyPunch(plan, who.name, clientIp(req), name);
    return hrJson({ ok: true, ...plan.report, applied: true, failed: done.failed, saved: done.saved });
  } catch (err) {
    if (err instanceof ImportError) return hrJson({ ok: false, error: err.message }, 400);
    return refusal(err) || hrError(err, "세콤 출근 기록을 넣지 못했습니다.", HR_PENDING_010);
  }
}
