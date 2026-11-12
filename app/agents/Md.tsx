import type { ReactNode } from "react";

// 보고서 본문 마크다운 — 에이전트 지침이 '## 제목 · - 목록 · **굵게**' 만 쓰게 돼 있다.
//  들여쓴 '  - 목록'은 바로 앞 항목 아래의 하위 목록으로 그린다(한 단계까지 — 리뷰 분석 자료의 상품군별 항목이 이렇게 쓰여 있다).
const bold = (t: string, k: string): ReactNode[] => t.split(/\*\*(.+?)\*\*/g).map((seg, i) => (i % 2 ? <strong key={`${k}-${i}`}>{seg}</strong> : seg));
type Item = { text: string; sub: string[] };
export function Md({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: Item[] = [];
  const flush = (k: number) => {
    if (!list.length) return;
    out.push(
      <ul key={`u${k}`}>
        {list.map((l, i) => (
          <li key={i}>
            {bold(l.text, `l${k}-${i}`)}
            {l.sub.length > 0 && <ul>{l.sub.map((s, j) => <li key={j}>{bold(s, `s${k}-${i}-${j}`)}</li>)}</ul>}
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) {
      const body = line.replace(/^[-*]\s+/, "");
      if (/^(\s{2,}|\t)/.test(raw) && list.length) list[list.length - 1].sub.push(body);
      else list.push({ text: body, sub: [] });
      return;
    }
    flush(i);
    if (!line) return;
    if (/^#{1,4}\s+/.test(line)) out.push(<h3 key={i}>{line.replace(/^#{1,4}\s+/, "")}</h3>);
    else out.push(<p key={i}>{bold(line, `p${i}`)}</p>);
  });
  flush(-1);
  return <div className="ag-md">{out}</div>;
}
