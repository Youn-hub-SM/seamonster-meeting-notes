import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getUntracked } from "@/app/lib/stock-tracked";
import { maxOrderDate } from "@/app/lib/sales-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 1000;
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

// 소매 매출 입력 최신일(오늘 KST 이하) — 대사 소매 판매(inventory_reconcile sold_raw)와 같은 행만: 도매 행(channel '도매'·source 'b2b') 제외.
//  B2B 매출 동기화는 도매 행을 발송일(D2 기본 = 오늘)로 넣어, 전 채널 최신일은 소매 입력이 밀려도 '오늘'이 된다 → 시차 경고가 사라진다.
//  order_date 인덱스로 한 행만 읽는다. 오류는 던진다(부르는 쪽이 '확인 못 함'으로 — S4).
async function retailMaxOrderDate(sb: ReturnType<typeof supabaseAdmin>): Promise<string | null> {
  const { data, error } = await sb.from("sales_orders").select("order_date")
    .neq("channel", "도매").neq("source", "b2b").lte("order_date", kstToday())
    .order("order_date", { ascending: false }).limit(1);
  if (error) throw new Error(`sales_orders: ${error.message}`);
  return data?.[0]?.order_date ? String(data[0].order_date) : null;
}

// GET /api/inventory/reconcile?from=&to=&channel=
//  재고 정합성 대사 — 실제 판매(sales_orders 소매분 + B2B 발송완료 발주 전량)를 '실제 출고'로 보고 재고 원장과 대조.
//  판매 규칙은 inventory_reconcile RPC(132) 한 곳. 기간 미지정 시 매출 최신일(오늘 KST 이하, 소매·전체 탭은 소매 매출만) 기준 최근 30일.
//  날짜 축: 소매 매출 = 주문일, 소매 온라인 출고 = 처리일(④ 출고한 날, KST) — 하루 단위로는 어긋날 수 있다(화면이 안내).
export async function GET(req: NextRequest) {
  try {
    const p = new URL(req.url).searchParams;
    let from = (p.get("from") || "").trim();
    let to = (p.get("to") || "").trim();
    const channel = (p.get("channel") || "").trim(); // "" | "도매" | "소매" | "도매 대량"
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to)))
      return NextResponse.json({ ok: false, error: "기간 형식이 잘못되었습니다." }, { status: 400 });

    const sb = supabaseAdmin();
    // 매출 입력 최신일 — 화면의 '시차 안내'용(매출은 영업일에만 입력되므로 원장 출고보다 늦을 수 있음).
    //  오늘(KST) 이하만 — 미래 날짜 행(미리 발송완료한 도매·연도 오타)을 최신일로 보지 않는다(133 미적용이어도 maxOrderDate 가 거른다).
    //  소매·전체 탭 = 소매 매출만(salesMaxScope 'retail'), 도매·도매 대량 탭 = 전 채널(판매는 발주에서 세므로 표시용).
    //  기간을 받았으면 표시용이라 실패해도 대사는 그대로 하고, 기본 기간을 정해야 하면 실패를 그대로 알린다(S4).
    const retailScope = channel !== "도매" && channel !== "도매 대량";
    let salesMax: string | null = null;
    let salesMaxErr: string | null = null;
    try { salesMax = retailScope ? await retailMaxOrderDate(sb) : await maxOrderDate(); }
    catch (e) { salesMaxErr = extractErrorMsg(e, retailScope ? "소매 매출 최신일 조회 실패" : "매출 최신일 조회 실패"); }
    if (!from || !to) {
      if (salesMaxErr) return NextResponse.json({ ok: false, error: `기본 기간을 정하지 못했습니다 — ${salesMaxErr}` }, { status: 500 });
      if (!salesMax) return NextResponse.json({ ok: false, error: retailScope ? "소매 매출 데이터가 없습니다." : "매출 데이터가 없습니다." }, { status: 400 });
      to = to || salesMax;
      if (!from) {
        // 날짜 산술은 UTC 자정 기준으로만 — 서버 시간대에 따라 하루 밀리지 않게(S6)
        const d = new Date(`${to}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 30);
        from = d.toISOString().slice(0, 10);
      }
    }

    // 품목 수가 서버 Max Rows(1000)를 넘으면 단발 호출은 조용히 잘린다 — product_id 순으로 끝까지 읽는다(S4)
    const rows: { product_id: string }[] = [];
    for (let off = 0; ; off += PAGE) {
      const { data, error } = await sb
        .rpc("inventory_reconcile", { p_from: from, p_to: to, p_channel: channel || null })
        .order("product_id", { ascending: true })
        .range(off, off + PAGE - 1);
      if (error) return NextResponse.json({ ok: false, error: `${error.message} (051·132 적용 여부 확인)` }, { status: 500 });
      const part = (data ?? []) as { product_id: string }[];
      rows.push(...part);
      if (part.length < PAGE) break;
    }
    // '재고 관리 사용 안함'(121) 품목은 대사에서 뺀다 — 입고를 안 적으니 늘 차이로 뜬다
    const untracked = await getUntracked(sb);
    const out = rows.filter((r) => !untracked.ids.has(r.product_id));

    return NextResponse.json({ ok: true, from, to, channel: channel || "전체", salesMax, salesMaxScope: retailScope ? "retail" : "all", salesMaxError: salesMaxErr, rows: out });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "대사 조회 실패") }, { status: 500 });
  }
}
