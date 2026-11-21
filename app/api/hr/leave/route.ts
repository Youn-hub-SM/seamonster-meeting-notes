import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { isDate, todayKst } from "@/app/lib/hr";
import { addDays, normalizeLog, weekdayOf, type WorkLog } from "@/app/lib/hr-work";
import { GRANT_COLS, HR_PENDING_004, ensureAutoGrants, fetchGrants, fetchLeaveEmployees, fetchLeaveLogs, fetchLeaveWorkplaces, fetchLogsBetween, leaverCompare, toGrant } from "@/app/lib/hr-leave-db";
import { refusal } from "@/app/lib/hr-pay-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f-]{36}$/i;
const SINCE_DAYS = 1100; // 사용·결근을 읽는 범위(3년) — 지금 유효한 발생 건과 앞 1년 출근율을 덮는다
const quarter = (n: number) => Number.isFinite(n) && Math.abs(n * 4 - Math.round(n * 4)) < 1e-9;

// GET /api/hr/leave — 연차 현황. 열 때마다 "오늘까지 생겼어야 할 자동 발생 건"을 넣는다(없는 것만, 한 번만).
//  ?history=1 이면 연차 이력(누가 언제 무엇을)만.
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    if (req.nextUrl.searchParams.get("history")) {
      const { data, error } = await hrDb().from("audit_log").select("id,at,actor,action,target_name,detail").like("action", "leave_%").order("at", { ascending: false }).limit(200);
      if (error) throw error;
      return hrJson({ ok: true, history: data || [] });
    }
    const today = todayKst();
    const [workplaces, employees] = await Promise.all([fetchLeaveWorkplaces(), fetchLeaveEmployees(today)]);
    const ids = employees.map((e) => e.id);
    const [grants, logs] = await Promise.all([fetchGrants(ids), fetchLeaveLogs(ids, addDays(today, -SINCE_DAYS))]);
    const added = await ensureAutoGrants(employees, workplaces, grants, logs.absences, today, who.name);
    if (added.length > 0) await hrAudit({ actor: who.name, action: "leave_auto", ip: clientIp(req), targetType: "leave", targetName: `자동 발생 ${added.length}건`, detail: { count: added.length } });
    return hrJson({ ok: true, today, workplaces, employees, grants: [...grants, ...added], uses: logs.uses, compare: leaverCompare(employees, workplaces, logs.absences, today), added: added.length });
  } catch (err) {
    return hrError(err, "연차를 불러오지 못했습니다.", HR_PENDING_004);
  }
}

