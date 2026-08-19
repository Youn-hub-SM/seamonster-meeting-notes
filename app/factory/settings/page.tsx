"use client";

// 파도소리 설정 — Swit 알림 연동(관리자 전용. API 가 관리자를 검사하고, 메뉴도 관리자에게만 보인다).
//  파도소리 계정이 주소로 직접 들어오면 403 안내만 보게 된다.

import { useEffect, useState } from "react";

export default function FactorySettingsPage() {
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    fetch("/api/factory/settings", { cache: "no-store" }).then((r) => r.json())
      .then((j) => {
        if (j.ok) { setUrl(j.config.url || ""); setEnabled(!!j.config.enabled); }
        else setDenied(true);
      })
      .catch(() => setDenied(true))
      .finally(() => setLoading(false));
  }, []);

  async function call(body: Record<string, unknown>, okText: string) {
    setSaving(true); setMsg(null);
    const j = await (await fetch("/api/factory/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    setSaving(false);
    setMsg(j.ok ? { ok: true, text: okText } : { ok: false, text: j.error || "실패" });
  }

  if (loading) return <div className="b2b-container"><div className="b2b-loading">불러오는 중...</div></div>;
  if (denied) return <div className="b2b-container"><div className="b2b-empty">관리자 전용 화면입니다.</div></div>;

  return (
    <div className="b2b-container" style={{ maxWidth: 640 }}>
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">설정</h1></div>
      </header>

      <section className="b2b-form-section">
        <div className="b2b-form-section-title">Swit 알림</div>
        <label className="b2b-field" style={{ marginBottom: 12 }}>
          <span className="b2b-field-label">수신 웹훅 URL</span>
          <input className="b2b-input" value={url} onChange={(e) => { setUrl(e.target.value); setMsg(null); }}
            placeholder="https://hook.swit.io/chat/..." spellCheck={false} />
        </label>
        <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 12px" }}>
          Swit 채널 &gt; 연동 &gt; 수신 웹훅(Incoming webhook)을 만들면 나오는 주소를 붙여넣습니다.
        </p>
        <label className="sm-row" style={{ gap: 6, alignItems: "center", cursor: "pointer", fontSize: 15, marginBottom: 14 }}>
          <input type="checkbox" className="b2b-checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setMsg(null); }} />
          입출고 알림 발송 (입고·출고·생산투입·이동·조정·취소)
        </label>
        {msg && <div className={msg.ok ? "sm-success" : "b2b-error"} style={{ marginBottom: 12 }}>{msg.text}</div>}
        <div className="b2b-form-foot b2b-form-foot-right">
          <button className="b2b-btn-secondary" onClick={() => call({ url, test: true }, "테스트 메시지를 보냈습니다 — Swit 채널을 확인하세요.")} disabled={saving || !url.trim()}>
            테스트 발송
          </button>
          <button className="b2b-btn-primary" onClick={() => call({ url, enabled }, "저장했습니다.")} disabled={saving}>저장</button>
        </div>
      </section>
    </div>
  );
}
