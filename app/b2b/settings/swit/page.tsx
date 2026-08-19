"use client";

// B2B 알림 → Swit 미러 설정 (Swit 도입 검토용) — 관리자 전용.
//  Flow 봇으로 나가던 알림(발주·입금·발송·재고 등)이 같은 내용으로 Swit 채널에도 발송된다.
//  기존 Flow 알림은 그대로 유지 — 이건 병행 미러라 도입 비교에 쓰고, 끄면 즉시 멈춘다.

import { useEffect, useState } from "react";

export default function B2BSwitSettingsPage() {
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/b2b/swit", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.ok) { setUrl(j.config.url || ""); setEnabled(!!j.config.enabled); } })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function call(body: Record<string, unknown>, okText: string) {
    setSaving(true); setMsg(null);
    const j = await (await fetch("/api/b2b/swit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    setSaving(false);
    setMsg(j.ok ? { ok: true, text: okText } : { ok: false, text: j.error || "실패" });
  }

  if (loading) return <div className="b2b-loading">불러오는 중...</div>;

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">Swit 알림</h1>
          <p className="b2b-page-subtitle">Flow 로 가는 B2B 알림을 Swit 채널로도 발송 — 도입 비교용</p>
        </div>
      </header>

      <section className="b2b-form-section" style={{ maxWidth: 640 }}>
        <div className="b2b-form-section-title">수신 웹훅</div>
        <label className="b2b-field" style={{ marginBottom: 12 }}>
          <span className="b2b-field-label">Swit 수신 웹훅 URL</span>
          <input className="b2b-input" value={url} onChange={(e) => { setUrl(e.target.value); setMsg(null); }}
            placeholder="https://hook.swit.io/chat/..." spellCheck={false} />
        </label>
        <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 12px" }}>
          Swit 채널 이름 클릭 &gt; 수신 웹훅(Incoming webhooks) &gt; New webhook(게시 유형 Messages)으로 만든 주소.
        </p>
        <label className="sm-row" style={{ gap: 6, alignItems: "center", cursor: "pointer", fontSize: 15, marginBottom: 14 }}>
          <input type="checkbox" className="b2b-checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setMsg(null); }} />
          B2B 알림을 Swit 로도 발송 (발주·입금·발송·재고 — Flow 와 같은 알림 설정 기준)
        </label>
        {msg && <div className={msg.ok ? "sm-success" : "b2b-error"} style={{ marginBottom: 12 }}>{msg.text}</div>}
        <div className="b2b-form-foot b2b-form-foot-right">
          <button className="b2b-btn-secondary" onClick={() => call({ url, test: true }, "테스트 메시지를 보냈습니다 — Swit 채널을 확인하세요.")} disabled={saving || !url.trim()}>
            테스트 발송
          </button>
          <button className="b2b-btn-primary" onClick={() => call({ url, enabled }, "저장했습니다.")} disabled={saving}>저장</button>
        </div>
      </section>
    </>
  );
}
