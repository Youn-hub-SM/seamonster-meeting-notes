import { randomUUID } from "crypto";
import { mutateKv, readKvSoft, readKvStrict } from "./production-kv";

// ─────────────────────────────────────────────
// 생산 캘린더용 프로모션 일정 — b2b_settings('production_promotions') 에 배열로 저장.
//  마이그레이션 없이 운영. 각 프로모션은 기간 + 예상 추가판매량.
// ─────────────────────────────────────────────

const KEY = "production_promotions";

export interface PromoItem {
  sku: string;
  name: string;
  qty: number;         // 이 상품의 예상 판매량
}

export interface Promotion {
  id: string;
  name: string;
  start: string;       // YYYY-MM-DD
  end: string;         // YYYY-MM-DD (>= start)
  items: PromoItem[];  // 상품별 예상 판매량
  expectedQty: number; // 예상 판매량 합계 (items 합)
  note?: string;
  color?: string;      // 캘린더 밴드 색 (선택)
}

const COLORS = ["#F15A30", "#0A66C2", "#22863A", "#B86E00", "#7C3AED", "#C92A2A"];

// 읽기는 두 갈래(S4) — 쓰기·목록 화면은 getPromotions(오류면 던진다: '빈 목록 + 이번 1건'으로 전체 일정을 덮어쓰지 않게),
//  계산 경로(권장·판매속도)는 getPromotionsWithOk(실패해도 빈 목록으로 계속 돌되 ok=false — 호출부가 경고·초안 중단).
//  저장은 mutateKv(낙관적 잠금 + 저장 오류 확인).
const asList = (v: unknown): Promotion[] => (Array.isArray(v) ? (v as Promotion[]) : []);

export async function getPromotions(): Promise<Promotion[]> {
  return asList((await readKvStrict<Promotion[]>(KEY)).value);
}

export async function getPromotionsWithOk(): Promise<{ list: Promotion[]; ok: boolean }> {
  const r = await readKvSoft<Promotion[]>(KEY);
  return { list: asList(r.value), ok: r.ok };
}

function normalize(p: Partial<Promotion>): Omit<Promotion, "id"> {
  const start = (p.start || "").trim();
  const end = (p.end || "").trim() || start;
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  const items = Array.isArray(p.items)
    ? p.items
        .map((it) => ({ sku: (it.sku || "").trim(), name: (it.name || "").trim(), qty: Math.max(0, Math.floor(Number(it.qty) || 0)) }))
        .filter((it) => it.name && it.qty > 0)
    : [];
  const expectedQty = items.length > 0
    ? items.reduce((s, it) => s + it.qty, 0)
    : Math.max(0, Math.floor(Number(p.expectedQty) || 0));
  return {
    name: (p.name || "").trim() || "프로모션",
    start: lo,
    end: hi,
    items,
    expectedQty,
    note: (p.note || "").trim() || undefined,
    color: p.color,
  };
}

// 추가 또는 수정(id 있으면 수정). 반환: 갱신된 전체 목록.
export async function upsertPromotion(input: Partial<Promotion>): Promise<Promotion[]> {
  const norm = normalize(input);
  if (!norm.start) throw new Error("시작일을 입력하세요.");
  const newId = randomUUID();
  return mutateKv<Promotion[]>(KEY, (cur) => {
    const list = [...asList(cur)];
    if (input.id) {
      const idx = list.findIndex((x) => x.id === input.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...norm, id: input.id };
    } else {
      const color = norm.color || COLORS[list.length % COLORS.length];
      list.push({ ...norm, color, id: newId });
    }
    list.sort((a, b) => a.start.localeCompare(b.start));
    return list;
  });
}

export async function deletePromotion(id: string): Promise<Promotion[]> {
  return mutateKv<Promotion[]>(KEY, (cur) => asList(cur).filter((x) => x.id !== id));
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysInclusive(a: string, b: string): number {
  if (!a || !b || b < a) return 0;
  const ms = new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime();
  return Math.round(ms / 86400_000) + 1;
}

// 앞으로 반영할 프로모션 수요 — 지금~목표 일수(생산 일정 기반)에 걸치는 프로모션의 '남은' 예상판매(SKU별).
//  진행 중인 행사는 이미 지난 만큼은 빼고 남은 기간분만(일할). 안 시작한 행사는 전량.
//  → 행사분때문에 '미리 만들어둔 것'은 현재고로 차감되고, 남은 행사분만 추가로 확보.
export async function getPromoForwardBySku(today: string, leadDays: number): Promise<Record<string, number>> {
  return promoForwardFrom((await getPromotionsWithOk()).list, today, leadDays);
}
export function promoForwardFrom(list: Promotion[], today: string, leadDays: number): Record<string, number> {
  const horizon = addDaysIso(today, Math.max(0, leadDays));
  const out: Record<string, number> = {};
  for (const p of list) {
    if (!p.start || p.end < today || p.start > horizon) continue;
    const total = daysInclusive(p.start, p.end);
    const fwd = daysInclusive(p.start > today ? p.start : today, p.end); // 남은(앞으로) 일수
    if (total <= 0 || fwd <= 0) continue;
    const frac = Math.min(1, fwd / total);
    for (const it of p.items || []) {
      const sku = (it.sku || "").trim().toUpperCase();
      if (!sku) continue;
      out[sku] = (out[sku] || 0) + (Number(it.qty) || 0) * frac;
    }
  }
  return out;
}

// 판매속도 보정용 — 최근 집계창[from,to]에 '이미 나간' 프로모션 판매분(SKU별, 일할).
//  이 값을 평상시 판매속도에서 빼서, 행사때 과하게 나간 스파이크를 제거한다.
//  → 행사분때문에 '과하게 많이 나간 것'이 평상시 안전재고를 부풀리지 않게.
export async function getPromoSoldInWindow(from: string, to: string): Promise<Record<string, number>> {
  return promoSoldFrom((await getPromotionsWithOk()).list, from, to);
}
export function promoSoldFrom(list: Promotion[], from: string, to: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!from || !to || to < from) return out;
  for (const p of list) {
    if (!p.start || p.end < from || p.start > to) continue;
    const total = daysInclusive(p.start, p.end);
    const overlap = daysInclusive(p.start > from ? p.start : from, p.end < to ? p.end : to);
    if (total <= 0 || overlap <= 0) continue;
    const frac = Math.min(1, overlap / total);
    for (const it of p.items || []) {
      const sku = (it.sku || "").trim().toUpperCase();
      if (!sku) continue;
      out[sku] = (out[sku] || 0) + (Number(it.qty) || 0) * frac;
    }
  }
  return out;
}
