import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005, parseProductInput } from "@/app/lib/factory-db";

export const dynamic = "force-dynamic";

// GET — 품목 마스터 전체(재고관리 사용안함 포함) + 관리자 여부
export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    const { data, error } = await factoryDb().from("products").select("*").order("name").order("sku");
    if (error) throw error;
    return NextResponse.json({ ok: true, products: data || [], admin: u.admin });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "품목 조회 실패") }, { status: 500 });
  }
}

// POST { sku, name, origin?, note?, cost?, price?, stock_tracked? } — 품목 등록(관리자). 등록 이력은 DB 트리거가 남긴다.
export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.admin) return NextResponse.json({ ok: false, error: "품목 등록은 관리자만 할 수 있습니다." }, { status: 403 });
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const { patch, error: bad } = parseProductInput({ sku: b.sku, name: b.name, origin: b.origin, note: b.note, cost: b.cost, price: b.price, stock_tracked: b.stock_tracked });
    if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });

    const db = factoryDb();
    const { data, error } = await db.from("products").insert({ ...patch, created_by: u.name }).select("*").single();
    if (error) {
      if ((error as { code?: string }).code === "23505") return NextResponse.json({ ok: false, error: `이미 있는 SKU입니다: ${patch.sku}` }, { status: 409 });
      throw error;
    }
    return NextResponse.json({ ok: true, product: data });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "품목 등록 실패") }, { status: 500 });
  }
}
