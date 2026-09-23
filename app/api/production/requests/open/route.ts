import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { isFactoryPurpose } from "@/app/lib/wholesale-production";

export const dynamic = "force-dynamic";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET ?date=YYYY-MM-DD — 입고 화면의 '생산 요청서' 선택 목록(지정 매칭).
//  열린(요청·진행중) 제조사 요청서를 요청일 순으로 내리고, 거래일이 생산기간(생산시작일~생산종료일)에 드는
//  가장 오래된 요청서를 기본값(default_id)으로 표시한다. 없으면 null(= 연결 안 함).
//  prod_start(118)/purpose(082) 미적용은 에러에 보이는 컬럼만 빼고 재시도.
export async function GET(req: NextRequest) {
  try {
    const dateParam = req.nextUrl.searchParams.get("date") || "";
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const date = DATE_RE.test(dateParam) ? dateParam : today;
    const sb = supabaseAdmin();
    type Head = { id: string; req_no: string | null; title: string | null; status: string; request_date: string; due_date?: string | null; prod_start?: string | null; purpose?: string | null; created_at: string };
    const sel = (withStart: boolean, withPurpose: boolean) => sb.from("production_requests")
      .select(`id, req_no, title, status, request_date, due_date, created_at${withStart ? ", prod_start" : ""}${withPurpose ? ", purpose" : ""}`)
      .in("status", ["요청", "진행중"])
      .order("request_date", { ascending: true }).order("created_at", { ascending: true }).limit(300);
    let ws = true, wp = true;
    let res = await sel(ws, wp);
    for (let guard = 0; res.error && guard < 2; guard++) {
      if (ws && /prod_start/i.test(res.error.message)) ws = false;
      else if (wp && /purpose/i.test(res.error.message)) wp = false;
      else break;
      res = await sel(ws, wp);
    }
    if (res.error) throw res.error;
    const heads = ((res.data ?? []) as unknown as Head[]).filter((h) => isFactoryPurpose(h.purpose));
    const rows = heads.map((h) => {
      const start = h.prod_start && DATE_RE.test(h.prod_start) ? h.prod_start : h.request_date;
      const end = h.due_date && DATE_RE.test(h.due_date) ? h.due_date : null;
      return { id: h.id, req_no: h.req_no, title: h.title, status: h.status, request_date: h.request_date, prod_start: start, due_date: end,
        in_window: !!end && start <= date && date <= end };
    });
    const def = rows.find((r) => r.in_window);
    return NextResponse.json({ ok: true, date, requests: rows, default_id: def?.id ?? null });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
