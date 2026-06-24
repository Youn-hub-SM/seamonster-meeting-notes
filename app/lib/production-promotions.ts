import { randomUUID } from "crypto";
import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// 생산 캘린더용 프로모션 일정 — b2b_settings('production_promotions') 에 배열로 저장.
//  마이그레이션 없이 운영. 각 프로모션은 기간 + 예상 추가판매량.
// ─────────────────────────────────────────────

const KEY = "production_promotions";

export interface Promotion {
  id: string;
  name: string;
  start: string;       // YYYY-MM-DD
  end: string;         // YYYY-MM-DD (>= start)
  expectedQty: number; // 예상 판매량(기간 합)
  note?: string;
  color?: string;      // 캘린더 밴드 색 (선택)
}

const COLORS = ["#F15A30", "#0A66C2", "#22863A", "#B86E00", "#7C3AED", "#C92A2A"];

export async function getPromotions(): Promise<Promotion[]> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    if (error || !data) return [];
    const v = data.value;
    return Array.isArray(v) ? (v as Promotion[]) : [];
  } catch {
    return [];
  }
}

async function savePromotions(list: Promotion[]): Promise<void> {
  const sb = supabaseAdmin();
  await sb.from("b2b_settings").upsert(
    { key: KEY, value: list, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

function normalize(p: Partial<Promotion>): Omit<Promotion, "id"> {
  const start = (p.start || "").trim();
  const end = (p.end || "").trim() || start;
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  return {
    name: (p.name || "").trim() || "프로모션",
    start: lo,
    end: hi,
    expectedQty: Math.max(0, Math.floor(Number(p.expectedQty) || 0)),
    note: (p.note || "").trim() || undefined,
    color: p.color,
  };
}

// 추가 또는 수정(id 있으면 수정). 반환: 갱신된 전체 목록.
export async function upsertPromotion(input: Partial<Promotion>): Promise<Promotion[]> {
  const list = await getPromotions();
  const norm = normalize(input);
  if (!norm.start) throw new Error("시작일을 입력하세요.");
  if (input.id) {
    const idx = list.findIndex((x) => x.id === input.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...norm, id: input.id };
  } else {
    const color = norm.color || COLORS[list.length % COLORS.length];
    list.push({ ...norm, color, id: randomUUID() });
  }
  list.sort((a, b) => a.start.localeCompare(b.start));
  await savePromotions(list);
  return list;
}

export async function deletePromotion(id: string): Promise<Promotion[]> {
  const list = (await getPromotions()).filter((x) => x.id !== id);
  await savePromotions(list);
  return list;
}
