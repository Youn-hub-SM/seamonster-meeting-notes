import type { ReactNode } from "react";

// 보고서 본문 마크다운 — 에이전트 지침이 '## 제목 · - 목록 · **굵게**' 만 쓰게 돼 있다
const bold = (t: string, k: string): ReactNode[] => t.split(/\*\*(.+?)\*\*/g).map((seg, i) => (i % 2 ? <strong key={`${k}-${i}`}>{seg}</strong> : seg));
export function Md({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = (k: number) => { if (list.length) { out.push(<ul key={`u${k}`}>{list.map((l, i) => <li key={i}>{bold(l, `l${k}-${i}`)}</li>)}</ul>); list = []; } };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) { list.push(line.replace(/^[-*]\s+/, "")); return; }
    flush(i);
    if (!line) return;
    if (/^#{1,4}\s+/.test(line)) out.push(<h3 key={i}>{line.replace(/^#{1,4}\s+/, "")}</h3>);
    else out.push(<p key={i}>{bold(line, `p${i}`)}</p>);
  });
  flush(-1);
  return <div className="ag-md">{out}</div>;
}