// POST /api/hr/leave — { action }
//   grant      { employee_id, days, grant_date, expire_date?, reason }  직접 추가(음수 = 빼기)
//   use        { employee_id, from, to, part }                         사용 등록 — 근무대장에 연차 줄을 넣는다(소정근로일만)
//   cancel_use { employee_id, date }                                   사용 취소 — 그 줄을 지우거나(연차), 반차·반반차를 없앤다(근무한 날)
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as Row;
    const employeeId = String(body.employee_id ?? "");
    if (!UUID.test(employeeId)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { employee_id: "직원을 고르세요" } }, 400);
    const [e] = await fetchLeaveEmployees(todayKst(), employeeId);
    if (!e) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);

    if (body.action === "grant") {
      const errors: Record<string, string> = {};
      const days = Number(body.days);
      if (!quarter(days) || days === 0 || Math.abs(days) > 100) errors.days = "일수는 0.25 단위(빼려면 음수)";
      const grantDate = String(body.grant_date ?? "");
      if (!isDate(grantDate)) errors.grant_date = "발생일을 입력하세요";
      const expire = String(body.expire_date ?? "").trim();
      if (expire && !isDate(expire)) errors.expire_date = "만료일이 날짜가 아닙니다";
      else if (expire && isDate(grantDate) && expire < grantDate) errors.expire_date = "만료일이 발생일보다 앞입니다";
      const reason = String(body.reason ?? "").trim().slice(0, 200);
      if (!reason) errors.reason = "사유를 입력하세요";
      if (Object.keys(errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: errors }, 400);
      const { data, error } = await hrDb().from("leave_grants")
        .insert({ employee_id: e.id, grant_date: grantDate, expire_date: expire || null, days, kind: "manual", reason, created_by: who.name, updated_by: who.name })
        .select(GRANT_COLS).single();
      if (error) throw error;
      const grant = toGrant(data as unknown as Row);
      await hrAudit({ actor: who.name, action: "leave_grant", ip: clientIp(req), targetType: "leave", targetId: grant.id, targetName: e.name, detail: { days, grant_date: grantDate, expire_date: expire || null, reason } });
      return hrJson({ ok: true, grant });
    }

    if (body.action === "use") {
      const from = String(body.from ?? ""), to = String(body.to ?? "") || from;
      const part = Number(body.part);
      const errors: Record<string, string> = {};
      if (!isDate(from)) errors.from = "시작일을 입력하세요";
      if (!isDate(to)) errors.to = "종료일을 입력하세요";
      else if (isDate(from) && to < from) errors.to = "종료일이 시작일보다 앞입니다";
      else if (isDate(from) && addDays(from, 62) < to) errors.to = "한 번에 두 달까지 넣을 수 있습니다";
      if (![1, 0.5, 0.25].includes(part)) errors.part = "종류를 고르세요";
      if (Object.keys(errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: errors }, 400);

      const logs = await fetchLogsBetween(e.id, from, to);
      const done: string[] = [], skipped: { date: string; reason: string }[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (!e.work_days.includes(weekdayOf(d))) continue;                       // 소정근로일이 아닌 날은 연차를 쓰지 않는다
        if (d < e.hire_date || (e.leave_date && d > e.leave_date)) { skipped.push({ date: d, reason: "재직 기간이 아님" }); continue; }
        const cur = logs.get(d);
        let row: WorkLog | null = null;
        if (!cur || cur.kind === "leave") {
          const n = normalizeLog({ work_date: d, kind: "leave", leave_days: part, memo: cur?.memo || "" });
          if (n.ok) row = n.log;
        } else if (cur.kind === "work" && part < 1) row = { ...cur, leave_days: part };
        if (!row) { skipped.push({ date: d, reason: cur?.kind === "work" ? "근무 기록이 있는 날 — 근무대장에서 고치세요" : "다른 기록이 있는 날" }); continue; }
        const { error } = await hrDb().rpc("save_work_logs", { p_employee: e.id, p_from: d, p_to: d, p_rows: [row], p_actor: who.name });
        if (error) {
          if ((error as { code?: string }).code !== "P0001") throw error;
          skipped.push({ date: d, reason: error.message });
          continue;
        }
        done.push(d);
      }
      if (done.length > 0) await hrAudit({ actor: who.name, action: "leave_use", ip: clientIp(req), targetType: "leave", targetId: e.id, targetName: e.name, detail: { from, to, part, days: done.length * part, dates: done.length } });
      if (done.length === 0) return hrJson({ ok: false, error: skipped[0] ? `등록한 날이 없습니다 — ${skipped[0].date} ${skipped[0].reason}` : "그 기간에 소정근로일이 없습니다." }, 400);
      return hrJson({ ok: true, done, skipped, uses: done.map((d) => ({ employee_id: e.id, work_date: d, days: part, kind: logs.get(d)?.kind === "work" ? "work" : "leave" })) });
    }

    if (body.action === "cancel_use") {
      const date = String(body.date ?? "");
      if (!isDate(date)) return hrJson({ ok: false, error: "날짜가 올바르지 않습니다." }, 400);
      const cur = (await fetchLogsBetween(e.id, date, date)).get(date);
      if (!cur || !(cur.leave_days > 0)) return hrJson({ ok: false, error: "그 날의 연차 기록이 없습니다. 새로 고치세요." }, 404);
      const rows = cur.kind === "leave" ? [] : [{ ...cur, leave_days: 0 }];
      const { error } = await hrDb().rpc("save_work_logs", { p_employee: e.id, p_from: date, p_to: date, p_rows: rows, p_actor: who.name });
      if (error) throw error;
      await hrAudit({ actor: who.name, action: "leave_use_cancel", ip: clientIp(req), targetType: "leave", targetId: e.id, targetName: e.name, detail: { date, days: cur.leave_days } });
      return hrJson({ ok: true });
    }
    return hrJson({ ok: false, error: "알 수 없는 요청입니다." }, 400);
  } catch (err) {
    return refusal(err) || hrError(err, "연차를 저장하지 못했습니다.", HR_PENDING_004);
  }
}

