import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName, getB2BUsers } from "@/app/lib/b2b-auth";
import { listUsers, addUser, deleteUser, setUserActive } from "@/app/lib/app-users";

export const dynamic = "force-dynamic";

async function adminName(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  const name = (await verifySession(token)) || resolveUserName(token);
  return isAdminName(name) ? name : null;
}

// GET — 계정 목록(DB + 환경변수). 관리자만.
export async function GET(req: NextRequest) {
  try {
    if (!(await adminName(req))) return NextResponse.json({ ok: false, error: "관리자만 접근할 수 있습니다." }, { status: 403 });
    const db = await listUsers();
    const env = getB2BUsers().map((u) => u.name); // 환경변수 계정(읽기 전용 표시용)
    return NextResponse.json({ ok: true, users: db, envUsers: env });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { name, password } — 계정 추가. 관리자만.
export async function POST(req: NextRequest) {
  try {
    const admin = await adminName(req);
    if (!admin) return NextResponse.json({ ok: false, error: "관리자만 접근할 수 있습니다." }, { status: 403 });
    const { name, password } = (await req.json()) as { name?: string; password?: string };
    if (!name?.trim() || !password?.trim()) return NextResponse.json({ ok: false, error: "이름과 비밀번호를 입력하세요." }, { status: 400 });
    if (getB2BUsers().some((u) => u.name === name.trim())) return NextResponse.json({ ok: false, error: "환경변수에 이미 있는 이름입니다." }, { status: 400 });
    await addUser(name, password, admin);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = extractErrorMsg(err, "추가 실패");
    return NextResponse.json({ ok: false, error: /duplicate|unique/i.test(msg) ? "이미 있는 이름입니다." : msg }, { status: 400 });
  }
}

// PATCH { id, active } — 활성/비활성. DELETE ?id — 삭제. 관리자만.
export async function PATCH(req: NextRequest) {
  try {
    if (!(await adminName(req))) return NextResponse.json({ ok: false, error: "관리자만 접근할 수 있습니다." }, { status: 403 });
    const { id, active } = (await req.json()) as { id?: string; active?: boolean };
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    await setUserActive(id, !!active);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "변경 실패") }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    if (!(await adminName(req))) return NextResponse.json({ ok: false, error: "관리자만 접근할 수 있습니다." }, { status: 403 });
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    await deleteUser(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
