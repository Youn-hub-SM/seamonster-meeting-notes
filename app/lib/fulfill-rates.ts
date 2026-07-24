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

// ───────────────────────── 배송일지 박스 종류 ─────────────────────────
// 택배량 집계 단위(굴·생굴·김치8…). 단가와 달리 '적용일 이력'을 두지 않고 현재 목록 하나만 둔다 —
//  배송일지 표는 여러 날짜를 한 화면에 뿌리므로 날짜마다 열이 달라지면 표가 성립하지 않는다.
//  대신 과거 기록에만 있는 종류는 화면·집계에서 '버리지 않고' 그대로 함께 보여준다(delivery-log.ts).
export type BoxCat = { name: string; maxKg: number | null }; // maxKg 이하. null = 마지막(초과) 구간

export const DEFAULT_BOX_CATS: BoxCat[] = [
  { name: "굴", maxKg: 1.7 }, { name: "생굴", maxKg: 2.7 }, { name: "김치8", maxKg: 4 }, { name: "김치10", maxKg: 5.2 },
  { name: "12kg", maxKg: 9 }, { name: "15kg", maxKg: 11 }, { name: "20kg", maxKg: 16 }, { name: "25kg", maxKg: null },
];

export function normalizeBoxCats(x: unknown): BoxCat[] {
  if (!Array.isArray(x)) return DEFAULT_BOX_CATS.map((c) => ({ ...c }));
  const cats = x
    .map((c) => ({ name: String((c as BoxCat)?.name ?? "").trim(), maxKg: (c as BoxCat)?.maxKg == null ? null : Number((c as BoxCat).maxKg) }))
    .filter((c) => c.name && (c.maxKg === null || Number.isFinite(c.maxKg)));
  if (cats.length === 0) return DEFAULT_BOX_CATS.map((c) => ({ ...c }));
  // 이름 중복 제거(먼저 온 것 유지) + 마지막은 반드시 무제한
  const seen = new Set<string>();
  const uniq = cats.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  uniq[uniq.length - 1].maxKg = null;
  return uniq;
}

// 총중량 → 박스 종류 이름. 구간은 '이하(≤)' 기준(요율 구간 boxTiers 와 같은 규칙).
export function boxCategoryOf(w: number, cats: BoxCat[]): string {
  const list = cats.length ? cats : DEFAULT_BOX_CATS;
  for (const c of list) if (c.maxKg == null || w <= c.maxKg) return c.name;
  return list[list.length - 1].name;
}

// 종류별 '대표중량' — 운임 재계산(배송일지 직접수정)용. 사용자가 따로 입력하지 않고 구간에서 자동 도출.
//  각 종류는 요율 구간 하나 안에 완전히 들어가야 하므로(validateBoxCats), 구간 안 어느 값을 쓰든 운임이 같다.
//  마지막(무제한)만 직전 상한보다 큰 값을 쓴다.
export function boxCatWeights(cats: BoxCat[]): Record<string, number> {
  const list = cats.length ? cats : DEFAULT_BOX_CATS;
  const out: Record<string, number> = {};
  let prev = 0;
  for (const c of list) {
    out[c.name] = c.maxKg == null ? prev + 1 : c.maxKg;
    if (c.maxKg != null) prev = c.maxKg;
  }
  return out;
}

// 저장 전 검증 — 통과하면 빈 배열, 아니면 사람이 읽는 오류 문구들.
//  ★핵심 규칙: 한 박스 종류가 요율 구간(boxTiers) 경계를 걸치면 안 된다.
//   걸치면 같은 종류인데 주문마다 운임이 달라져, 배송일지에서 개수를 직접 고칠 때 금액이 어긋난다.
export function validateBoxCats(cats: BoxCat[], tiers: BoxTier[]): string[] {
  const errs: string[] = [];
  if (!cats.length) return ["박스 종류는 최소 1개 필요합니다."];
  const names = cats.map((c) => c.name);
  if (names.some((n) => !n)) errs.push("이름이 비어 있는 박스 종류가 있습니다.");
  const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (dup.length) errs.push(`박스 종류 이름이 중복됩니다: ${[...new Set(dup)].join(", ")}`);
  if (cats[cats.length - 1].maxKg != null) errs.push("마지막 박스 종류는 '초과(무제한)'여야 합니다.");

  let prev = 0;
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    if (c.maxKg == null) { if (i !== cats.length - 1) errs.push(`'${c.name}'의 이하(kg)가 비어 있습니다.`); break; }
    if (c.maxKg <= prev) { errs.push(`'${c.name}'의 이하(kg) ${c.maxKg}는 앞 종류(${prev})보다 커야 합니다.`); prev = c.maxKg; continue; }
    // 이 종류의 범위 (prev, maxKg] 안에 요율 경계가 들어오면 안 됨
    const upper = c.maxKg;
    const crossing = tiers.filter((t) => t.maxKg != null && t.maxKg > prev && t.maxKg < upper).map((t) => t.maxKg);
    if (crossing.length) errs.push(`'${c.name}'(${prev}~${c.maxKg}kg)가 운임 구간 경계 ${crossing.join("·")}kg를 걸칩니다 — 같은 종류인데 운임이 달라져 배송일지 수정 시 금액이 어긋납니다. 종류 경계를 운임 구간 경계에 맞추세요.`);
    prev = c.maxKg;
  }
  return errs;
}
