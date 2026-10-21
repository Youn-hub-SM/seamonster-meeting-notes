"use client";

import { useEffect, useState } from "react";
import { useConfirm } from "@/app/components/Feedback";
import { STATUS_SHORT } from "@/app/lib/b2b-orders";
import { OnOff, Pill, SetCard, SetRow, SaveBar, TimesEditor, Result, useDraft, useReportDirty, api, errText, hhmm, type Msg, type SectionProps } from "../ui";

// 발주(B2B) — 발주 알림 이벤트 · 아침 일정 알림(예약) · 거래명세표 공급자.

type EventMeta = { key: string; label: string; desc?: string; kind: "toggle" | "status"; statuses?: string[] };
type NotifyConfig = Record<string, boolean | string[]>;
type DigestSections = { ship: boolean; unscheduled: boolean; invoice: boolean; payment: boolean; prod: boolean };
type Digest = { enabled: boolean; hour: number; days: number; times: string[]; sections: DigestSections; title: string };
type Supplier = { name: string; biz_no: string; ceo: string; addr: string; biz_type: string; biz_item: string; email: string; bank: string };
type Statement = { supplier: Supplier; stamp: string };

const DIGEST_PARTS: [keyof DigestSections, string][] = [["ship", "발송 예정"], ["unscheduled", "발송일정 미등록"], ["invoice", "계산서 미발행"], ["payment", "입금 대기"], ["prod", "생산 요청"]];
const statusLabel = (s: string) => (STATUS_SHORT as Record<string, string>)[s] ?? s;

