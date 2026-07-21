import { Meeting } from "./types";

// 회의록 → 일반 게시판 친화 '평문' 정리본.
//  마크다운 기호(#, **, -)는 렌더러 없는 게시판에서 그대로 노출돼 가독성이 떨어지므로,
//  1) · 가) · (1) · · 계층의 번호/기호만으로 구조를 표현한다.

const KO = "가나다라마바사아자차카타파하";
const ko = (i: number): string => (i < KO.length ? KO[i] : String(i + 1)); // 14개 초과 시 숫자로 폴백

export function meetingToMarkdown(meeting: Meeting): string {
  const out: string[] = [];

  out.push(meeting.title);
  if (meeting.date) out.push(meeting.date);

  // 1) 시간순 요약
  if (meeting.timelineSummary.length > 0) {
    out.push("", "1) 시간순 요약", "");
    for (const item of meeting.timelineSummary) {
      const t = (item.time || "").trim();
      out.push(`  · ${t ? `${t}  ` : ""}${item.content}`);
    }
  }

  // 2) 결론(의사결정) — 항목이 하나도 없는 범주는 건너뜀
  const decisions = meeting.decisions.filter((d) => d.decided.length || d.rejected.length || d.pending.length);
  if (decisions.length > 0) {
    out.push("", "2) 결론 (의사결정)", "");
    decisions.forEach((dec, di) => {
      out.push(`  ${ko(di)}) ${dec.category}`);
      const group = (label: string, items: string[]) => {
        if (!items.length) return;
        out.push(`     ${label}`);
        for (const s of items) out.push(`       · ${s}`);
      };
      group("[하기로 한 것]", dec.decided);
      group("[하지 않기로 한 것]", dec.rejected);
      group("[보류]", dec.pending);
      if (di < decisions.length - 1) out.push("");
    });
  }

  // 3) To-Do — 담당자별로 묶어 표시(등장 순서 유지)
  if (meeting.todos.length > 0) {
    out.push("", "3) To-Do", "");
    const order: string[] = [];
    const byAssignee = new Map<string, string[]>();
    for (const item of meeting.todos) {
      const who = item.assignee || "담당자 미정";
      if (!byAssignee.has(who)) { byAssignee.set(who, []); order.push(who); }
      const deadline = item.deadline ? ` — ${item.deadline}` : "";
      byAssignee.get(who)!.push(`${item.task}${deadline}`);
    }
    order.forEach((who, wi) => {
      out.push(`  [${who}]`);
      for (const task of byAssignee.get(who)!) out.push(`     · ${task}`);
      if (wi < order.length - 1) out.push("");
    });
  }

  return out.join("\n");
}
