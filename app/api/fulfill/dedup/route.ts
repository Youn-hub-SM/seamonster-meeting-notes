import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getDedupConfig, setDedupConfig, DEDUP_DEFAULT, type DedupConfig } from "@/app/lib/fulfill-dedup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 중복 방지 설정 + 현재 등록된 처리완료 주문 키 수(참고). PUT — 설정 저장. DELETE — 키 전체 비우기.
export async function GET() {
  try {
    const cfg = await getDedupConfig();
    let processedCount: number | null = null;
    try {
      const { count } = await supabaseAdmin().from("fulfill_order_keys").select("key", { count: "exact", head: true });
      processedCount = count ?? 0;
    } catch { /* 079 미적용 */ }
    return NextResponse.json({ ok: true, config: cfg, default: DEDUP_DEFAULT, processedCount });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as Partial<DedupConfig>;
    const saved = await setDedupConfig({
      enabled: b.enabled !== false,
      match: b.match === "order_only" ? "order_only" : "order_and_items",
      windowDays: Number(b.windowDays) || DEDUP_DEFAULT.windowDays,
    });
    return NextResponse.json({ ok: true, config: saved });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}

// DELETE — 처리완료 주문 키 전체 삭제(중복 판정 기록 초기화). 재고·배송일지에는 영향 없음.
export async function DELETE() {
  try {
    const { error } = await supabaseAdmin().from("fulfill_order_keys").delete().neq("key", "");
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "초기화 실패") }, { status: 500 });
  }
}
