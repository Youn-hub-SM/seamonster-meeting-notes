import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { HR_COOKIE, HR_TTL_S, getHrUsers, hrConfigured, signHrSession, verifyHrSession } from "@/app/lib/hr-auth";
import { getB2BUsers } from "@/app/lib/b2b-auth";
import { getActiveDbUsers } from "@/app/lib/app-users";
import { clientIp, hrAudit, hrDb, hrJson } from "@/app/lib/hr-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 급여·연차 창 로그인. 업무도우미 로그인(/api/b2b/auth)과 무관하다 — 여기서는 HR_USERS 의 비밀번호만 본다.
//  같은 주소에서 15분 안에 5번 틀리면 잠근다(hr.login_attempts). 표가 아직 없으면 서버 메모리로 센다.

const MAX_FAILS = 5;
const LOCK_MIN = 15;
const memFails = new Map<string, number[]>(); // DB 를 못 쓸 때의 대체(인스턴스마다 따로라 느슨하다)

const digest = (s: string) => createHash("sha256").update(s).digest();
const samePassword = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

async function recentFails(ip: string): Promise<number> {
  const since = new Date(Date.now() - LOCK_MIN * 60_000).toISOString();
  try {
    const { data, error } = await hrDb().from("login_attempts").select("ok,at").eq("ip", ip).gte("at", since).order("at", { ascending: false }).limit(20);
    if (error) throw error;
    // 마지막 성공 뒤의 실패만 센다
    let n = 0;
    for (const r of (data || []) as { ok: boolean }[]) { if (r.ok) break; n++; }
    return n;
  } catch {
    const cut = Date.now() - LOCK_MIN * 60_000;
    return (memFails.get(ip) || []).filter((t) => t > cut).length;
  }
}
async function record(ip: string, ok: boolean): Promise<void> {
  try {
    const { error } = await hrDb().from("login_attempts").insert({ ip, ok });
    if (error) throw error;
  } catch {
    if (ok) memFails.delete(ip);
    else memFails.set(ip, [...(memFails.get(ip) || []).filter((t) => t > Date.now() - LOCK_MIN * 60_000), Date.now()]);
  }
}

// 업무도우미·파도소리 계정이 쓰는 비밀번호인가 — 그렇다면 급여 창 비밀번호로 인정하지 않는다.
//  대표가 실수로 같은 비밀번호를 지정해도, 업무도우미 비밀번호를 아는 사람이 이 창에 들어오는 일이 없게.
async function usedElsewhere(password: string): Promise<boolean> {
  if (getB2BUsers().some((u) => samePassword(u.password, password))) return true;
  try {
    return (await getActiveDbUsers()).some((u) => samePassword(u.password, password));
  } catch { return false; }
}

export async function POST(req: NextRequest) {
  if (!hrConfigured()) {
    // 로그인 전 화면에는 무엇이 빠졌는지 알리지 않는다(환경변수 이름은 서버 로그에만)
    console.error("[hr] 설정 전 — 환경변수 HR_SECRET(16자 이상)·HR_USERS(이름:비밀번호, 8자 이상)를 넣고 다시 배포하세요.");
    return hrJson({ ok: false, error: "아직 들어갈 수 없습니다. 설정이 끝나지 않았습니다." }, 503);
  }
  const ip = clientIp(req);
  if ((await recentFails(ip)) >= MAX_FAILS) {
    return hrJson({ ok: false, error: `비밀번호를 ${MAX_FAILS}번 틀렸습니다. ${LOCK_MIN}분 뒤에 다시 입력하세요.` }, 429);
  }
  let password = "";
  try { password = String(((await req.json()) as { password?: unknown }).password ?? "").trim(); } catch { /* 빈 값으로 처리 */ }

  // 모든 계정과 끝까지 비교한다(먼저 맞았다고 멈추지 않는다)
  let name: string | null = null;
  for (const u of getHrUsers()) if (samePassword(u.password, password)) name = u.name;

  if (name && (await usedElsewhere(password))) {
    console.error("[hr] 급여 창 비밀번호가 업무도우미 계정 비밀번호와 같습니다 — 다른 값으로 바꾸세요:", name);
    name = null;
  }
  if (!name) {
    await record(ip, false);
    return hrJson({ ok: false, error: "비밀번호가 틀렸습니다." }, 401);
  }

  await record(ip, true);
  await hrAudit({ actor: name, action: "login", ip });
  const res = hrJson({ ok: true, name });
  res.cookies.set(HR_COOKIE, await signHrSession(name), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",   // 다른 사이트에서 넘어오는 요청에는 쿠키가 붙지 않는다
    path: "/",
    maxAge: HR_TTL_S,
  });
  return res;
}

// 지금 들어와 있는 사람
export async function GET(req: NextRequest) {
  const name = await verifyHrSession(req.cookies.get(HR_COOKIE)?.value);
  if (!name) return hrJson({ ok: false, error: "인증이 필요합니다." }, 401);
  return hrJson({ ok: true, name });
}

// 로그아웃
export async function DELETE() {
  const res = hrJson({ ok: true });
  res.cookies.set(HR_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
