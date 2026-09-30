import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005 } from "@/app/lib/factory-db";
import { kgNum, type FactoryProduct, type StockLot, type StockRow } from "@/app/lib/factory";

export const dynamic = "force-dynamic";

type LotRow = {
  product_id: string; mfg_date: string | null; box_kg: number | string; boxes: number;
  in_boxes: number; out_boxes: number; adj_boxes: number;
  first_in_date: string | null; last_in_date: string | null; first_txn_date: string | null;
  live_in_date: string | null;
};

// 로트 뷰 전체 — PostgREST 한도(1000행)를 넘어도 잘리지 않게 페이지로 읽는다. 정렬을 고정해야 페이지끼리 겹치거나 빠지지 않는다.
async function allLots(): Promise<LotRow[]> {
  const out: LotRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await factoryDb().from("stock_lots").select("*")
      .order("product_id").order("mfg_date", { nullsFirst: true }).order("box_kg").range(from, from + 999);
    if (error) throw error;
    out.push(...((data || []) as LotRow[]));
    if (!data || data.length < 1000) return out;
  }
}

// GET — 재고장: 재고관리 사용 품목 전체 + 합계 + 로트(품목 × 제조일자 × 박스 중량)
//  최신 입고일 = 가장 최근 입고 기록일, 최고령 입고일 = 남은 박스가 들어온 가장 오래된 입고일
//  (로트마다 먼저 들어온 것이 먼저 나간다고 보고 DB 뷰가 live_in_date 로 계산 — 입고·소진·재입고가 반복돼도 맞다).
//  총 입고·총 출고 = 누적(취소 제외). 현재 수량 = 입고 − 출고 ± 조정.
export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    const [pr, lotRows] = await Promise.all([
      factoryDb().from("products").select("*").eq("stock_tracked", true).order("name").order("sku"),
      allLots(),
    ]);
    if (pr.error) throw pr.error;

    const byProduct = new Map<string, LotRow[]>();
    for (const l of lotRows) {
      const a = byProduct.get(l.product_id) || [];
      a.push(l);
      byProduct.set(l.product_id, a);
    }

    const rows: StockRow[] = ((pr.data || []) as FactoryProduct[]).map((p) => {
      const lots: StockLot[] = (byProduct.get(p.id) || []).map((l) => ({
        mfg_date: l.mfg_date,
        box_kg: Number(l.box_kg),
        boxes: Number(l.boxes) || 0,
        in_boxes: Number(l.in_boxes) || 0,
        out_boxes: Number(l.out_boxes) || 0,
        adj_boxes: Number(l.adj_boxes) || 0,
        in_date: l.live_in_date || l.first_in_date || l.first_txn_date,
        last_in_date: l.last_in_date,
      }));
      // 잔량 있는 로트 먼저, 그 안에서 오래된 입고(→제조일자) 순 — 출고할 때 오래된 것부터 보이게
      lots.sort((a, b) => (Number(b.boxes > 0) - Number(a.boxes > 0))
        || String(a.in_date || "9999").localeCompare(String(b.in_date || "9999"))
        || String(a.mfg_date || "9999").localeCompare(String(b.mfg_date || "9999"))
        || b.box_kg - a.box_kg);
      const sum = (f: (l: StockLot) => number) => lots.reduce((s, l) => s + f(l), 0);
      const live = lots.filter((l) => l.boxes > 0);
      const inDates = lots.map((l) => l.last_in_date).filter((d): d is string => !!d).sort();
      const liveDates = live.map((l) => l.in_date).filter((d): d is string => !!d).sort();
      return {
        ...p,
        cost: p.cost == null ? null : Number(p.cost),
        price: p.price == null ? null : Number(p.price),
        boxes: sum((l) => l.boxes),
        kg: kgNum(sum((l) => l.boxes * l.box_kg)),
        in_boxes: sum((l) => l.in_boxes),
        in_kg: kgNum(sum((l) => l.in_boxes * l.box_kg)),
        out_boxes: sum((l) => l.out_boxes),
        out_kg: kgNum(sum((l) => l.out_boxes * l.box_kg)),
        adj_boxes: sum((l) => l.adj_boxes),
        last_in_date: inDates.length ? inDates[inDates.length - 1] : null,
        oldest_in_date: liveDates.length ? liveDates[0] : null,
        lots,
      };
    });
    return NextResponse.json({ ok: true, rows, admin: u.admin, who: u.name });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "재고 조회 실패") }, { status: 500 });
  }
}
