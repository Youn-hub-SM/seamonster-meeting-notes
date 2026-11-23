import { NextRequest } from "next/server";
import { hrError, hrJson, requireHr } from "@/app/lib/hr-db";
import { todayKst } from "@/app/lib/hr";
import { loadHome } from "@/app/lib/hr-home-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/hr/home — 첫 화면(대시보드): 오늘의 근무 현황 · 세무 일정 · 해야 할 일. 읽기만 한다.
//  구역마다 따로 불러온다 — 한 구역이 실패하면 그 구역만 null 이고 errors 에 문장이 온다.
export async function GET(req: NextRequest) {
  const who = await requireHr(req);
  if (who.res) return who.res;
  try {
    return hrJson({ ok: true, ...(await loadHome(todayKst())) });
  } catch (err) {
    return hrError(err, "첫 화면을 불러오지 못했습니다.");
  }
}
