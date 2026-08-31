// 회의 정리 결과 — 2026-08-28 확정: AI 가 쓰는 '주제별 마크다운 정리본' 하나로 단순화.
//  (할 일 추출·아사나 업로드 제거 — 정리본을 아사나에 옮겨 거기서 직접 업무 등록, 대표 결정)
export interface Meeting {
  title: string;
  date: string;
  createdAt: string;
  body: string; // 도입 문단 + ## 주제 섹션 + ## 결론 및 다음 단계 (티로풍)
  rawText: string;
}
