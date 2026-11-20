import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending012, PENDING_012 } from "@/app/lib/factory-db";
import { parsePartnerInput } from "@/app/lib/factory-partners";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// PATCH — 거래처 수정(모든 계정). 이름을 바꿔도 이미 적힌 기록의 거래처 글자는 그대로다.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return bad("거래처를 찾을 수 없습니다.", 404);
    const u = await factoryWho(req);
    const { patch, error: pe } = parsePartnerInput((await req.json().catch(() => ({}))) as Record<string, unknown>, true);
    if (pe) return bad(pe);
    if (!Object.keys(patch).length) return bad("바꿀 내용이 없습니다.");
    const { data, error } = await factoryDb().from("partners")
      .update({ ...patch, updated_by: u.name, updated_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
    if (error) {
      if ((error as { code?: string }).code === "23505") return bad("이미 있는 업체명입니다.");
      throw error;
    }
    if (!data) return bad("거래처를 찾을 수 없습니다.", 404);
    return NextResponse.json({ ok: true, partner: data });
  } catch (err) {
    if (isPending012(err)) return NextResponse.json({ ok: false, error: PENDING_012, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "거래처 수정 실패") }, { status: 500 });
  }
}

// DELETE — 목록에서 지운다(관리자). 기록에 적힌 거래처 글자는 남는다.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return bad("거래처를 찾을 수 없습니다.", 404);
    const u = await factoryWho(req);
    if (!u.admin) return bad("권한이 없습니다.", 403);
    const { error } = await factoryDb().from("partners").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isPending012(err)) return NextResponse.json({ ok: false, error: PENDING_012, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "거래처 삭제 실패") }, { status: 500 });
  }
}
