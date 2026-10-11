import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getDedupConfig, setDedupConfig, DEDUP_DEFAULT, type DedupConfig } from "@/app/lib/fulfill-dedup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 중복 방지 설정 + 현재 등록된 처리완료 주문 키 수(참고). PUT — 설정 저장.
//  키 전체 비우기(DELETE)는 없앴다 — 비우면 다음 누적 파일에서 이미 출고한 주문이 전부 CN·출고·차감에 다시 실린다.
//  오래된 키는 발주 파일 분석 때 자동 정리된다(창의 2배 또는 90일).
export async function GET() {
  try {
    const cfg = await getDedupConfig();
    let processedCount: number | null = null; // 조회 실패 = 모름(—)
    const { count, error } = await supabaseAdmin().from("fulfill_order_keys").select("key", { count: "exact", head: true });
    if (!error) processedCount = count ?? 0;
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
