import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHANNELS = ["도매", "소매"] as const;
const MARK = "채널이동"; // partner 필드에 마커로 넣어 이동 내역을 구분·조회

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// GET ?limit= — 최근 옮긴 내역(그룹 단위)
export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 50));
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("inventory_txns")
      .select("id, product_id, type, qty, channel, txn_date, memo, group_id, created_at, created_by, products:product_id(name, sku)")
      .eq("partner", MARK)
      .order("created_at", { ascending: false })
      .limit(limit * 2); // 이동 1건 = 출고+입고 2행
    if (error) throw error;

    // group_id 로 짝지어 이동 1건으로 합침
    type Leg = { id: string; product_id: string; type: string; qty: number; channel: string; txn_date: string; memo: string | null; group_id: string | null; created_at: string; created_by: string | null; products: { name?: string; sku?: string | null } | { name?: string; sku?: string | null }[] | null };
    const byGroup = new Map<string, Leg[]>();
    for (const r of (data as unknown as Leg[]) ?? []) {
      const k = r.group_id || r.id;
      byGroup.set(k, [...(byGroup.get(k) || []), r]);
    }
    const moves = [...byGroup.entries()].map(([group_id, legs]) => {
      const out = legs.find((l) => l.type === "출고");
      const inn = legs.find((l) => l.type === "입고");
      const p = (inn || out)?.products;
      const prod = Array.isArray(p) ? p[0] : p;
      return {
        group_id,
        product_name: prod?.name || "(품목?)",
        sku: prod?.sku || null,
        qty: Math.abs(Number((inn || out)?.qty) || 0),
        from: out?.channel || "?",
        to: inn?.channel || "?",
        txn_date: (inn || out)?.txn_date || "",
        memo: (inn || out)?.memo || null,
        created_at: (inn || out)?.created_at || "",
        created_by: (inn || out)?.created_by || null,
        complete: !!(out && inn),
      };
    }).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);

    return NextResponse.json({ ok: true, moves });
  } catch (err) {
    console.error("[inventory/move GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { product_id, from, to, qty, txn_date?, memo? } — 한 품목을 from채널 재고 → to채널 재고로 이동.
//  출고(from, −) + 입고(to, +) 두 행을 같은 group_id 로 묶어 한 번에 기록(원자적, 취소 시 함께 삭제).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const product_id = String(b.product_id || "");
    const from = String(b.from || "");
    const to = String(b.to || "");
    const qty = Math.round((Number(b.qty) || 0) * 100) / 100;
    if (!product_id) return NextResponse.json({ ok: false, error: "품목을 선택하세요." }, { status: 400 });
    if (!CHANNELS.includes(from as never) || !CHANNELS.includes(to as never)) return NextResponse.json({ ok: false, error: "채널이 올바르지 않습니다." }, { status: 400 });
    if (from === to) return NextResponse.json({ ok: false, error: "옮길 채널이 서로 달라야 합니다." }, { status: 400 });
    if (qty <= 0) return NextResponse.json({ ok: false, error: "옮길 수량을 입력하세요." }, { status: 400 });

    const txn_date = DATE_RE.test(String(b.txn_date || "")) ? String(b.txn_date) : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const memo = String(b.memo || "").trim() || null;
    const group_id = crypto.randomUUID();
    const created_by = await actor(req);
    const base = { product_id, partner: MARK, memo, group_id, txn_date, status: "완료", created_by };

    const sb = supabaseAdmin();
    const { data, error } = await sb.from("inventory_txns").insert([
      { ...base, type: "출고", qty: -qty, channel: from, unit_amount: null },
      { ...base, type: "입고", qty: qty, channel: to, unit_amount: null },
    ]).select("id");
    if (error) {
      if (/channel/i.test(error.message)) return NextResponse.json({ ok: false, error: "채널 컬럼이 없습니다 — migration 036 을 먼저 적용하세요." }, { status: 500 });
      throw error;
    }
    return NextResponse.json({ ok: true, group_id, count: data?.length ?? 0 });
  } catch (err) {
    console.error("[inventory/move POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "이동 실패") }, { status: 500 });
  }
}

// DELETE ?group_id= — 이동 취소(양쪽 채널 원복). 마커가 채널이동인 행만 삭제.
export async function DELETE(req: NextRequest) {
  try {
    const group_id = req.nextUrl.searchParams.get("group_id");
    if (!group_id) return NextResponse.json({ ok: false, error: "group_id 가 필요합니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("inventory_txns").delete().eq("group_id", group_id).eq("partner", MARK);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/move DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