// PATCH /api/hr/leave — 발생 건 수정 { id, days?, expire_date?, reason?, voided? }
//  자동 발생 건도 일수·만료일·사유를 고칠 수 있고, 없던 것으로 할 수 있다(voided). 발생일과 열쇠는 그대로 — 다시 생기지 않는다.
export async function PATCH(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as Row;
    const id = String(body.id ?? "");
    if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 발생 건입니다." }, 404);
    const cur = await hrDb().from("leave_grants").select(GRANT_COLS).eq("id", id).maybeSingle();
    if (cur.error) throw cur.error;
    if (!cur.data) return hrJson({ ok: false, error: "없는 발생 건입니다." }, 404);
    const before = toGrant(cur.data as unknown as Row);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const row: Row = {}, errors: Record<string, string> = {};
    if (has("days")) {
      const days = Number(body.days);
      if (!Number.isFinite(days) || Math.abs(days) > 100 || days === 0 || Math.round(days * 100) !== days * 100) errors.days = "일수를 확인하세요";
      else if (before.kind !== "manual" && days < 0) errors.days = "자동 발생 건은 0보다 커야 합니다";
      else row.days = days;
    }
    if (has("expire_date")) {
      const v = String(body.expire_date ?? "").trim();
      if (v && !isDate(v)) errors.expire_date = "만료일이 날짜가 아닙니다";
      else if (v && v < before.grant_date) errors.expire_date = "만료일이 발생일보다 앞입니다";
      else row.expire_date = v || null;
    }
    if (has("reason")) row.reason = String(body.reason ?? "").trim().slice(0, 200);
    if (has("voided")) row.voided = !!body.voided;
    if (Object.keys(errors).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: errors }, 400);
    if (Object.keys(row).length === 0) return hrJson({ ok: false, error: "바꿀 내용이 없습니다." }, 400);
    const { data, error } = await hrDb().from("leave_grants").update({ ...row, updated_by: who.name, updated_at: new Date().toISOString() }).eq("id", id).select(GRANT_COLS).single();
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "leave_grant_update", ip: clientIp(req), targetType: "leave", targetId: id, targetName: before.reason || before.grant_date, detail: { before: { days: before.days, expire_date: before.expire_date, voided: before.voided }, changed: row } });
    return hrJson({ ok: true, grant: toGrant(data as unknown as Row) });
  } catch (err) {
    return hrError(err, "발생 건을 저장하지 못했습니다.", HR_PENDING_004);
  }
}

// DELETE /api/hr/leave?id= — 직접 추가한 건만 지운다(자동 발생 건은 지우면 다시 생기므로 '없던 것으로' 한다)
export async function DELETE(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 발생 건입니다." }, 404);
  try {
    const cur = await hrDb().from("leave_grants").select(GRANT_COLS).eq("id", id).maybeSingle();
    if (cur.error) throw cur.error;
    if (!cur.data) return hrJson({ ok: false, error: "없는 발생 건입니다." }, 404);
    const g = toGrant(cur.data as unknown as Row);
    if (g.kind !== "manual") return hrJson({ ok: false, error: "자동 발생 건은 지울 수 없습니다. [발생 건 수정]에서 없던 것으로 하세요." }, 400);
    const { error } = await hrDb().from("leave_grants").delete().eq("id", id);
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "leave_grant_delete", ip: clientIp(req), targetType: "leave", targetId: id, targetName: g.reason || g.grant_date, detail: { days: g.days, grant_date: g.grant_date, expire_date: g.expire_date, employee_id: g.employee_id } });
    return hrJson({ ok: true });
  } catch (err) {
    return hrError(err, "발생 건을 지우지 못했습니다.", HR_PENDING_004);
  }
}
