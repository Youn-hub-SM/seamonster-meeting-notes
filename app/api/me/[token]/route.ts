import { NextRequest, NextResponse } from "next/server";
import { clientIp, hrAudit, hrDb, hrJson, isHrPending } from "@/app/lib/hr-db";
import { ME_BLOCKED, ME_BLOCK_FAILS, ME_COOKIE, ME_GONE, ME_LOCK_MIN, ME_MAX_FAILS, ME_TTL_S, failState, findLink, loadMe, recordAttempt, rrnMatches, signMe, verifyMe } from "@/app/lib/hr-me";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// 직원 확인 링크 — 급여 창(/hr) 로그인 밖에 있는 길. 미들웨어는 이 경로를 그냥 통과시키고, 여기서 스스로 검증한다:
//   ① 주소의 토큰이 살아 있는 링크인가 ② 그 링크로 본인 확인을 통과한 쿠키가 있는가.
//  둘을 통과해야 그 직원 한 명의 자료를 준다. 통과 전에는 이름조차 주지 않는다. 읽기만 한다.
type Ctx = { params: Promise<{ token: string }> };

const out = (body: unknown, status = 200): NextResponse => {
  const res = hrJson(body, status);
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
};
const gone = () => out({ ok: false, error: ME_GONE }, 404);
// 무슨 일이 있었는지 바깥에 알리지 않는다(표 이름·DB 문장). 서버 로그에만 남긴다.
const fail = (err: unknown) => {
  console.error("[me]", (err as { message?: string })?.message || err);
  return isHrPending(err) ? gone() : out({ ok: false, error: "지금은 볼 수 없습니다. 잠시 뒤 다시 열어 주세요." }, 500);
};
const cookieOpt = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/api/me" };

// GET /api/me/<토큰>[?month=YYYY-MM] — 본인 확인 전이면 { need: "verify" }, 통과했으면 본인 자료
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const { token } = await params;
    const link = await findLink(token);
    if (!link) return gone();
    if (!verifyMe(req.cookies.get(ME_COOKIE)?.value, link.id, link.version)) {
      const f = await failState(link.id);
      return out({ ok: true, need: "verify", locked: f.locked, blocked: f.blocked, can_verify: !!link.employee.rrn_hash });
    }
    return out({ ok: true, ...(await loadMe(link, req.nextUrl.searchParams.get("month") || "")) });
  } catch (err) {
    return fail(err);
  }
}

// POST /api/me/<토큰> — { rrn } 본인 확인. 주민등록번호 13자리가 인사대장의 것과 같으면 확인 상태 쿠키를 준다.
//  입력한 번호는 비교에만 쓰고 저장·기록하지 않는다. 15분 안에 5번 틀리면 그 링크를 15분 잠근다.
//  맞히지 못하고 20번을 틀리면 링크가 잠긴다 — 급여 창에서 [링크 다시 만들기]를 해야 풀린다.
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { token } = await params;
    const link = await findLink(token);
    if (!link) return gone();
    if (!link.employee.rrn_hash) return out({ ok: false, error: "본인 확인에 쓸 정보가 등록돼 있지 않습니다. 담당자에게 문의하세요." }, 400);
    const f = await failState(link.id);
    if (f.blocked) return out({ ok: false, locked: true, blocked: true, error: ME_BLOCKED }, 429);
    if (f.locked) return out({ ok: false, locked: true, error: `${ME_MAX_FAILS}번 틀렸습니다. ${ME_LOCK_MIN}분 뒤에 다시 입력하세요.` }, 429);

    let digits = "";
    try { digits = String(((await req.json()) as { rrn?: unknown }).rrn ?? "").replace(/\D/g, ""); } catch { /* 빈 값으로 처리 */ }
    const ok = rrnMatches(digits, link.employee.rrn_hash);
    const ip = clientIp(req);
    await recordAttempt(link.id, ip, ok);
    if (!ok) {
      const left = ME_MAX_FAILS - f.recent - 1;
      const blocked = f.streak + 1 >= ME_BLOCK_FAILS;
      await hrAudit({ actor: "직원 확인 링크", action: blocked ? "me_blocked" : "me_verify_fail", ip, targetType: "employee", targetId: link.employee.id, targetName: link.employee.name });
      if (blocked) return out({ ok: false, locked: true, blocked: true, error: ME_BLOCKED }, 401);
      return out({ ok: false, locked: left <= 0, error: left > 0 ? `주민등록번호가 맞지 않습니다. ${left}번 더 틀리면 ${ME_LOCK_MIN}분 동안 잠깁니다.` : `${ME_MAX_FAILS}번 틀렸습니다. ${ME_LOCK_MIN}분 뒤에 다시 입력하세요.` }, 401);
    }
    await hrDb().from("employee_links").update({ last_opened_at: new Date().toISOString() }).eq("id", link.id);
    await hrAudit({ actor: `직원 ${link.employee.name}`, action: "me_verify", ip, targetType: "employee", targetId: link.employee.id, targetName: link.employee.name });
    const res = out({ ok: true });
    res.cookies.set(ME_COOKIE, signMe(link.id, link.version), { ...cookieOpt, maxAge: ME_TTL_S });
    return res;
  } catch (err) {
    return fail(err);
  }
}

// DELETE /api/me/<토큰> — 이 기기의 확인 상태를 지운다(나가기)
export async function DELETE() {
  const res = out({ ok: true });
  res.cookies.set(ME_COOKIE, "", { ...cookieOpt, maxAge: 0 });
  return res;
}
