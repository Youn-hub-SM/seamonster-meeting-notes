"use client";

import { useToast } from "@/app/components/Feedback";
import type { Briefing } from "@/app/lib/crm-briefing";

// CRM 주간 브리핑 창(2026-11-25) — 성과 탭의 한 주 숫자를 글로 푼 것(app/lib/crm-briefing.ts, 규칙 기반·AI 호출 없음).
//  이 창은 보여 주기만 한다: 주 이동·발송 수 받아 오기·계산은 WeeklyStats 가 한다. [브리핑 복사]는 팀즈·메일에 붙일 글을 복사한다.
export default function WeeklyBriefing({ briefing, busy, busyText, canNext, onPrev, onNext, onClose }: {
  briefing: Briefing | null; busy: boolean; busyText: string; canNext: boolean; onPrev: () => void; onNext: () => void; onClose: () => void;
}) {
  const toast = useToast();
  const copy = async () => {
    if (!briefing) return;
    try { await navigator.clipboard.writeText(briefing.text); toast.success("브리핑을 복사했습니다"); }
    catch { toast.error("복사하지 못했습니다. 글을 직접 끌어서 복사하세요"); }
  };
  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal crm-brief-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">주간 브리핑</h2><button className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body">
          <div className="crm-brief-nav">
            <div className="sm-tabs">
              <button className="sm-tab" onClick={onPrev} disabled={busy} aria-label="이전 주">이전 주</button>
              <span className="crm-perf-week num">{briefing?.period || "-"}</span>
              <button className="sm-tab" onClick={onNext} disabled={busy || !canNext} aria-label="다음 주">다음 주</button>
            </div>
          </div>
          {busy || !briefing ? <div className="b2b-loading">{busyText}</div> : (
            <>
              {briefing.notice && <div className="sm-warn">{briefing.notice}</div>}
              <p className="crm-brief-lead">{briefing.lead}</p>
              {briefing.sections.map((s) => (
                <section key={s.key} className="crm-brief-sec">
                  <h3 className="crm-brief-title">{s.title}</h3>
                  {!s.lines.length ? <p className="crm-brief-empty">{s.empty}</p> : (
                    <ul className="crm-brief-list">
                      {s.lines.map((l, i) => (
                        <li key={i} className={`crm-brief-line${l.tone ? ` is-${l.tone}` : ""}`}>
                          <span className="crm-brief-text">{l.text}</span>
                          {l.sub && <span className="crm-brief-sub num">{l.sub}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </>
          )}
        </div>
        <div className="b2b-modal-foot"><span /><div className="b2b-modal-foot-right">
          <button className="b2b-btn-secondary" onClick={onClose}>닫기</button>
          <button className="b2b-btn-primary" onClick={copy} disabled={busy || !briefing}>브리핑 복사</button>
        </div></div>
      </div>
    </div>
  );
}
