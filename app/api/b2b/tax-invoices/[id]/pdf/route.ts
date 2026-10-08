import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { boltaPdf } from "@/app/lib/bolta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

// GET — 발행 완료 문서의 PDF 다운로드 주소(볼타, 5분 유효). 처음엔 생성 중(ready:false)일 수 있다 — 화면이 몇 초 뒤 다시 부른다.
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const { data, error } = await supabaseAdmin().from("tax_invoices").select("issuance_key, status").eq("id", id).maybeSingle();
    if (error) throw error;
    const row = data as { issuance_key?: string | null; status?: string } | null;
    if (!row?.issuance_key || row.status !== "발행완료") return NextResponse.json({ ok: false, error: "발행 완료된 문서만 PDF 가 있습니다." }, { status: 400 });
    return NextResponse.json({ ok: true, ...(await boltaPdf(row.issuance_key)) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "PDF 조회 실패") }, { status: 500 });
  }
}
