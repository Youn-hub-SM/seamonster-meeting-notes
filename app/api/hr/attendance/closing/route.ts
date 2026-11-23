import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { isMonth } from "@/app/lib/hr-work";
import { confirmedWorkplaces } from "@/app/lib/hr-pay-db";
import { HR_PENDING_010, closingBlockers, fetchClosings } from "@/app/lib/hr-punch-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;

// GET /api/hr/attendance/closing?month=YYYY-MM — 그 달에 근무대장을 확정한 사업장. ready = 확정 기능이 있는가(hr/010)
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const month = req.nextUrl.searchParams.get("month") || "";
  if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
  try {
    return hrJson({ ok: true, ...(await fetchClosings(month)) });
  } catch (err) {
    return hrError(err, "근무대장 확정을 불러오지 못했습니다.", HR_PENDING_010);
  }
}

// POST /api/hr/attendance/closing — { workplace_id, month, close }
//   close: true   근무대장 확정. 시급제 직원에게 '입력 전'인 날이 남아 있으면 거절한다. 확정하면 그 달 근무대장은 잠기고 급여를 저장할 수 있다.
//   close: false  확정 취소. 그 달 급여가 확정돼 있으면 거절한다(급여 확정을 먼저 취소).
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { workplace_id?: string; month?: string; close?: boolean };
    const workplaceId = String(body.workplace_id ?? ""), month = String(body.month ?? "");
    if (!UUID.test(workplaceId)) return hrJson({ ok: false, error: "사업장을 고르세요." }, 400);
    if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
    if (typeof body.close !== "boolean") return hrJson({ ok: false, error: "알 수 없는 요청입니다." }, 400);
    const wp = await hrDb().from("workplaces").select("id,name").eq("id", workplaceId).maybeSingle();
    if (wp.error) throw wp.error;
    if (!wp.data) return hrJson({ ok: false, error: "없는 사업장입니다." }, 404);
    const name = String((wp.data as { name?: string }).name ?? "");
    // 확정 표가 아직 없으면(hr/010 전) 다른 까닭을 대기 전에 그것부터 알린다
    if (!(await fetchClosings(month)).ready) return hrJson({ ok: false, pending: true, error: HR_PENDING_010 }, 503);

    if (body.close === false) {
      if ((await confirmedWorkplaces(month)).includes(workplaceId)) return hrJson({ ok: false, error: "급여가 확정된 달입니다. 급여 확정을 먼저 취소하세요." }, 409);
      const { error } = await hrDb().from("work_closings").delete().eq("workplace_id", workplaceId).eq("month", month);
      if (error) throw error;
      await hrAudit({ actor: who.name, action: "work_unclose", ip: clientIp(req), targetType: "work", targetId: workplaceId, targetName: `${name} ${month}`, detail: { month } });
      return hrJson({ ok: true, ...(await fetchClosings(month)) });
    }

    const left = await closingBlockers(workplaceId, month);
    if (left.length > 0) {
      const total = left.reduce((t, x) => t + x.days, 0);
      return hrJson({ ok: false, error: `입력 전인 날이 ${total}일 남았습니다(${left.slice(0, 5).map((x) => `${x.name} ${x.days}일`).join(", ")}${left.length > 5 ? ` 외 ${left.length - 5}명` : ""}). 모두 넣은 뒤 확정하세요.` }, 409);
    }
    const { error } = await hrDb().from("work_closings").upsert({ workplace_id: workplaceId, month, closed_by: who.name, closed_at: new Date().toISOString() }, { onConflict: "workplace_id,month" });
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "work_close", ip: clientIp(req), targetType: "work", targetId: workplaceId, targetName: `${name} ${month}`, detail: { month } });
    return hrJson({ ok: true, ...(await fetchClosings(month)) });
  } catch (err) {
    return hrError(err, "근무대장 확정을 바꾸지 못했습니다.", HR_PENDING_010);
  }
}
