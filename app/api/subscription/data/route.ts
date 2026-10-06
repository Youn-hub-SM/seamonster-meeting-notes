import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getKv } from "@/app/lib/b2b-settings";
import { toDashboardRows, isMissingTable, SYNC_KV, type SubRow, type ItemRow } from "@/app/lib/subscription-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/subscription/data — 정기배송 분석 화면이 열릴 때 자동으로 불러오는 카페24 수집 데이터(127).
//  카페24 관리자 CSV 와 같은 열의 행으로 돌려준다(이름·연락처 없음, 아이디·이름은 암호화 값). 로그인 사용자만(미들웨어).
//  미적용·수집 전이면 ok:true, rows:[] — 화면은 예전처럼 CSV 업로드를 기다린다.
async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw error;
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export async function GET() {
  try {
    const sb = supabaseAdmin();
    let subs: SubRow[], items: ItemRow[];
    try {
      [subs, items] = await Promise.all([
        pageAll<SubRow>((a, b) => sb.from("cafe24_subscriptions").select("*").order("subscription_id").range(a, b)),
        pageAll<ItemRow>((a, b) => sb.from("cafe24_subscription_items").select("*").order("subscription_item_id").range(a, b)),
      ]);
    } catch (e) {
      if (isMissingTable(e as { message?: string })) return NextResponse.json({ ok: true, rows: [], notApplied: true });
      throw e;
    }
    let last: { at?: string; asOf?: string; complete?: boolean } | null = null;
    try { const raw = await getKv(SYNC_KV); last = raw ? JSON.parse(raw) : null; } catch { /* 요약 없이 */ }
    return NextResponse.json({ ok: true, rows: toDashboardRows(subs, items), syncedAt: last?.at ?? null, asOf: last?.asOf ?? null, complete: last?.complete ?? null, subs: subs.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "정기배송 데이터 조회 실패") }, { status: 500 });
  }
}
