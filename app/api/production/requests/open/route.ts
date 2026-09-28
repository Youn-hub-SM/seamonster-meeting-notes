import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { isFactoryPurpose } from "@/app/lib/wholesale-production";

export const dynamic = "force-dynamic";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// range 페이징 전량 — .limit 은 서버 Max Rows(1000)에 잘리고, '마감 지나도 자동 제외 없음' 규칙으로 열린 요청서가
//  쌓이면 요청일 오름차순의 뒤(= 현재 기간 요청서)부터 밀려난다. 오류는 던진다.
const PAGE = 1000;
async function pageAll<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await q(off, off + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

// GET ?date=YYYY-MM-DD — 입고 화면의 '생산 요청서' 선택 목록(지정 매칭).
//  열린(요청·진행중) 제조사 요청서를 요청일 순으로 내리고, 거래일이 생산기간(생산시작일~생산종료일)에 드는
//  가장 오래된 요청서를 기본값(default_id)으로 표시한다. 없으면 null(= 연결 안 함).
//  이미 전 품목 100% 이상인 요청서(full)는 목록엔 남기되 기본값으로 고르지 않는다 — 구코드가 제조사 요청서를
//  자동 완료하지 않아 열린 채 남은 것에 새 입고가 '초과'로 붙던 사고 방지.
//  prod_start(118)/purpose(082) 미적용은 에러에 보이는 컬럼만 빼고 재시도.
export async function GET(req: NextRequest) {
  try {
    const dateParam = req.nextUrl.searchParams.get("date") || "";
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const date = DATE_RE.test(dateParam) ? dateParam : today;
    const sb = supabaseAdmin();
    type Head = { id: string; req_no: string | null; title: string | null; status: string; request_date: string; due_date?: string | null; prod_start?: string | null; purpose?: string | null; created_at: string };
    const sel = (withStart: boolean, withPurpose: boolean, a: number, b: number) => sb.from("production_requests")
      .select(`id, req_no, title, status, request_date, due_date, created_at${withStart ? ", prod_start" : ""}${withPurpose ? ", purpose" : ""}`)
      .in("status", ["요청", "진행중"])
      .order("request_date", { ascending: true }).order("created_at", { ascending: true }).range(a, b);
    let ws = true, wp = true;
    let all: Head[] | null = null;
    for (let guard = 0; guard < 3 && all === null; guard++) {
      try { all = await pageAll<Head>((a, b) => sel(ws, wp, a, b)); }
      catch (e) {
        const m = String((e as { message?: string } | null)?.message || "");
        if (ws && /prod_start/i.test(m)) ws = false;
        else if (wp && /purpose/i.test(m)) wp = false;
        else throw e;
      }
    }
    // 용도 필터는 JS 에서 — NULL·모르는 값은 재고 보충으로 보므로 쿼리 .eq 로는 그 행이 빠진다
    const heads = (all ?? []).filter((h) => isFactoryPurpose(h.purpose));
    const rows = heads.map((h) => {
      const start = h.prod_start && DATE_RE.test(h.prod_start) ? h.prod_start : h.request_date;
      const end = h.due_date && DATE_RE.test(h.due_date) ? h.due_date : null;
      return { id: h.id, req_no: h.req_no, title: h.title, status: h.status, request_date: h.request_date, prod_start: start, due_date: end,
        in_window: !!end && start <= date && date <= end, full: false };
    });
    // 기간 안 요청서만 이행 판독(getRequestFullness 와 같은 규칙 — 모든 줄 입고 ≥ 요청 − 0.001, 품목 없으면 미완).
    //  품목·입고 모두 100개씩 청크 + 페이징 전량.
    const winIds = rows.filter((r) => r.in_window).map((r) => r.id);
    // 이행 판독이 실패해도 목록은 돌려준다(목록째 사라지면 화면이 조용히 '연결 안 함'으로 저장한다) —
    //  대신 기본값을 비워(100% 요청서를 기본으로 고르지 않게) full_ok:false 로 알린다.
    let fullOk = true;
    if (winIds.length) try {
      type Item = { id: string; request_id: string; requested_qty: number };
      const items: Item[] = [];
      for (let i = 0; i < winIds.length; i += 100) {
        const part = winIds.slice(i, i + 100);
        items.push(...await pageAll<Item>((a, b) => sb.from("production_request_items")
          .select("id, request_id, requested_qty").in("request_id", part).order("id", { ascending: true }).range(a, b)));
      }
      const recv = new Map<string, number>();
      for (let i = 0; i < items.length; i += 100) {
        const part = items.slice(i, i + 100).map((x) => x.id);
        const rcs = await pageAll<{ item_id: string; qty: number }>((a, b) => sb.from("production_receipts")
          .select("item_id, qty").in("item_id", part).order("id", { ascending: true }).range(a, b));
        for (const r of rcs) recv.set(r.item_id, (recv.get(r.item_id) || 0) + (Number(r.qty) || 0));
      }
      const itemsByReq = new Map<string, Item[]>();
      for (const it of items) { const arr = itemsByReq.get(it.request_id) ?? []; arr.push(it); itemsByReq.set(it.request_id, arr); }
      for (const r of rows) {
        if (!r.in_window) continue;
        const its = itemsByReq.get(r.id) ?? [];
        r.full = its.length > 0 && its.every((it) => (recv.get(it.id) || 0) >= (Number(it.requested_qty) || 0) - 0.001);
      }
    } catch (e) {
      console.error("[production/requests/open] 이행 판독 실패", e);
      fullOk = false;
      for (const r of rows) r.full = false;
    }
    const def = fullOk ? rows.find((r) => r.in_window && !r.full) : undefined;
    return NextResponse.json({ ok: true, date, requests: rows, default_id: def?.id ?? null, full_ok: fullOk });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
