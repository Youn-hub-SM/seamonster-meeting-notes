import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 원가 변경 예약 — "n월 n일부터 이 원가". 반영은 DB 함수(apply_due_cost_schedules, migration 093)가
//  매일 00:10 KST 에 한다. 여기서는 예약을 만들고·보고·지우고, 필요하면 즉시 반영을 부른다.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const num = (v: unknown) => Math.max(0, Math.round((Number(v) || 0) * 100) / 100);

async function actor(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(t)) || resolveUserName(t) || null;
}

// GET [?product_id=] — 예약 목록. product_id 없으면 대기 중인 전체(가까운 날짜순).
export async function GET(req: NextRequest) {
  try {
    const pid = req.nextUrl.searchParams.get("product_id");
    const sb = supabaseAdmin();
    let q = sb.from("product_cost_schedules")
      .select("id, product_id, effective_date, cost_material, pkg_inner, pkg_label, pkg_outer, cost_price, memo, applied_at, created_by, created_at, products(name, sku)");
    q = pid ? q.eq("product_id", pid) : q.is("applied_at", null);
    const { data, error } = await q.order("effective_date", { ascending: true }).limit(500);
    // 093 미적용 환경에서도 화면이 죽지 않게 — 예약 기능만 조용히 비활성.
    if (error) return NextResponse.json({ ok: true, schedules: [], pending_migration: true });

    type Join = { name?: string; sku?: string | null };
    const schedules = (data ?? []).map((r) => {
      const p = (Array.isArray(r.products) ? r.products[0] : r.products) as Join | null;
      return {
        id: r.id as string,
        product_id: r.product_id as string,
        product_name: p?.name ?? "(삭제된 품목)",
        sku: p?.sku ?? null,
        effective_date: String(r.effective_date).slice(0, 10),
        cost_material: Number(r.cost_material) || 0,
        pkg_inner: Number(r.pkg_inner) || 0,
        pkg_label: Number(r.pkg_label) || 0,
        pkg_outer: Number(r.pkg_outer) || 0,
        cost_price: Number(r.cost_price) || 0,
        memo: (r.memo as string) ?? null,
        applied_at: (r.applied_at as string) ?? null,
        created_by: (r.created_by as string) ?? null,
      };
    });
    return NextResponse.json({ ok: true, schedules });
  } catch (err) {
    console.error("[cost-schedules GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { product_id, effective_date, cost_material?, pkg_inner?, pkg_label?, pkg_outer?, cost_price?, memo? }
//  상세 합이 0 보다 크면 그 합이 원가가 된다(상품 마스터 입력 규칙과 동일) — DB 함수도 같은 규칙으로 반영한다.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const productId = String(b.product_id || "").trim();
    const date = String(b.effective_date || "");
    if (!productId) return NextResponse.json({ ok: false, error: "품목이 필요합니다." }, { status: 400 });
    if (!DATE_RE.test(date)) return NextResponse.json({ ok: false, error: "적용일이 올바르지 않습니다." }, { status: 400 });
    if (date < kstToday()) return NextResponse.json({ ok: false, error: "지난 날짜로는 예약할 수 없습니다." }, { status: 400 });

    const cm = num(b.cost_material), pi = num(b.pkg_inner), pl = num(b.pkg_label), po = num(b.pkg_outer);
    const detail = cm + pi + pl + po;
    const flat = num(b.cost_price);
    if (detail <= 0 && flat <= 0) {
      return NextResponse.json({ ok: false, error: "원가를 입력하세요 (상세 또는 직접 입력)." }, { status: 400 });
    }

    const { error } = await supabaseAdmin().from("product_cost_schedules").insert({
      product_id: productId, effective_date: date,
      cost_material: cm, pkg_inner: pi, pkg_label: pl, pkg_outer: po,
      cost_price: detail > 0 ? detail : flat,
      memo: String(b.memo || "").trim() || null,
      created_by: await actor(req),
    });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cost-schedules POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "예약 실패") }, { status: 500 });
  }
}

// DELETE ?id= — 아직 반영되지 않은 예약만 취소할 수 있다(반영된 건 원가 이력으로 남은 사실이다).
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const { data, error } = await supabaseAdmin()
      .from("product_cost_schedules").delete().eq("id", id).is("applied_at", null).select("id");
    if (error) throw error;
    if (!data?.length) return NextResponse.json({ ok: false, error: "이미 반영된 예약은 취소할 수 없습니다." }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cost-schedules DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}

// PATCH — 지금 바로 반영(대기 중이면서 오늘 이하인 예약). 크론을 기다리지 않고 밀어 넣을 때.
export async function PATCH() {
  try {
    const { data, error } = await supabaseAdmin().rpc("apply_due_cost_schedules");
    if (error) throw error;
    return NextResponse.json({ ok: true, applied: Number(data) || 0 });
  } catch (err) {
    console.error("[cost-schedules PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "반영 실패 — 마이그레이션 093 적용을 확인하세요.") }, { status: 500 });
  }
}
