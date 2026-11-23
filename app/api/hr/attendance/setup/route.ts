import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_010, fetchPunchSettings, saveNames, savePunchSettings } from "@/app/lib/hr-punch-db";
import { cleanSettings } from "@/app/lib/hr-punch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;

// GET /api/hr/attendance/setup — 보정 기준
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    return hrJson({ ok: true, settings: await fetchPunchSettings() });
  } catch (err) {
    return hrError(err, "보정 기준을 불러오지 못했습니다.", HR_PENDING_010);
  }
}

// PUT /api/hr/attendance/setup — 세콤 이름 짝과 보정 기준
//   { names: [{ source_name, employee_id | null, skip }] }   짝을 넣거나 고친다(둘 다 비우면 그 이름의 짝을 지운다)
//   { settings: { grace_min, overtime_min } }                지각·조퇴로 보지 않는 분 · 연장을 확인하는 분
export async function PUT(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { names?: unknown; settings?: Record<string, unknown> };
    if (Array.isArray(body.names)) {
      const items: { source_name: string; employee_id: string | null; skip: boolean }[] = [];
      for (const raw of (body.names as Record<string, unknown>[]).slice(0, 500)) {
        const source_name = String(raw?.source_name ?? "").trim().slice(0, 100);
        const employee_id = raw?.employee_id ? String(raw.employee_id) : null;
        if (!source_name || (employee_id && !UUID.test(employee_id))) return hrJson({ ok: false, error: "이름 짝이 올바르지 않습니다." }, 400);
        items.push({ source_name, employee_id, skip: raw?.skip === true });
      }
      await saveNames(items, who.name);
      await hrAudit({ actor: who.name, action: "punch_names", ip: clientIp(req), targetType: "work", targetName: "세콤 이름 짝", detail: { count: items.length, skip: items.filter((i) => i.skip).length } });
    }
    if (body.settings && typeof body.settings === "object") {
      const g = Number(body.settings.grace_min), o = Number(body.settings.overtime_min);
      if (!Number.isInteger(g) || g < 0 || g > 60) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { grace_min: "0~60분" } }, 400);
      if (!Number.isInteger(o) || o < 0 || o > 240) return hrJson({ ok: false, error: "입력을 확인하세요.", fields: { overtime_min: "0~240분" } }, 400);
      const s = cleanSettings({ grace_min: g, overtime_min: o });
      await savePunchSettings(s, who.name);
      await hrAudit({ actor: who.name, action: "punch_settings", ip: clientIp(req), targetType: "work", targetName: "세콤 보정 기준", detail: s });
    }
    return hrJson({ ok: true, settings: await fetchPunchSettings() });
  } catch (err) {
    return hrError(err, "저장하지 못했습니다.", HR_PENDING_010);
  }
}
