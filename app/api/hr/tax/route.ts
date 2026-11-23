import { NextRequest } from "next/server";
import { hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { HR_PENDING_003 } from "@/app/lib/hr-pay-db";
import { loadTax } from "@/app/lib/hr-tax-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/hr/tax?year=YYYY — 그 해에 지급한 급여의 원천세 집계(급여마다 인원·지급 합계·비과세·과세 급여·소득세·지방소득세).
//  신고는 지급한 달 기준이라 지급일이 그 해에 든 급여를 준다(귀속월이 앞 해여도). 읽기만 한다.
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  const year = Number(req.nextUrl.searchParams.get("year"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return hrJson({ ok: false, error: "해를 고르세요." }, 400);
  try {
    return hrJson({ ok: true, ...(await loadTax(year)) });
  } catch (err) {
    return hrError(err, "원천세 집계를 불러오지 못했습니다.", HR_PENDING_003);
  }
}
