import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending010, PENDING_010 } from "@/app/lib/factory-db";
import { DEFAULT_FORECAST_SETTINGS, DAY_CHOICES, type FlowOverview, type ForecastSettings } from "@/app/lib/factory-forecast";

export const dynamic = "force-dynamic";

// 파도소리 [예상] 화면 — 올려 둔 흐름 합계(factory.flow_overview) + 품명별 현재고 + 설정. 관리자만.
//  계산(계절 지수·범위·생산 권장)은 화면이 app/lib/factory-forecast.ts 로 한다 — 기준 일수를 바꿀 때 다시 부르지 않게.
const KV_KEY = "factory_forecast";
const deny = () => NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 403 });


async function readSettings(): Promise<ForecastSettings> {
  try {
    const { data } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KV_KEY).maybeSingle();
    const v = (data?.value ?? {}) as Partial<ForecastSettings>;
    return {
      days: (DAY_CHOICES as readonly number[]).includes(Number(v.days)) ? Number(v.days) : DEFAULT_FORECAST_SETTINGS.days,
      excluded: Array.isArray(v.excluded) ? v.excluded.filter((s): s is string => typeof s === "string").slice(0, 500) : [],
    };
  } catch {
    return { ...DEFAULT_FORECAST_SETTINGS };
  }
}

// 품명별 현재고(kg) — 재고관리 사용 품목의 로트 합. 같은 품명의 규격이 여럿이면 합친다.
async function stockByName(): Promise<Record<string, number>> {
  const pr = await factoryDb().from("products").select("id, name").eq("stock_tracked", true);
  if (pr.error) throw pr.error;
  const nameOf = new Map(((pr.data || []) as { id: string; name: string }[]).map((p) => [p.id, p.name.trim()] as const));
  const out: Record<string, number> = {};
  for (const n of nameOf.values()) out[n] = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await factoryDb().from("stock_lots").select("product_id, mfg_date, box_kg, kg")
      .order("product_id").order("mfg_date", { nullsFirst: true }).order("box_kg", { nullsFirst: true }).range(from, from + 999);
    if (error) throw error;
    for (const l of (data || []) as { product_id: string; kg: number | string }[]) {
      const n = nameOf.get(l.product_id);
      if (n != null) out[n] += Number(l.kg) || 0;
    }
    if (!data || data.length < 1000) break;
  }
  for (const n of Object.keys(out)) out[n] = Math.round(out[n] * 100) / 100;
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.admin) return deny();
    const [ov, settings] = await Promise.all([factoryDb().rpc("flow_overview"), readSettings()]);
    if (ov.error) throw ov.error;
    // 현재고를 못 읽어도 예상은 보여 준다(재고 칸만 빈다)
    let stock: Record<string, number> = {};
    let stockError = "";
    try { stock = await stockByName(); } catch (e) { stockError = extractErrorMsg(e, "현재고 조회 실패"); }
    return NextResponse.json({ ok: true, overview: ov.data as FlowOverview, stock, stockError, settings });
  } catch (err) {
    if (isPending010(err)) return NextResponse.json({ ok: false, error: PENDING_010, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "예상 조회 실패") }, { status: 500 });
  }
}

// POST { days?, exclude?: 품명, include?: 품명 } — 기준 일수 바꾸기 · 품목을 표에서 빼기/되돌리기
export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.admin) return deny();
    const b = (await req.json().catch(() => ({}))) as { days?: unknown; exclude?: unknown; include?: unknown };
    const cur = await readSettings();
    const next: ForecastSettings = { days: cur.days, excluded: [...cur.excluded] };
    if (b.days != null) {
      if (!(DAY_CHOICES as readonly number[]).includes(Number(b.days))) return NextResponse.json({ ok: false, error: "기준 일수가 올바르지 않습니다." }, { status: 400 });
      next.days = Number(b.days);
    }
    if (typeof b.exclude === "string" && b.exclude.trim() && !next.excluded.includes(b.exclude.trim())) next.excluded.push(b.exclude.trim());
    if (typeof b.include === "string") next.excluded = next.excluded.filter((s) => s !== String(b.include).trim());
    const { error } = await supabaseAdmin().from("b2b_settings")
      .upsert({ key: KV_KEY, value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return NextResponse.json({ ok: true, settings: next });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 저장 실패") }, { status: 500 });
  }
}
