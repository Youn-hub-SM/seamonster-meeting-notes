// 생산관리 — SKU 규칙(추론) + 생성기.
// 기존 45개 제품 SKU 에서 도출한 규칙. (가운데 코드/일부 비정형은 사용자 확인 후 보정 예정)
//
// 라인별 패턴
//   100g 소매      : {어종}-100-{mid}-100      (예: GA-100-K-100)
//   1kg 팩         : P_{어종}-{규격}X1          (예: P_GA-100X1)
//   5kg×2 벌크     : BULK-{어종}-{규격}         (예: BULK-GA-200)
//   더간편한(85g)  : R-{어종}                   (예: R-YA)
//   더간편한(425g) : P_R-{어종}                 (예: P_R-YA)
//   더 깨끗한      : {어종}-20-K-120            (예: DG-20-K-120)

export interface Species {
  code: string;
  name: string;
  // 100g 소매 SKU 가운데 코드 (기존 데이터에서 관찰된 값. 대부분 K)
  retailMid: string;
}

// 기존 제품에서 관찰된 어종 코드 + 100g 소매 가운데 코드
export const SPECIES: Species[] = [
  { code: "GA", name: "광어", retailMid: "K" },
  { code: "NA", name: "농어", retailMid: "K" },
  { code: "DG", name: "대구", retailMid: "O" },
  { code: "DSC", name: "삼치", retailMid: "K" },
  { code: "YA", name: "연어", retailMid: "K" },
  { code: "CD", name: "참돔", retailMid: "K" },
  { code: "AG", name: "아귀", retailMid: "K" },
  { code: "SH", name: "새우", retailMid: "K" },
  { code: "DAL", name: "달고기", retailMid: "K" },
  { code: "SQ", name: "오징어", retailMid: "V" },
  { code: "T", name: "틸라피아", retailMid: "T" },
];

export type LineKey = "retail100" | "pack1kg" | "bulk" | "ready_s" | "ready_l" | "cleaner";

export interface ProductLine {
  key: LineKey;
  label: string;
  desc: string;
  needsCut: boolean;   // 절단 규격(100g/200g) 선택 필요 여부
}

export const LINES: ProductLine[] = [
  { key: "retail100", label: "100g 소매", desc: "낱개 소매 (100g)", needsCut: false },
  { key: "pack1kg", label: "1kg 팩", desc: "1kg 팩 (절단 규격 선택)", needsCut: true },
  { key: "bulk", label: "5kg×2 벌크", desc: "식자재 벌크 (절단 규격 선택)", needsCut: true },
  { key: "ready_s", label: "더간편한 (85g)", desc: "더간편한 소포장", needsCut: false },
  { key: "ready_l", label: "더간편한 (425g)", desc: "더간편한 대포장", needsCut: false },
  { key: "cleaner", label: "더 깨끗한", desc: "더 깨끗한 라인", needsCut: false },
];

// 절단 규격(그램)
export const CUTS = ["100", "200"] as const;
export type Cut = (typeof CUTS)[number];

export function findSpecies(code: string): Species | undefined {
  return SPECIES.find((s) => s.code === code.toUpperCase());
}

/**
 * 규칙대로 SKU 생성.
 * @param lineKey 라인
 * @param speciesCode 어종 코드 (예: "GA")
 * @param cut 절단 규격 ("100"|"200") — 1kg팩/벌크에서만 사용
 * @param midOverride 100g 소매 가운데 코드 직접 지정 (미지정 시 어종 기본값)
 */
export function generateSku(
  lineKey: LineKey,
  speciesCode: string,
  cut: string = "100",
  midOverride?: string
): string {
  const code = speciesCode.trim().toUpperCase();
  const sp = findSpecies(code);
  const mid = (midOverride && midOverride.trim()) || sp?.retailMid || "K";
  switch (lineKey) {
    case "retail100":
      return `${code}-100-${mid}-100`;
    case "pack1kg":
      return `P_${code}-${cut}X1`;
    case "bulk":
      return `BULK-${code}-${cut}`;
    case "ready_s":
      return `R-${code}`;
    case "ready_l":
      return `P_R-${code}`;
    case "cleaner":
      return `${code}-20-K-120`;
    default:
      return code;
  }
}
