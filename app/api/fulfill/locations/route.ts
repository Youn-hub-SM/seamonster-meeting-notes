import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getPickZones, savePickZones } from "@/app/lib/pick-zones";
import { getAllBundles } from "@/app/lib/product-bundles";
import { bustScanMapCache } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 창고 위치(픽업 구역) 관리 — 송장 스캔 피킹 리스트의 동선 정렬용.
//  · GET: 구역 목록(걷는 순서) + 품목 목록(구역 배정 포함, 묶음세트 제외 — 세트는 구성품 위치를 따라감)
//  · PUT: 구역 목록 저장 { zones: string[] }
//  · PATCH: 품목 구역 배정 { product_id, zone: string|null }
//  products.pick_zone 은 migration 117. 미적용이면 배정 저장에서 안내 에러.

type ProdRow = { id: string; sku: string | null; name: string; active: boolean | null; pick_zone?: string | null };

export async function GET() {
  try {
    const sb = supabaseAdmin();
    const [zones, bundles] = await Promise.all([getPickZones(sb), getAllBundles(sb)]);
    // pick_zone(117) 미적용이어도 화면이 뜨게 폴백 — 배정값만 비어 보임.
    let zoneCol = true;
    let rows: ProdRow[];
    const q1 = await sb.from("products").select("id, sku, name, active, pick_zone")
      .order("active", { ascending: false }).order("name", { ascending: true });
    if (q1.error) {
      // 컬럼 문제(42703/PGRST204 — 메시지에 pick_zone)일 때만 117 미적용으로 판단.
      // 네트워크 등 다른 에러를 미적용으로 오판하면 배정값이 전부 '미지정'으로 보이고 저장이 잠긴다.
      if (!/pick_zone/i.test(extractErrorMsg(q1.error, ""))) throw q1.error;
      zoneCol = false;
      const q2 = await sb.from("products").select("id, sku, name, active")
        .order("active", { ascending: false }).order("name", { ascending: true });
      if (q2.error) throw q2.error;
      rows = (q2.data as ProdRow[] | null) ?? [];
    } else {
      rows = (q1.data as ProdRow[] | null) ?? [];
    }
    const products = rows
      .filter((p) => !bundles.has(p.id)) // 묶음세트는 자체 위치가 없음
      .map((p) => ({ id: p.id, sku: p.sku, name: p.name, active: p.active !== false, pick_zone: p.pick_zone ?? null }));
    return NextResponse.json({ ok: true, zones, products, zoneCol });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { zones?: unknown };
    if (!Array.isArray(body.zones)) return NextResponse.json({ ok: false, error: "zones 배열이 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const zones = await savePickZones(sb, body.zones as string[]);
    bustScanMapCache();
    return NextResponse.json({ ok: true, zones });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { product_id?: string; zone?: string | null };
    const id = String(body.product_id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "product_id 가 필요합니다." }, { status: 400 });
    const zone = body.zone == null ? null : String(body.zone).trim().slice(0, 40) || null;
    const sb = supabaseAdmin();
    const { error } = await sb.from("products").update({ pick_zone: zone }).eq("id", id);
    if (error) {
      const msg = extractErrorMsg(error, "저장 실패");
      if (/pick_zone/i.test(msg)) {
        return NextResponse.json({ ok: false, error: "migration 117 을 먼저 적용하세요 (products.pick_zone 없음)" }, { status: 400 });
      }
      throw error;
    }
    bustScanMapCache();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}
