// 택배 발주처리 요율(단가) — 자주 바뀌므로 설정(b2b_settings.fulfill_rates)에서 관리.
//  택배 기본운임 구간 · 도착보장 박스당 추가운임 · 드라이아이스 단가 · 부자재 단가.

export type BoxTier = { maxKg: number | null; fee: number }; // maxKg=null → 초과(무제한) 마지막 구간
export type Supply = { name: string; price: number };        // 부자재(박스 등) 단가
export type FulfillRates = {
  boxTiers: BoxTier[];    // 무게(kg) 오름차순, 마지막은 maxKg=null
  guarSurcharge: number;  // 도착보장 박스당 추가운임(원)
  dryFull: number;        // 드라이아이스 1박스
  dryHalf: number;        // 드라이아이스 1/2박스
  supplies: Supply[];
};

export const DEFAULT_RATES: FulfillRates = {
  boxTiers: [{ maxKg: 2.7, fee: 2700 }, { maxKg: 5.2, fee: 3300 }, { maxKg: null, fee: 3900 }],
  guarSurcharge: 143,
  dryFull: 30800,
  dryHalf: 19800,
  supplies: [],
};

// 단가는 일자별로 소급 적용하지 않는다 → '적용 시작일'을 붙인 이력으로 관리.
//  각 날짜의 계산은 그 날짜에 유효했던 버전(적용일이 그 날짜 이하인 것 중 가장 최근)을 사용.
export const DEFAULT_EFFECTIVE = "2000-01-01"; // 이력이 없을 때 모든 날짜를 커버하는 기준일
export type RateVersion = FulfillRates & { effectiveFrom: string }; // "YYYY-MM-DD"

// 주문 총중량 → 박스타입(1부터) / 기본운임
export function boxTypeOf(w: number, tiers: BoxTier[]): number {
  for (let i = 0; i < tiers.length; i++) { const t = tiers[i]; if (t.maxKg == null || w <= t.maxKg) return i + 1; }
  return tiers.length || 1;
}
export function baseFeeOf(w: number, tiers: BoxTier[]): number {
  for (const t of tiers) { if (t.maxKg == null || w <= t.maxKg) return Number(t.fee) || 0; }
  return tiers.length ? Number(tiers[tiers.length - 1].fee) || 0 : 0;
}

// 저장값 → 안전한 FulfillRates(누락/이상값은 기본값으로 보정)
export function normalizeRates(x: unknown): FulfillRates {
  const o = (x && typeof x === "object" ? x : {}) as Partial<FulfillRates>;
  let tiers = Array.isArray(o.boxTiers) ? o.boxTiers.map((t) => ({ maxKg: t?.maxKg == null ? null : Number(t.maxKg), fee: Math.max(0, Math.round(Number(t?.fee) || 0)) })) : [];
  tiers = tiers.filter((t) => t.maxKg === null || Number.isFinite(t.maxKg));
  if (tiers.length === 0) tiers = DEFAULT_RATES.boxTiers;
  else if (!tiers.some((t) => t.maxKg === null)) tiers[tiers.length - 1].maxKg = null; // 마지막은 무제한 보장
  const num = (v: unknown, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    boxTiers: tiers,
    guarSurcharge: num(o.guarSurcharge, DEFAULT_RATES.guarSurcharge),
    dryFull: num(o.dryFull, DEFAULT_RATES.dryFull),
    dryHalf: num(o.dryHalf, DEFAULT_RATES.dryHalf),
    supplies: Array.isArray(o.supplies) ? o.supplies.map((s) => ({ name: String(s?.name || "").trim(), price: Math.max(0, Math.round(Number(s?.price) || 0)) })).filter((s) => s.name) : [],
  };
}

function normDate(v: unknown): string {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : DEFAULT_EFFECTIVE;
}

// 저장값 → 적용일 오름차순 단가 이력. (신형 {versions:[…]} · 배열 · 구형 단일객체 모두 허용)
export function normalizeHistory(x: unknown): RateVersion[] {
  let arr: unknown[];
  if (Array.isArray(x)) arr = x;
  else if (x && typeof x === "object" && Array.isArray((x as { versions?: unknown[] }).versions)) arr = (x as { versions: unknown[] }).versions;
  else if (x && typeof x === "object" && ("boxTiers" in x || "dryFull" in x || "guarSurcharge" in x)) arr = [x]; // 구형: 단일 단가
  else arr = [];
  const versions: RateVersion[] = arr.map((v) => ({ ...normalizeRates(v), effectiveFrom: normDate((v as { effectiveFrom?: unknown } | null)?.effectiveFrom) }));
  if (versions.length === 0) versions.push({ ...DEFAULT_RATES, effectiveFrom: DEFAULT_EFFECTIVE });
  versions.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
  return versions;
}

// 해당 날짜(YYYY-MM-DD)에 유효한 단가 = 적용일이 그 날짜 이하인 것 중 가장 최근. 없으면 가장 이른 것.
export function ratesFor(history: RateVersion[], date: string): FulfillRates {
  const h = history.length ? history : [{ ...DEFAULT_RATES, effectiveFrom: DEFAULT_EFFECTIVE }];
  let picked = h[0];
  for (const v of h) { if (v.effectiveFrom <= date) picked = v; else break; } // h는 오름차순
  return picked;
}
