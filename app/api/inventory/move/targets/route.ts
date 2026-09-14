import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// GET ?product_id= — 재고 옮기기(소매→도매)의 배정 대상: 이 품목이 들어 있는 열린 도매 생산 요청서.
//  오래된 요청부터(요청일 순 — 종전 FIFO 관행과 같은 순서). 전체 이력 로더 대신 품목·상태로 좁힌
//  전용 조회(무제한 로드는 서버 1000행 캡에서 조용히 잘려 잔여가 과대 표시될 수 있음 — 검증 지적).
//  purpose(082) 미적용 환경은 빈 목록(배정 기능 자체가 도매 납품 요청 전제 — 자동 전환도 같이 보류됨).
export async function GET(req: NextRequest) {
  try {
    const productId = req.nextUrl.searchParams.get("product_id") || "";
    if (!productId) return NextResponse.json({ ok: false, error: "product_id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();

    const { data: itemsRaw, error: ie } = await sb.from("production_request_items")
      .select("id, request_id, requested_qty, production_requests!inner(id, req_no, title, status, request_date, due_date)")
      .eq("product_id", productId)
      .in("production_requests.status", ["요청", "진행중"])
      .eq("production_requests.purpose", "도매 납품")
      .limit(200);
    if (ie) {
      if (/purpose/i.test(ie.message)) return NextResponse.json({ ok: true, targets: [] }); // 082 미적용 — 배정 비활성
      throw ie;
    }
    type Head = { id: string; req_no: string | null; title: string | null; status: string; request_date: string; due_date: string | null };
    const rows = (itemsRaw ?? [])
      .map((r) => {
        const rel = (r as { production_requests?: Head | Head[] | null }).production_requests;
        const head = Array.isArray(rel) ? rel[0] : rel;
        return head ? { item_id: r.id as string, requested_qty: Number(r.requested_qty) || 0, head } : null;
      })
      .filter((x): x is { item_id: string; requested_qty: number; head: Head } => !!x);

    // 품목행별 기입고 합
    const recv = new Map<string, number>();
    for (let i = 0; i < rows.length; i += 100) {
      const part = rows.slice(i, i + 100).map((x) => x.item_id);
      const { data: rcs, error: re } = await sb.from("production_receipts").select("item_id, qty").in("item_id", part).limit(5000);
      if (re) throw re;
      for (const rc of rcs ?? []) recv.set(rc.item_id as string, (recv.get(rc.item_id as string) || 0) + (Number(rc.qty) || 0));
    }

    const targets = rows.map((x) => {
      const received = Math.round((recv.get(x.item_id) || 0) * 100) / 100;
      return {
        item_id: x.item_id,
        request_id: x.head.id,
        req_no: x.head.req_no,
        title: x.head.title,
        request_date: x.head.request_date,
        due_date: x.head.due_date,
        requested_qty: x.requested_qty,
        received_qty: received,
        remaining: Math.max(0, Math.round((x.requested_qty - received) * 100) / 100),
      };
    }).sort((a, b) => String(a.request_date).localeCompare(String(b.request_date)));

    return NextResponse.json({ ok: true, targets });
  } catch (err) {
    console.error("[inventory/move/targets GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "요청서 조회 실패") }, { status: 500 });
  }
}
