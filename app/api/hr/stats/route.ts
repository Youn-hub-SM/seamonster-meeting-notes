import { NextRequest } from "next/server";
import { hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { loadStats } from "@/app/lib/hr-stats-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/hr/stats?end=YYYY-MM[&workplace=<id>][&affiliation=<소속 이름>] — 끝 달을 포함한 12개월의 통계(인건비·근무 시간·인원·연차).
//  읽기만 한다. 근무대장 12개월 치를 읽어 급여 화면과 같은 함수로 시간을 계산하므로 직원이 많으면 몇 초 걸린다.
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    const sp = req.nextUrl.searchParams;
    const b = await loadStats(sp.get("end") || "", sp.get("workplace") || "", (sp.get("affiliation") || "").trim());
    if ("error" in b) return hrJson({ ok: false, error: b.error }, b.status);
    return hrJson({ ok: true, ...b });
  } catch (err) {
    return hrError(err, "통계를 불러오지 못했습니다.");
  }
}
