"use client";

import { useEffect, useState } from "react";

export default function VocSettingsPage() {
  const [origin, setOrigin] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);

  const webhookUrl = origin ? `${origin}/api/voc/tally` : "/api/voc/tally";

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/voc/tally-config", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setHasSecret(!!j.hasSecret))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function saveSecret() {
    setSaving(true); setMsg("");
    try {
      const res = await fetch("/api/voc/tally-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setHasSecret(j.hasSecret); setSecret(""); setMsg(j.hasSecret ? "시크릿이 저장되었습니다." : "시크릿이 해제되었습니다.");
    } catch (e) { setMsg(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  function copyUrl() {
    navigator.clipboard.writeText(webhookUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정 · 탈리(Tally) 연동</h1>
          <p className="b2b-page-subtitle">Tally 설문 폼을 연결하면 제출된 응답이 VOC(수집경로=설문)로 자동 등록됩니다.</p>
        </div>
      </header>

      {/* 1) 웹훅 URL */}
      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">1. 웹훅(Webhook) 주소</span></div>
        <p className="sm-muted" style={{ fontSize: 13, marginBottom: 10 }}>아래 주소를 Tally 폼의 <strong>Integrations → Webhooks</strong> 에 붙여넣으세요.</p>
        <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input className="b2b-input" readOnly value={webhookUrl} style={{ flex: 1, minWidth: 240, fontFamily: "monospace" }} onFocus={(e) => e.target.select()} />
          <button className="b2b-btn-secondary" onClick={copyUrl}>{copied ? "복사됨 ✓" : "복사"}</button>
        </div>
      </section>

      {/* 2) 서명 시크릿 */}
      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">2. 서명 시크릿 (Signing secret)</span></div>
        <p className="sm-muted" style={{ fontSize: 13, marginBottom: 10 }}>
          Tally 웹훅 설정의 <strong>Signing secret</strong> 값을 여기에 저장하면, 위조된 요청을 차단합니다(권장).
          현재 상태: {loading ? "확인 중…" : hasSecret ? <strong style={{ color: "var(--sm-success)" }}>설정됨</strong> : <strong style={{ color: "var(--sm-warning)" }}>미설정 — 모든 요청 수신</strong>}
        </p>
        <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input className="b2b-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={hasSecret ? "새 값으로 변경(비우고 저장 시 해제)" : "Tally Signing secret 붙여넣기"} style={{ flex: 1, minWidth: 240 }} />
          <button className="b2b-btn-primary" onClick={saveSecret} disabled={saving}>{saving ? "저장 중…" : "저장"}</button>
        </div>
        {msg && <p style={{ fontSize: 13, marginTop: 8, color: msg.includes("실패") ? "var(--sm-danger)" : "var(--sm-success)" }}>{msg}</p>}
      </section>

      {/* 3) 필드 자동매핑 안내 */}
      <section className="b2b-card" style={{ marginTop: 14 }}>
        <div className="b2b-card-head"><span className="b2b-card-title">3. 폼 필드 자동 매핑</span></div>
        <p className="sm-muted" style={{ fontSize: 13, marginBottom: 10 }}>Tally 질문의 <strong>제목(라벨)</strong>에 아래 단어가 들어가면 해당 항목으로 자동 분류됩니다. 못 맞춘 답변은 모두 <strong>내용</strong>에 보존됩니다.</p>
        <table className="b2b-table">
          <thead><tr><th>VOC 항목</th><th>라벨에 포함되면</th></tr></thead>
          <tbody>
            <tr><td>클레임 유형</td><td>유형 · 분류 · 카테고리 (배송·품질·포장·누락·오배송·가시·이물·기타 중 일치)</td></tr>
            <tr><td>고객</td><td>이름 · 고객 · 연락처 · 전화 · 이메일</td></tr>
            <tr><td>구매상품 / 구매처</td><td>상품·제품·품목 / 구매처·구입처·판매처</td></tr>
            <tr><td>구매일 / 제품 생산일</td><td>구매일·구입일 / 생산일·제조일 (YYYY-MM-DD)</td></tr>
            <tr><td>내용</td><td>내용 · 불편 · 상세 · 의견 · 문의 · 클레임</td></tr>
            <tr><td>사진</td><td>파일 업로드 질문(또는 사진·이미지·첨부)</td></tr>
          </tbody>
        </table>
        <p className="sm-faint" style={{ fontSize: 12, marginTop: 10 }}>※ 접수일은 제출일(오늘)로, 수집경로는 ‘설문’으로 자동 기록됩니다. 같은 제출의 재전송은 중복 등록되지 않습니다.</p>
      </section>
    </div>
  );
}
