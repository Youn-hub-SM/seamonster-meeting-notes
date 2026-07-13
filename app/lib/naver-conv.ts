import { supabaseAdmin } from "./supabase";
import { fetchConvReportDay, type ConvRow } from "./naver-ad";

// 네이버 검색광고 '구매(purchase) 전환' 일별 집계 + 캐시.
// AD_CONVERSION_DETAIL 리포트가 무거워 일자 단위로 naver_conv_daily 에 캐시(최근 2일은 매번 갱신).
// 마이그레이션(064) 미적용이어도 라이브 조회로 폴백(느리지만 동작).

export type PurchaseAgg = Record<string, { conv: number; sales: number }>;

function dateList(since: string, until: string): string[] {
  const out: string[] = [];
  const s = new Date(`${since}T00:00:00Z`), u = new Date(`${until}T00:00:00Z`);
  for (let t = s.getTime(); t <= u.getTime(); t += 864e5) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    if (out.length > 62) break; // 안전장치
  }
  return out;
}

// 동시성 제한 실행
async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; res[i] = await fn(items[i]); }
  }));
  return res;
}

// 하루 리포트 rows → 엔티티별 구매 집계(키워드/광고그룹 동시)
function aggregateDay(rows: ConvRow[]) {
  const keyword: PurchaseAgg = {}, adgroup: PurchaseAgg = {};
  for (const r of rows) {
    if (r.convType !== "purchase") continue;
    if (r.keywordId) { const k = (keyword[r.keywordId] ||= { conv: 0, sales: 0 }); k.conv += r.conv; k.sales += r.sales; }
    if (r.adgroupId) { const a = (adgroup[r.adgroupId] ||= { conv: 0, sales: 0 }); a.conv += r.conv; a.sales += r.sales; }
  }
  return { keyword, adgroup };
}

type DayRows = { day: string; rows: ConvRow[] };

function fmtUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// until을 '어제'까지로 캡(AD_CONVERSION_DETAIL은 당일 미지원). 어제 문자열도 반환.
function capUntil(until: string): { effUntil: string; yStr: string } {
  const now = new Date();
  const todayStr = fmtUTC(now);
  const yStr = fmtUTC(new Date(now.getTime() - 864e5));
  return { effUntil: until >= todayStr ? yStr : until, yStr };
}

// 지정 기간의 일별 구매전환을 캐시에 채우고, 라이브 폴백용 rows·사용일자를 반환.
async function ensureRange(since: string, effUntil: string, yStr: string): Promise<{ useCache: boolean; fetched: DayRows[]; toFetch: string[] }> {
  const days = since > effUntil ? [] : dateList(since, effUntil);
  const recent = new Set([yStr]); // 어제는 전환 지연 반영 위해 항상 재조회
  if (!days.length) return { useCache: true, fetched: [], toFetch: [] };

  let useCache = true;
  let presentDays = new Set<string>();
  try {
    const { data, error } = await supabaseAdmin().from("naver_conv_daily").select("stat_date").gte("stat_date", since).lte("stat_date", effUntil);
    if (error) throw error;
    presentDays = new Set((data || []).map((r) => String((r as { stat_date: string }).stat_date)));
  } catch { useCache = false; }

  const toFetch = useCache ? days.filter((d) => !presentDays.has(d) || recent.has(d)) : days;
  const fetched: DayRows[] = await mapPool(toFetch, 4, async (day) => ({ day, rows: await fetchConvReportDay(day) }));

  // 캐시 저장(있을 때): 해당 일자 삭제 후 재삽입
  if (useCache) {
    for (const { day, rows } of fetched) {
      const agg = aggregateDay(rows);
      const inserts = [
        ...Object.entries(agg.keyword).map(([id, v]) => ({ stat_date: day, entity_type: "keyword", entity_id: id, purchase_conv: v.conv, purchase_sales: v.sales })),
        ...Object.entries(agg.adgroup).map(([id, v]) => ({ stat_date: day, entity_type: "adgroup", entity_id: id, purchase_conv: v.conv, purchase_sales: v.sales })),
      ];
      try {
        await supabaseAdmin().from("naver_conv_daily").delete().eq("stat_date", day);
        if (inserts.length) await supabaseAdmin().from("naver_conv_daily").insert(inserts);
      } catch { useCache = false; break; }
    }
  }
  return { useCache, fetched, toFetch };
}

