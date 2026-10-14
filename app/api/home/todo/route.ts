import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 홈 '오늘 할 일' 건수(2026-10-14 D1) — 로그인 게이트는 미들웨어(/api/* 전체)가 담당, 공개 예외에 넣지 않는다.
//  집계마다 따로 try/catch — 한 집계(테이블 미적용·조회 실패)가 전체를 죽이지 않게 그 항목만 0 으로 둔다.
//  근거:
//   deposits   bank_deposits.status = '확인필요'(089)            → /b2b/payments
//   orders     orders.status = '발송대기'(ORDER_STATUSES)        → /b2b/orders (목록은 상태 쿼리 파라미터를 받지 않는다)
//   production production_requests.status = '요청'(PR_STATUSES — 아직 담당자가 확인하지 않은 요청서) → /production/request
//   inquiries  channel_inquiries.answered = false(137, 네이버 고객문의·상품문의) → 답변 화면이 도구 안에 없어 href 없음
//   report     analyst_reports(122) 어제(KST) 행이 status 'ok'·본문 있음인데 sent_at 이 없거나 updated_at 보다 앞(= /api/analyst GET 의 sent_current 가 false) → /briefing
//              행이 없으면(아직 분석 전) 0

type TodoItem = { key: string; label: string; count: number; href?: string };

const kstDay = (back = 0) => new Date(Date.now() + 9 * 3600e3 - back * 86400e3).toISOString().slice(0, 10);

async function safeCount(fn: () => Promise<number>): Promise<number> {
  try { const n = await fn(); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; } catch { return 0; }
}

export async function GET() {
  let sb: ReturnType<typeof supabaseAdmin>;
  try { sb = supabaseAdmin(); } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "DB 연결 실패" }, { status: 500 });
  }

  const countWhere = (table: string, col: string, val: string | boolean) => safeCount(async () => {
    const { count, error } = await sb.from(table).select("*", { count: "exact", head: true }).eq(col, val);
    if (error) throw error;
    return count ?? 0;
  });

  const [deposits, orders, production, inquiries, report] = await Promise.all([
    countWhere("bank_deposits", "status", "확인필요"),
    countWhere("orders", "status", "발송대기"),
    countWhere("production_requests", "status", "요청"),
    countWhere("channel_inquiries", "answered", false),
    safeCount(async () => {
      const { data, error } = await sb.from("analyst_reports").select("status, report_md, sent_at, updated_at").eq("report_date", kstDay(1)).maybeSingle();
      if (error) throw error;
      if (!data || data.status !== "ok" || !data.report_md) return 0;
      const sent = data.sent_at ? Date.parse(String(data.sent_at)) : NaN;
      const upd = Date.parse(String(data.updated_at));
      const sentCurrent = Number.isFinite(sent) && sent >= upd;
      return sentCurrent ? 0 : 1;
    }),
  ]);

  const items: TodoItem[] = [
    { key: "deposits", label: "확인필요 입금", count: deposits, href: "/b2b/payments" },
    { key: "orders", label: "발송대기 발주", count: orders, href: "/b2b/orders" },
    { key: "production", label: "확인 안 된 생산 요청", count: production, href: "/production/request" },
    { key: "inquiries", label: "미답변 문의", count: inquiries },
    { key: "report", label: "아직 안 보낸 일일 리포트", count: report, href: "/briefing" },
  ];
  return NextResponse.json({ ok: true, items }, { headers: { "Cache-Control": "no-store" } });
}
