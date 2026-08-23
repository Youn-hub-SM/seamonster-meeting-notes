"use client";

import { useEffect, useState } from "react";

// 생산관리 설정 — 리드타임 + [업무도우미 변경알림](Teams 채널) 이벤트 체크리스트.
//  2026-08-23 대청소: 박스히어로 연동(자체 재고관리로 대체)·Flow 알림봇 필드 제거.
export default function ProductionSettingsPage() {
  const [leadInput, setLeadInput] = useState("");
  const [leadSaved, setLeadSaved] = useState<number | null>(null);
  const [leadSaving, setLeadSaving] = useState(false);
  const [leadMsg, setLeadMsg] = useState("");

  // [업무도우미 변경알림] — 켜기 + 이벤트 체크리스트. 발송은 Teams '업무도우미 변경알림' 채널.
  type MnConfig = { enabled: boolean; botId: string; receivers: string; title: string; events: Record<string, boolean> };
  const [mn, setMn] = useState<MnConfig | null>(null);
  const [mnEventDefs, setMnEventDefs] = useState<{ key: string; label: string; group?: string }[]>([]);
  const [mnBusy, setMnBusy] = useState(false);
  const [mnMsg, setMnMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function loadLead() {
    try {
      const j = await (await fetch("/api/production/lead-days", { cache: "no-store" })).json();
      if (j.ok) { setLeadSaved(j.leadDays); setLeadInput(String(j.leadDays)); }
    } catch { /* noop */ }
  }
  async function loadMn() {
    try {
      const j = await (await fetch("/api/production/settings/master-notify", { cache: "no-store" })).json();
      if (j.ok) { setMn(j.config); setMnEventDefs(j.events || []); }
    } catch { /* noop */ }
  }
  useEffect(() => { loadLead(); loadMn(); }, []);

  async function saveMn() {
    if (!mn) return;
    setMnBusy(true); setMnMsg(null);
    try {
      const r = await fetch("/api/production/settings/master-notify", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mn) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setMnMsg({ kind: "ok", text: "저장됨" });
    } catch (e) { setMnMsg({ kind: "err", text: e instanceof Error ? e.message : "저장 오류" }); }
    setMnBusy(false);
  }
  async function testMn() {
    setMnBusy(true); setMnMsg(null);
    try {
      const r = await fetch("/api/production/settings/master-notify", { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "테스트 실패");
      setMnMsg({ kind: "ok", text: "테스트 알림을 보냈습니다. Teams 변경알림 채널을 확인하세요." });
    } catch (e) { setMnMsg({ kind: "err", text: e instanceof Error ? e.message : "테스트 실패" }); }
    setMnBusy(false);
  }

  async function saveLead() {
    const n = Math.round(Number(leadInput));
    if (!Number.isFinite(n) || n < 1 || n > 60) { setLeadMsg("1~60 사이 숫자를 입력하세요."); return; }
    setLeadSaving(true);
    setLeadMsg("");
    try {
      const res = await fetch("/api/production/lead-days", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: n }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setLeadSaved(j.leadDays);
      setLeadInput(String(j.leadDays));
      setLeadMsg(`저장됨 — 안전재고가 하루 출고 × ${j.leadDays}일로 계산됩니다.`);
    } catch (e) {
      setLeadMsg(e instanceof Error ? e.message : "저장 실패");
    }
    setLeadSaving(false);
  }

  return (
    <div className="b2b-container" style={{ maxWidth: 720 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정</h1>
        </div>
      </header>

      <section className="b2b-card">
        <div className="b2b-card-head"><h2 className="b2b-card-title">생산 리드타임</h2></div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 14px", lineHeight: 1.6 }}>
          제조사에 생산을 요청하고 받기까지 걸리는 일수입니다. <strong>안전재고 = 하루 평균 출고 × 리드타임</strong>으로,
          이 기간 팔릴 만큼은 늘 확보해 재고 쇼트를 막습니다. {leadSaved != null && <>현재 <strong>{leadSaved}일</strong>.</>}
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="b2b-input"
            type="number"
            min={1}
            max={60}
            value={leadInput}
            onChange={(e) => setLeadInput(e.target.value)}
            style={{ width: 120 }}
          />
          <span style={{ fontSize: 15, color: "var(--sm-text-mid)" }}>일</span>
          <button className="b2b-btn-primary" onClick={saveLead} disabled={leadSaving}>
            {leadSaving ? "저장 중..." : "저장"}
          </button>
        </div>
        {leadMsg && (
          <div style={{ marginTop: 10, fontSize: 12, color: leadMsg.startsWith("저장됨") ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 600 }}>
            {leadMsg}
          </div>
        )}
      </section>

      {/* [업무도우미 변경알림] — 상품마스터 변경 + 생산·재고 알림. 발송은 Teams 변경알림 채널(Flow 제거) */}
      <section className="b2b-card" style={{ marginTop: 16 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">[업무도우미 변경알림] <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 상품마스터 변경 + 생산 요청·재고 이전(소매→도매) 알림 — Teams '업무도우미 변경알림' 채널로 발송</span></h2>
          <button className="b2b-btn-primary" onClick={saveMn} disabled={mnBusy || !mn}>{mnBusy ? "저장 중..." : "저장"}</button>
        </div>
        {mnMsg && <div className={mnMsg.kind === "ok" ? "sm-success" : "b2b-error"} style={{ marginBottom: 10 }}>{mnMsg.text}</div>}
        {mn && (
          <>
            <label className="sm-row" style={{ gap: 6, fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
              <input type="checkbox" className="b2b-checkbox" checked={mn.enabled} onChange={(e) => setMn({ ...mn, enabled: e.target.checked })} />
              상품마스터 변경알림 켜기 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>· 생산·재고 알림은 이 토글과 무관 — 아래 체크로만 제어</span>
            </label>
            <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 6px" }}>발송 채널 URL은 관리자 › 설정 › B2B 도매의 &apos;Teams 알림&apos; 카드에서 관리합니다.</p>
            <div style={{ marginTop: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>발송할 알림 목록</span>
              <p className="sm-faint" style={{ fontSize: 12, margin: "3px 0 0" }}>체크 해제한 알림은 발송되지 않습니다 (변경 기록에는 남음).</p>
              {[...new Set(mnEventDefs.map((ev) => ev.group || "기타"))].map((g) => (
                <div key={g} style={{ marginTop: 8 }}>
                  <div className="sm-faint" style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{g}</div>
                  <div className="sm-row" style={{ gap: 14, flexWrap: "wrap" }}>
                    {mnEventDefs.filter((ev) => (ev.group || "기타") === g).map((ev) => (
                      <label key={ev.key} className="sm-row" style={{ gap: 5, fontSize: 15 }}>
                        <input type="checkbox" className="b2b-checkbox" checked={mn.events[ev.key] !== false}
                          onChange={(e) => setMn({ ...mn, events: { ...mn.events, [ev.key]: e.target.checked } })} />
                        {ev.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="sm-row" style={{ gap: 8, alignItems: "center", marginTop: 12 }}>
              <button className="b2b-btn-secondary" onClick={testMn} disabled={mnBusy}>테스트 발송</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
