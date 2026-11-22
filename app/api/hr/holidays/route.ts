import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_007, HR_PENDING_008, fetchHolidayWorkplaces, fetchHolidays, missingHolidayCols } from "@/app/lib/hr-holidays-db";
import { HOLIDAY_NAME_MAX, fixedHolidaysOf, isHolidayKind, isYear, type HolidayWorkplace } from "@/app/lib/hr-holidays";
import { isDate } from "@/app/lib/hr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 쉬는 날(공휴일·휴무일) 목록 — 근무대장의 [평소대로 채우기]가 이 날을 유급 휴일·무급 휴무로 채우고, 연차 사용 등록이 이 날을 건너뛴다.

const UUID = /^[0-9a-f-]{36}$/i;
type DbErr = { message?: string; code?: string } | null;

// GET /api/hr/holidays?year=YYYY — 그 해의 쉬는 날 + 적용 범위를 고를 사업장·소속
//  extended = 구분·적용 범위를 쓸 수 있다(hr/008 적용)
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const year = Number(req.nextUrl.searchParams.get("year"));
  if (!isYear(year)) return hrJson({ ok: false, error: "해를 고르세요." }, 400);
  try {
    const h = await fetchHolidays(`${year}-01-01`, `${year}-12-31`);
    const workplaces: HolidayWorkplace[] = h.extended ? await fetchHolidayWorkplaces() : [];
    return hrJson({ ok: true, year, holidays: h.list, pending: h.pending, extended: h.extended, workplaces });
  } catch (err) {
    return hrError(err, "공휴일을 불러오지 못했습니다.", HR_PENDING_007);
  }
}

// POST /api/hr/holidays
//   { date, name, kind?, workplace_id?, affiliation? }   하루 더하기. 같은 날·같은 적용 범위의 줄이 있으면 이름과 구분만 바꾼다
//   { action: "fill_fixed", year }                       그 해에 날짜가 정해진 공휴일(1/1·3/1·5/1·5/5·6/6·7/17·8/15·10/3·10/9·12/25)을 넣는다 — 이미 있는 날은 그대로
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { action?: string; year?: unknown; date?: unknown; name?: unknown; kind?: unknown; workplace_id?: unknown; affiliation?: unknown };
    if (body.action === "fill_fixed") {
      const year = Number(body.year);
      if (!isYear(year)) return hrJson({ ok: false, error: "해를 고르세요." }, 400);
      const cur = await fetchHolidays(`${year}-01-01`, `${year}-12-31`);
      if (cur.pending) return hrJson({ ok: false, pending: true, error: HR_PENDING_007 }, 503);
      // 전체에 적용되는 줄이 이미 있는 날은 건너뛴다(사업장·소속만의 휴무일은 공휴일 자리를 막지 않는다)
      const have = new Set(cur.list.filter((h) => !h.workplace_id).map((h) => h.date));
      const rows = fixedHolidaysOf(year).filter((h) => !have.has(h.date)).map((h) => ({ holiday_date: h.date, name: h.name, seeded: false, created_by: who.name }));
      if (rows.length > 0) {
        const { error } = await hrDb().from("holidays").insert(rows);
        if (error) throw error;
      }
      await hrAudit({ actor: who.name, action: "holiday_fill", ip: clientIp(req), targetType: "holiday", targetName: String(year), detail: { added: rows.length } });
      return hrJson({ ok: true, added: rows.length });
    }

    const date = String(body.date ?? "").trim();
    const name = String(body.name ?? "").trim();
    const kindRaw = body.kind == null || body.kind === "" ? "public" : body.kind;
    const workplaceId = String(body.workplace_id ?? "").trim();
    const affiliation = String(body.affiliation ?? "").trim();
    const fields: Record<string, string> = {};
    if (!isDate(date)) fields.date = "날짜를 입력하세요";
    if (!name) fields.name = "이름을 입력하세요";
    else if (name.length > HOLIDAY_NAME_MAX) fields.name = `${HOLIDAY_NAME_MAX}자 이하`;
    if (!isHolidayKind(kindRaw)) fields.kind = "구분을 고르세요";
    if (workplaceId && !UUID.test(workplaceId)) fields.scope = "적용 범위를 고르세요";
    else if (affiliation && !workplaceId) fields.scope = "적용 범위를 고르세요";
    if (Object.keys(fields).length > 0 || !isHolidayKind(kindRaw)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields }, 400);
    const kind = kindRaw;

    if (workplaceId) {
      const wp = (await fetchHolidayWorkplaces()).find((w) => w.id === workplaceId);
      if (!wp) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { scope: "없는 사업장입니다" } }, 400);
      if (affiliation && !wp.affiliations.includes(affiliation)) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { scope: "그 사업장에 없는 소속입니다" } }, 400);
    }

    // 같은 날·같은 적용 범위의 줄을 찾는다. 구분·적용 범위 칸이 없으면(hr/008 미적용) 옛 방식(날짜 하나에 한 줄)으로.
    let find = hrDb().from("holidays").select("id").eq("holiday_date", date).eq("affiliation", affiliation);
    find = workplaceId ? find.eq("workplace_id", workplaceId) : find.is("workplace_id", null);
    const cur: { data: unknown; error: DbErr } = await find.maybeSingle();
    if (cur.error && missingHolidayCols(cur.error)) {
      if (kind !== "public" || workplaceId) return hrJson({ ok: false, pending: true, error: HR_PENDING_008 }, 503);
      const { error } = await hrDb().from("holidays").upsert({ holiday_date: date, name, created_by: who.name }, { onConflict: "holiday_date" });
      if (error) throw error;
    } else {
      if (cur.error) throw cur.error;
      const hit = cur.data as { id?: string } | null;
      const { error } = hit?.id
        ? await hrDb().from("holidays").update({ name, kind }).eq("id", hit.id)
        : await hrDb().from("holidays").insert({ holiday_date: date, name, kind, workplace_id: workplaceId || null, affiliation, created_by: who.name });
      if (error) throw error;
    }
    await hrAudit({ actor: who.name, action: "holiday_add", ip: clientIp(req), targetType: "holiday", targetId: date, targetName: name, detail: { kind, workplace_id: workplaceId || null, affiliation } });
    return hrJson({ ok: true, holiday: { date, name, kind, workplace_id: workplaceId || null, affiliation } });
  } catch (err) {
    return hrError(err, "공휴일을 저장하지 못했습니다.", HR_PENDING_007);
  }
}

