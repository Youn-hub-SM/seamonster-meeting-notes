import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase";
import type { ReportChart, ReportLooker } from "./report-ai";

// 저장된 커스텀 리포트 — b2b_settings(key-value)에 JSON 배열로 보관(별도 테이블/RLS 불필요).
//  sql 에 {{변수}} 를 넣어두면 재사용 시 그 값만 바꿔 실행(템플릿). BoxHero 커스텀 리포트와 동일 개념.

export type SavedReport = {
  id: string;
  name: string;
  question: string;      // 최초 자연어 질문(참고)
  sql: string;           // 실행 SQL(‘{{변수}}’ 포함 가능)
  chart: ReportChart;
  looker: ReportLooker;
  createdAt: string;
  createdBy?: string | null;  // 저장자(이름). 레거시 레코드는 없을 수 있음.
};

const KEY = "report_saved_list";

export async function getSavedReports(): Promise<SavedReport[]> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
    const v = (data as { value?: unknown } | null)?.value;
    return Array.isArray(v) ? (v as SavedReport[]) : [];
  } catch {
    return [];
  }
}

async function writeList(list: SavedReport[]): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb.from("b2b_settings").upsert(
    { key: KEY, value: list, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw error;
}

export async function addSavedReport(r: Omit<SavedReport, "id" | "createdAt">): Promise<SavedReport> {
  const list = await getSavedReports();
  const rec: SavedReport = { ...r, id: randomUUID(), createdAt: new Date().toISOString() };
  await writeList([rec, ...list].slice(0, 100)); // 최신 우선, 최대 100개
  return rec;
}

export async function deleteSavedReport(id: string): Promise<void> {
  const list = await getSavedReports();
  await writeList(list.filter((x) => x.id !== id));
}
