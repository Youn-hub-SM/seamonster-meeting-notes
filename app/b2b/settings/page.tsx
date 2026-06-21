"use client";

import { useEffect, useState } from "react";
import { STATUS_SHORT } from "@/app/lib/b2b-orders";
import { MODEL_OPTIONS } from "@/app/lib/config";

type EventMeta = {
  key: string;
  label: string;
  desc: string;
  kind: "toggle" | "status";
  statuses?: string[];
};
type NotifyConfig = Record<string, boolean | string[]>;

function statusLabel(s: string): string {
  return (STATUS_SHORT as Record<string, string>)[s] ?? s;
}

export default function SettingsPage() {
  const [config, setConfig] = useState<NotifyConfig>({});
  const [events, setEvents] = useState<EventMeta[]>([]);
  const [webhookSet, setWebhookSet] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [modelSaving, setModelSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [notifyRes, modelRes] = await Promise.all([
          fetch("/api/b2b/settings/notify", { cache: "no-store" }),
          fetch("/api/b2b/settings/model", { cache: "no-store" }),
        ]);
        const j = await notifyRes.json();
        if (!notifyRes.ok || !j.ok) throw new Error(j.error || "조회 실패");
        setConfig(j.config || {});
        setEvents(j.events || []);
        setWebhookSet(!!j.webhookSet);
        const mj = await modelRes.json();
        if (modelRes.ok && mj.ok) setModel(mj.current);
      } catch (e) {
        setError(e instanceof Error ? e.message : "조회 중 오류");
      }
      setLoading(false);
    })();
  }, []);

  async function selectModel(key: string) {
    if (key === model || modelSaving) return;
    const prev = model;
    setModel(key); // 낙관적 반영
    setModelSaving(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/settings/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
    } catch (e) {
      setModel(prev); // 실패 시 롤백
      setError(e instanceof Error ? e.message : "모델 저장 중 오류");
    }
    setModelSaving(false);
  }

  function isToggleOn(key: string): boolean {
    return config[key] === true;
  }
  function setToggle(key: string, on: boolean) {
    setConfig((prev) => ({ ...prev, [key]: on }));
    setSavedAt("");
  }
  function isStatusOn(key: string, status: string): boolean {
    const v = config[key];
    return Array.isArray(v) && v.includes(status);
  }
  function toggleStatus(key: string, status: string) {
    setConfig((prev) => {
      const v = Array.isArray(prev[key]) ? (prev[key] as string[]) : [];
      const next = v.includes(status) ? v.filter((s) => s !== status) : [...v, status];
      return { ...prev, [key]: next };
    });
    setSavedAt("");
  }
  function setAllStatuses(ev: EventMeta, on: boolean) {
    setConfig((prev) => ({ ...prev, [ev.key]: on ? [...(ev.statuses || [])] : [] }));
    setSavedAt("");
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/settings/notify", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      const d = new Date();
      setSavedAt(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 저장됨`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 중 오류");
    }
    setSaving(false);
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정</h1>
          <p className="b2b-page-subtitle">Zapier(외부) 알림을 이벤트·상태별로 켜고 끕니다. 히스토리 기록은 항상 모두 남습니다.</p>
        </div>
        <div className="b2b-page-actions">
          {savedAt && <span style={{ fontSize: 13, color: "#22863a", alignSelf: "center" }}>{savedAt}</span>}
          <button className="b2b-btn-primary" onClick={save} disabled={saving || loading}>
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* AI 모델 선택 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">AI 모델</h2>
          {modelSaving && <span style={{ fontSize: 13, color: "var(--sm-text-light)" }}>적용 중...</span>}
        </div>
        <p style={{ fontSize: 13, color: "var(--sm-text-mid)", margin: "0 0 14px" }}>
          회의록 정리 · 문장 교정 · CS 코치가 사용하는 모델입니다. 버튼을 누르면 즉시 적용됩니다.
          (사업자등록증 OCR 은 정확도 위해 항상 Sonnet 사용)
        </p>
        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : (
          <div className="ai-model-grid">
            {MODEL_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={`ai-model-card ${model === opt.key ? "is-active" : ""}`}
                onClick={() => selectModel(opt.key)}
                disabled={modelSaving}
              >
                <div className="ai-model-label">
                  {opt.label}
                  {model === opt.key && <span className="ai-model-check">✓ 사용 중</span>}
                </div>
                <div className="ai-model-desc">{opt.desc}</div>
                <div className="ai-model-price">{opt.price} <span>/ 1M 토큰</span></div>
              </button>
            ))}
          </div>
        )}
      </section>

      {!webhookSet && (
        <div className="b2b-error" style={{ background: "#FFF4E0", color: "#B86E00", border: "1px solid #f0d9a8" }}>
          <strong>Zapier 웹훅 URL(ZAPIER_WEBHOOK_URL)이 설정돼 있지 않습니다.</strong>
          <br />
          지금은 어떤 알림도 외부로 발송되지 않습니다. 아래 설정은 URL 설정 후 그대로 적용됩니다.
        </div>
      )}

      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">Zapier 알림</h2>
        </div>

        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : (
          <div className="b2b-notify-list">
            {events.map((ev) => (
              <div key={ev.key} className="b2b-notify-row">
                <div className="b2b-notify-info">
                  <div className="b2b-notify-label">{ev.label}</div>
                  <div className="b2b-notify-desc">{ev.desc}</div>
                </div>

                {ev.kind === "toggle" ? (
                  <label className="b2b-notify-toggle">
                    <input
                      type="checkbox"
                      className="b2b-checkbox"
                      checked={isToggleOn(ev.key)}
                      onChange={(e) => setToggle(ev.key, e.target.checked)}
                    />
                    <span>알림 발송</span>
                  </label>
                ) : (
                  <div className="b2b-notify-statuses">
                    {(ev.statuses || []).map((s) => (
                      <label key={s} className={`b2b-notify-chip ${isStatusOn(ev.key, s) ? "is-on" : ""}`}>
                        <input
                          type="checkbox"
                          checked={isStatusOn(ev.key, s)}
                          onChange={() => toggleStatus(ev.key, s)}
                        />
                        {statusLabel(s)}
                      </label>
                    ))}
                    <button
                      type="button"
                      className="b2b-notify-all"
                      onClick={() => {
                        const allOn = (ev.statuses || []).every((s) => isStatusOn(ev.key, s));
                        setAllStatuses(ev, !allOn);
                      }}
                    >
                      {(ev.statuses || []).every((s) => isStatusOn(ev.key, s)) ? "전체 끄기" : "전체 켜기"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <p style={{ fontSize: 12.5, color: "var(--sm-text-light)", marginTop: 12 }}>
        💡 상태형 항목은 <strong>체크한 결과 상태로 바뀔 때만</strong> 알림이 갑니다. 예) 발주 상태에서 &lsquo;발송완료&rsquo;만 체크하면
        중간 단계(생산중·발송대기 등)는 알림이 오지 않습니다.
      </p>
    </>
  );
}
