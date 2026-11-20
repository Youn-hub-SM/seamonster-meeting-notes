"use client";

// 오디언스 추출 — [탈리 응답자 제외] 칸(구매 고객·정기배송 고객 공용, 2026-11-20).
//  고른 탈리 폼에 이미 답한 고객을 찾은 고객에서 뺀다 — 비교는 서버가 전화번호로 한다(app/lib/audience-tally.ts).
//  폼 목록은 이 칸을 처음 누를 때 한 번 읽는다. 폼은 MAX 개까지.
import { useMemo, useRef, useState } from "react";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";

export type ExForm = { id: string; name: string };
// 검색 결과에 함께 오는 집계 — 응답 수, 전화번호를 못 찾은 응답 수, 빠진 고객 수
export type TallyStat = { forms: string[]; responses: number; noPhone: number; removed: number };
const MAX = 5; // 서버(MAX_EXCLUDE_FORMS)와 같은 값

export default function TallyExclude({ value, onChange }: { value: ExForm[]; onChange: (v: ExForm[]) => void }) {
  const [forms, setForms] = useState<ExForm[] | null>(null);
  const [error, setError] = useState("");
  const asked = useRef(false);

  const load = () => {
    if (asked.current) return;
    asked.current = true;
    fetch("/api/audience?forms=1", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!j.ok) throw new Error(j.error);
      setForms(j.forms || []); setError("");
    }).catch((e) => { asked.current = false; setError(e instanceof Error ? e.message : "탈리 폼 목록을 불러오지 못했습니다."); });
  };
  const full = value.length >= MAX;
  const options: ComboOption[] = useMemo(() => (full ? [] : (forms || []).filter((f) => !value.some((v) => v.id === f.id)).map((f) => ({ id: f.id, label: f.name }))), [forms, value, full]);
  const add = (o: ComboOption) => { if (!full && !value.some((v) => v.id === o.id)) onChange([...value, { id: o.id, name: o.label }]); };

  return (
    <div className="b2b-field aud-wide" onFocusCapture={load} onPointerDownCapture={load}>
      <span className="b2b-field-label">탈리 응답자 제외</span>
      {error && <div className="b2b-error">{error}</div>}
      <Combobox value="" options={options} onSelect={add} ariaLabel="탈리 폼 검색" placeholder="탈리 폼 검색"
        emptyText={full ? `폼은 ${MAX}개까지 고릅니다` : forms ? "일치하는 폼이 없습니다" : "폼을 불러오는 중..."} />
      {value.length > 0 && (
        <div className="aud-chips">
          {value.map((f) => (
            <button key={f.id} type="button" className="aud-chip" aria-label={`${f.name} 빼기`} onClick={() => onChange(value.filter((x) => x.id !== f.id))}>
              {f.name}<span className="aud-chip-code">응답자 제외</span><span aria-hidden="true">✕</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 결과 머리의 회색 글에 붙이는 말
export const tallyText = (t: TallyStat | null | undefined): string => (t ? ` · 탈리 응답 ${t.responses.toLocaleString("ko-KR")}건 중 ${t.removed.toLocaleString("ko-KR")}명 제외` : "");
