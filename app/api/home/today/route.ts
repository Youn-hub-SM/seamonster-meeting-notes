import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { loadUnpaidOrders } from "@/app/lib/b2b-deposits";

// 오늘 'YYYY-MM-DD'(KST) — b2b-digest 의 kstDateStr 과 같은 식. 그 모듈은 다이제스트 전체(원장 대조·생산 할 일)를 끌어와 여기서 import 하지 않는다.
const kstDateStr = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/home/today — 홈 첫 줄 아래 한 문장("오늘 발송 2건, 입금 대기 3건 7,334,800원")의 두 숫자. 2026-10-17 디자인 4차 D1.
//  (1) ship: 오늘(KST) 발송 건수 — shipments 중 ship_date = 오늘, status 발송대기·발송중. B2B 일정 알림(b2b-digest '발송 일정')과 같은 조건.
//  (2) unpaid: 입금 대기 — orders 중 payment_status 입금전·일부입금(취소 제외), 미수금 = 실효 청구액(부분취소 감액) − 입금 합.
//      입금 확인 화면(/api/b2b/payments/unpaid)·입금문자 자동매칭과 같은 loadUnpaidOrders 를 그대로 쓴다.
//  집계마다 try/catch — 실패하면 0(홈 한 줄이 통째로 비는 것보다 낫다). 미들웨어 /api/* 게이트 안(공개 예외 아님).
export async function GET() {
  const today = kstDateStr();
  let ship = 0;
  try {
    const { count, error } = await supabaseAdmin()
      .from("shipments").select("id", { count: "exact", head: true })
      .eq("ship_date", today).in("status", ["발송대기", "발송중"]);
    if (error) throw error;
    ship = count ?? 0;
  } catch (e) { console.warn("[home/today] 오늘 발송 집계 실패", e); }

  let unpaid = { count: 0, remaining: 0 };
  try {
    const rows = await loadUnpaidOrders();
    unpaid = { count: rows.length, remaining: rows.reduce((s, r) => s + (Number(r.remaining) || 0), 0) };
  } catch (e) { console.warn("[home/today] 입금 대기 집계 실패", e); }

  return NextResponse.json({ ok: true, today, ship, unpaid });
}
