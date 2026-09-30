import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import {
  factoryDb, factoryWho, isPending005, PENDING_005,
  parseProductInput, histValue, MASTER_FIELDS, type ProductPatch,
} from "@/app/lib/factory-db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const pending = () => NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });

// PATCH — 품목 수정. SKU·품목·원산지·비고·재고관리는 관리자만, 제품원가·판매가는 모든 계정.
//  바뀐 값은 DB 트리거(factory.log_product_change)가 같은 트랜잭션에서 product_changes 에 남긴다(히스토리 '변경').
//  '누가'는 updated_by 로 넘긴다.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const u = await factoryWho(req);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const { patch, error: bad } = parseProductInput(b);
    if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });

    const db = factoryDb();
    const { data: cur, error: ce } = await db.from("products").select("*").eq("id", id).maybeSingle();
    if (ce) throw ce;
    if (!cur) return NextResponse.json({ ok: false, error: "품목을 찾을 수 없습니다." }, { status: 404 });
    const before = cur as Record<string, unknown>;

    // 바뀐 칸만 보낸다(권한 판정도 바뀐 칸 기준)
    const changed = (Object.keys(patch) as (keyof ProductPatch)[])
      .filter((k) => histValue(before[k]) !== histValue(patch[k]));
    if (changed.length === 0) return NextResponse.json({ ok: true, product: cur, unchanged: true });
    if (!u.admin && changed.some((k) => (MASTER_FIELDS as readonly string[]).includes(k)))
      return NextResponse.json({ ok: false, error: "SKU·품목·원산지·비고·재고관리는 관리자만 바꿀 수 있습니다." }, { status: 403 });

    const upd: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: u.name };
    for (const k of changed) upd[k] = patch[k];
    const { data, error } = await db.from("products").update(upd).eq("id", id).select("*").single();
    if (error) {
      if ((error as { code?: string }).code === "23505") return NextResponse.json({ ok: false, error: `이미 있는 SKU입니다: ${patch.sku}` }, { status: 409 });
      throw error;
    }
    return NextResponse.json({ ok: true, product: data });
  } catch (err) {
    if (isPending005(err)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "품목 수정 실패") }, { status: 500 });
  }
}

// DELETE — 품목 삭제(관리자). 입출고 기록이 한 줄이라도 있으면(취소 포함) DB 함수가 막는다 — 히스토리가 끊긴다.
//  삭제 이력과 삭제는 DB 함수(factory.delete_product) 한 트랜잭션.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const u = await factoryWho(req);
    if (!u.admin) return NextResponse.json({ ok: false, error: "품목 삭제는 관리자만 할 수 있습니다." }, { status: 403 });
    const { error } = await factoryDb().rpc("delete_product", { p_id: id, p_actor: u.name });
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "P0001") return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
      if (code === "22P02") return NextResponse.json({ ok: false, error: "품목을 찾을 수 없습니다." }, { status: 404 });
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isPending005(err)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "품목 삭제 실패") }, { status: 500 });
  }
}
