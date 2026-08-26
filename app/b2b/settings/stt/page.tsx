"use client";

import { useEffect, useState } from "react";

// 설정 · 음성 전사 — 회의 정리 화면의 '녹음 파일 변환'이 쓰는 리턴제로(RTZR) 자격증명.
//  값은 저장 여부만 보여주고 되돌려주지 않는다(아사나 PAT 와 같은 방식).
export default function SttSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [hasId, setHasId] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [model, setModel] = useState("sommers");
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [test, setTest] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/b2b/settings/stt", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j.ok) { setHasId(!!j.hasId); setHasSecret(!!j.hasSecret); setModel(j.model || "sommers"); } })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save(body: Record<string, string>, okMsg: string, tag: string) {
    setBusy(tag); setMsg(null); setTest([]);
    try {
      const res = await fetch("/api/b2b/settings/stt", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setHasId(!!j.hasId); setHasSecret(!!j.hasSecret); setModel(j.model || "sommers");
      setMsg({ t: okMsg, ok: true });
    } catch (e) { setMsg({ t: e instanceof Error ? e.message : "저장 실패", ok: false }); }
    finally { setBusy(""); }
  }

  async function runTest() {
    setBusy("test"); setMsg(null); setTest([]);
    try {
      const res = await fetch("/api/b2b/settings/stt", { method: "POST" });
      const j = await res.json();
      if (Array.isArray(j.lines)) setTest(j.lines);
      else throw new Error(j.error || "점검 실패");
    } catch (e) { setMsg({ t: e instanceof Error ? e.message : "점검 실패", ok: false }); }
    finally { setBusy(""); }
  }

  const state = (has: boolean) =>
    loading ? "확인 중…" : has
      ? <strong style={{ color: "var(--sm-success)" }}>저장됨</strong>
      : <strong style={{ color: "var(--sm-warning)" }}>미설정</strong>;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정 · 음성 전사</h1>
        </div>
      </header>

      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">리턴제로(RTZR) 연동</span></div>
        <p className="sm-muted" style={{ fontSize: 15, marginBottom: 12 }}>
          회의 정리 화면에서 <strong>녹음 파일을 그대로 올리면</strong> 화자가 구분된 전사본으로 바꿔 넣어줍니다.
          회의 용어집에 등록한 사내 용어가 전사 단계에 함께 넘어가 인식률이 올라갑니다.
          자격증명 발급: 리턴제로 개발자 콘솔에서 <strong>애플리케이션 등록 → CLIENT ID · CLIENT SECRET</strong>.
        </p>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">1) CLIENT ID · 현재 {state(hasId)}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input
              className="b2b-input" value={clientId} onChange={(e) => setClientId(e.target.value)}
              placeholder={hasId ? "새 값으로 변경(비우고 저장 시 해제)" : "리턴제로 콘솔의 CLIENT ID"}
              style={{ flex: 1, minWidth: 240 }}
            />
            <button
              className="b2b-btn-primary" disabled={busy === "id"}
              onClick={async () => { await save({ clientId }, clientId.trim() ? "CLIENT ID 저장됨" : "CLIENT ID 해제됨", "id"); setClientId(""); }}
            >{busy === "id" ? "저장 중…" : "저장"}</button>
          </div>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">2) CLIENT SECRET · 현재 {state(hasSecret)}</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input
              className="b2b-input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
              placeholder={hasSecret ? "새 값으로 변경(비우고 저장 시 해제)" : "리턴제로 콘솔의 CLIENT SECRET"}
              style={{ flex: 1, minWidth: 240 }}
            />
            <button
              className="b2b-btn-primary" disabled={busy === "secret"}
              onClick={async () => { await save({ clientSecret }, clientSecret.trim() ? "CLIENT SECRET 저장됨" : "CLIENT SECRET 해제됨", "secret"); setClientSecret(""); }}
            >{busy === "secret" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>
            SECRET 은 재발급이 어려우니 콘솔에서 받은 값을 따로 보관해두세요. 저장 후에는 화면에 다시 표시되지 않습니다.
          </span>
        </div>

        <div className="sm-col" style={{ gap: 6, marginBottom: 14 }}>
          <span className="b2b-field-label">3) 인식 엔진</span>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <select
              className="b2b-input" value={model} onChange={(e) => setModel(e.target.value)}
              style={{ width: 200 }}
            >
              <option value="sommers">sommers (리턴제로 자체)</option>
              <option value="whisper">whisper</option>
            </select>
            <button className="b2b-btn-secondary" disabled={busy === "model"}
              onClick={() => save({ model }, `인식 엔진을 ${model} 로 저장했습니다`, "model")}
            >{busy === "model" ? "저장 중…" : "저장"}</button>
          </div>
          <span className="sm-faint" style={{ fontSize: 12 }}>
            같은 녹음이라도 엔진에 따라 결과가 꽤 다릅니다. 한쪽이 아쉬우면 바꿔서 같은 파일로 비교해보세요.
            군말 필터와 문단 나누기는 꺼둔 상태입니다 — 들린 대로 다 받아야 정리 단계에서 살릴 수 있습니다.
          </span>
        </div>

        <div className="sm-row" style={{ gap: 8, alignItems: "center" }}>
          <button className="b2b-btn-secondary" onClick={runTest} disabled={busy === "test"}>
            {busy === "test" ? "확인 중…" : "연결 테스트"}
          </button>
          <span className="sm-faint" style={{ fontSize: 12 }}>저장된 자격증명으로 토큰이 발급되는지, 용어집이 몇 개 실리는지 확인합니다.</span>
        </div>

        {msg && <div className={msg.ok ? "sm-success" : "b2b-error"} style={{ marginTop: 10 }}>{msg.t}</div>}
        {test.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.8 }}>
            {test.map((l, i) => (
              <div key={i} className={/실패|미설정|비어/.test(l) ? "b2b-error" : "sm-success"} style={{ padding: "2px 10px", marginBottom: 4 }}>{l}</div>
            ))}
          </div>
        )}
      </section>

      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">비용과 보관</span></div>
        <p className="sm-muted" style={{ fontSize: 15, marginBottom: 0 }}>
          가입 시 <strong>600분(10시간)</strong>이 무료로 제공되고, 이후에는 <strong>시간당 1,000원</strong>입니다(월 1,000시간까지).
          최소 집계 단위는 10초입니다. 주 1회 2시간 회의 기준으로 월 8시간, 약 8,000원입니다.
          올린 녹음 파일은 리턴제로에 전달한 직후 우리 저장소에서 지워지며, 화면에는 전사본만 남습니다.
        </p>
      </section>
    </div>
  );
}
