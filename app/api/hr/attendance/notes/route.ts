import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { isMonth, monthRange } from "@/app/lib/hr-work";
import { HR_PENDING_010, HR_PENDING_011, fetchNotes, parseNote } from "@/app/lib/hr-punch-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;

// GET /api/hr/attendance/notes?month=YYYY-MM — 그 달에 미리 적어 둔 것
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const month = req.nextUrl.searchParams.get("month") || "";
  if (!isMonth(month)) return hrJson({ ok: false, error: "달을 고르세요." }, 400);
  try {
    const { from, to } = monthRange(month);
    return hrJson({ ok: true, notes: await fetchNotes(from, to) });
  } catch (err) {
    return hrError(err, "미리 적은 것을 불러오지 못했습니다.", HR_PENDING_010);
  }
}

// POST /api/hr/attendance/notes — 미리 적기. { employee_id, work_date, kind, in_time?, out_time?, memo? }
//  "오늘 못 찍었어요"·조퇴·결근·병가를 들은 날 적어 둔다(kind: in·out·both·early·absent·sick·etc). 같은 직원·같은 날에 이미 있으면 고친다. 세콤 파일을 넣을 때 그날 줄에 붙는다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const parsed = parseNote((await req.json()) as Record<string, unknown>);
    if (!parsed.ok) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: parsed.fields }, 400);
    const emp = await hrDb().from("employees").select("id,name").eq("id", String(parsed.row.employee_id)).maybeSingle();
    if (emp.error) throw emp.error;
    if (!emp.data) return hrJson({ ok: false, error: "없는 직원입니다." }, 404);
    const { error } = await hrDb().from("punch_notes").upsert({ ...parsed.row, created_by: who.name, created_at: new Date().toISOString() }, { onConflict: "employee_id,work_date" });
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "punch_note", ip: clientIp(req), targetType: "employee", targetId: String(parsed.row.employee_id), targetName: String((emp.data as { name?: string }).name ?? ""), detail: { work_date: parsed.row.work_date, kind: parsed.row.kind, in_time: parsed.row.in_time, out_time: parsed.row.out_time } });
    return hrJson({ ok: true });
  } catch (err) {
    // hr/011 전에는 DB 가 조퇴·결근·병가를 받지 않는다(종류 제약 23514) — 무엇을 적용하면 되는지 알린다
    if (String((err as { code?: string })?.code ?? "") === "23514") return hrJson({ ok: false, pending: true, error: HR_PENDING_011 }, 503);
    return hrError(err, "저장하지 못했습니다.", HR_PENDING_010);
  }
}

// DELETE /api/hr/attendance/notes?id=<id>
export async function DELETE(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!UUID.test(id)) return hrJson({ ok: false, error: "없는 기록입니다." }, 404);
  try {
    const { error } = await hrDb().from("punch_notes").delete().eq("id", id);
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "punch_note_delete", ip: clientIp(req), targetType: "work", targetId: id, targetName: "미리 적기" });
    return hrJson({ ok: true });
  } catch (err) {
    return hrError(err, "지우지 못했습니다.", HR_PENDING_010);
  }
}
