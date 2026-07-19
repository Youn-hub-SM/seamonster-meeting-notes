import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase";
import type { MarginResult, MarginSpec } from "./margin-calc";

// 저장된 이익률 계산 — b2b_settings(key-value)에 JSON 배열로 보관(저장 리포트와 동일 방식).
//  specs(계산 레시피)가 있으면 클릭 시 AI 없이 '현재' 원가 기준으로 즉시 재계산(저장 SQL 재실행에 해당).
//  specs 가 없으면 결과 스냅샷 표시, 그것도 없으면(레거시) AI 재계산.

export type SavedMarginCalc = {
  id: string;
  name: string;
  question: string;             // AI 재계산용 질문(이어서 질문까지 합친 문장)
  specs?: MarginSpec[] | null;  // 계산 레시피 — 있으면 AI 없이 현재 데이터로 즉시 계산
  result?: MarginResult | null; // 저장 시점 결과 스냅샷(스펙 없을 때의 즉시 열기용)
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
