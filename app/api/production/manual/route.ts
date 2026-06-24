import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getManualProductions, addManualProduction, deleteManualProduction, updateManualStatus, ManualProduction } from "@/app/lib/production-manual";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, items: await getManualProductions() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<ManualProduction>;
    const items = await addManualProduction(body);
    return NextResponse.json({ ok: true, items });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, status } = (await req.json()) as { id?: string; status?: string };
    if (!id || !status) return NextResponse.json({ ok: false, error: "id·status 가 필요합니다." }, { status: 400 });
    const items = await updateManualStatus(id, status);
    return NextResponse.json({ ok: true, items });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "상태 변경 실패") }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const items = await deleteManualProduction(id);
    return NextResponse.json({ ok: true, items });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
