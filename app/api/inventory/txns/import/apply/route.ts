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
    const body = (await req.json()) as { rows?: ImportTxn[]; done?: boolean; channel?: string };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const status = body.done === false ? "대기" : "완료"; // 즉시처리 미체크면 대기
    const channel = body.channel === "도매" ? "도매" : "소매"; // 036, 기본 소매
    if (!rows.length) return NextResponse.json({ ok: false, error: "반영할 행이 없습니다." }, { status: 400 });
    const cookie = req.cookies.get("b2b_auth")?.value;
    const actor = (await verifySession(cookie)) || resolveUserName(cookie);

    const sb = supabaseAdmin();
    const valid = rows.filter((r) => r && r.product_id && (r.type === "입고" || r.type === "출고") && Number(r.qty) !== 0);
    if (!valid.length) return NextResponse.json({ ok: false, error: "유효한 행이 없습니다." }, { status: 400 });

    // 유형별로 주문번호(IN-/OUT-) + group_id 부여. migration 033 미적용이면 묶음 없이 진행(폴백).
    const orderByType = new Map<string, { group_id: string; order_no: string }>();
    for (const t of new Set(valid.map((r) => r.type))) {
      try {
        const { data, error } = await sb.rpc("next_inventory_order_no", { p_type: t });
        if (error || !data) throw error || new Error("no order_no");
        orderByType.set(t, { group_id: crypto.randomUUID(), order_no: String(data) });
      } catch { /* 033 미적용 — 묶음 생략 */ }
    }

    const insert: Record<string, unknown>[] = valid.map((r) => {
      const grp = orderByType.get(r.type);
      return {
        product_id: r.product_id,
        type: r.type,
        channel,
        qty: Math.round(Number(r.qty)),
        unit_amount: r.unit_amount == null ? null : Math.max(0, Math.round(Number(r.unit_amount))),
        txn_date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.txn_date)) ? r.txn_date : undefined,
        partner: r.partner ? String(r.partner).slice(0, 200) : null,
        memo: r.memo ? String(r.memo).slice(0, 500) : null,
        created_by: actor,
        status,
        ...(grp ? { group_id: grp.group_id, order_no: grp.order_no } : {}),
      };
    });

    // 선택 컬럼(status=034, channel=036) 미적용 환경이면 그 컬럼만 빼고 재시도. group/order 는 rpc 성공 시에만 추가돼 안전.
    let ins = await sb.from("inventory_txns").insert(insert);
    for (let guard = 0; ins.error && guard < 2; guard++) {
      const miss = (["channel", "status"] as const).find((c) => new RegExp(c, "i").test(ins.error!.message));
      if (!miss) break;
      for (const row of insert) delete row[miss];
      ins = await sb.from("inventory_txns").insert(insert);
    }
    if (ins.error) throw ins.error;
    return NextResponse.json({ ok: true, applied: insert.length, status, orders: [...orderByType.values()].map((o) => o.order_no) });
  } catch (err) {
    console.error("[inventory/txns import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "적용 실패") }, { status: 500 });
  }
}
