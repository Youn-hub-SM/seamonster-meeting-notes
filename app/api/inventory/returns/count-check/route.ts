import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getAllBundles, expandBundleQty } from "@/app/lib/product-bundles";

export const dynamic = "force-dynamic";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/inventory/returns/count-check { rows: [{ product_id, date }] } — 반품 창 [재고에서도 빼기] 직전 가드(S8·S12).
//  반품일(그날 포함) 뒤에 그 품목의 소매 실사(조정)가 있으면 실사가 이미 실물 감소를 반영했을 수 있다 — 반품일로 소급 출고하면
//  이중 차감이다(월말 뒤에 하는 지난 달 결산에서 흔한 순서). 그런 품목을 돌려준다(count_date = 가장 늦은 실사일).
//  세트면 구성품의 실사를 본다(출고도 구성품으로 전개돼 기록된다). 조회 실패는 500 — 화면은 출고를 막는다(S4).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { rows?: { product_id?: unknown; date?: unknown }[] };
    const rows = (Array.isArray(b.rows) ? b.rows : [])
      .map((r) => ({ product_id: String(r?.product_id || ""), date: String(r?.date || "") }))
      .filter((r) => r.product_id && DATE_RE.test(r.date));
    if (!rows.length) return NextResponse.json({ ok: true, held: [] });

    const sb = supabaseAdmin();
    const bundles = await getAllBundles(sb); // 읽기 실패는 던진다 — '세트 없음'으로 보고 확인을 건너뛰지 않는다
    const compsOf = new Map<string, string[]>();
    for (const r of rows) if (!compsOf.has(r.product_id)) compsOf.set(r.product_id, [...expandBundleQty(bundles, r.product_id, 1).keys()]);
    const ids = [...new Set([...compsOf.values()].flat())];
    const minDate = rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date);

    const latest = new Map<string, string>(); // 품목 → 가장 이른 반품일 이후 가장 늦은 실사일
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      for (let off = 0; ; off += 1000) {
        const { data, error } = await sb.from("inventory_txns").select("product_id, txn_date")
          .eq("type", "조정").eq("channel", "소매").in("product_id", part).gte("txn_date", minDate)
          .order("id", { ascending: true }).range(off, off + 999);
        if (error) throw error;
        for (const t of data ?? []) {
          const pid = String(t.product_id), d = String(t.txn_date).slice(0, 10);
          if (!latest.has(pid) || String(latest.get(pid)) < d) latest.set(pid, d);
        }
        if ((data ?? []).length < 1000) break;
      }
    }

    const held: { product_id: string; date: string; count_date: string }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.product_id}|${r.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      let cd = "";
      for (const c of compsOf.get(r.product_id) ?? []) { const d = latest.get(c); if (d && d >= r.date && d > cd) cd = d; }
      if (cd) held.push({ product_id: r.product_id, date: r.date, count_date: cd });
    }
    return NextResponse.json({ ok: true, held });
  } catch (err) {
    console.error("[inventory/returns count-check]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "실사 기록 확인 실패") }, { status: 500 });
  }
}
