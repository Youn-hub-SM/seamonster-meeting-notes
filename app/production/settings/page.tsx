"use client";

import { useEffect, useState } from "react";

type AliasItem = { sku: string; names: string[]; canonical: string; alias: string; display: string };
type DemixCand = { sku: string; name: string; boxheroOut: number; b2bShipped: number };

export default function ProductionSettingsPage() {
  const [configured, setConfigured] = useState(false);
  const [masked, setMasked] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [aliasItems, setAliasItems] = useState<AliasItem[]>([]);
  const [aliasInput, setAliasInput] = useState<Record<string, string>>({});
  const [aliasSavingSku, setAliasSavingSku] = useState<string | null>(null);

  const [leadInput, setLeadInput] = useState("");
  const [leadSaved, setLeadSaved] = useState<number | null>(null);
  const [leadSaving, setLeadSaving] = useState(false);
  const [leadMsg, setLeadMsg] = useState("");

  const [demixEnabled, setDemixEnabledS] = useState(false);
  const [demixFactor, setDemixFactorS] = useState("0.6");
  const [demixSkus, setDemixSkusS] = useState<string[]>([]);
  const [demixCands, setDemixCands] = useState<DemixCand[]>([]);
  const [demixLoading, setDemixLoading] = useState(true);
  const [demixSaving, setDemixSaving] = useState(false);
  const [demixMsg, setDemixMsg] = useState("");
  const [demixUnresolved, setDemixUnresolved] = useState(0);

  // [업무도우미 변경알림] — 상품마스터 변경 시 Flow 알림봇으로 수신자들에게 발송(B2B 도매 봇과 별개)
  type MnConfig = { enabled: boolean; botId: string; receivers: string; title: string; events: Record<string, boolean> };
  const [mn, setMn] = useState<MnConfig | null>(null);
  const [mnEventDefs, setMnEventDefs] = useState<{ key: string; label: string }[]>([]);
  const [mnApiKey, setMnApiKey] = useState("");       // 입력 시에만 갱신(빈값이면 기존 키 유지)
  const [mnHasKey, setMnHasKey] = useState(false);
  const [mnFallbackKey, setMnFallbackKey] = useState(false); // 전용 키 없이 B2B 봇 키 폴백 중
  const [mnTestReceiver, setMnTestReceiver] = useState("");
  const [mnBusy, setMnBusy] = useState(false);
  const [mnMsg, setMnMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function loadStatus() {
    try {
      const j = await (await fetch("/api/production/settings", { cache: "no-store" })).json();
      if (j.ok) { setConfigured(j.configured); setMasked(j.masked || ""); }
    } catch { /* noop */ }
  }
  async function loadAliases() {
    try {
      const j = await (await fetch("/api/production/item-alias", { cache: "no-store" })).json();
      if (j.ok) {
        setAliasItems(j.items || []);
        const inputs: Record<string, string> = {};
        for (const it of j.items || []) inputs[it.sku] = it.alias || "";
        setAliasInput(inputs);
      }
    } catch { /* noop */ }
  }
  async function loadLead() {
    try {
      const j = await (await fetch("/api/production/lead-days", { cache: "no-store" })).json();
      if (j.ok) { setLeadSaved(j.leadDays); setLeadInput(String(j.leadDays)); }
    } catch { /* noop */ }
  }
  async function loadDemix() {
    setDemixLoading(true);
    try {
      const [d, inv] = await Promise.all([
        fetch("/api/production/demix", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/production/inventory", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
      ]);
      if (d.ok) { setDemixEnabledS(d.enabled); setDemixFactorS(String(d.factor)); setDemixSkusS(d.skus || []); }
      if (inv.ok) {
        const cands: DemixCand[] = (inv.rows || [])
          .filter((r: { b2bShippedQty: number }) => r.b2bShippedQty > 0)
          .map((r: { sku: string; name: string; boxheroOutQty: number; b2bShippedQty: number }) => ({ sku: r.sku, name: r.name, boxheroOut: r.boxheroOutQty, b2bShipped: r.b2bShippedQty }))
          .sort((a: DemixCand, b: DemixCand) => b.b2bShipped - a.b2bShipped);
        setDemixCands(cands);
        setDemixUnresolved(inv.demixUnresolvedQty || 0);
      }
    } catch { /* noop */ }
    setDemixLoading(false);
  }
  async function loadMn() {
    try {
      const j = await (await fetch("/api/production/settings/master-notify", { cache: "no-store" })).json();
      if (j.ok) { setMn(j.config); setMnEventDefs(j.events || []); setMnHasKey(!!j.hasApiKey); setMnFallbackKey(!!j.fallbackKey); }
    } catch { /* noop */ }
  }
  useEffect(() => { loadStatus(); loadAliases(); loadLead(); loadDemix(); loadMn(); }, []);

  async function saveMn() {
    if (!mn) return;
    setMnBusy(true); setMnMsg(null);
    try {
      const body: Record<string, unknown> = { ...mn };
      if (mnApiKey.trim()) body.apiKey = mnApiKey.trim();
      const r = await fetch("/api/production/settings/master-notify", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      if (mnApiKey.trim()) { setMnHasKey(true); setMnFallbackKey(false); setMnApiKey(""); }
      setMnMsg({ kind: "ok", text: "저장됨" });
    } catch (e) { setMnMsg({ kind: "err", text: e instanceof Error ? e.message : "저장 오류" }); }
    setMnBusy(false);
  }
  async function testMn() {
    setMnBusy(true); setMnMsg(null);
    try {
      const r = await fetch("/api/production/settings/master-notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mnTestReceiver.trim() ? { testReceiver: mnTestReceiver.trim() } : {}) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "테스트 실패");
      setMnMsg({ kind: "ok", text: "테스트 알림을 보냈습니다. Flow 를 확인하세요." });
    } catch (e) { setMnMsg({ kind: "err", text: e instanceof Error ? e.message : "테스트 실패" }); }
    setMnBusy(false);
  }

  function toggleDemixSku(sku: string) {
    setDemixSkusS((s) => (s.includes(sku) ? s.filter((x) => x !== sku) : [...s, sku]));
  }
  async function saveDemix() {
    setDemixSaving(true);
    setDemixMsg("");
    try {
      const res = await fetch("/api/production/demix", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: demixEnabled, skus: demixSkus, factor: Number(demixFactor) || 0.6 }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setDemixEnabledS(j.enabled); setDemixSkusS(j.skus); setDemixFactorS(String(j.factor));
      setDemixMsg("저장됨.");
    } catch (e) {
      setDemixMsg(e instanceof Error ? e.message : "저장 실패");
    }
    setDemixSaving(false);
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

  async function saveAlias(sku: string) {
    setAliasSavingSku(sku);
    try {
      const res = await fetch("/api/production/item-alias", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, name: aliasInput[sku] || "" }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      await loadAliases();
    } catch { /* noop */ }
    setAliasSavingSku(null);
  }

  async function save() {
    if (!token.trim()) { setMsg({ kind: "err", text: "토큰을 입력하세요." }); return; }
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/production/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setMsg({ kind: "ok", text: "박스히어로 연결 성공 — 토큰을 저장했습니다." });
      setToken("");
      await loadStatus();
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "저장 실패" });
    }
    setSaving(false);
  }

  return (
    <div className="b2b-container" style={{ maxWidth: 720 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">설정</h1>
        </div>
      </header>

      <section className="b2b-card">
        <div className="b2b-card-head"><h2 className="b2b-card-title">박스히어로 연동</h2></div>
        <div style={{ padding: "4px 2px 2px" }}>
          <div style={{ marginBottom: 14, fontSize: 12.5, color: "var(--sm-text-mid)", lineHeight: 1.6 }}>
            상태:{" "}
            {configured
              ? <span style={{ color: "var(--sm-success)", fontWeight: 600 }}>연결됨 ({masked})</span>
              : <span style={{ color: "var(--sm-danger)", fontWeight: 600 }}>미설정</span>}
            <br />
            박스히어로 앱 → 설정 &gt; 통합 설정 &gt; API 에서 토큰을 발급해 붙여넣으세요. 저장 시 자동으로 연결을 확인합니다.
          </div>

          <div className="b2b-field">
            <label className="b2b-field-label">API 토큰</label>
            <input
              className="b2b-input"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={configured ? "새 토큰으로 교체하려면 입력" : "토큰 붙여넣기"}
              autoComplete="off"
            />
          </div>

          {msg && (
            <div style={{ marginTop: 10, fontSize: 12, color: msg.kind === "ok" ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 600 }}>
              {msg.text}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>
              {saving ? "확인 중..." : "저장 + 연결 확인"}
            </button>
          </div>
        </div>
      </section>

      <section className="b2b-card" style={{ marginTop: 16 }}>
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
          <span style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>일</span>
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

      <section className="b2b-card" style={{ marginTop: 16 }}>
        <div className="b2b-card-head"><h2 className="b2b-card-title">생산 품목명</h2></div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 14px", lineHeight: 1.6 }}>
          B2B에서 같은 제품을 업체별로 다른 품목명으로 부르면(단가 차이 등) 생산에서 갈라집니다.
          같은 <strong>SKU</strong>는 생산에선 한 품목으로 묶이며, 여기서 <strong>생산 표시명</strong>만 정리하면 됩니다. (비우면 가장 짧은 이름 자동 사용)
        </p>
        {aliasItems.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--sm-text-light)" }}>정리할 품목이 없습니다. (같은 SKU에 이름이 여러 개인 경우만 표시)</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {aliasItems.map((it) => (
              <div key={it.sku} style={{ borderTop: "1px solid var(--sm-border)", paddingTop: 12 }}>
                <div style={{ fontSize: 11, color: "var(--sm-text-light)", marginBottom: 4 }}>
                  <code>{it.sku}</code> · B2B 품목명: {it.names.join(" / ")}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    className="b2b-input"
                    value={aliasInput[it.sku] ?? ""}
                    onChange={(e) => setAliasInput((m) => ({ ...m, [it.sku]: e.target.value }))}
                    placeholder={it.canonical}
                    style={{ flex: 1, minWidth: 240 }}
                  />
                  <button className="b2b-btn-secondary" onClick={() => saveAlias(it.sku)} disabled={aliasSavingSku === it.sku}>
                    {aliasSavingSku === it.sku ? "..." : "저장"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="b2b-card" style={{ marginTop: 16 }}>
        <div className="b2b-card-head"><h2 className="b2b-card-title">도매/소매 채널 분리 (실험)</h2></div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 14px", lineHeight: 1.6 }}>
          같은 SKU로 <strong>도매·소매가 섞여</strong> 나가는 품목만, 소매 판매속도에서 <strong>과거 도매(B2B) 발송분</strong>을 빼서 평상시 소매 속도만 잡습니다.
          도매 발송이 박스히어로 출고에 안 찍히면 과소생산→쇼트 위험이 있어 <strong>기본 꺼짐 + 품목 화이트리스트 + 차감비율</strong>로만 켜세요.
          (BULK·소매전용처럼 SKU가 이미 분리된 품목은 체크하지 않습니다.)
          <br /><span style={{ color: "var(--sm-text-light)" }}>※ 분할발송 차수 기준이라, 발주를 통째로 한 번에 보낸 건은 아직 차감에 안 잡힙니다(차감 과소 = 안전측).</span>
        </p>
        <label className="prod-filter-check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={demixEnabled} onChange={(e) => setDemixEnabledS(e.target.checked)} /> 도매 차감 사용
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>차감 비율</span>
          <input className="b2b-input" type="number" min={0} max={1} step={0.1} value={demixFactor} onChange={(e) => setDemixFactorS(e.target.value)} style={{ width: 90 }} />
          <span style={{ fontSize: 11.5, color: "var(--sm-text-light)" }}>도매 발송분의 이 비율만 차감(안전 여유). 1 = 전량.</span>
        </div>
        {demixLoading ? (
          <div style={{ fontSize: 12, color: "var(--sm-text-light)" }}>후보 품목 불러오는 중...</div>
        ) : demixCands.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--sm-text-light)" }}>최근 집계창에 B2B 발송이 잡힌 품목이 없습니다. (도매 발송이 있어야 후보로 떠요)</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ fontSize: 11.5, color: "var(--sm-text-mid)" }}>도매·소매 혼입 품목만 체크 — 근거(박스히어로 출고 vs B2B 발송):</div>
            {demixCands.map((c) => {
              const ok = c.boxheroOut >= c.b2bShipped * 0.9; // 도매가 BoxHero 출고에 잡힘(근사값이라 10% 여유)
              return (
                <label key={c.sku} className="demix-cand">
                  <input type="checkbox" checked={demixSkus.includes(c.sku)} onChange={() => toggleDemixSku(c.sku)} />
                  <code style={{ fontSize: 11 }}>{c.sku}</code>
                  <span className="demix-cand-name">{c.name}</span>
                  <span className={ok ? "demix-ok" : "demix-bad"}>
                    BoxHero {c.boxheroOut.toLocaleString()} / B2B {c.b2bShipped.toLocaleString()}{ok ? "" : " 도매 미기록 의심"}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {demixUnresolved > 0 && (
          <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--sm-danger)", lineHeight: 1.5 }}>
            도매 발송 중 {demixUnresolved.toLocaleString()}개가 SKU와 연결되지 않아 차감에서 빠집니다 — 해당 발주 상품에 SKU가 지정됐는지 확인하세요.
          </p>
        )}
        {demixMsg && (
          <div style={{ marginTop: 10, fontSize: 12, color: demixMsg === "저장됨." ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 600 }}>{demixMsg}</div>
        )}
        <div style={{ marginTop: 14 }}>
          <button className="b2b-btn-primary" onClick={saveDemix} disabled={demixSaving}>{demixSaving ? "저장 중..." : "저장"}</button>
        </div>
      </section>

      {/* [업무도우미 변경알림] — 상품마스터 변경 시 Flow 알림봇으로 수신자들에게 발송 */}
      <section className="b2b-card" style={{ marginTop: 16 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">[업무도우미 변경알림] <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 상품마스터 변경 시 Flow 알림 발송 (B2B 도매 알림봇과 별개 봇)</span></h2>
          <button className="b2b-btn-primary" onClick={saveMn} disabled={mnBusy || !mn}>{mnBusy ? "저장 중..." : "저장"}</button>
        </div>
        {mnMsg && <div className={mnMsg.kind === "ok" ? "sm-success" : "b2b-error"} style={{ marginBottom: 10 }}>{mnMsg.text}</div>}
        {mn && (
          <>
            <label className="sm-row" style={{ gap: 6, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              <input type="checkbox" className="b2b-checkbox" checked={mn.enabled} onChange={(e) => setMn({ ...mn, enabled: e.target.checked })} />
              변경알림 켜기
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>봇 ID</span>
                <input className="b2b-input" value={mn.botId} onChange={(e) => setMn({ ...mn, botId: e.target.value })} placeholder="BFLOW_300003566171" /></label>
              <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>알림 제목</span>
                <input className="b2b-input" value={mn.title} onChange={(e) => setMn({ ...mn, title: e.target.value })} placeholder="[업무도우미 변경알림]" /></label>
              <label className="sm-col" style={{ gap: 3, gridColumn: "1 / -1" }}><span style={{ fontSize: 13, fontWeight: 600 }}>수신 대상 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 11.5 }}>· 쉼표로 구분(B2B 알림봇 수신자와 같은 ID 형식)</span></span>
                <input className="b2b-input" value={mn.receivers} onChange={(e) => setMn({ ...mn, receivers: e.target.value })} placeholder="예: user1@seamonster.kr, user2@seamonster.kr" /></label>
              <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>Flow API 키 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 11.5 }}>{mnHasKey ? "· 저장됨(입력 시 교체)" : mnFallbackKey ? "· B2B 봇 키 사용 중(입력 시 전용 키)" : "· 미설정"}</span></span>
                <input className="b2b-input" type="password" value={mnApiKey} onChange={(e) => setMnApiKey(e.target.value)} placeholder={mnHasKey || mnFallbackKey ? "변경할 때만 입력" : "키관리에서 발급받은 API Key"} /></label>
            </div>
            <div style={{ marginTop: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>발송할 변경 목록</span>
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginTop: 6 }}>
                {mnEventDefs.map((ev) => (
                  <label key={ev.key} className="sm-row" style={{ gap: 5, fontSize: 13 }}>
                    <input type="checkbox" className="b2b-checkbox" checked={mn.events[ev.key] !== false}
                      onChange={(e) => setMn({ ...mn, events: { ...mn.events, [ev.key]: e.target.checked } })} />
                    {ev.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="sm-row" style={{ gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <input className="b2b-input" style={{ width: 220 }} value={mnTestReceiver} onChange={(e) => setMnTestReceiver(e.target.value)} placeholder="테스트 수신자(비우면 전체)" />
              <button className="b2b-btn-secondary" onClick={testMn} disabled={mnBusy}>테스트 발송</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
