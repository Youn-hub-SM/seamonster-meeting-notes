import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005, isPending007, PENDING_007 } from "@/app/lib/factory-db";
import { kgNum, type FactoryProduct, type StockLot, type StockMeta, type StockRow } from "@/app/lib/factory";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);

// factory.stock_lots 1행 — 품목 × 제조일자, kg (007)
type LotRow = {
  product_id: string; mfg_date: string | null;
  kg: number | string; in_kg: number | string; out_kg: number | string; adj_kg: number | string;
  first_in_date: string | null; last_in_date: string | null; first_txn_date: string | null;
  live_in_date: string | null;
};

// 로트 뷰 전체 — PostgREST 한도(1000행)를 넘어도 잘리지 않게 페이지로 읽는다. 정렬을 고정해야 페이지끼리 겹치거나 빠지지 않는다.
async function allLots(): Promise<LotRow[]> {
  const out: LotRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await factoryDb().from("stock_lots").select("*")
      .order("product_id").order("mfg_date", { nullsFirst: true }).range(from, from + 999);
    if (error) throw error;
    out.push(...((data || []) as LotRow[]));
    if (!data || data.length < 1000) return out;
  }
}

type PeriodTxn = { id: string; product_id: string; type: "입고" | "출고"; kg: number | string };

// 기간 입고·출고 — 거래일이 [from, to] 안, 취소 제외. 1000행 한도를 넘어도 잘리지 않게 id 순 페이지로 읽는다.
async function periodTxns(from: string, to: string): Promise<PeriodTxn[]> {
  const out: PeriodTxn[] = [];
  for (let at = 0; ; at += 1000) {
    const { data, error } = await factoryDb().from("stock_txns").select("id, product_id, type, kg")
      .is("cancelled_at", null).in("type", ["입고", "출고"]).gte("txn_date", from).lte("txn_date", to)
      .order("id").range(at, at + 999);
    if (error) throw error;
    out.push(...((data || []) as PeriodTxn[]));
    if (!data || data.length < 1000) return out;
  }
}

// GET ?from=&to= — 재고장: 재고관리 사용 품목 전체 + 합계 + 로트(품목 × 제조일자). 단위 kg.
//  최신 입고일 = 가장 최근 입고 기록일, 최고령 입고일 = 남은 kg 가 들어온 가장 오래된 입고일(뷰 live_in_date).
//  총 입고·총 출고 = 누적(취소 제외). 현재 kg = 입고 − 출고 ± 조정. 기간 입고·출고·하루 출고·예상소진·재고자산.
export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    const sp = req.nextUrl.searchParams;
    const today = kstToday();
    let to = validDate(sp.get("to") || "") ? sp.get("to")! : today;
    if (to > today) to = today;
    let from = validDate(sp.get("from") || "") ? sp.get("from")! : to;
    if (from > to) from = to;
    const periodDays = dayDiff(from, to) + 1;

    const [pr, lotRows, ptx] = await Promise.all([
      factoryDb().from("products").select("*").eq("stock_tracked", true).order("name").order("sku"),
      allLots(),
      periodTxns(from, to),
    ]);
    if (pr.error) throw pr.error;
    // 007 미적용 — 옛 뷰(boxes 열)가 돌아온다
    if (lotRows.length && !("kg" in lotRows[0])) return NextResponse.json({ ok: false, error: PENDING_007, pending_migration: true }, { status: 503 });

    // 기간 합 — 품목별 kg. 출고 kg 는 음수로 저장돼 있어 절댓값.
    const per = new Map<string, { inKg: number; outKg: number }>();
    for (const t of ptx) {
      const a = per.get(t.product_id) || { inKg: 0, outKg: 0 };
      const kg = Math.abs(Number(t.kg) || 0);
      if (t.type === "입고") a.inKg += kg; else a.outKg += kg;
      per.set(t.product_id, a);
    }

    const byProduct = new Map<string, LotRow[]>();
    for (const l of lotRows) {
      const a = byProduct.get(l.product_id) || [];
      a.push(l);
      byProduct.set(l.product_id, a);
    }

    const rows: StockRow[] = ((pr.data || []) as FactoryProduct[]).map((p) => {
      const lots: StockLot[] = (byProduct.get(p.id) || []).map((l) => ({
        mfg_date: l.mfg_date,
        kg: kgNum(Number(l.kg) || 0),
        in_kg: kgNum(Number(l.in_kg) || 0),
        out_kg: kgNum(Number(l.out_kg) || 0),
        adj_kg: kgNum(Number(l.adj_kg) || 0),
        in_date: l.live_in_date || l.first_in_date || l.first_txn_date,
        last_in_date: l.last_in_date,
      }));
      // 잔량 있는 로트 먼저, 그 안에서 오래된 입고(→제조일자) 순 — 출고할 때 오래된 것부터 보이게
      lots.sort((a, b) => (Number(b.kg > 0) - Number(a.kg > 0))
        || String(a.in_date || "9999").localeCompare(String(b.in_date || "9999"))
        || String(a.mfg_date || "9999").localeCompare(String(b.mfg_date || "9999")));
      const sum = (f: (l: StockLot) => number) => kgNum(lots.reduce((s, l) => s + f(l), 0));
      const live = lots.filter((l) => l.kg > 0);
      const inDates = lots.map((l) => l.last_in_date).filter((d): d is string => !!d).sort();
      const liveDates = live.map((l) => l.in_date).filter((d): d is string => !!d).sort();
      const kg = sum((l) => l.kg);
      const pp = per.get(p.id) || { inKg: 0, outKg: 0 };
      const daily = kgNum(pp.outKg / periodDays);
      const cost = p.cost == null ? null : Number(p.cost);
      return {
        ...p,
        cost,
        price: p.price == null ? null : Number(p.price),
        kg,
        in_kg: sum((l) => l.in_kg),
        out_kg: sum((l) => l.out_kg),
        adj_kg: sum((l) => l.adj_kg),
        last_in_date: inDates.length ? inDates[inDates.length - 1] : null,
        oldest_in_date: liveDates.length ? liveDates[0] : null,
        lots,
        period_in_kg: kgNum(pp.inKg),
        period_out_kg: kgNum(pp.outKg),
        daily_out_kg: daily,
        // 남은 게 없으면 0일, 기간 출고가 없으면 계산 불가(null)
        depletion_days: daily > 0 ? Math.max(0, Math.floor(kg / daily)) : null,
        // 제품원가 = kg당(대표 확정 2026-10-20). 마이너스 재고는 자산 0 으로 본다.
        value: cost == null ? null : Math.round(Math.max(0, kg) * cost),
      };
    });
    const meta: StockMeta = { from, to, periodDays };
    return NextResponse.json({ ok: true, rows, meta, admin: u.admin, who: u.name });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    if (isPending007(err)) return NextResponse.json({ ok: false, error: PENDING_007, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "재고 조회 실패") }, { status: 500 });
  }
}
