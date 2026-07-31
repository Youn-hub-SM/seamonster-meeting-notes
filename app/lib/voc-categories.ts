// VOC 문제 유형 마스터 조회(서버 전용) — 유형은 사용자가 화면에서 추가/편집하므로(072 voc_categories)
//  저장·임포트의 검증 기준은 하드코딩 목록이 아니라 이 테이블이어야 한다.
//  072 미적용 환경 폴백: 기존 하드코딩 8종(= 화면 폴백과 동일).
import { supabaseAdmin } from "./supabase";
import { VOC_CATEGORIES, suggestFault, type VocFault } from "./voc";

export interface VocCategoryOption { name: string; fault: VocFault }

const fallback = (): VocCategoryOption[] => VOC_CATEGORIES.map((name) => ({ name, fault: suggestFault(name) }));

// 유형 목록(비활성 포함). 비활성은 새 등록 선택지에서만 숨기고 검증에서는 허용 — 과거 데이터 수정이 막히지 않게.
export async function loadVocCategoryOptions(): Promise<VocCategoryOption[]> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("voc_categories").select("name, fault").order("sort", { ascending: true }).order("name", { ascending: true });
    if (error || !data?.length) return fallback();
    const rows = (data as { name: string; fault: string }[])
      .map((r) => ({ name: String(r.name || "").trim(), fault: (r.fault || "미분류") as VocFault }))
      .filter((r) => r.name);
    return rows.length ? rows : fallback();
  } catch {
    return fallback();
  }
}

export async function loadVocCategoryNames(): Promise<string[]> {
  return (await loadVocCategoryOptions()).map((c) => c.name);
}

// 유형의 귀책 기본값 — 마스터에 있으면 그 값, 없으면 기존 추정(FAULT_BY_CATEGORY).
export function faultOf(opts: VocCategoryOption[], category: string): VocFault {
  return opts.find((c) => c.name === category)?.fault || suggestFault(category);
}
