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
