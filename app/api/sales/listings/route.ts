import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/sales/listings?product_id=<uuid>
//  선택 상품의 SKU + 그 상품을 구성품으로 갖는 묶음들의 SKU 가 매출원장(sales_orders)에 등장한
//  채널별 리스팅(판매처·상품명·옵션명·관리코드)과 최근 판매량(7일/30일/1년·마지막 판매일)을 돌려준다.
//  구성품이 품절이면 그 구성품이 든 묶음 리스팅도 내려야 하므로 묶음까지 자동 전개한다.
//  데이터원이 매출이라 판매 이력이 없는 리스팅은 나오지 않는다(집계 창 365일).

type RpcRow = {
  channel: string;
  product_name: string;
  option_name: string;
  sku_code: string;
  qty_7: number;
  qty_30: number;
  qty_window: number;
  last_sale: string | null;
};

const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export async function GET(req: NextRequest) {
  try {
    const productId = new URL(req.url).searchParams.get("product_id") || "";
    if (!productId) {
      return NextResponse.json({ ok: false, error: "product_id 가 필요합니다." }, { status: 400 });
    }

    const sb = supabaseAdmin();

    // 1) 대상 상품
    const { data: prod, error: pErr } = await sb
      .from("products")
      .select("id, sku, name, spec")
      .eq("id", productId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!prod) {
      return NextResponse.json({ ok: false, error: "상품을 찾을 수 없습니다." }, { status: 404 });
    }
    if (!(prod.sku || "").trim()) {
      return NextResponse.json({ ok: false, error: "이 상품은 상품마스터에 SKU 가 없어 검색할 수 없습니다." }, { status: 400 });
    }

    // 2) 이 상품을 구성품으로 갖는 묶음들 — 구성품 품절 시 묶음 리스팅도 조치 대상.
    //  중첩 묶음(묶음 안의 묶음)까지 상향으로 재귀 수집 — expandBundleQty(하향 재귀, depth 8)와 대칭 규칙.
    const { data: allLinks, error: bErr } = await sb.from("product_bundles").select("parent_id, component_id");
    if (bErr) throw bErr;
    const parentsOf = new Map<string, string[]>();
    for (const l of allLinks ?? []) {
      const arr = parentsOf.get(l.component_id as string) ?? [];
      arr.push(l.parent_id as string);
      parentsOf.set(l.component_id as string, arr);
    }
    const ancestorIds = new Set<string>();
    let frontier = [productId];
    for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const pid of parentsOf.get(id) ?? []) {
          if (!ancestorIds.has(pid) && pid !== productId) { ancestorIds.add(pid); next.push(pid); }
        }
      }
      frontier = next;
    }
    type ParentJoin = { id: string; sku: string | null; name: string };
    let bundles: ParentJoin[] = [];
    if (ancestorIds.size > 0) {
      const { data: bundleProds, error: bpErr } = await sb
        .from("products")
        .select("id, sku, name")
        .in("id", [...ancestorIds]);
      if (bpErr) throw bpErr;
      bundles = ((bundleProds ?? []) as ParentJoin[]).filter((p) => !!(p.sku || "").trim());
    }

    // 3) 검색 SKU 집합(대문자 정규화) — 어느 SKU 가 묶음 매칭인지 화면 표시용으로 기억
    const kindBySku = new Map<string, { kind: "self" | "bundle"; bundle_name?: string }>();
    kindBySku.set(prod.sku.trim().toUpperCase(), { kind: "self" });
    for (const b of bundles) {
      const key = (b.sku as string).trim().toUpperCase();
      if (!kindBySku.has(key)) kindBySku.set(key, { kind: "bundle", bundle_name: b.name });
    }

    // 4) 리스팅 집계 (migration 105 RPC)
    const { data, error: rErr } = await sb.rpc("sales_sku_listings", {
      p_skus: [...kindBySku.keys()],
      p_today: kstToday(),
      p_days: 365,
    });
    if (rErr) {
      // 105 미적용 환경 폴백 — 죽는 대신 적용 안내(기존 패턴)
      if (/sales_sku_listings/i.test(rErr.message || "")) {
        return NextResponse.json(
          { ok: false, error: "마이그레이션 105(sales_sku_listings) 적용이 필요합니다." },
          { status: 503 }
        );
      }
      throw rErr;
    }

    const listings = ((data ?? []) as RpcRow[]).map((r) => {
      const m = kindBySku.get((r.sku_code || "").trim().toUpperCase());
      return {
        ...r,
        qty_7: Number(r.qty_7) || 0,
        qty_30: Number(r.qty_30) || 0,
        qty_window: Number(r.qty_window) || 0,
        via_bundle: m?.kind === "bundle",
      };
    });

    return NextResponse.json({
      ok: true,
      target: { id: prod.id, sku: prod.sku, name: prod.name, spec: prod.spec },
      bundles: bundles.map((b) => ({ sku: b.sku, name: b.name })),
      listings,
    });
  } catch (err) {
    console.error("[sales/listings]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "리스팅 조회 실패") }, { status: 500 });
  }
}
