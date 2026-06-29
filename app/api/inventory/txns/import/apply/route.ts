import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import type { ImportTxn } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inventory/txns/import/apply { rows: ImportTxn[] } — 미리보기에서 확인한 입출고를 일괄 기록.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: ImportTxn[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return NextResponse.json({ ok: false, error: "반영할 행이 없습니다." }, { status: 400 });
    const cookie = req.cookies.get("b2b_auth")?.value;
    const actor = (await verifySession(cookie)) || resolveUserName(cookie);

    const insert = rows
      .filter((r) => r && r.product_id && (r.type === "입고" || r.type === "출고") && Number(r.qty) !== 0)
      .map((r) => ({
        product_id: r.product_id,
        type: r.type,
        qty: Math.round(Number(r.qty)), // 미리보기에서 부호 적용됨
        unit_amount: r.unit_amount == null ? null : Math.max(0, Math.round(Number(r.unit_amount))),
        txn_date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.txn_date)) ? r.txn_date : undefined,
        partner: r.partner ? String(r.partner).slice(0, 200) : null,
        memo: r.memo ? String(r.memo).slice(0, 500) : null,
        created_by: actor,
      }));
    if (!insert.length) return NextResponse.json({ ok: false, error: "유효한 행이 없습니다." }, { status: 400 });

    const { error } = await supabaseAdmin().from("inventory_txns").insert(insert);
    if (error) throw error;
    return NextResponse.json({ ok: true, applied: insert.length });
  } catch (err) {
    console.error("[inventory/txns import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "적용 실패") }, { status: 500 });
  }
}
