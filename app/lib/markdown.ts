import { Meeting } from "./types";

// 회의록 정리본(복사용) — 2026-08-28 형식 전환: AI 가 티로풍 '주제별 마크다운'(도입 문단 +
//  ## 주제 섹션 + ## 결론 및 다음 단계)으로 body 를 쓰므로, 여기서는 제목·날짜만 얹어 그대로 내보낸다.
//  노션·팀즈 등 마크다운을 받는 곳에 붙여넣기 좋다(화면은 별도 서식 렌더).

export function meetingToMarkdown(meeting: Meeting): string {
  const head = [meeting.title, meeting.date].filter(Boolean).join("\n");
  return `${head}\n\n${meeting.body || ""}`.trim();
}
