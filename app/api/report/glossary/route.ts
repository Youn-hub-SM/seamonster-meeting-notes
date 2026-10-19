import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { listGlossary, upsertGlossary, deleteGlossary, isPending140, PENDING_140 } from "@/app/lib/report-glossary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI 데이터 비서 용어 사전(migration 140). GET 목록 / POST {term, definition} 추가(같은 용어면 덮어씀) / PUT {id, term, definition} / DELETE ?id=
//  누구나 추가·수정·삭제할 수 있고 누가 했는지 남는다(created_by·updated_by).
async function who(req: NextRequest): Promise<string> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token) || "?";
}
const pending = () => NextResponse.json({ ok: false, error: PENDING_140, pending_migration: true }, { status: 503 });
const fail = (e: unknown, msg: string) => (isPending140(e) ? pending() : NextResponse.json({ ok: false, error: extractErrorMsg(e, msg) }, { status: 500 }));

export async function GET() {
  try { return NextResponse.json({ ok: true, terms: await listGlossary() }); }
  catch (e) { return fail(e, "용어 사전을 불러오지 못했습니다."); }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => ({}))) as { term?: string; definition?: string };
    const term = await upsertGlossary({ term: String(b.term || ""), definition: String(b.definition || ""), user: await who(req) });
    return NextResponse.json({ ok: true, term });
  } catch (e) {
    if (e instanceof Error && /입력하세요|이미 있는/.test(e.message)) return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    return fail(e, "용어를 저장하지 못했습니다.");
  }
}

export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => ({}))) as { id?: string; term?: string; definition?: string };
    if (!b.id) return NextResponse.json({ ok: false, error: "id 필요" }, { status: 400 });
    const term = await upsertGlossary({ id: String(b.id), term: String(b.term || ""), definition: String(b.definition || ""), user: await who(req) });
    return NextResponse.json({ ok: true, term });
  } catch (e) {
    if (e instanceof Error && /입력하세요|이미 있는/.test(e.message)) return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    return fail(e, "용어를 고치지 못했습니다.");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id") || "";
    if (!id) return NextResponse.json({ ok: false, error: "id 필요" }, { status: 400 });
    await deleteGlossary(id);
    return NextResponse.json({ ok: true });
  } catch (e) { return fail(e, "용어를 지우지 못했습니다."); }
}
