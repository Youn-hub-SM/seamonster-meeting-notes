import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_007, fetchHolidays } from "@/app/lib/hr-holidays-db";
import { HOLIDAY_NAME_MAX, fixedHolidaysOf, isYear } from "@/app/lib/hr-holidays";
import { isDate } from "@/app/lib/hr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 공휴일(쉬는 날) 목록 — 근무대장의 [평소대로 채우기]가 이 날을 유급 휴일로 채우고, 연차 사용 등록이 이 날을 건너뛴다.

// GET /api/hr/holidays?year=YYYY — 그 해의 쉬는 날
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const year = Number(req.nextUrl.searchParams.get("year"));
  if (!isYear(year)) return hrJson({ ok: false, error: "해를 고르세요." }, 400);
  try {
    const h = await fetchHolidays(`${year}-01-01`, `${year}-12-31`);
    return hrJson({ ok: true, year, holidays: h.list, pending: h.pending });
  } catch (err) {
    return hrError(err, "공휴일을 불러오지 못했습니다.", HR_PENDING_007);
  }
}

// POST /api/hr/holidays
//   { date, name }                    하루 더하기(이미 있는 날이면 이름만 바꾼다)
//   { action: "fill_fixed", year }    그 해에 날짜가 정해진 공휴일(1/1·3/1·5/1·5/5·6/6·7/17·8/15·10/3·10/9·12/25)을 넣는다 — 이미 있는 날은 그대로
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { action?: string; year?: unknown; date?: unknown; name?: unknown };
    if (body.action === "fill_fixed") {
      const year = Number(body.year);
      if (!isYear(year)) return hrJson({ ok: false, error: "해를 고르세요." }, 400);
      const rows = fixedHolidaysOf(year).map((h) => ({ holiday_date: h.date, name: h.name, seeded: false, created_by: who.name }));
      const { data, error } = await hrDb().from("holidays").upsert(rows, { onConflict: "holiday_date", ignoreDuplicates: true }).select("holiday_date");
      if (error) throw error;
      const added = (data || []).length;
      await hrAudit({ actor: who.name, action: "holiday_fill", ip: clientIp(req), targetType: "holiday", targetName: String(year), detail: { added } });
      return hrJson({ ok: true, added });
    }
    const date = String(body.date ?? "").trim();
    const name = String(body.name ?? "").trim();
    const fields: Record<string, string> = {};
    if (!isDate(date)) fields.date = "날짜를 입력하세요";
    if (!name) fields.name = "이름을 입력하세요";
    else if (name.length > HOLIDAY_NAME_MAX) fields.name = `${HOLIDAY_NAME_MAX}자 이하`;
    if (Object.keys(fields).length > 0) return hrJson({ ok: false, error: "입력을 확인하세요.", fields }, 400);
    const { error } = await hrDb().from("holidays").upsert({ holiday_date: date, name, created_by: who.name }, { onConflict: "holiday_date" });
    if (error) throw error;
    await hrAudit({ actor: who.name, action: "holiday_add", ip: clientIp(req), targetType: "holiday", targetId: date, targetName: name });
    return hrJson({ ok: true, holiday: { date, name } });
  } catch (err) {
    return hrError(err, "공휴일을 저장하지 못했습니다.", HR_PENDING_007);
  }
}

// DELETE /api/hr/holidays?date=YYYY-MM-DD — 쉬는 날에서 뺀다(이미 근무대장에 저장한 '유급 휴일' 줄은 바뀌지 않는다)
export async function DELETE(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const date = req.nextUrl.searchParams.get("date") || "";
  if (!isDate(date)) return hrJson({ ok: false, error: "없는 날짜입니다." }, 404);
  try {
    const { data, error } = await hrDb().from("holidays").delete().eq("holiday_date", date).select("holiday_date,name");
    if (error) throw error;
    const hit = ((data || []) as { name?: string }[])[0];
    if (!hit) return hrJson({ ok: false, error: "목록에 없는 날짜입니다." }, 404);
    await hrAudit({ actor: who.name, action: "holiday_delete", ip: clientIp(req), targetType: "holiday", targetId: date, targetName: String(hit.name || "") });
    return hrJson({ ok: true });
  } catch (err) {
    return hrError(err, "공휴일을 지우지 못했습니다.", HR_PENDING_007);
  }
}
