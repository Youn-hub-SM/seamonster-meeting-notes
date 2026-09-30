import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005, parseProductInput } from "@/app/lib/factory-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 들어온 칸만(변경 행은 바뀐 칸만 온다) — 화이트리스트 밖(id·label 등)은 버린다. 값 검사는 parseProductInput.
const FIELDS = ["sku", "name", "origin", "note", "cost", "price", "stock_tracked"] as const;
const pick = (r: Record<string, unknown>) => Object.fromEntries(FIELDS.filter((k) => k in r).map((k) => [k, r[k]]));
const nameOf = (r: Record<string, unknown>) => String(r.label || r.name || r.sku || "?");

// POST { creates: Row[], updates: Row[] } — 미리보기에서 확인한 행만 반영(관리자). 서버에서 다시 정리(화면 변조 방어).
//  바뀐 칸은 DB 트리거가 히스토리 '변경'에 남긴다(누가 = updated_by / created_by).
export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.admin) return NextResponse.json({ ok: false, error: "관리자만 반영할 수 있습니다." }, { status: 403 });
    const body = (await req.json().catch(() => ({}))) as { creates?: Record<string, unknown>[]; updates?: Record<string, unknown>[] };
    const creates = Array.isArray(body.creates) ? body.creates : [];
    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (creates.length + updates.length > 2000) return NextResponse.json({ ok: false, error: "한 번에 2000건까지 반영할 수 있습니다." }, { status: 400 });
    const db = factoryDb();
    let created = 0, updated = 0;
    const errors: string[] = [];
    const dupMsg = (name: unknown, sku: unknown) => `${name}: SKU '${sku}' 가 이미 다른 품목에 등록되어 있습니다.`;

    for (const r of creates) {
      const { patch, error: bad } = parseProductInput(pick(r));
      if (bad) { errors.push(`${nameOf(r)}: ${bad}`); continue; }
      if (!patch.sku || !patch.name) { errors.push(`${nameOf(r)}: SKU·품목이 필요합니다.`); continue; }
      const { error } = await db.from("products").insert({ ...patch, created_by: u.name });
      if (error) { errors.push((error as { code?: string }).code === "23505" ? dupMsg(patch.name, patch.sku) : `${patch.name}: ${error.message}`); continue; }
      created++;
    }

    for (const r of updates) {
      const id = String(r.id || "");
      if (!id) { errors.push(`${nameOf(r)}: ID 없음`); continue; }
      const { patch, error: bad } = parseProductInput(pick(r));
      if (bad) { errors.push(`${nameOf(r)}: ${bad}`); continue; }
      if (Object.keys(patch).length === 0) continue; // 바뀐 칸 없음
      const { data, error } = await db.from("products")
        .update({ ...patch, updated_by: u.name, updated_at: new Date().toISOString() }).eq("id", id).select("id");
      if (error) { errors.push((error as { code?: string }).code === "23505" ? dupMsg(nameOf(r), patch.sku) : `${nameOf(r)}: ${error.message}`); continue; }
      if (!data || data.length === 0) { errors.push(`${nameOf(r)}: 품목을 찾을 수 없습니다(그사이 삭제됨).`); continue; }
      updated++;
    }

    return NextResponse.json({ ok: errors.length === 0, created, updated, errors });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    console.error("[factory/products import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "적용 실패") }, { status: 500 });
  }
}
