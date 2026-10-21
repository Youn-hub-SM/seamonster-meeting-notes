"use client";

import { useEffect, useState, type ReactNode } from "react";

// 관리자 › 설정 공용 부품(2026-10-21 대표: 같은 모양 · 메뉴별 · 중복 없이 · 켜기/끄기 · 예약).
//  모든 설정은 화면에서 바꾼 뒤 아래 [저장]으로 반영한다(대표 결정 — 바로 저장 아님). 테스트·미리 보기·보내기 같은 '실행' 버튼만 바로 동작한다.
//  켜기/끄기 = 디자인 기준 토글(.sm-tabs > .sm-tab .is-active).

export type Msg = { ok: boolean; text: string };
export type SectionProps = { onDirty: (dirty: boolean) => void };

/** [켜짐][꺼짐] 토글 */
export function OnOff({ value, onChange, disabled, onLabel = "켜짐", offLabel = "꺼짐", label }: {
  value: boolean; onChange: (v: boolean) => void; disabled?: boolean; onLabel?: string; offLabel?: string; label: string;
}) {
  return (
    <div className="sm-tabs set-onoff" role="group" aria-label={label}>
      <button type="button" className={`sm-tab ${value ? "is-active" : ""}`} aria-pressed={value} disabled={disabled} onClick={() => onChange(true)}>{onLabel}</button>
      <button type="button" className={`sm-tab ${!value ? "is-active" : ""}`} aria-pressed={!value} disabled={disabled} onClick={() => onChange(false)}>{offLabel}</button>
    </div>
  );
}

export type PillState = "on" | "off" | "warn" | "err";
const PILL: Record<PillState, { bg: string; fg: string }> = {
  on: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  off: { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
  warn: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  err: { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
};
export function Pill({ state, children }: { state: PillState; children: ReactNode }) {
  return <span className="b2b-status-pill" style={{ background: PILL[state].bg, color: PILL[state].fg }}>{children}</span>;
}

/** 설정 카드 — 제목 · 상태 · 한 줄 설명 · 줄들 */
export function SetCard({ title, pill, desc, actions, children }: { title: string; pill?: ReactNode; desc?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="b2b-card set-card">
      <div className="b2b-card-head">
        <div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)" }}>
          <h2 className="b2b-card-title">{title}</h2>
          {pill}
        </div>
        {actions && <div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)" }}>{actions}</div>}
      </div>
      {desc && <p className="set-desc">{desc}</p>}
      {children}
    </section>
  );
}

/** 설정 줄 — 왼쪽 이름·설명, 오른쪽 조작. children = 줄 아래 펼친 값 */
export function SetRow({ label, desc, control, children, note }: { label: ReactNode; desc?: ReactNode; control?: ReactNode; children?: ReactNode; note?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-main">
        <div className="set-row-text">
          <div className="set-row-label">{label}</div>
          {desc && <div className="set-row-desc">{desc}</div>}
          {note && <div className="set-row-note">{note}</div>}
        </div>
        {control && <div className="set-row-control">{control}</div>}
      </div>
      {children && <div className="set-row-body">{children}</div>}
    </div>
  );
}

/** 예약 시각 목록(KST HH:MM, 5분 단위로 내림) */
export function TimesEditor({ times, onChange, max = 6, disabled }: { times: string[]; onChange: (t: string[]) => void; max?: number; disabled?: boolean }) {
  const [draft, setDraft] = useState("09:00");
  const add = () => {
    const [h, m] = draft.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return;
    const t = `${String(h).padStart(2, "0")}:${String(Math.floor(m / 5) * 5).padStart(2, "0")}`; // 5분 틱 — 그 사이 시각은 울리지 않는다
    if (!times.includes(t)) onChange([...times, t].sort().slice(0, max));
  };
  return (
    <div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)" }}>
      {times.map((t) => (
        <span key={t} className="b2b-status-pill set-time">
          {t}
          {times.length > 1 && !disabled && (
            <button type="button" className="set-time-del" aria-label={`${t} 빼기`} onClick={() => onChange(times.filter((x) => x !== t))}>✕</button>
          )}
        </span>
      ))}
      {!disabled && (
        <>
          <input type="time" className="b2b-input set-time-input" step={300} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="추가할 시각" />
          <button type="button" className="b2b-btn-secondary" onClick={add} disabled={times.length >= max}>시각 추가</button>
          {times.length >= max && <span className="b2b-btn-why">최대 {max}개</span>}
        </>
      )}
    </div>
  );
}

/** 섹션 아래 고정 저장 줄 — 바꾼 것이 있을 때만 [저장]이 켜진다 */
export function SaveBar({ dirty, saving, onSave, onReset, msg }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void; msg: Msg | null }) {
  return (
    <div className={`set-savebar ${dirty ? "is-dirty" : ""}`}>
      <span className="set-savebar-text" role="status">
        {saving ? "저장 중..." : dirty ? "저장하지 않은 변경이 있습니다" : msg ? msg.text : "변경 사항 없음"}
      </span>
      {msg && !msg.ok && !saving && <span className="b2b-field-error">{msg.text}</span>}
      <div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)" }}>
        <button type="button" className="b2b-btn-secondary" onClick={onReset} disabled={!dirty || saving}>되돌리기</button>
        <button type="button" className="b2b-btn-primary" onClick={onSave} disabled={!dirty || saving}>{saving ? "저장 중..." : "저장"}</button>
      </div>
    </div>
  );
}

/** 실행 결과 한 줄(테스트 발송 등) */
export function Result({ msg }: { msg: Msg | null }) {
  if (!msg) return null;
  return <div className={msg.ok ? "sm-success" : "b2b-error"} style={{ marginTop: "var(--sm-space-2)" }}>{msg.text}</div>;
}

/** 저장본과 편집본 — dirty 판정과 되돌리기를 한곳에서 */
export function useDraft<T>(initial: T | null) {
  const [saved, setSaved] = useState<T | null>(initial);
  const [draft, setDraft] = useState<T | null>(initial);
  const dirty = saved !== null && draft !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const load = (v: T) => { setSaved(v); setDraft(v); };
  const reset = () => setDraft(saved);
  return { saved, draft, setDraft, dirty, load, reset };
}

/** 부모에 dirty 알림 */
export function useReportDirty(dirty: boolean, onDirty: (d: boolean) => void) {
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
}

export const hhmm = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
export const errText = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

/** JSON 요청 — ok 가 아니면 던진다 */
export async function api<T = Record<string, unknown>>(url: string, method = "GET", body?: unknown): Promise<T & { ok: boolean }> {
  const res = await fetch(url, {
    method, cache: "no-store",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({ ok: false, error: `서버 응답 오류(HTTP ${res.status})` }));
  if (!res.ok || !j.ok) throw new Error(j.error || `요청 실패(HTTP ${res.status})`);
  return j;
}
