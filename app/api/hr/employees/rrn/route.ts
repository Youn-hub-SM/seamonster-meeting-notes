import { NextRequest } from "next/server";
import { clientIp, hrAudit, hrDb, hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { decryptRrn } from "@/app/lib/hr-crypto";
import { formatRrn } from "@/app/lib/hr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;
const PURPOSES = ["view", "print", "excel"] as const;

// POST /api/hr/employees/rrn — 주민등록번호 전체 보기. { ids: [...], purpose: view|print|excel }
//  누가 언제 누구의 번호를 무슨 용도로 봤는지 이력에 남긴다(번호 자체는 남기지 않는다).
//  이력을 남기지 못하면 번호도 내주지 않는다.
export async function POST(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const body = (await req.json()) as { ids?: unknown; purpose?: unknown };
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))].filter((s) => UUID.test(s)).slice(0, 2000) : [];
    const purpose = (PURPOSES as readonly string[]).includes(String(body.purpose)) ? String(body.purpose) : "view";
    if (ids.length === 0) return hrJson({ ok: false, error: "직원을 고르세요." }, 400);

    const rows: { id: string; name: string; rrn_enc: string | null }[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await hrDb().from("employees").select("id,name,rrn_enc").in("id", ids.slice(i, i + 200));
      if (error) throw error;
      rows.push(...((data || []) as typeof rows));
    }
    const withRrn = rows.filter((r) => r.rrn_enc);

    const logged = await hrAudit({
      actor: who.name, action: purpose === "view" ? "rrn_view" : "rrn_export", ip: clientIp(req),
      targetType: "employee", targetId: withRrn.length === 1 ? withRrn[0].id : "", targetName: withRrn.length === 1 ? withRrn[0].name : `${withRrn.length}명`,
      detail: { purpose, count: withRrn.length, names: withRrn.slice(0, 50).map((r) => r.name) },
    });
    if (!logged) return hrJson({ ok: false, error: "열람 이력을 남기지 못해 번호를 보여 줄 수 없습니다." }, 500);

    const rrn: Record<string, string> = {};
    for (const r of withRrn) rrn[r.id] = formatRrn(decryptRrn(r.rrn_enc as string));
    return hrJson({ ok: true, rrn });
  } catch (err) {
    return hrError(err, "주민등록번호를 불러오지 못했습니다.");
  }
}
