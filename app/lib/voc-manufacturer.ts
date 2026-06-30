// 월간 제조사 VOC 공유자료 — 계산(클라이언트/서버 공용, DB 코드 없음).
//  제조사 귀책(fault='제조사') 클레임을 월 단위로 모아 제품별 집계 + 청구 가능 손해액 + 증빙 사진.
import { VOC_CATEGORIES, type Voc } from "./voc";

export const MFG_FAULT = "제조사"; // 공유 대상 귀책

export interface MfgProduct {
  product: string;
  count: number;
  claimable: number;               // 청구 가능 손해액 합(제조사 귀책)
  categories: [string, number][];  // 유형별 건수(내림차순)
  topCategory: string;             // 최다 유형
}

export interface MfgReport {
  month: string;                   // YYYY-MM
  items: Voc[];                    // 제조사 귀책 · 해당 월 · 접수일 오름차순
  byProduct: MfgProduct[];         // 건수·손해액 큰 순
  byCategory: [string, number][];  // 유형별 건수(VOC_CATEGORIES 순서 보정)
  photos: { url: string; label: string }[];
  summary: { count: number; claimable: number; productCount: number; photoCount: number };
}

const inMonth = (d: string | null | undefined, ym: string) => !!d && d.slice(0, 7) === ym;

export function buildManufacturerReport(rows: Voc[], month: string): MfgReport {
  const items = rows
    .filter((r) => r.fault === MFG_FAULT && inMonth(r.received_at, month))
    .sort((a, b) => (a.received_at || "").localeCompare(b.received_at || ""));

  // 제품별
  const pmap = new Map<string, { count: number; claimable: number; cats: Map<string, number> }>();
  for (const r of items) {
    const key = (r.product || "").trim() || "(미지정)";
    const p = pmap.get(key) || { count: 0, claimable: 0, cats: new Map() };
    p.count += 1;
    p.claimable += r.loss_amount || 0;
    p.cats.set(r.category, (p.cats.get(r.category) || 0) + 1);
    pmap.set(key, p);
  }
  const byProduct: MfgProduct[] = [...pmap.entries()].map(([product, p]) => {
    const categories = [...p.cats.entries()].sort((a, b) => b[1] - a[1]);
    return { product, count: p.count, claimable: p.claimable, categories, topCategory: categories[0]?.[0] || "-" };
  }).sort((a, b) => b.count - a.count || b.claimable - a.claimable || a.product.localeCompare(b.product, "ko"));

  // 유형별(전체)
  const cmap = new Map<string, number>();
  for (const r of items) cmap.set(r.category, (cmap.get(r.category) || 0) + 1);
  const order = new Map(VOC_CATEGORIES.map((c, i) => [c as string, i]));
  const byCategory = [...cmap.entries()].sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99));

  const photos = items.flatMap((r) => (r.photos || []).map((url) => ({ url, label: `${r.received_at?.slice(5) || ""} · ${r.product || "-"} · ${r.category}` })));

  return {
    month, items, byProduct, byCategory, photos,
    summary: {
      count: items.length,
      claimable: items.reduce((s, r) => s + (r.loss_amount || 0), 0),
      productCount: byProduct.length,
      photoCount: photos.length,
    },
  };
}
