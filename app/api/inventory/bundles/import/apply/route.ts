import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logProductChange } from "@/app/lib/b2b-activity";
import { notifyMasterChange } from "@/app/lib/master-notify";
import { replaceBundleComponents } from "@/app/lib/product-bundles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type InBundle = {
  parentSku?: string; name?: string;
  components?: { sku?: string; qty?: number }[];
  // 선택 — 상품마스터 재방문 없이 묶음 화면에서 한 번에 입력(비우면 기존값 유지)
  courier_name?: string;    // 택배 상품명(CNplus 품목명)
  courier_weight?: number;  // 택배 주문당 총중량(kg) — 박스타입/운임 구간 기준
  retail_price?: number;    // 소비자가
  sale_price?: number;      // B2B 도매가
};

// POST /api/inventory/bundles/import/apply { bundles: [{parentSku, name, components:[{sku, qty}], courier_name?, courier_weight?, retail_price?, sale_price?}] }
//  묶음 부모SKU 가 상품에 없으면 생성(택배·가격 필드 포함). 이미 있으면 '입력된 값만' 갱신. 구성 교체(전체 대체).
//  구성 교체는 replaceBundleComponents 한 곳(131 RPC — 한 트랜잭션)에서. 구성품 검증(없음·중복·미사용·같은 구성품 두 줄)은
//  부모 생성·갱신보다 먼저 해서, 잘못된 묶음 때문에 빈 세트 상품이 생기거나 기존 구성이 지워지지 않게 한다.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { bundles?: InBundle[] };
    const bundles = Array.isArray(body.bundles) ? body.bundles : [];
    if (!bundles.length) return NextResponse.json({ ok: false, error: "반영할 묶음이 없습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    // 비활성 포함 전체 조회 — SKU 는 유일(073)하므로 미사용 상품이 SKU 를 쥐고 있으면 생성 대신 안내해야 함
    const { data: products, error } = await sb.from("products").select("id, sku, name, active");
    if (error) throw error;
    const bySku = new Map<string, { id: string; active: boolean }[]>();
    for (const p of products ?? []) { const k = p.sku ? String(p.sku).trim() : ""; if (k) bySku.set(k, [...(bySku.get(k) || []), { id: p.id, active: p.active !== false }]); }

    let applied = 0, created = 0;
    const errors: string[] = [];
    const appliedLabels: string[] = []; // 변경알림용 — 반영된 묶음 이름(SKU)

    for (const b of bundles) {
      const parentSku = String(b.parentSku || "").trim();
      const comps = (Array.isArray(b.components) ? b.components : []).map((c) => ({ sku: String(c.sku || "").trim(), qty: Math.max(1, Math.round(Number(c.qty) || 1)) })).filter((c) => c.sku);
      if (!parentSku || !comps.length) { errors.push(`${parentSku || "?"}: 정보 부족`); continue; }

      // 구성품 확인 — 부모를 만들거나 고치기 전에(실패한 묶음이 빈 세트 상품·구성 삭제를 남기지 않게)
      const compRows: { component_id: string; qty: number; sku: string }[] = [];
      let compErr = "";
      const seenSku = new Set<string>();
      for (const c of comps) {
        if (c.sku === parentSku) { compErr = "자기 자신을 구성품으로 넣을 수 없음"; break; }
        if (seenSku.has(c.sku)) { compErr = `구성품 '${c.sku}' 가 두 줄 — 한 줄로 합치세요`; break; }
        seenSku.add(c.sku);
        const ids = bySku.get(c.sku);
        if (!ids || ids.length === 0) { compErr = `구성품 '${c.sku}' 없음`; break; }
        if (ids.length > 1) { compErr = `구성품 '${c.sku}' 중복`; break; }
        if (!ids[0].active) { compErr = `구성품 '${c.sku}' 는 미사용 상품`; break; }
        compRows.push({ component_id: ids[0].id, qty: c.qty, sku: c.sku });
      }
      if (compErr) { errors.push(`${parentSku}: ${compErr}`); continue; }

      // 선택 필드(택배·가격) — 입력된 것만 반영(빈값/0 은 기존값 유지)
      const extras: Record<string, unknown> = {};
      const cn = String(b.courier_name || "").trim();
      if (cn) extras.courier_name = cn.slice(0, 100);
      if (Number(b.courier_weight) > 0) extras.courier_weight = Number(b.courier_weight);
      if (Number(b.retail_price) > 0) extras.retail_price = Math.round(Number(b.retail_price));
      if (Number(b.sale_price) > 0) extras.sale_price = Math.round(Number(b.sale_price));

      // 부모 확인/생성
      let parentId: string;
      const pIds = bySku.get(parentSku);
      if (pIds && pIds.length === 1) {
        if (!pIds[0].active) { errors.push(`묶음SKU '${parentSku}' 는 미사용 처리된 상품입니다 — 상품마스터에서 사용 처리 후 다시 반영하세요.`); continue; }
        parentId = pIds[0].id;
        // 기존 부모 — 입력된 택배·가격 필드만 갱신(054/028 미적용이면 해당 컬럼 빼고 재시도)
        if (Object.keys(extras).length > 0) {
          let up = await sb.from("products").update(extras).eq("id", parentId);
          for (let g = 0; up.error && g < 3; g++) {
            const miss = (["courier_name", "courier_weight", "retail_price"] as const).find((k) => k in extras && new RegExp(k, "i").test(up.error!.message));
            if (!miss) break;
            delete extras[miss];
            if (!Object.keys(extras).length) break;
            up = await sb.from("products").update(extras).eq("id", parentId);
          }
        }
      }
      else if (pIds && pIds.length > 1) { errors.push(`묶음SKU '${parentSku}' 중복 — 건너뜀`); continue; }
      else {
        const name = String(b.name || "").trim() || parentSku;
        const insertRow: Record<string, unknown> = { sku: parentSku, name, unit: "개", cost_price: 0, sale_price: 0, tax_type: "taxable", active: true, ...extras };
        let ins = await sb.from("products").insert(insertRow).select("id").single();
        for (let g = 0; ins.error && g < 3; g++) {
          const miss = (["courier_name", "courier_weight", "retail_price"] as const).find((k) => k in insertRow && new RegExp(k, "i").test(ins.error!.message));
          if (!miss) break;
          delete insertRow[miss];
          ins = await sb.from("products").insert(insertRow).select("id").single();
        }
        if (ins.error) {
          if (ins.error.code === "23505") errors.push(`묶음SKU '${parentSku}' 는 이미 다른 상품(대소문자 차이 포함)이 사용 중입니다.`);
          else errors.push(`묶음SKU '${parentSku}' 생성 실패: ${ins.error.message}`);
          continue;
        }
        parentId = ins.data.id;
        bySku.set(parentSku, [{ id: parentId, active: true }]);
        created++;
        await logProductChange("created", name, parentSku);
      }

      // 구성 교체 — 검증·순환 검사·삭제·넣기가 한 번에(실패하면 기존 구성 그대로)
      const skuOf = new Map(compRows.map((r) => [r.component_id, r.sku]));
      const rr = await replaceBundleComponents(sb, parentId, compRows.map((r) => ({ component_id: r.component_id, qty: r.qty })), (id) => `'${skuOf.get(id) || id}'`);
      if (!rr.ok) { errors.push(`${parentSku}: ${rr.error}`); continue; }
      applied++;
      appliedLabels.push(`${String(b.name || "").trim() || parentSku} (${parentSku}) — 구성 ${comps.length}종`);
    }

    if (applied > 0) {
      await notifyMasterChange("bundle", [
        `묶음 구성 변경 — ${applied}건${created > 0 ? ` (신규 세트 ${created}개)` : ""}`,
        ...appliedLabels.slice(0, 10).map((s) => `- ${s}`),
        ...(appliedLabels.length > 10 ? [`외 ${appliedLabels.length - 10}건`] : []),
      ]);
    }

    return NextResponse.json({ ok: errors.length === 0, applied, created, errors });
  } catch (err) {
    console.error("[bundles/import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "묶음 반영 실패") }, { status: 500 });
  }
}
