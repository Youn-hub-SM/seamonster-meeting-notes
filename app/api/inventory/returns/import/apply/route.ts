import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import type { ImportReturn } from "../route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// POST { rows, return_date, partner? } — 미리보기에서 확인한 반품 행을 저장.
//  미리보기가 이미 SKU 매칭·합산을 끝냈으므로 여기서는 값만 검사해 넣는다.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { rows?: ImportReturn[]; return_date?: string; partner?: string };
    const date = String(b.return_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ ok: false, error: "반품일이 올바르지 않습니다." }, { status: 400 });
    }
    const partner = String(b.partner || "").trim() || null;
    const who = await actor(req);

    const rows = (Array.isArray(b.rows) ? b.rows : [])
      .map((r) => ({
        product_id: String(r.product_id || ""),
        return_date: date,
        qty: Math.round((Number(r.qty) || 0) * 100) / 100,
        unit_amount: Number(r.unit_amount) > 0 ? Math.round(Number(r.unit_amount)) : null,
        partner,
        memo: r.memo ? String(r.memo) : null,
        created_by: who,
      }))
      .filter((r) => r.product_id && r.qty > 0);
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "반영할 행이 없습니다." }, { status: 400 });

    const { data: ins, error } = await supabaseAdmin().from("purchase_returns").insert(rows).select("id, product_id, qty, return_date");
    if (error) throw error;
    // 저장된 행(id) — 화면의 '재고에서도 빼기'가 반품마다 id 를 제출 키로 같은 품목·수량·날짜 출고를 남긴다(반품 삭제가 이 키로 출고를 찾는다)
    return NextResponse.json({ ok: true, inserted: rows.length, rows: ins ?? [] });
  } catch (err) {
    console.error("[inventory/returns/import/apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "반영 실패") }, { status: 500 });
  }
}
