"use client";

// 선택지 관리 모달 — 발송채널·고객·유형을 추가/삭제. 상태(활성/비활성)는 로직이 걸려 있어 고정. (2026-11-06 page.tsx 에서 분리)
import { useState } from "react";
import type { CrmOptions } from "@/app/lib/crm";

const OPT_SECTIONS: { key: keyof CrmOptions; title: string }[] = [
  { key: "channels", title: "발송 수단" },
  { key: "customers", title: "고객군(판매 채널)" },
  { key: "msgTypes", title: "유형" },
];

export default function OptionsModal({ current, onClose, onSaved }: { current: CrmOptions; onClose: () => void; onSaved: (o: CrmOptions) => void }) {
  const [draft, setDraft] = useState<CrmOptions>(() => ({
    channels: current.channels.map((o) => ({ ...o })),
    customers: current.customers.map((o) => ({ ...o })),
    msgTypes: current.msgTypes.map((o) => ({ ...o })),
  }));
  const [adding, setAdding] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const add = (sec: keyof CrmOptions) => {
    const label = (adding[sec] || "").trim();
    if (!label) return;
    if (draft[sec].some((o) => o.key === label || o.label === label)) { setError(`"${label}" 은 이미 있습니다.`); return; }
    setError("");
    setDraft((d) => ({ ...d, [sec]: [...d[sec], { key: label, label }] })); // 새 선택지 key = 라벨 그대로(한글 허용)
    setAdding((a) => ({ ...a, [sec]: "" }));
  };
  const removeOpt = (sec: keyof CrmOptions, key: string) => setDraft((d) => ({ ...d, [sec]: d[sec].filter((o) => o.key !== key) }));

  async function saveOpts() {
    setSaving(true); setError("");
    try {
      const r = await fetch("/api/crm/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ options: draft }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "선택지를 저장하지 못했습니다. 이름을 확인하세요");
      onSaved(j.options as CrmOptions);
    } catch (e) { setError(e instanceof Error ? e.message : "선택지를 저장하지 못했습니다. 이름을 확인하세요"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal crm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">선택지 관리</h2>
          <button className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {error && <div className="b2b-error">{error}</div>}
          {OPT_SECTIONS.map(({ key, title }) => (
            <div key={key} className="crm-opt-section">
              <div className="b2b-field-label crm-opt-title">{title}</div>
              <div className="sm-row-wrap crm-opt-list">
                {draft[key].map((o) => (
                  <span key={o.key} className="b2b-status-pill crm-opt-item">
                    {o.label}
                    <button type="button" className="crm-opt-x" aria-label={`${o.label} 삭제`} onClick={() => removeOpt(key, o.key)}>✕</button>
                  </span>
                ))}
                {draft[key].length === 0 && <span className="sm-faint crm-opt-empty">비어 있음 — 저장하면 기본값으로 돌아갑니다</span>}
              </div>
              <div className="sm-row crm-opt-add">
                <input className="b2b-input" value={adding[key] || ""} aria-label={`새 ${title} 이름`} maxLength={20}
                  onChange={(e) => setAdding((a) => ({ ...a, [key]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") add(key); }} />
                <button type="button" className="b2b-btn-secondary" onClick={() => add(key)}>{title} 추가</button>
              </div>
            </div>
          ))}
          <p className="b2b-field-hint">선택지를 지워도 기존 메시지 값은 남고 "(구)" 로 표시됩니다</p>
        </div>
        <div className="b2b-modal-foot">
          <div />
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose}>그만두기</button>
            <button className="b2b-btn-primary" onClick={saveOpts} disabled={saving}>{saving ? "저장 중..." : "선택지 저장"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
