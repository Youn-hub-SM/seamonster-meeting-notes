// 내려받는 엑셀의 공통 모양 — 서버 전용(exceljs 워크시트를 다룬다).
//  [엑셀 올리기]가 있는 화면의 내려받기 파일은 '올릴 때 꼭 있어야 하는 칸'의 머리 글자를 노랗게 칠한다(2026-11-24 대표).
//  어느 칸이 필수인지는 읽는 쪽(hr-import.ts 의 *_REQUIRED_LABELS)이 정한다 — 읽는 규칙과 색이 어긋나지 않게 한 곳에 둔다.

import type ExcelJS from "exceljs";

export const REQUIRED_ARGB = "FFFFE699";   // 연한 노랑

// rowNo 줄(머리 줄)에서 labels 에 든 이름의 칸만 칠한다. 줄 전체에 건 바탕색보다 칸에 건 색이 이긴다.
export function markRequired(ws: ExcelJS.Worksheet, rowNo: number, labels: readonly string[]): void {
  ws.getRow(rowNo).eachCell((c) => {
    if (labels.includes(String(c.value ?? ""))) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: REQUIRED_ARGB } };
  });
}
