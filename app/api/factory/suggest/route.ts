import { NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb } from "@/app/lib/factory-db";

export const dynamic = "force-dynamic";

// GET — 입력 자동완성 목록. 품명이 158종이고 계속 늘어나므로 마스터 테이블 대신
//  기존 값에서 뽑아 제안한다(자유 입력은 막지 않는다).
export async function GET() {
  try {
    const db = factoryDb();
    const [lots, txns] = await Promise.all([
      db.from("lots").select("item_name, spec, supplier, note").limit(5000),
      db.from("lot_txns").select("dest").not("dest", "is", null).limit(5000),
    ]);
    if (lots.error) throw lots.error;

    const uniq = (vals: unknown[]): string[] =>
      [...new Set(vals.map((v) => String(v ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));

    const rows = (lots.data || []) as Record<string, unknown>[];
    return NextResponse.json({
      ok: true,
      item_names: uniq(rows.map((r) => r.item_name)),
      specs: uniq(rows.map((r) => r.spec)),
      suppliers: uniq(rows.map((r) => r.supplier)),
      notes: uniq(rows.map((r) => r.note)),
      dests: uniq(((txns.data || []) as Record<string, unknown>[]).map((r) => r.dest)),
    });
  } catch (err) {
    console.error("[factory/suggest GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "자동완성 목록 조회 실패") }, { status: 500 });
  }
}
