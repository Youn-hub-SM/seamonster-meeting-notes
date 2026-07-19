import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase";

// 저장된 이익률 계산 시나리오 — b2b_settings(key-value)에 JSON 배열로 보관(저장 리포트와 동일 방식).
//  실행 시 저장된 질문을 그대로 다시 분석(원가·수수료·계절이 바뀌면 결과도 최신 기준으로 나옴).

export type SavedMarginCalc = {
  id: string;
  name: string;
  question: string;      // 다시 실행할 질문(이어서 질문까지 합친 문장)
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