// DELETE /api/hr/holidays?id= — 쉬는 날에서 뺀다(이미 근무대장에 저장한 줄은 바뀌지 않는다)
//  id 가 날짜 모양이면(hr/008 전의 줄 — 날짜 하나에 한 줄) 그 날짜의 전체 적용 줄을 지운다.
export async function DELETE(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const id = req.nextUrl.searchParams.get("id") || req.nextUrl.searchParams.get("date") || "";
  if (!UUID.test(id) && !isDate(id)) return hrJson({ ok: false, error: "목록에 없는 날짜입니다." }, 404);
  try {
    let res: { data: unknown; error: DbErr };
    if (UUID.test(id)) res = await hrDb().from("holidays").delete().eq("id", id).select("holiday_date,name");
    else {
      res = await hrDb().from("holidays").delete().eq("holiday_date", id).is("workplace_id", null).select("holiday_date,name");
      if (res.error && missingHolidayCols(res.error)) res = await hrDb().from("holidays").delete().eq("holiday_date", id).select("holiday_date,name");
    }
    if (res.error) throw res.error;
    const hit = ((res.data || []) as { holiday_date?: string; name?: string }[])[0];
    if (!hit) return hrJson({ ok: false, error: "목록에 없는 날짜입니다." }, 404);
    await hrAudit({ actor: who.name, action: "holiday_delete", ip: clientIp(req), targetType: "holiday", targetId: String(hit.holiday_date || id), targetName: String(hit.name || "") });
    return hrJson({ ok: true });
  } catch (err) {
    return hrError(err, "공휴일을 지우지 못했습니다.", HR_PENDING_007);
  }
}
