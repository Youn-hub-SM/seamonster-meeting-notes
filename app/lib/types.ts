export interface TimelineSummary {
  time: string;       // "00:11~02:29" or "1" (순서 번호)
  content: string;    // 핵심 요약 한 줄
}

export interface Decision {
  category: string;   // "광고" / "콘텐츠" / "CRM" 등
  decided: string[];  // 하기로 한 것
  rejected: string[]; // 하지 않기로 한 것
  pending: string[];  // 보류한 것
}

export interface TodoItem {
  assignee: string;   // 담당자 (불명확 시 "담당자 미정")
  task: string;       // 실행 과제
  deadline?: string;  // 기한 (있으면)
}

export interface Meeting {
  id: string;
  title: string;
  date: string;
  createdAt: string;
  timelineSummary: TimelineSummary[];
  decisions: Decision[];
  todos: TodoItem[];
  rawText: string;
}
