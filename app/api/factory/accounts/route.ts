import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName, getB2BUsers } from "@/app/lib/b2b-auth";
import { listUsers, addUser, deleteUser, setUserActive, updateUser, dbPasswordTaken } from "@/app/lib/app-users";

export const dynamic = "force-dynamic";

// 파도소리 계정 관리(파도소리 화면 '계정' 메뉴, 2026-10-22 대표 지시 — 직원 계정은 대표가 만들어 나눠 준다).
//  관리자만. 다루는 것은 파도소리(role=factory) 계정뿐 — 내부 계정은 목록에도 안 나오고 바꿀 수도 없다.
//  저장은 씨몬스터 계정 관리(/api/b2b/users)와 같은 app_users. 로그인은 비밀번호만으로 사람을 찾으므로
//  이미 쓰는 비밀번호(환경변수·DB 전체)는 받지 않는다.
const MIN_PW = 6;

async function isAdmin(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get("b2b_auth")?.value;
  return isAdminName((await verifySession(token)) || resolveUserName(token));
}
const deny = () => NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 403 });
const bad = (error: string) => NextResponse.json({ ok: false, error }, { status: 400 });

async function pwProblem(password: string, exceptId?: string): Promise<string | null> {
  const pw = password.trim();
  if (pw.length < MIN_PW) return `비밀번호는 ${MIN_PW}자 이상으로 하세요.`;
  if (getB2BUsers().some((u) => u.password === pw) || (await dbPasswordTaken(pw, exceptId))) return "이미 쓰는 비밀번호입니다. 다른 값으로 하세요.";
  return null;
}
async function factoryUser(id: string) {
  return (await listUsers()).find((u) => u.id === id && u.role === "factory") || null;
}

// GET — 파도소리 계정 목록. ?check=1 이면 목록 없이 관리자 여부만(메뉴 표시용).
export async function GET(req: NextRequest) {
  try {
    if (!(await isAdmin(req))) return deny();
    if (req.nextUrl.searchParams.get("check")) return NextResponse.json({ ok: true });
    const users = (await listUsers()).filter((u) => u.role === "factory");
    return NextResponse.json({ ok: true, users });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { name, password } — 파도소리 계정 추가
export async function POST(req: NextRequest) {
  try {
    if (!(await isAdmin(req))) return deny();
    const token = req.cookies.get("b2b_auth")?.value;
    const by = (await verifySession(token)) || resolveUserName(token);
    const { name, password } = (await req.json().catch(() => ({}))) as { name?: string; password?: string };
    if (!name?.trim()) return bad("이름을 입력하세요.");
    if (getB2BUsers().some((u) => u.name === name.trim())) return bad("이미 있는 이름입니다.");
    const p = await pwProblem(password || "");
    if (p) return bad(p);
    await addUser(name, password || "", by || undefined, "factory");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = extractErrorMsg(err, "추가 실패");
    return bad(/duplicate|unique/i.test(msg) ? "이미 있는 이름입니다." : msg);
  }
}

// PATCH { id, active? | password? } — 사용 중지·다시 사용·비밀번호 변경(다음 로그인부터)
export async function PATCH(req: NextRequest) {
  try {
    if (!(await isAdmin(req))) return deny();
    const { id, active, password } = (await req.json().catch(() => ({}))) as { id?: string; active?: boolean; password?: string };
    if (!id || !(await factoryUser(id))) return bad("파도소리 계정을 찾을 수 없습니다.");
    if (typeof password === "string") {
      const p = await pwProblem(password, id);
      if (p) return bad(p);
      await updateUser(id, { password });
    }
    if (typeof active === "boolean") await setUserActive(id, active);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "변경 실패") }, { status: 500 });
  }
}

// DELETE ?id — 삭제(기록의 '누가' 이름은 남는다)
export async function DELETE(req: NextRequest) {
  try {
    if (!(await isAdmin(req))) return deny();
    const id = req.nextUrl.searchParams.get("id") || "";
    if (!(await factoryUser(id))) return bad("파도소리 계정을 찾을 수 없습니다.");
    await deleteUser(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
