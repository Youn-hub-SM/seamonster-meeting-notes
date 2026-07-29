import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { txn_ids: string[] } — 각 거래 시점의 재고 변동(전 → 후)을 계산.
//  기준: 같은 품목·같은 채널의 '완료' 원장을 (created_at, id) 순으로 누적한 잔고.
//  after = 해당 거래까지 누적 합, before = after − qty. '대기' 거래는 재고 미반영이라 제외(null).
//  입고/출고 세부 내역의 "몇 개에서 몇 개로" 표시용 — 조회 전용, 쓰기 없음.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { txn_ids?: unknown };
    const ids = (Array.isArray(b.txn_ids) ? b.txn_ids : []).map(String).filter(Boolean).slice(0, 200);
    if (!ids.length) return NextResponse.json({ ok: false, error: "txn_ids 가 필요합니다." }, { status: 400 });

    const sb = supabaseAdmin();
    const withCh = await sb.from("inventory_txns").select("id, product_id, channel, qty, status, created_at").in("id", ids);
    const targetRes = withCh.error && /channel/i.test(withCh.error.message)
      ? await sb.from("inventory_txns").select("id, product_id, qty, status, created_at").in("id", ids) // 036 미적용 폴백
      : withCh;
    if (targetRes.error) throw targetRes.error;
    type Txn = { id: string; product_id: string; channel?: string | null; qty: number; status?: string | null; created_at: string };
    const targets = (targetRes.data ?? []) as Txn[];

    const balances: Record<string, { before: number; after: number } | null> = {};
    // (품목, 채널) 묶음별로 완료 원장 전체를 한 번에 가져와 JS 누적 — 품목당 수백 행 수준이라 충분히 가볍다.
    const groups = new Map<string, Txn[]>();
    for (const t of targets) groups.set(`${t.product_id}|${t.channel ?? ""}`, [...(groups.get(`${t.product_id}|${t.channel ?? ""}`) || []), t]);

    for (const [key, list] of groups) {
      const [pid, ch] = key.split("|");
      let q = sb.from("inventory_txns").select("id, qty, status, created_at").eq("product_id", pid);
      if (ch) q = q.eq("channel", ch);
      const { data, error } = await q.limit(20000);
      if (error) { for (const t of list) balances[t.id] = null; continue; }
      const rows = ((data ?? []) as Txn[])
        .filter((r) => r.status == null || r.status === "완료")
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      let run = 0;
      const afterById = new Map<string, number>();
      for (const r of rows) { run += Number(r.qty) || 0; afterById.set(r.id, run); }
      for (const t of list) {
        if (t.status != null && t.status !== "완료") { balances[t.id] = null; continue; } // 대기 = 재고 미반영
        const after = afterById.get(t.id);
        balances[t.id] = after === undefined ? null : { before: Math.round((after - (Number(t.qty) || 0)) * 100) / 100, after: Math.round(after * 100) / 100 };
      }
    }
    return NextResponse.json({ ok: true, balances });
  } catch (err) {
    console.error("[inventory/orders/balance]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "잔고 계산 실패") }, { status: 500 });
  }
}
