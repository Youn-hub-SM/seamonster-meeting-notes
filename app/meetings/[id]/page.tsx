import Link from "next/link";
import { getMeetingById } from "@/app/lib/meetings";
import { meetingToMarkdown } from "@/app/lib/markdown";
import { notFound } from "next/navigation";
import DeleteButton from "./DeleteButton";
import CopyMarkdownButton from "./CopyMarkdownButton";

export const dynamic = "force-dynamic";

export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const meeting = await getMeetingById(id);

  if (!meeting) {
    notFound();
  }

  return (
    <div className="container">
      <Link href="/" className="btn-secondary" style={{ marginBottom: 24, display: "inline-flex" }}>
        &larr; 목록으로
      </Link>

      <div className="detail-header">
        <div className="detail-date">{meeting.date}</div>
        <h1 className="detail-title">{meeting.title}</h1>
        <div style={{ marginTop: 16 }}>
          <CopyMarkdownButton markdown={meetingToMarkdown(meeting)} />
        </div>
      </div>

      {/* 1) 시간순 요약 */}
      {meeting.timelineSummary.length > 0 && (
        <div className="detail-section">
          <h2 className="detail-section-title">1) 시간순 요약</h2>
          <div className="timeline-list">
            {meeting.timelineSummary.map((item, i) => (
              <div key={i} className="timeline-item">
                <span className="timeline-time">{item.time}</span>
                <span className="timeline-content">{item.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 2) 결론(의사결정) */}
      {meeting.decisions.length > 0 && (
        <div className="detail-section">
          <h2 className="detail-section-title">2) 결론 (의사결정)</h2>
          {meeting.decisions.map((dec, i) => (
            <div key={i} className="decision-category">
              <h3 className="decision-category-title">{dec.category}</h3>
              {dec.decided.length > 0 && (
                <div className="decision-group">
                  <span className="decision-label decision-label--decided">하기로 한 것</span>
                  <ul className="decision-list">
                    {dec.decided.map((d, j) => (
                      <li key={j} className="decision-item decision-item--decided">{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {dec.rejected.length > 0 && (
                <div className="decision-group">
                  <span className="decision-label decision-label--rejected">하지 않기로 한 것</span>
                  <ul className="decision-list">
                    {dec.rejected.map((d, j) => (
                      <li key={j} className="decision-item decision-item--rejected">{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {dec.pending.length > 0 && (
                <div className="decision-group">
                  <span className="decision-label decision-label--pending">보류</span>
                  <ul className="decision-list">
                    {dec.pending.map((d, j) => (
                      <li key={j} className="decision-item decision-item--pending">{d}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 3) To-Do 리스트 */}
      {meeting.todos.length > 0 && (
        <div className="detail-section">
          <h2 className="detail-section-title">3) To-Do 리스트</h2>
          <ul className="todo-list">
            {meeting.todos.map((item, i) => (
              <li key={i} className="todo-item">
                <span className="todo-assignee">[{item.assignee}]</span>
                <span className="todo-task">{item.task}</span>
                {item.deadline && (
                  <span className="todo-deadline">— {item.deadline}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <RawTextSection rawText={meeting.rawText} />

      <div className="detail-actions">
        <DeleteButton meetingId={meeting.id} />
      </div>
    </div>
  );
}

function RawTextSection({ rawText }: { rawText: string }) {
  return (
    <div className="raw-toggle">
      <details>
        <summary className="btn-secondary" style={{ cursor: "pointer" }}>
          원본 텍스트 보기
        </summary>
        <div className="raw-text">{rawText}</div>
      </details>
    </div>
  );
}
