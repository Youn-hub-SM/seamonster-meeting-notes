import { Meeting } from "./types";

export function meetingToMarkdown(meeting: Meeting): string {
  const lines: string[] = [];

  lines.push(`# ${meeting.title}`);
  lines.push(`> ${meeting.date}`);
  lines.push("");

  // 1) 시간순 요약
  if (meeting.timelineSummary.length > 0) {
    lines.push("## 1) 시간순 요약");
    lines.push("");
    for (const item of meeting.timelineSummary) {
      lines.push(`- **${item.time}** / ${item.content}`);
    }
    lines.push("");
  }

  // 2) 결론(의사결정)
  if (meeting.decisions.length > 0) {
    lines.push("## 2) 결론 (의사결정)");
    lines.push("");
    for (const dec of meeting.decisions) {
      lines.push(`### ${dec.category}`);
      lines.push("");
      if (dec.decided.length > 0) {
        lines.push("**하기로 한 것**");
        for (const d of dec.decided) {
          lines.push(`- ${d}`);
        }
        lines.push("");
      }
      if (dec.rejected.length > 0) {
        lines.push("**하지 않기로 한 것**");
        for (const d of dec.rejected) {
          lines.push(`- ${d}`);
        }
        lines.push("");
      }
      if (dec.pending.length > 0) {
        lines.push("**보류**");
        for (const d of dec.pending) {
          lines.push(`- ${d}`);
        }
        lines.push("");
      }
    }
  }

  // 3) To-Do 리스트
  if (meeting.todos.length > 0) {
    lines.push("## 3) To-Do 리스트");
    lines.push("");
    for (const item of meeting.todos) {
      const deadline = item.deadline ? ` — ${item.deadline}` : "";
      lines.push(`- [${item.assignee}] ${item.task}${deadline}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