export default function OrdersSection({ onDirty }: SectionProps) {
  const confirm = useConfirm();
  const [err, setErr] = useState("");
  const [events, setEvents] = useState<EventMeta[]>([]);
  const notify = useDraft<NotifyConfig>(null);
  const digest = useDraft<Digest>(null);
  const stmt = useDraft<Statement>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [cronOk, setCronOk] = useState(true);
  const [teamsOn, setTeamsOn] = useState<boolean | null>(null);
  const [preview, setPreview] = useState("");
  const [dMsg, setDMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<Msg | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [n, d, s, t] = await Promise.all([
          api<{ config: NotifyConfig; events: EventMeta[] }>("/api/b2b/settings/notify"),
          api<{ config: Digest; lastSent: string | null; cronKeySet?: boolean; cronSecretSet?: boolean }>("/api/b2b/settings/digest"),
          api<{ supplier: Supplier; stamp: string }>("/api/b2b/settings/statement"),
          api<{ enabled: boolean; hasUrl: boolean }>("/api/b2b/settings/teams"),
        ]);
        setEvents(n.events || []); notify.load(n.config || {});
        digest.load(d.config); setLastSent(d.lastSent || null); setCronOk((d.cronKeySet ?? d.cronSecretSet) !== false);
        stmt.load({ supplier: s.supplier, stamp: s.stamp || "" });
        setTeamsOn(!!t.enabled && !!t.hasUrl);
      } catch (e) { setErr(errText(e, "발주 설정을 불러오지 못했습니다. 새로고침하세요")); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = notify.dirty || digest.dirty || stmt.dirty;
  useReportDirty(dirty, onDirty);
  const reset = () => { notify.reset(); digest.reset(); stmt.reset(); setSaveMsg(null); };

  async function save() {
    setSaving(true); setSaveMsg(null);
    try {
      if (notify.dirty && notify.draft) { await api("/api/b2b/settings/notify", "PUT", { config: notify.draft }); notify.load(notify.draft); }
      if (digest.dirty && digest.draft) { const j = await api<{ config: Digest }>("/api/b2b/settings/digest", "PUT", digest.draft); digest.load(j.config); }
      if (stmt.dirty && stmt.draft) { await api("/api/b2b/settings/statement", "POST", stmt.draft); stmt.load(stmt.draft); }
      setSaveMsg({ ok: true, text: `저장했습니다 (${hhmm()})` });
    } catch (e) { setSaveMsg({ ok: false, text: errText(e, "저장하지 못했습니다. 입력값을 확인하세요") }); }
    setSaving(false);
  }

  // 알림 이벤트 편집
  const n = notify.draft || {};
  const setN = (k: string, v: boolean | string[]) => notify.setDraft((p) => ({ ...(p || {}), [k]: v }));
  const isOn = (ev: EventMeta) => ev.kind === "toggle" ? n[ev.key] !== false : Array.isArray(n[ev.key]) ? (n[ev.key] as string[]).length > 0 : true;
  const stOn = (k: string, s: string) => { const v = n[k]; return v === undefined ? true : Array.isArray(v) && v.includes(s); };
  const toggleSt = (ev: EventMeta, s: string) => {
    const cur = Array.isArray(n[ev.key]) ? (n[ev.key] as string[]) : n[ev.key] === undefined ? [...(ev.statuses || [])] : [];
    setN(ev.key, cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);
  };

  // 아침 일정 알림 실행
  async function loadPreview() {
    setBusy("preview"); setDMsg(null);
    try { const j = await api<{ preview: string }>("/api/b2b/schedule-digest"); setPreview(j.preview || ""); }
    catch (e) { setDMsg({ ok: false, text: errText(e, "미리 보지 못했습니다. 새로고침하세요") }); }
    setBusy("");
  }
  async function sendNow() {
    if (!(await confirm({ title: "'아침 일정 알림' 지금 보내기", body: "Teams B2B 채널로 바로 보냅니다. 보낸 메시지는 거둘 수 없습니다.", action: "지금 보내기", danger: false }))) return;
    setBusy("send"); setDMsg(null);
    try { await api("/api/b2b/schedule-digest?send=1"); setDMsg({ ok: true, text: "알림을 보냈습니다" }); }
    catch (e) { setDMsg({ ok: false, text: errText(e, "알림을 보내지 못했습니다. 연결 › Teams 를 확인하세요") }); }
    setBusy("");
  }

  const d = digest.draft;
  const sd = stmt.draft;
  const setSup = (k: keyof Supplier, v: string) => stmt.setDraft((p) => (p ? { ...p, supplier: { ...p.supplier, [k]: v } } : p));
  function onStamp(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 500_000) { setSaveMsg({ ok: false, text: "직인을 올리지 못했습니다. 500KB 이하 PNG 로 다시 고르세요" }); return; }
    const r = new FileReader();
    r.onload = () => stmt.setDraft((p) => (p ? { ...p, stamp: String(r.result || "") } : p));
    r.readAsDataURL(f);
  }
  const blocked = teamsOn === false ? "연결 › Teams 가 꺼져 있거나 주소가 없어 나가지 않습니다" : undefined;

  return (
    <>
      {err && <div className="b2b-error">{err}</div>}

      <SetCard title="발주 알림" pill={teamsOn === false ? <Pill state="warn">Teams 꺼짐</Pill> : undefined}
        desc="발주에 일이 생길 때 Teams B2B 채널로 보낼 알림입니다. 상태가 있는 알림은 고른 상태로 바뀔 때만 보냅니다.">
        {blocked && <p className="set-row-note">{blocked}</p>}
        {notify.draft === null ? <div className="b2b-loading">불러오는 중...</div> : events.map((ev) => (
          <SetRow key={ev.key} label={ev.label} desc={ev.desc}
            control={ev.kind === "toggle"
              ? <OnOff label={ev.label} value={isOn(ev)} onChange={(v) => setN(ev.key, v)} />
              : <OnOff label={ev.label} value={isOn(ev)} onChange={(v) => setN(ev.key, v ? [...(ev.statuses || [])] : [])} />}>
            {ev.kind === "status" && isOn(ev) && (
              <div className="b2b-notify-statuses">
                {(ev.statuses || []).map((s) => (
                  <label key={s} className={`b2b-notify-chip ${stOn(ev.key, s) ? "is-on" : ""}`}>
                    <input type="checkbox" checked={stOn(ev.key, s)} onChange={() => toggleSt(ev, s)} />
                    {statusLabel(s)}
                  </label>
                ))}
              </div>
            )}
          </SetRow>
        ))}
      </SetCard>

      <SetCard title="아침 일정 알림"
        pill={!d ? null : !d.enabled ? <Pill state="off">예약 꺼짐</Pill> : teamsOn === false ? <Pill state="warn">Teams 꺼짐</Pill> : <Pill state="on">예약 켜짐</Pill>}
        desc="발송 예정·미등록 일정·계산서·입금·생산 요청을 정해진 시각에 Teams B2B 채널로 보냅니다."
        actions={<>
          <button type="button" className="b2b-btn-secondary" onClick={loadPreview} disabled={!!busy}>{busy === "preview" ? "불러오는 중..." : "미리 보기"}</button>
          <button type="button" className="b2b-btn-secondary" onClick={sendNow} disabled={!!busy || teamsOn === false}>{busy === "send" ? "보내는 중..." : "지금 보내기"}</button>
        </>}>
        {!d ? <div className="b2b-loading">불러오는 중...</div> : (
          <>
            <SetRow label="예약" desc="매일 아래 시각(한국시간)에 자동으로 보냅니다"
              note={<>마지막 자동 발송: <strong>{lastSent || "기록 없음"}</strong>{!cronOk && <> · <span style={{ color: "var(--sm-danger)" }}>예약 실행 키가 없어 자동 발송이 실패합니다</span></>}</>}
              control={<OnOff label="아침 일정 알림 예약" value={d.enabled} onChange={(v) => digest.setDraft({ ...d, enabled: v })} />}>
              <TimesEditor times={d.times} onChange={(t) => digest.setDraft({ ...d, times: t })} disabled={!d.enabled} />
            </SetRow>
            <SetRow label="보낼 내용" desc="계산서·입금은 기간과 상관없이 모두">
              <div className="sm-row-wrap" style={{ gap: "var(--sm-space-3)" }}>
                {DIGEST_PARTS.map(([k, l]) => (
                  <label key={k} className="sm-row" style={{ gap: "var(--sm-space-1)", fontSize: "var(--sm-fs-sm)" }}>
                    <input type="checkbox" className="b2b-checkbox" checked={!!d.sections[k]} onChange={(e) => digest.setDraft({ ...d, sections: { ...d.sections, [k]: e.target.checked } })} /> {l}
                  </label>
                ))}
              </div>
            </SetRow>
            <SetRow label="앞뒤 기간" desc="오늘 기준 앞뒤 며칠의 발송 예정을 넣을지"
              control={<span className="sm-row" style={{ gap: "var(--sm-space-1)" }}><input type="number" className="b2b-input set-num" min={1} max={31} value={d.days} onChange={(e) => digest.setDraft({ ...d, days: Number(e.target.value) })} aria-label="앞뒤 기간(일)" />일</span>} />
            <SetRow label="제목" control={<input className="b2b-input set-secret" value={d.title} maxLength={60} onChange={(e) => digest.setDraft({ ...d, title: e.target.value })} aria-label="알림 제목" />} />
            <Result msg={dMsg} />
            {preview && <pre className="set-preview">{preview}</pre>}
          </>
        )}
      </SetCard>

      <SetCard title="거래명세표" desc="명세표의 공급자(우리 회사) 정보와 직인입니다.">
        {!sd ? <div className="b2b-loading">불러오는 중...</div> : (
          <>
            <div className="set-grid">
              {([["name", "상호", "씨몬스터"], ["biz_no", "사업자등록번호", "000-00-00000"], ["ceo", "대표자", ""], ["email", "이메일", "youn@seamonster.kr"], ["biz_type", "업태", "도소매"], ["biz_item", "종목", "수산물"]] as [keyof Supplier, string, string][]).map(([k, l, ph]) => (
                <label key={k} className="b2b-field"><span className="b2b-field-label">{l}</span>
                  <input className="b2b-input" value={sd.supplier[k] || ""} placeholder={ph ? `예: ${ph}` : undefined} onChange={(e) => setSup(k, e.target.value)} /></label>
              ))}
              <label className="b2b-field set-grid-wide"><span className="b2b-field-label">사업장 소재지</span>
                <input className="b2b-input" value={sd.supplier.addr || ""} onChange={(e) => setSup("addr", e.target.value)} /></label>
              <label className="b2b-field set-grid-wide"><span className="b2b-field-label">입금 은행정보</span>
                <input className="b2b-input" value={sd.supplier.bank || ""} placeholder="예: 국민은행 000000-00-000000 (예금주: 씨몬스터)" onChange={(e) => setSup("bank", e.target.value)} /></label>
            </div>
            <SetRow label="직인(도장) 이미지" desc="투명 배경 PNG, 500KB 이하"
              control={<div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)" }}>
                {sd.stamp && <img src={sd.stamp} alt="직인 미리보기" className="set-stamp" />}
                <input type="file" accept="image/png,image/jpeg" onChange={onStamp} aria-label="직인 이미지 고르기" />
                {sd.stamp && <button type="button" className="b2b-link-btn" onClick={() => stmt.setDraft({ ...sd, stamp: "" })}>직인 빼기</button>}
              </div>} />
          </>
        )}
      </SetCard>

      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} msg={saveMsg} />
    </>
  );
}