// 지정 기간의 '구매 전환' 집계를 엔티티유형별로 반환.
export async function getPurchaseConversions(since: string, until: string, entityType: "keyword" | "adgroup"): Promise<{ map: PurchaseAgg; daysFetched: number; cached: boolean; effectiveUntil: string }> {
  const { effUntil, yStr } = capUntil(until);
  const days = since > effUntil ? [] : dateList(since, effUntil);
  if (!days.length) return { map: {}, daysFetched: 0, cached: true, effectiveUntil: effUntil };

  const { useCache, fetched, toFetch } = await ensureRange(since, effUntil, yStr);

  const map: PurchaseAgg = {};
  if (useCache) {
    const { data } = await supabaseAdmin().from("naver_conv_daily").select("entity_id,purchase_conv,purchase_sales").eq("entity_type", entityType).gte("stat_date", since).lte("stat_date", effUntil);
    for (const r of (data || []) as { entity_id: string; purchase_conv: number; purchase_sales: number }[]) {
      const m = (map[r.entity_id] ||= { conv: 0, sales: 0 }); m.conv += r.purchase_conv || 0; m.sales += r.purchase_sales || 0;
    }
  } else {
    // 라이브 폴백: fetched = 전체 일자
    for (const { rows } of fetched) {
      for (const r of rows) {
        if (r.convType !== "purchase") continue;
        const id = entityType === "keyword" ? r.keywordId : r.adgroupId;
        if (!id) continue;
        const m = (map[id] ||= { conv: 0, sales: 0 }); m.conv += r.conv; m.sales += r.sales;
      }
    }
  }
  return { map, daysFetched: toFetch.length, cached: useCache, effectiveUntil: effUntil };
}

export type PurchaseDay = { date: string; conv: number; sales: number };

// 한 엔티티(광고그룹/키워드)의 '구매 전환'을 일자별로 반환. (리포트 그래프/표용)
export async function getPurchaseConvByDay(entityId: string, entityType: "keyword" | "adgroup", since: string, until: string): Promise<{ days: PurchaseDay[]; daysFetched: number; cached: boolean; effectiveUntil: string }> {
  const { effUntil, yStr } = capUntil(until);
  if (since > effUntil) return { days: [], daysFetched: 0, cached: true, effectiveUntil: effUntil };

  const { useCache, fetched, toFetch } = await ensureRange(since, effUntil, yStr);

  const byDate: Record<string, { conv: number; sales: number }> = {};
  if (useCache) {
    const { data } = await supabaseAdmin().from("naver_conv_daily").select("stat_date,purchase_conv,purchase_sales").eq("entity_type", entityType).eq("entity_id", entityId).gte("stat_date", since).lte("stat_date", effUntil);
    for (const r of (data || []) as { stat_date: string; purchase_conv: number; purchase_sales: number }[]) {
      const d = (byDate[r.stat_date] ||= { conv: 0, sales: 0 }); d.conv += r.purchase_conv || 0; d.sales += r.purchase_sales || 0;
    }
  } else {
    // 라이브 폴백: fetched = 전체 일자
    for (const { day, rows } of fetched) {
      for (const r of rows) {
        if (r.convType !== "purchase") continue;
        const id = entityType === "keyword" ? r.keywordId : r.adgroupId;
        if (id !== entityId) continue;
        const d = (byDate[day] ||= { conv: 0, sales: 0 }); d.conv += r.conv; d.sales += r.sales;
      }
    }
  }
  const days = Object.entries(byDate).map(([date, v]) => ({ date, conv: v.conv, sales: v.sales })).sort((a, b) => a.date.localeCompare(b.date));
  return { days, daysFetched: toFetch.length, cached: useCache, effectiveUntil: effUntil };
}
