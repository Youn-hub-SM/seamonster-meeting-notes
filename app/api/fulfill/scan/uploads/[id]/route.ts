import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { requireLogin } from "@/app/lib/require-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// DELETE — 업로드 1건 삭제(해당 라인 cascade)
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const login = await requireLogin(req);
  if (login.res) return login.res;
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const { error } = await sb.from("fulfill_scan_uploads").delete().eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "삭제 실패") }, { status: 500 });
  }
}
