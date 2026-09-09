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

    // 4) 리스팅 집계 (migration 105 RPC) + 어미상품 추정 (106 RPC — 부가 정보라 실패해도 리스팅은 반환)
    const rpcArgs = { p_skus: [...kindBySku.keys()], p_today: kstToday(), p_days: 365 };
    const [listRes, compRes] = await Promise.all([
      sb.rpc("sales_sku_listings", rpcArgs),
      sb.rpc("sales_sku_companions", rpcArgs),
    ]);
    if (listRes.error) {
      // 105 미적용 환경 폴백 — 죽는 대신 적용 안내(기존 패턴)
      if (/sales_sku_listings/i.test(listRes.error.message || "")) {
        return NextResponse.json(
          { ok: false, error: "마이그레이션 105(sales_sku_listings) 적용이 필요합니다." },
          { status: 503 }
        );
      }
      throw listRes.error;
    }

    // 어미상품 추정 — 같은 주문 동반율 40% 이상인 상위 2개만(일반 상품의 장바구니 동반 구매는
    //  비율이 낮아 자연히 걸러진다 → 네이버 추가상품처럼 늘 본상품과 함께 찍히는 리스팅에만 뜬다).
    //  106 미적용이면 compRes.error — 무시하고 리스팅만 반환.
    type CompRow = {
      channel: string; product_name: string; option_name: string; sku_code: string;
      companion_name: string; together_orders: number; total_orders: number;
    };
    const compKey = (r: { channel: string; product_name: string; option_name: string; sku_code: string }) =>
      [r.channel, r.product_name, r.option_name, r.sku_code].join("\u0001");
    const companionsByListing = new Map<string, { name: string; share: number }[]>();
    if (!compRes.error) {
      for (const r of (compRes.data ?? []) as CompRow[]) {
        const total = Number(r.total_orders) || 0;
        const share = total > 0 ? (Number(r.together_orders) || 0) / total : 0;
        if (share < 0.4) continue;
        const arr = companionsByListing.get(compKey(r)) ?? [];
        arr.push({ name: r.companion_name, share: Math.round(share * 100) });
        companionsByListing.set(compKey(r), arr);
      }
      // 동반율 상위 2개 확정 — RPC 반환 행 순서에 의존하지 않는다
      for (const [k, arr] of companionsByListing) {
        arr.sort((a, b) => b.share - a.share);
        companionsByListing.set(k, arr.slice(0, 2));
      }
    }

    const listings = ((listRes.data ?? []) as RpcRow[]).map((r) => {
      const m = kindBySku.get((r.sku_code || "").trim().toUpperCase());
      return {
        ...r,
        qty_7: Number(r.qty_7) || 0,
        qty_30: Number(r.qty_30) || 0,
        qty_window: Number(r.qty_window) || 0,
        via_bundle: m?.kind === "bundle",
        companions: companionsByListing.get(compKey(r)) ?? [],
      };
    });

    // 6) 채널 등록 카탈로그(107, 네이버 커머스API 동기화분) — 판매 이력 없는 리스팅까지 사실 기반.
    //  미적용·미동기화 환경이면 조용히 빈 배열(매출 기반 리스팅은 그대로 동작).
    type CatalogRow = {
      channel: string; item_key: string; origin_no: string;
      listing_name: string; item_kind: string; item_name: string | null;
      sku_code: string; sale_status: string | null; stock_qty: number | null; synced_at: string;
    };
    let catalog: (CatalogRow & { via_bundle: boolean })[] = [];
    let catalogSyncedAt: string | null = null;
    // 대소문자 무시 매칭 — 카탈로그의 관리코드는 채널 원문 그대로라 혼합 표기(Sm-a01)도 잡아야 한다.
    //  ilike 패턴이므로 와일드카드 문자(% _ \)는 이스케이프.
    const escLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
    const skuVariants = [...new Set(
      [prod.sku, ...bundles.map((b) => b.sku as string)]
        .filter((s): s is string => !!s && !!s.trim())
        .map((s) => escLike(s.trim()))
    )];
    const catRes = await sb
      .from("channel_catalog")
      .select("channel, item_key, origin_no, listing_name, item_kind, item_name, sku_code, sale_status, stock_qty, synced_at")
      .ilikeAnyOf("sku_code", skuVariants)
      .order("listing_name");
    if (!catRes.error) {
      catalog = ((catRes.data ?? []) as CatalogRow[]).map((r) => ({
        ...r,
        via_bundle: kindBySku.get((r.sku_code || "").trim().toUpperCase())?.kind === "bundle",
      }));
      for (const r of catalog) {
        if (!catalogSyncedAt || r.synced_at > catalogSyncedAt) catalogSyncedAt = r.synced_at;
      }
    }

    return NextResponse.json({
      ok: true,
      target: { id: prod.id, sku: prod.sku, name: prod.name, spec: prod.spec },
      bundles: bundles.map((b) => ({ sku: b.sku, name: b.name })),
      listings,
      catalog,
      catalog_synced_at: catalogSyncedAt,
    });
  } catch (err) {
    console.error("[sales/listings]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "리스팅 조회 실패") }, { status: 500 });
  }
}
