import { randomUUID } from "crypto";
import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// 수동 생산일정 — b2b_settings('production_manual') 에 배열로 저장.
//  품목·생산량만 입력하면 현재고·일평균출고·예상소진일은 박스히어로에서 자동 스냅샷.
// ─────────────────────────────────────────────

const KEY = "production_manual";

export interface ManualProduction {
  id: string;
  sku: string;
  name: string;
  qty: number;                    // 생산량
  productionDate: string;         // YYYY-MM-DD (캘린더 배치)
  stock: number | null;           // 추가 당시 현재고 스냅샷
  dailyOut: number;               // 추가 당시 일평균출고 스냅샷
  depletionDate: string | null;   // 예상 재고소진일 스냅샷
  createdAt: string;
}

export async function getManualProductions(): Promise<ManualProduction[]> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    if (error || !data) return [];
    return Array.isArray(data.value) ? (data.value as ManualProduction[]) : [];
  } catch {
    return [];
  }
}

async function save(list: ManualProduction[]): Promise<void> {
  const sb = supabaseAdmin();
  await sb.from("b2b_settings").upsert(
    { key: KEY, value: list, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

export async function addManualProduction(input: Partial<ManualProduction>): Promise<ManualProduction[]> {
  const sku = (input.sku || "").trim();
  const name = (input.name || "").trim();
  const qty = Math.max(0, Math.floor(Number(input.qty) || 0));
  const productionDate = (input.productionDate || "").trim();
  if (!sku || !name) throw new Error("품목을 선택하세요.");
  if (!qty) throw new Error("생산량을 입력하세요.");
  if (!productionDate) throw new Error("생산 목표일이 필요합니다.");

  const list = await getManualProductions();
  list.push({
    id: randomUUID(),
    sku,
    name,
    qty,
    productionDate,
    stock: input.stock == null ? null : Number(input.stock),
    dailyOut: Number(input.dailyOut) || 0,
    depletionDate: input.depletionDate || null,
    createdAt: new Date().toISOString(),
  });
  await save(list);
  return list;
}

export async function deleteManualProduction(id: string): Promise<ManualProduction[]> {
  const list = (await getManualProductions()).filter((x) => x.id !== id);
  await save(list);
  return list;
}
