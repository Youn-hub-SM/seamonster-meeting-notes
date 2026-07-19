import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase";
import type { MarginResult } from "./margin-calc";

// 저장된 이익률 계산 — b2b_settings(key-value)에 JSON 배열로 보관(저장 리포트와 동일 방식).
//  결과 스냅샷을 함께 저장해 클릭 시 AI 호출 없이 바로 열림. '다시 계산'만 AI 를 다시 태움.

export type SavedMarginCalc = {
  id: string;
  name: string;
  question: string;            // 다시 계산할 질문(이어서 질문까지 합친 문장)
  result?: MarginResult | null; // 저장 시점 결과 스냅샷(즉시 열기용). 없으면(레거시) 클릭 시 재계산
  createdAt: string;
  createdBy?: string | null;
};

const KEY = "margin_calc_saved_list";

export async function getSavedMarginCalcs(): Promise<SavedMarginCalc[]> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    const v = (data as { value?: unknown } | null)?.value;
    return Array.isArray(v) ? (v as SavedMarginCalc[]) : [];
  } catch {
    return [];
  }
}

async function writeList(list: SavedMarginCalc[]): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb.from("b2b_settings").upsert(
    { key: KEY, value: list, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw error;
}

export async function addSavedMarginCalc(input: Omit<SavedMarginCalc, "id" | "createdAt">): Promise<SavedMarginCalc> {
  const rec: SavedMarginCalc = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  const list = await getSavedMarginCalcs();
  await writeList([rec, ...list]);
  return rec;
}

export async function deleteSavedMarginCalc(id: string): Promise<void> {
  const list = await getSavedMarginCalcs();
  await writeList(list.filter((r) => r.id !== id));
}
