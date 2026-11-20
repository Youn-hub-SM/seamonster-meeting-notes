import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending010, PENDING_010 } from "@/app/lib/factory-db";

export const dynamic = "force-dynamic";

// GET ?item=품명 — 품목 하나의 월별 흐름(창고 생산·현장 출고·거래처 출고·주문 생산)과 거래처별 출고. 관리자만.
export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.admin) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 403 });
    const item = (req.nextUrl.searchParams.get("item") || "").trim();
    if (!item) return NextResponse.json({ ok: false, error: "품목이 없습니다." }, { status: 400 });
    const { data, error } = await factoryDb().rpc("flow_item", { p_item: item });
    if (error) throw error;
    return NextResponse.json({ ok: true, detail: data });
  } catch (err) {
    if (isPending010(err)) return NextResponse.json({ ok: false, error: PENDING_010, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "품목 조회 실패") }, { status: 500 });
  }
}
