import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_003, UUID_RE, buildPayroll, loadBundle, refusal } from "@/app/lib/hr-pay-db";
import { sumResults } from "@/app/lib/hr-pay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/hr/payroll?month=YYYY-MM[&workplace=<id>] — 그 달 그 사업장의 월 급여.
//  작성 중이면 직원·근무대장·임금·요율·세액표·항목과 저장된 입력을 준다(화면이 hr-pay.ts 로 계산해 보여 준다).
//  확정된 달이면 저장된 줄만 준다 — 다시 계산하지 않는다.
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const month = req.nextUrl.searchParams.get("month") || "";
  const workplace = req.nextUrl.searchParams.get("workplace") || "";
  try {
    const b = await loadBundle(month, UUID_RE.test(workplace) ? workplace : "");
    if ("error" in b) return hrJson({ ok: false, error: b.error }, b.status);
    return hrJson({ ok: true, ...b });
  } catch (err) {
    return hrError(err, "급여를 불러오지 못했습니다.", HR_PENDING_003);
  }
}

// PUT /api/hr/payroll — 저장 또는 확정. { workplace_id, month, pay_date, inputs: { <직원 id>: { overrides, extras, memo } }, confirm? }
//  금액은 서버가 다시 계산한다(근무대장·임금·요율·세액표를 지금 값으로 읽는다). confirm 이면 같은 트랜잭션에서 확정하고
//  그 달의 급여와 근무대장이 잠긴다.
export async function PUT(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { workplace_id?: string; month?: string; pay_date?: string; inputs?: unknown; confirm?: boolean };
    const sent = body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs) ? (body.inputs as Record<string, unknown>) : {};
    const built = await buildPayroll({ workplaceId: String(body.workplace_id ?? ""), month: String(body.month ?? ""), payDate: String(body.pay_date ?? ""), sent });
    if (!built.ok) return hrJson({ ok: false, error: built.error }, built.status);
    const confirm = body.confirm === true;

    const { data, error } = await hrDb().rpc("save_payroll", {
      p_workplace: built.wp.id, p_month: body.month, p_pay_date: body.pay_date, p_lines: built.lines, p_fixed: built.fixed, p_confirm: confirm, p_actor: who.name,
    });
    if (error) throw error;
    const t = sumResults(built.results);
    await hrAudit({
      actor: who.name, action: confirm ? "payroll_confirm" : "payroll_save", ip: clientIp(req), targetType: "payroll", targetId: String(data || ""),
      targetName: `${built.wp.name} ${body.month}`, detail: { pay_date: body.pay_date, lines: built.lines.length, pay_total: t.pay_total, deduct_total: t.deduct_total, net_pay: t.net_pay },
    });
    const b = await loadBundle(String(body.month), built.wp.id);
    if ("error" in b) return hrJson({ ok: false, error: b.error }, b.status);
    return hrJson({ ok: true, ...b });
  } catch (err) {
    return refusal(err) || hrError(err, "급여를 저장하지 못했습니다.", HR_PENDING_003);
  }
}

// POST /api/hr/payroll — { action: "unconfirm", id } 확정 취소(작성 중으로). 근무대장 잠금도 풀린다. 이력에 남는다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { action?: string; id?: string };
    const id = String(body.id ?? "");
    if (body.action !== "unconfirm") return hrJson({ ok: false, error: "알 수 없는 요청입니다." }, 400);
    if (!UUID_RE.test(id)) return hrJson({ ok: false, error: "없는 급여입니다." }, 404);
    const head = await hrDb().from("payrolls").select("id,workplace_id,month").eq("id", id).maybeSingle();
    if (head.error) throw head.error;
    if (!head.data) return hrJson({ ok: false, error: "없는 급여입니다." }, 404);
    const h = head.data as unknown as { workplace_id: string; month: string };
    const { error } = await hrDb().rpc("unconfirm_payroll", { p_id: id, p_actor: who.name });
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "payroll_unconfirm", ip: clientIp(req), targetType: "payroll", targetId: id, targetName: h.month });
    const b = await loadBundle(h.month, h.workplace_id);
    if ("error" in b) return hrJson({ ok: false, error: b.error }, b.status);
    return hrJson({ ok: true, ...b });
  } catch (err) {
    return refusal(err) || hrError(err, "확정을 취소하지 못했습니다.", HR_PENDING_003);
  }
}
