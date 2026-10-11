import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { toInvChannelParam } from "@/app/lib/inventory";

export const dynamic = "force-dynamic";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/inventory/txns?product_id=&type=&from=&to=&limit= — 원장(활동 히스토리·구매판매·조정 공용).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const product_id = sp.get("product_id");
    const type = sp.get("type");
    const channel = toInvChannelParam(sp.get("channel")); // 전체·모르는 값 = null(칸 필터 없음)
    const from = sp.get("from");
    const to = sp.get("to");
    const limit = Math.min(2000, Math.max(1, Number(sp.get("limit")) || 500));
    // 선택 컬럼 — channel·group_id(033·036)·status(034)·reason(099)·source(131)·order_no(033). 미적용 환경이면 오류에 이름이 보이는 칸을 빼고 다시 읽는다.
    //  order_no 는 이동 판정(isMoveTxn — 131 이전 행은 '주문번호 없는' partner '채널이동'만 이동)에 쓴다.
    //  status 를 함께 내려 화면이 '대기'(재고 미반영) 행을 완료와 구분한다.
    //  limit 까지 range 로 페이지를 이어 읽는다 — 단발 .limit() 은 서버 Max Rows(1000)에 조용히 잘려 limit=2000 이 1000행만 돌려줬다.
    //  응답 more = limit 에 닿음(더 오래된 행이 있을 수 있음). 품목 이력(HISTORY_LIMIT 1000)의 '행 수 < limit = 전부' 판정은 그대로 맞다.
    const optional = ["channel", "group_id", "status", "reason", "source", "order_no"];
    const page = (cols: string[], off: number, upto: number) => {
      let q = supabaseAdmin()
        .from("inventory_txns")
        .select(`id, product_id, type, ${cols.length ? `${cols.join(", ")}, ` : ""}qty, unit_amount, txn_date, partner, memo, created_by, created_at, products(name, sku)`)
        .order("txn_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: true }); // 페이지 경계가 흔들리지 않게(같은 시각 행)
      if (product_id) q = q.eq("product_id", product_id);
      if (type) q = q.eq("type", type);
      if (cols.includes("channel") && channel) q = q.eq("channel", channel); // 036·113·115 — 모르는 값·미지정은 전 칸
      if (from && DATE_RE.test(from)) q = q.gte("txn_date", from);
      if (to && DATE_RE.test(to)) q = q.lte("txn_date", to);
      return q.range(off, upto);
    };
    const run = async (cols: string[]): Promise<{ data: unknown[] | null; error: { message: string } | null }> => {
      const out: unknown[] = [];
      for (let off = 0; off < limit; off += 1000) {
        const upto = Math.min(off + 999, limit - 1);
        const { data, error } = await page(cols, off, upto);
        if (error) return { data: null, error };
        out.push(...(data ?? []));
        if ((data ?? []).length < upto - off + 1) break;
      }
      return { data: out, error: null };
    };
    let cols = [...optional];
    let res = await run(cols);
    for (let guard = 0; res.error && guard < optional.length; guard++) {
      const msg = res.error.message || "";
      const miss = cols.find((c) => new RegExp(`\\b${c}\\b`, "i").test(msg));
      if (!miss) break;
      // channel 이 없는 환경에서 칸 필터를 요청하면 전 칸이 섞여 보인다 — 종전 폴백과 같게 channel·group_id 를 함께 뺀다
      cols = cols.filter((c) => c !== miss && !(miss === "channel" && c === "group_id"));
      res = await run(cols);
    }
    if (res.error) throw res.error;
    const rows = ((res.data ?? []) as unknown as Record<string, unknown>[]).map((r) => {
      const p = r.products as { name?: string; sku?: string | null } | undefined;
      return { ...r, status: (r.status as string | undefined) ?? "완료", product_name: p?.name || "(삭제된 품목)", sku: p?.sku ?? null, products: undefined };
    });
    return NextResponse.json({ ok: true, rows, more: rows.length >= limit });
  } catch (err) {
    console.error("[inventory/txns GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "원장 조회 실패") }, { status: 500 });
  }
}
