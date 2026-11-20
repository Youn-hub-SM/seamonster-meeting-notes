// 급여·연차 창 — 서버 전용 DB 접근·인증 확인·이력. 화면에서 import 하지 말 것(서비스 키가 번들에 실린다).

import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "./supabase";
import { HR_COOKIE, verifyHrSession } from "./hr-auth";

// hr 스키마 전용 핸들. **급여 창의 라우트는 supabaseAdmin() 대신 반드시 이걸 쓴다.**
//  반대로 업무도우미·파도소리 코드는 이 파일을 import 하지 않는다 — 급여 데이터에 닿는 길은 /api/hr/* 뿐이다.
//  사전 조건: Supabase Dashboard > Settings > API > Exposed schemas 에 hr 추가(migration hr/001 주석).
export function hrDb() {
  return supabaseAdmin().schema("hr");
}

// 모든 /api/hr/* 핸들러의 첫 줄. 미들웨어가 이미 막지만 여기서 한 번 더 본다(이중 검사).
//  통과하면 { name }, 아니면 { res }(401) — 호출부는 `if (who.res) return who.res;`
export async function requireHr(req: NextRequest): Promise<{ name: string; res?: undefined } | { name?: undefined; res: NextResponse }> {
  const name = await verifyHrSession(req.cookies.get(HR_COOKIE)?.value);
  if (!name) return { res: hrJson({ ok: false, error: "인증이 필요합니다." }, 401) };
  return { name };
}

// 급여 창의 응답은 어디에도 캐시되지 않게 한다
export function hrJson(body: unknown, status = 200): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return (fwd.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim().slice(0, 64);
}

// migration hr/001 미적용(또는 Exposed schemas 에 hr 없음) — 표가 없다는 오류
export function isHrPending(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err ?? "");
  const code = String((err as { code?: string })?.code ?? "");
  return code === "PGRST106" || code === "42P01" || code === "3F000"
    || /(does not exist|schema cache|Could not find|schema must be one of|Invalid schema)/i.test(m);
}
export const HR_PENDING = "DB 준비 전입니다. supabase/migrations/hr/001_hr_init.sql 을 적용하고 Supabase Exposed schemas 에 hr 을 추가하세요.";

export const HR_PENDING_002 = "DB 준비 전입니다. supabase/migrations/hr/002_work_logs.sql 을 적용하세요.";

// pending = 표가 없을 때 보일 안내(그 기능이 기대하는 마이그레이션). 비우면 hr/001 안내.
export function hrError(err: unknown, fallback: string, pending: string = HR_PENDING): NextResponse {
  if (isHrPending(err)) return hrJson({ ok: false, pending: true, error: pending }, 503);
  const m = (err as { message?: string })?.message;
  return hrJson({ ok: false, error: typeof m === "string" && m ? m : fallback }, 500);
}

// 변경·열람 이력(hr.audit_log). 업무도우미의 activity_log 에는 아무것도 남기지 않는다.
//  detail 에 주민등록번호·비밀번호를 넣지 않는다. 기록 실패가 본 작업을 막지는 않되, 서버 로그에는 남긴다.
export type AuditEntry = {
  actor: string; action: string; ip?: string;
  targetType?: string; targetId?: string; targetName?: string;
  detail?: Record<string, unknown>;
};
export async function hrAudit(e: AuditEntry): Promise<boolean> {
  try {
    const { error } = await hrDb().from("audit_log").insert({
      actor: e.actor, action: e.action, ip: e.ip || "",
      target_type: e.targetType || "", target_id: e.targetId || "", target_name: e.targetName || "",
      detail: e.detail || {},
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[hr] 이력 기록 실패", e.action, (err as { message?: string })?.message || err);
    return false;
  }
}
