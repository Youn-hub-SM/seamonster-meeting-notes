import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getAllBundles } from "@/app/lib/product-bundles";
import { getUntracked } from "@/app/lib/stock-tracked";

export const dynamic = "force-dynamic";

// 공용 상품 마스터(읽기 전용) — 생산·발주·VOC 등 모든 도구가 끌어다 쓰는 단일 소스.
// 편집은 /b2b/products(상품 마스터)에서. products 테이블이 단일 원본.
//
// 묶음(세트) 상품은 자기 cost_price·volume_kg 가 보통 0/미입력이라, 구성품 합으로 '치환'해서 내려줌
// (매출이익 RPC 와 동일 규칙: 구성품 중 부피 결측이 있으면 부피=null). 이래야 VOC 손해금액 자동계산 등이
// 묶음 상품에서도 실제 원가를 잡음. raw 값이 필요하면 /b2b/products(상품 마스터)를 사용.
export async function GET() {
  try {
    const sb = supabaseAdmin();
    // '재고 관리 사용 안함'(121) 표식 — 재고 이동 화면의 품목 고르기가 이 값으로 빼고(여기서 거르지 않는다),
    //  이동 POST 는 다시 확인하지 않는다. getUntracked 는 조회 오류를 던지고(121 미적용만 빈 집합, S4) 그대로 목록 전체 500 이다.
    //  표식만 빼고 ok 로 내리면 이동 화면이 표식 없는 품목을 '관리함'으로 보고 드라이아이스 등을 옮길 수 있다(fail open).
    //  이동 화면의 untracked_error 처리와 이동 POST 의 getUntracked 거절이 들어오기 전까지는 완화하지 않는다.
    // 전 품목 — 서버 Max Rows(1000)에 잘리면 뒤쪽 품목이 모든 도구의 고르기 목록에서 조용히 빠진다(S4). 이름·id 순으로 끝까지.
    type Row = { id: string; sku: string | null; name: string; spec: string | null; unit: string | null; sale_price: number | null; cost_price: number | null; volume_kg: number | null; active: boolean | null; attrs: unknown };
    const readAll = async (): Promise<Row[]> => {
      const out: Row[] = [];
      for (let off = 0; off < 100000; off += 1000) {
        const { data, error } = await sb.from("products").select("id, sku, name, spec, unit, sale_price, cost_price, volume_kg, active, attrs")
          .order("name", { ascending: true }).order("id", { ascending: true }).range(off, off + 999);
        if (error) throw error;
        out.push(...((data ?? []) as Row[]));
        if ((data ?? []).length < 1000) break;
      }
      return out;
    };
    const [all, bundles, untracked] = await Promise.all([
      readAll(),
      getAllBundles(sb), // parent_id → 구성품[] (037 미적용이면 빈 맵 → 치환 없음)
      getUntracked(sb), // 실패하면 던진다 → 아래 catch 에서 500(위 주석)
    ]);

    // 구성품 원가/부피 조회용 전체 맵(비활성 포함 — 구성품이 비활성일 수 있음)
    const byId = new Map<string, { cost: number; vol: number | null }>();
    for (const p of all) byId.set(p.id, { cost: Number(p.cost_price) || 0, vol: p.volume_kg == null ? null : Number(p.volume_kg) });

    // 묶음 부모 → 구성품 합(1레벨). 구성품 부피가 하나라도 결측이면 부피=null.
    const resolve = (id: string): { cost: number; vol: number | null } | null => {
      const comps = bundles.get(id);
      if (!comps) return null;
      let cost = 0, vol: number | null = 0, volMissing = false;
      for (const c of comps) {
        const co = byId.get(c.component_id);
        if (!co) { volMissing = true; continue; }
        cost += co.cost * c.qty;
        if (co.vol == null) volMissing = true;
        else if (vol != null) vol += co.vol * c.qty;
      }
      return { cost, vol: volMissing ? null : vol };
    };

    const products = all
      .filter((p) => p.active)
      .map((p) => {
        const r = resolve(p.id);
        const base = { ...p, stock_tracked: !untracked.ids.has(p.id) };
        return r ? { ...base, cost_price: r.cost, volume_kg: r.vol, is_bundle: true } : base;
      });
    return NextResponse.json({ ok: true, products });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "상품 조회 실패") }, { status: 500 });
  }
}
