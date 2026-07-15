import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { INV_TXN_TYPES, signedQty, type InvTxnType } from "@/app/lib/inventory";
import { getAllBundles, expandBundleQty, isBundleId } from "@/app/lib/product-bundles";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// POST { product_id, type, qty, unit_amount?, txn_date?, partner?, memo? } — 입고/출고/조정 기록.
//  입고/출고는 qty 양수(수량), 조정은 부호 있는 델타(목표수량-현재수량을 UI 에서 계산해 전달).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const product_id = String(b.product_id || "");
    const type = String(b.type || "") as InvTxnType;
    if (!product_id) return NextResponse.json({ ok: false, error: "품목을 선택하세요." }, { status: 400 });
    if (!INV_TXN_TYPES.includes(type)) return NextResponse.json({ ok: false, error: "유형이 올바르지 않습니다." }, { status: 400 });
    const qty = signedQty(type, Number(b.qty) || 0);
    if (qty === 0) return NextResponse.json({ ok: false, error: "수량을 입력하세요." }, { status: 400 });
    const txn_date = DATE_RE.test(String(b.txn_date || "")) ? String(b.txn_date) : undefined;

    const sb = supabaseAdmin();
    // 묶음(세트)은 자체 재고가 없다 → 입고/출고는 구성품으로 전개해 기록(다른 경로와 동일 규칙),
    //  조정은 파생값이라 조정 대상이 될 수 없으므로 막는다.
    const bundles = await getAllBundles(sb);
    const isSet = isBundleId(bundles, product_id);
    if (isSet && type === "조정")
      return NextResponse.json({ ok: false, error: "묶음(세트)은 자체 재고가 없어 조정할 수 없습니다. 구성품의 재고를 조정하세요." }, { status: 400 });

    const row: Record<string, unknown> = {
      product_id, type, qty,
      channel: b.channel === "도매" ? "도매" : "소매", // 036, 기본 소매
      unit_amount: b.unit_amount === undefined || b.unit_amount === "" || b.unit_amount === null ? null : Math.max(0, Math.round(Number(b.unit_amount) || 0)),
      partner: String(b.partner || "").trim() || null,
      memo: String(b.memo || "").trim() || null,
      created_by: await actor(req),
    };
    if (txn_date) row.txn_date = txn_date;
    // 입고/출고 단건도 주문번호 부여(033 미적용이면 생략). 즉시처리 미체크면 대기.
    if (type === "입고" || type === "출고") {
      row.status = b.done === false ? "대기" : "완료";
      try {
        const { data, error } = await sb.rpc("next_inventory_order_no", { p_type: type });
        if (!error && data) { row.group_id = crypto.randomUUID(); row.order_no = String(data); }
      } catch { /* 033 미적용 */ }
    }

    // 세트면 구성품 여러 행으로, 아니면 그대로 1행. 같은 group_id/order_no 로 묶여 한 거래로 남는다.
    const per = expandBundleQty(bundles, product_id, Math.abs(Number(b.qty) || 0));
    const attempt: Record<string, unknown>[] = [...per.entries()].map(([pid, q]) => ({
      ...row,
      product_id: pid,
      qty: signedQty(type, q),
      ...(isSet ? { unit_amount: null, memo: [row.memo, "세트 분해"].filter(Boolean).join(" ") } : {}),
    }));

    // 선택 컬럼(status=034, channel=036) 미적용 환경이면 그 컬럼만 빼고 재시도.
    let res = await sb.from("inventory_txns").insert(attempt).select();
    for (let guard = 0; res.error && guard < 2; guard++) {
      const miss = (["channel", "status"] as const).find((c) => c in attempt[0] && new RegExp(c, "i").test(res.error!.message));
      if (!miss) break;
      for (const r of attempt) delete r[miss];
      res = await sb.from("inventory_txns").insert(attempt).select();
    }
    if (res.error) throw res.error;
    return NextResponse.json({ ok: true, txn: res.data?.[0] ?? null, txns: res.data });
  } catch (err) {
    console.error("[inventory/txn POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "기록 실패") }, { status: 500 });
  }
}

// DELETE ?id= — 거래 취소(원장에서 삭제 = 현재고 원복)
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    // 생산요청 입고와 연결된 도매 입고 원장은 여기서 못 지운다(정합성 보호) → 생산요청서에서 취소.
    //  (069 미적용 환경이면 count=null 로 통과)
    const { count } = await sb.from("production_receipts").select("id", { count: "exact", head: true }).eq("inv_txn_id", id);
    if ((count ?? 0) > 0)
      return NextResponse.json({ ok: false, error: "이 입고는 생산요청 입고와 연결되어 있어 여기서 취소할 수 없습니다. 생산요청서에서 입고를 취소하세요." }, { status: 400 });
    const { error } = await sb.from("inventory_txns").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/txn DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
