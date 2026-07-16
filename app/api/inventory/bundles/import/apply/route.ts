import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logProductChange } from "@/app/lib/b2b-activity";
import { notifyMasterChange } from "@/app/lib/master-notify";

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
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { bundles?: InBundle[] };
    const bundles = Array.isArray(body.bundles) ? body.bundles : [];
    if (!bundles.length) return NextResponse.json({ ok: false, error: "반영할 묶음이 없습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const { data: products, error } = await sb.from("products").select("id, sku, name").eq("active", true);
    if (error) throw error;
    const bySku = new Map<string, string[]>();
    for (const p of products ?? []) { const k = p.sku ? String(p.sku).trim() : ""; if (k) bySku.set(k, [...(bySku.get(k) || []), p.id]); }

    let applied = 0, created = 0;
    const errors: string[] = [];
    const appliedLabels: string[] = []; // 변경알림용 — 반영된 묶음 이름(SKU)

    for (const b of bundles) {
      const parentSku = String(b.parentSku || "").trim();
      const comps = (Array.isArray(b.components) ? b.components : []).map((c) => ({ sku: String(c.sku || "").trim(), qty: Math.max(1, Math.round(Number(c.qty) || 1)) })).filter((c) => c.sku);
      if (!parentSku || !comps.length) { errors.push(`${parentSku || "?"}: 정보 부족`); continue; }

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
        parentId = pIds[0];
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
        if (ins.error) { errors.push(`묶음SKU '${parentSku}' 생성 실패: ${ins.error.message}`); continue; }
        parentId = ins.data.id;
        bySku.set(parentSku, [parentId]);
        created++;
        await logProductChange("created", name, parentSku);
      }

      // 구성품 확인
      const rows: { parent_id: string; component_id: string; qty: number }[] = [];
      let compErr = "";
      for (const c of comps) {
        if (c.sku === parentSku) { compErr = "자기 자신을 구성품으로 넣을 수 없음"; break; }
        const ids = bySku.get(c.sku);
        if (!ids || ids.length === 0) { compErr = `구성품 '${c.sku}' 없음`; break; }
        if (ids.length > 1) { compErr = `구성품 '${c.sku}' 중복`; break; }
        rows.push({ parent_id: parentId, component_id: ids[0], qty: c.qty });
      }
      if (compErr) { errors.push(`${parentSku}: ${compErr}`); continue; }

      // 구성 교체
      const del = await sb.from("product_bundles").delete().eq("parent_id", parentId);
      if (del.error) { errors.push(`${parentSku}: ${del.error.message}`); continue; }
      const insb = await sb.from("product_bundles").insert(rows);
      if (insb.error) { errors.push(`${parentSku}: ${insb.error.message}`); continue; }
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
