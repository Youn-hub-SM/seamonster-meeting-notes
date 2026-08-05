import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb } from "@/app/lib/factory-db";

export const dynamic = "force-dynamic";

// GET — 창고 목록(내부창고 먼저)
export async function GET() {
  try {
    const { data, error } = await factoryDb()
      .from("warehouses").select("*").eq("active", true)
      .order("is_own", { ascending: false }).order("sort");
    if (error) throw error;
    return NextResponse.json({ ok: true, rows: data || [] });
  } catch (err) {
    console.error("[factory/warehouses GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "창고 조회 실패") }, { status: 500 });
  }
}

// POST { name, is_own? } — 창고 추가
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { name?: string; is_own?: boolean };
    const name = String(b.name || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "창고명을 입력하세요." }, { status: 400 });
    const { data, error } = await factoryDb()
      .from("warehouses").insert({ name, is_own: !!b.is_own, sort: 50 }).select("*").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, row: data });
  } catch (err) {
    const msg = extractErrorMsg(err, "창고 추가 실패");
    return NextResponse.json({ ok: false, error: /duplicate|unique/i.test(msg) ? "이미 있는 창고명입니다." : msg }, { status: 400 });
  }
}
