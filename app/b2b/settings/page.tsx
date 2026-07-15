"use client";

import { useEffect, useState } from "react";
import { STATUS_SHORT } from "@/app/lib/b2b-orders";

type EventMeta = {
  key: string;
  label: string;
  desc: string;
  kind: "toggle" | "status";
  statuses?: string[];
};
type NotifyConfig = Record<string, boolean | string[]>;
type Msg = { ok: boolean; text: string };

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
  // Flow 봇 알림(Zapier 대체)
  const [flowBotId, setFlowBotId] = useState("");
  const [flowApiKey, setFlowApiKey] = useState("");     // 입력 시에만 갱신(빈값이면 기존 키 유지)
  const [flowHasKey, setFlowHasKey] = useState(false);
  const [flowReceivers, setFlowReceivers] = useState("");
  const [flowTitle, setFlowTitle] = useState("");
  const [flowTestReceiver, setFlowTestReceiver] = useState("");
  const [appUrl, setAppUrl] = useState("");
  const [flowActive, setFlowActive] = useState(false);
  const [zapierEnv, setZapierEnv] = useState(false);
  const [flowSaving, setFlowSaving] = useState(false);
  const [flowMsg, setFlowMsg] = useState<Msg | null>(null);
  // 아침 일정 다이제스트
  const [digest, setDigest] = useState("");
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestMsg, setDigestMsg] = useState<Msg | null>(null);
  type DCfg = { enabled: boolean; hour: number; days: number; sections: { ship: boolean; unscheduled: boolean; invoice: boolean; payment: boolean }; title: string };
  const [dcfg, setDcfg] = useState<DCfg | null>(null);
  const [dcfgSaving, setDcfgSaving] = useState(false);
  // 거래명세표 — 공급자(우리 회사) 정보 + 직인
  type Supplier = { name: string; biz_no: string; ceo: string; addr: string; biz_type: string; biz_item: string; email: string; bank: string };
  const [sup, setSup] = useState<Supplier>({ name: "", biz_no: "", ceo: "", addr: "", biz_type: "", biz_item: "", email: "youn@seamonster.kr", bank: "" });
  const [stamp, setStamp] = useState("");
  const [supSaving, setSupSaving] = useState(false);
  const [supMsg, setSupMsg] = useState<Msg | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [notifyRes, flowRes] = await Promise.all([
          fetch("/api/b2b/settings/notify", { cache: "no-store" }),
          fetch("/api/b2b/settings/flow-alert", { cache: "no-store" }),
        ]);
        const j = await notifyRes.json();
        if (!notifyRes.ok || !j.ok) throw new Error(j.error || "조회 실패");
        setConfig(j.config || {});
        setEvents(j.events || []);
        setWebhookSet(!!j.webhookSet);
        const fj = await flowRes.json();
        if (flowRes.ok && fj.ok) {
          setFlowBotId(fj.botId || "");
          setFlowReceivers(fj.receivers || "");
          setFlowTitle(fj.title || "");
          setFlowHasKey(!!fj.hasApiKey);
          setAppUrl(fj.appBaseUrl || "");
          setFlowActive(!!fj.active);
          setZapierEnv(!!fj.zapierEnv);
        }
        const dg = await (await fetch("/api/b2b/settings/digest", { cache: "no-store" })).json();
        if (dg.ok) setDcfg(dg.config);
        const st = await (await fetch("/api/b2b/settings/statement", { cache: "no-store" })).json();
        if (st.ok) { setSup(st.supplier); setStamp(st.stamp || ""); }
      } catch (e) {
        setError(e instanceof Error ? e.message : "조회 중 오류");
      }
      setLoading(false);
    })();
  }, []);

  async function saveFlow() {
    setFlowSaving(true); setError(""); setFlowMsg(null);
    try {
      const body: Record<string, string> = { botId: flowBotId, receivers: flowReceivers, title: flowTitle, appBaseUrl: appUrl };
      if (flowApiKey.trim()) body.apiKey = flowApiKey.trim();   // 빈값이면 기존 키 유지
      const r = await fetch("/api/b2b/settings/flow-alert", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setFlowActive(!!j.active);
      if (flowApiKey.trim()) { setFlowHasKey(true); setFlowApiKey(""); }
      setFlowMsg({ ok: true, text: "저장됨" });
    } catch (e) { setError(e instanceof Error ? e.message : "저장 오류"); }
    setFlowSaving(false);
  }
  async function testFlow() {
    setFlowSaving(true); setFlowMsg(null);
    try {
      const r = await fetch("/api/b2b/settings/flow-alert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(flowTestReceiver.trim() ? { testReceiver: flowTestReceiver.trim() } : {}) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "테스트 실패");
      setFlowMsg({ ok: true, text: `Flow로 테스트 발송 완료 (수신자 ${j.sentTo}명). 플로우를 확인하세요.` });
    } catch (e) { setFlowMsg({ ok: false, text: e instanceof Error ? e.message : "테스트 실패" }); }
    setFlowSaving(false);
  }
  async function saveSupplier() {
    setSupSaving(true); setSupMsg(null);
    try {
      const r = await fetch("/api/b2b/settings/statement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplier: sup, stamp }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setSupMsg({ ok: true, text: "저장됨" });
    } catch (e) { setSupMsg({ ok: false, text: e instanceof Error ? e.message : "저장 오류" }); }
    setSupSaving(false);
  }
  function onStampFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 500_000) { setSupMsg({ ok: false, text: "직인 이미지는 500KB 이하 PNG 로 올려주세요." }); return; }
    const reader = new FileReader();
    reader.onload = () => setStamp(String(reader.result || ""));
    reader.readAsDataURL(f);
  }
  async function loadDigest() {
    setDigestBusy(true); setDigestMsg(null);
    try { const j = await (await fetch("/api/b2b/schedule-digest", { cache: "no-store" })).json(); if (!j.ok) throw new Error(j.error || "미리보기 실패"); setDigest(j.preview || ""); }
    catch (e) { setDigestMsg({ ok: false, text: e instanceof Error ? e.message : "미리보기 실패" }); }
    setDigestBusy(false);
  }
  async function sendDigestNow() {
    if (!window.confirm("지금 Flow로 '아침 일정 알림'을 보낼까요? (위 수신자 전체에게 발송)")) return;
    setDigestBusy(true); setDigestMsg(null);
    try { const j = await (await fetch("/api/b2b/schedule-digest?send=1", { cache: "no-store" })).json(); if (!j.ok) throw new Error(j.error || "발송 실패"); setDigestMsg({ ok: true, text: "발송 완료" }); }
    catch (e) { setDigestMsg({ ok: false, text: e instanceof Error ? e.message : "발송 실패" }); }
    setDigestBusy(false);
  }
  async function saveDigestCfg() {
    if (!dcfg) return;
    setDcfgSaving(true); setDigestMsg(null);
    try { const j = await (await fetch("/api/b2b/settings/digest", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dcfg) })).json(); if (!j.ok) throw new Error(j.error || "저장 실패"); setDcfg(j.config); setDigestMsg({ ok: true, text: "저장됨" }); }
    catch (e) { setDigestMsg({ ok: false, text: e instanceof Error ? e.message : "저장 실패" }); }
    setDcfgSaving(false);
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
        </div>
        <div className="b2b-page-actions">
          {savedAt && <span style={{ fontSize: 12, color: "var(--sm-success)", alignSelf: "center" }}>{savedAt}</span>}
          <button className="b2b-btn-primary" onClick={save} disabled={saving || loading}>
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* 발주 완료 → 매출 데이터(Supabase) 자동 반영 */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">발송완료 매출 반영</h2>
          <span style={{ fontSize: 11.5, color: "var(--sm-success)" }}>● 자동 (Supabase)</span>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--sm-text-mid)", margin: 0, lineHeight: 1.8 }}>
          발주가 <strong>발송완료</strong>되면 라인아이템별 매출이 <strong>매출 데이터(sales_orders)</strong>에 자동 반영됩니다
          (채널 <strong>&lsquo;도매&rsquo;</strong>, 발주별 1회, 중복 방지). <a href="/sales/report" style={{ color: "var(--sm-orange)", fontWeight: 600 }}>매출 리포트</a>·
          <a href="/sales/search" style={{ color: "var(--sm-orange)", fontWeight: 600 }}> 주문 검색</a>에서 함께 조회됩니다.
          <br />
          별도 설정이 필요 없으며, 기존 <strong>구글시트 연동은 종료</strong>되었습니다. 재구매·고객 분석 오염을 막기 위해 도매 매출은 매출액만 반영하고 개별 고객으로는 집계하지 않습니다.
        </p>
      </section>

      {/* Flow 봇 알림 (Zapier 대체) */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">Flow 알림 (직접 발송)</h2>
          <span style={{ fontSize: 11.5, color: flowActive ? "var(--sm-success)" : "var(--sm-text-light)" }}>
            {flowActive ? "● Flow로 발송 중 (Zapier 대체)" : (zapierEnv ? "○ 현재 Zapier로 발송" : "○ 미설정")}
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 12px", lineHeight: 1.7 }}>
          B2B 알림을 <strong>Zapier 없이 Flow(플로우)로 직접</strong> 지정 수신자에게 보냅니다(비용 절감). <strong>봇 ID·API 키·수신자</strong>가 모두 채워지면 <strong>Zapier 대신 Flow로만</strong> 발송돼요. 아래 <strong>이벤트별 on/off</strong>도 그대로 적용됩니다.
        </p>
        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : (
          <>
            <div className="b2b-field" style={{ marginBottom: 10 }}>
              <label className="b2b-field-label">봇 ID <span className="sm-faint" style={{ fontWeight: 400 }}>(flow.team 봇 소유 계정 이메일)</span></label>
              <input className="b2b-input" value={flowBotId} onChange={(e) => { setFlowBotId(e.target.value); setFlowMsg(null); }} placeholder="예: seamonster.kr@gmail.com" spellCheck={false} />
            </div>
            <div className="b2b-field" style={{ marginBottom: 10 }}>
              <label className="b2b-field-label">봇 API 키 {flowHasKey && <span style={{ color: "var(--sm-success)", fontWeight: 400 }}>· 설정됨</span>}</label>
              <input className="b2b-input" type="password" value={flowApiKey} onChange={(e) => { setFlowApiKey(e.target.value); setFlowMsg(null); }} placeholder={flowHasKey ? "변경할 때만 입력 (비우면 기존 키 유지)" : "x-flow-api-key 값"} spellCheck={false} autoComplete="new-password" />
            </div>
            <div className="b2b-field" style={{ marginBottom: 10 }}>
              <label className="b2b-field-label">수신자 <span className="sm-faint" style={{ fontWeight: 400 }}>(한 줄에 한 명, 또는 쉼표로 구분)</span></label>
              <textarea className="b2b-input" value={flowReceivers} onChange={(e) => { setFlowReceivers(e.target.value); setFlowMsg(null); }} placeholder={"dizzywldls@naver.com\nmd@seamonster.kr\nseamonster2016@naver.com"} rows={3} spellCheck={false} style={{ resize: "vertical", fontFamily: "inherit" }} />
              <span style={{ fontSize: 11, color: "var(--sm-text-light)" }}>flow.team의 <strong>같은 이용기관(조직) 멤버</strong> 이메일이어야 발송됩니다.</span>
            </div>
            <div className="b2b-field" style={{ marginBottom: 10 }}>
              <label className="b2b-field-label">알림 제목</label>
              <input className="b2b-input" value={flowTitle} onChange={(e) => setFlowTitle(e.target.value)} placeholder="씨몬스터 B2B 알림" spellCheck={false} />
            </div>
            <div className="b2b-field" style={{ marginBottom: 10 }}>
              <label className="b2b-field-label">앱 접속 URL <span className="sm-faint" style={{ fontWeight: 400 }}>(알림의 주문 링크용)</span></label>
              <input className="b2b-input" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="예: https://내부도구주소 (비우면 Vercel 도메인 자동)" spellCheck={false} />
              <span style={{ fontSize: 11, color: "var(--sm-text-light)" }}>알림 본문에 <strong>주문 상세 링크</strong>(…/b2b/orders/…)를 붙입니다. 비우면 Vercel 프로덕션 도메인을 자동 사용해요.</span>
            </div>
            <div className="b2b-field" style={{ marginBottom: 12 }}>
              <label className="b2b-field-label">테스트 수신자 <span className="sm-faint" style={{ fontWeight: 400 }}>(선택 · 비우면 위 수신자 전체)</span></label>
              <input className="b2b-input" value={flowTestReceiver} onChange={(e) => setFlowTestReceiver(e.target.value)} placeholder="테스트만 받을 이메일 1명" spellCheck={false} />
            </div>
            <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className="b2b-btn-primary" onClick={saveFlow} disabled={flowSaving}>{flowSaving ? "저장 중..." : "저장"}</button>
              <button className="b2b-btn-secondary" onClick={testFlow} disabled={flowSaving || !flowActive} title={flowActive ? "" : "먼저 저장하세요"}>테스트 발송</button>
              {flowMsg && <span style={{ fontSize: 12, color: flowMsg.ok ? "var(--sm-success)" : "var(--sm-danger)" }}>{flowMsg.text}</span>}
            </div>
          </>
        )}
      </section>

      {/* 아침 일정 알림 (매일 08:00 자동 Flow 발송) */}
      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">아침 일정 알림 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 매일 08:00 자동</span></h2>
        </div>
        <p style={{ fontSize: 12, color: "var(--sm-text-mid)", margin: "0 0 12px", lineHeight: 1.7 }}>
          매일 지정 시각에 <strong>미완료 업무</strong>를 위 <strong>Flow 수신자</strong>에게 챗봇으로 보냅니다. 내용·시간·기간을 아래에서 정하세요.
          자동 발송은 Vercel 환경변수 <code>CRON_SECRET</code> 설정이 필요해요.
        </p>
        {dcfg && (
          <div style={{ border: "1px solid var(--sm-border)", borderRadius: 10, padding: 14, marginBottom: 12, display: "grid", gap: 12 }}>
            <label className="sm-row" style={{ gap: 7, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              <input type="checkbox" className="b2b-checkbox" checked={dcfg.enabled} onChange={(e) => setDcfg({ ...dcfg, enabled: e.target.checked })} /> 자동 발송 사용
            </label>
            <div className="sm-row" style={{ gap: 16, flexWrap: "wrap", alignItems: "center" }}>
              <label className="sm-row" style={{ gap: 6, fontSize: 13 }}>발송 시각
                <select className="b2b-select" style={{ width: "auto" }} value={dcfg.hour} onChange={(e) => setDcfg({ ...dcfg, hour: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                </select>
                <span className="sm-faint" style={{ fontSize: 11 }}>(한국시간)</span>
              </label>
              <label className="sm-row" style={{ gap: 6, fontSize: 13 }}>기간
                <input type="number" className="b2b-input" style={{ width: 70 }} min={1} max={31} value={dcfg.days} onChange={(e) => setDcfg({ ...dcfg, days: Number(e.target.value) })} />일
              </label>
            </div>
            <p className="sm-faint" style={{ fontSize: 11, margin: 0, lineHeight: 1.6 }}>
              ⓘ 현재 요금제(Hobby)에서는 크론이 하루 1회만 가능해 <strong>매일 오전 8시경</strong>에 발송됩니다.
              지정한 시각에 맞춰 보내려면 시간별 크론(Vercel Pro)이 필요해요.
            </p>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>보낼 내용</div>
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap" }}>
                {([["ship", "발송 예정"], ["unscheduled", "발송일정 미등록"], ["invoice", "계산서 미발행"], ["payment", "입금 대기"]] as const).map(([k, l]) => (
                  <label key={k} className="sm-row" style={{ gap: 5, fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" className="b2b-checkbox" checked={dcfg.sections[k]} onChange={(e) => setDcfg({ ...dcfg, sections: { ...dcfg.sections, [k]: e.target.checked } })} /> {l}
                  </label>
                ))}
              </div>
            </div>
            <label style={{ fontSize: 13 }}>제목
              <input className="b2b-input" style={{ marginTop: 4 }} value={dcfg.title} onChange={(e) => setDcfg({ ...dcfg, title: e.target.value })} placeholder="씨몬스터 B2B 오늘의 할 일" />
            </label>
            <div><button className="b2b-btn-primary" onClick={saveDigestCfg} disabled={dcfgSaving}>{dcfgSaving ? "저장 중..." : "설정 저장"}</button></div>
          </div>
        )}
        <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: digest ? 10 : 0 }}>
          <button className="b2b-btn-secondary" onClick={loadDigest} disabled={digestBusy}>{digestBusy ? "..." : "미리보기"}</button>
          <button className="b2b-btn-primary" onClick={sendDigestNow} disabled={digestBusy || !flowActive} title={flowActive ? "" : "먼저 Flow 봇을 설정하세요"}>지금 보내기</button>
          {digestMsg && <span style={{ fontSize: 12, color: digestMsg.ok ? "var(--sm-success)" : "var(--sm-danger)" }}>{digestMsg.text}</span>}
        </div>
        {digest && <pre style={{ fontSize: 12, background: "var(--sm-bg)", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap", lineHeight: 1.6, margin: 0, fontFamily: "inherit" }}>{digest}</pre>}
      </section>

      {!webhookSet && !flowActive && (
        <div className="sm-warn">
          <strong>외부 알림 대상이 없습니다.</strong>
          <br />
          위 <strong>Flow 봇</strong>(봇 ID·API 키·수신자)을 설정하거나 Zapier 웹훅(ZAPIER_WEBHOOK_URL)을 지정하세요. 아래 이벤트 설정은 대상 지정 후 그대로 적용됩니다.
        </div>
      )}

      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">알림 이벤트 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>(Flow·Zapier 공통)</span></h2>
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

      {/* 거래명세표 — 공급자 정보 + 직인 */}
      <section className="b2b-card" style={{ marginTop: 16 }}>
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">거래명세표 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· 공급자(우리 회사) 정보 · 발주 목록의 &lsquo;명세표&rsquo;에서 사용</span></h2>
          <button className="b2b-btn-primary" onClick={saveSupplier} disabled={supSaving}>{supSaving ? "저장 중..." : "저장"}</button>
        </div>
        {supMsg && <div className={supMsg.ok ? "sm-success" : "b2b-error"} style={{ marginBottom: 10 }}>{supMsg.text}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>상호</span>
            <input className="b2b-input" value={sup.name} onChange={(e) => setSup({ ...sup, name: e.target.value })} placeholder="예: 씨몬스터" /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>사업자등록번호</span>
            <input className="b2b-input" value={sup.biz_no} onChange={(e) => setSup({ ...sup, biz_no: e.target.value })} placeholder="000-00-00000" /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>대표자</span>
            <input className="b2b-input" value={sup.ceo} onChange={(e) => setSup({ ...sup, ceo: e.target.value })} /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>이메일</span>
            <input className="b2b-input" value={sup.email} onChange={(e) => setSup({ ...sup, email: e.target.value })} placeholder="youn@seamonster.kr" /></label>
          <label className="sm-col" style={{ gap: 3, gridColumn: "1 / -1" }}><span style={{ fontSize: 13, fontWeight: 600 }}>사업장 소재지</span>
            <input className="b2b-input" value={sup.addr} onChange={(e) => setSup({ ...sup, addr: e.target.value })} /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>업태</span>
            <input className="b2b-input" value={sup.biz_type} onChange={(e) => setSup({ ...sup, biz_type: e.target.value })} placeholder="예: 도소매" /></label>
          <label className="sm-col" style={{ gap: 3 }}><span style={{ fontSize: 13, fontWeight: 600 }}>종목</span>
            <input className="b2b-input" value={sup.biz_item} onChange={(e) => setSup({ ...sup, biz_item: e.target.value })} placeholder="예: 수산물" /></label>
          <label className="sm-col" style={{ gap: 3, gridColumn: "1 / -1" }}><span style={{ fontSize: 13, fontWeight: 600 }}>입금 은행정보 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 12 }}>· 명세표 하단에 표시</span></span>
            <input className="b2b-input" value={sup.bank} onChange={(e) => setSup({ ...sup, bank: e.target.value })} placeholder="예: 국민은행 000000-00-000000 (예금주: 씨몬스터)" /></label>
        </div>
        <div className="sm-row" style={{ gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>직인(도장) 이미지</span>
          <input type="file" accept="image/png,image/jpeg" onChange={onStampFile} style={{ fontSize: 12 }} />
          {stamp ? (
            <>
              <img src={stamp} alt="직인 미리보기" style={{ width: 44, height: 44, objectFit: "contain", border: "1px solid var(--sm-border)", borderRadius: 6, background: "var(--sm-white)" }} />
              <button className="b2b-link-btn" style={{ color: "var(--sm-danger)" }} onClick={() => setStamp("")}>직인 제거</button>
            </>
          ) : (
            <span className="sm-faint" style={{ fontSize: 12 }}>배경이 투명한 PNG(500KB 이하)를 올리면 명세표 공급자란에 자동으로 찍힙니다.</span>
          )}
        </div>
      </section>

      <p style={{ fontSize: 11.5, color: "var(--sm-text-light)", marginTop: 12 }}>
        상태형 항목은 <strong>체크한 결과 상태로 바뀔 때만</strong> 알림이 갑니다. 예) 발주 상태에서 &lsquo;발송완료&rsquo;만 체크하면
        중간 단계(생산중·발송대기 등)는 알림이 오지 않습니다.
      </p>
    </>
  );
}
