"use client";

import { useEffect, useState } from "react";
import { scheduleHorizon, kstTodayIso, type ScheduleHorizon } from "@/app/lib/production-schedule";
import { dateShort } from "@/app/lib/format";
import { OnOff, Pill, SetCard, SetRow, SaveBar, Result, useDraft, useReportDirty, api, errText, hhmm, type Msg, type SectionProps } from "../ui";

// 생산·재고 — 생산·재고 알림 · 상품마스터 변경알림(Teams 변경알림 채널) · 주간 생산 요청서 초안 · 권장생산 기준(읽기 전용).

type Mn = { enabled: boolean; botId: string; receivers: string; title: string; events: Record<string, boolean> };
type MnEvent = { key: string; label: string; group?: string };
type Draft = { ai: boolean; auto: boolean; time: string }; // AI 검토 포인트 · 자동 작성 · 작성 시각(수요일 KST)

export default function ProductionSection({ onDirty }: SectionProps) {
  const [err, setErr] = useState("");
  const mn = useDraft<Mn>(null);
  const [defs, setDefs] = useState<MnEvent[]>([]);
  const draft = useDraft<Draft>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [cronKey, setCronKey] = useState(true);
  const [teamsOn, setTeamsOn] = useState<boolean | null>(null);
  const [sched, setSched] = useState<ScheduleHorizon | null>(null);
  const [tMsg, setTMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<Msg | null>(null);

  useEffect(() => {
    setSched(scheduleHorizon(kstTodayIso())); // 화면을 연 날(KST) 기준
    (async () => {
      try {
        const [m, d, t] = await Promise.all([
          api<{ config: Mn; events: MnEvent[] }>("/api/production/settings/master-notify"),
          api<{ enabled: boolean; schedule: { enabled: boolean; time: string }; lastRun: string | null; cronKeySet: boolean }>("/api/b2b/settings/draft-ai"),
          api<{ enabled: boolean; hasUrl: boolean; hasHelperUrl: boolean }>("/api/b2b/settings/teams"),
        ]);
        mn.load(m.config); setDefs(m.events || []);
        draft.load({ ai: !!d.enabled, auto: d.schedule?.enabled !== false, time: d.schedule?.time || "13:50" });
        setLastRun(d.lastRun || null); setCronKey(d.cronKeySet !== false);
        setTeamsOn(!!t.enabled && (!!t.hasHelperUrl || !!t.hasUrl));
      } catch (e) { setErr(errText(e, "생산·재고 설정을 불러오지 못했습니다. 새로고침하세요")); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = mn.dirty || draft.dirty;
  useReportDirty(dirty, onDirty);
  const reset = () => { mn.reset(); draft.reset(); setSaveMsg(null); };

  async function save() {
    setSaving(true); setSaveMsg(null);
    try {
      if (mn.dirty && mn.draft) { await api("/api/production/settings/master-notify", "PUT", mn.draft); mn.load(mn.draft); }
      if (draft.dirty && draft.draft) {
        const j = await api<{ enabled: boolean; schedule: { enabled: boolean; time: string } }>("/api/b2b/settings/draft-ai", "PUT", { enabled: draft.draft.ai, schedule: { enabled: draft.draft.auto, time: draft.draft.time } });
        draft.load({ ai: !!j.enabled, auto: j.schedule.enabled, time: j.schedule.time });
      }
      setSaveMsg({ ok: true, text: `저장했습니다 (${hhmm()})` });
    } catch (e) { setSaveMsg({ ok: false, text: errText(e, "저장하지 못했습니다. 다시 누르세요") }); }
    setSaving(false);
  }

  async function test() {
    setBusy(true); setTMsg(null);
    try { await api("/api/production/settings/master-notify", "POST"); setTMsg({ ok: true, text: "테스트를 보냈습니다. Teams 변경알림 채널을 확인하세요" }); }
    catch (e) { setTMsg({ ok: false, text: errText(e, "테스트를 보내지 못했습니다. 연결 › Teams 를 확인하세요") }); }
    setBusy(false);
  }

  const m = mn.draft;
  const dr = draft.draft;
  const evOn = (k: string) => !!m && m.events[k] !== false;
  const setEv = (k: string, v: boolean) => m && mn.setDraft({ ...m, events: { ...m.events, [k]: v } });
  const group = (g: string) => defs.filter((d) => (d.group || "기타") === g);
  const groups = [...new Set(defs.map((d) => d.group || "기타"))];
  const prodGroups = groups.filter((g) => g !== "상품마스터");
  const blocked = teamsOn === false ? <p className="set-row-note">연결 › Teams 가 꺼져 있거나 주소가 없어 나가지 않습니다</p> : null;

  return (
    <>
      {err && <div className="b2b-error">{err}</div>}

      <SetCard title="생산·재고 알림" pill={teamsOn === false ? <Pill state="warn">Teams 꺼짐</Pill> : undefined}
        desc="생산 요청·입고·재고 이동 같은 일이 생길 때 Teams 변경알림 채널로 보냅니다."
        actions={<button type="button" className="b2b-btn-secondary" onClick={test} disabled={busy || teamsOn === false}>{busy ? "보내는 중..." : "테스트 발송"}</button>}>
        {blocked}
        {!m ? <div className="b2b-loading">불러오는 중...</div> : prodGroups.flatMap((g) => group(g)).map((ev) => (
          <SetRow key={ev.key} label={ev.label} desc={prodGroups.length > 1 ? ev.group : undefined}
            control={<OnOff label={ev.label} value={evOn(ev.key)} onChange={(v) => setEv(ev.key, v)} />} />
        ))}
        <Result msg={tMsg} />
      </SetCard>

      <SetCard title="상품마스터 변경알림" pill={!m ? null : !m.enabled ? <Pill state="off">꺼짐</Pill> : teamsOn === false ? <Pill state="warn">Teams 꺼짐</Pill> : <Pill state="on">켜짐</Pill>}
        desc="상품 등록·수정·삭제를 Teams 변경알림 채널로 보냅니다. 생산·재고 알림과는 따로 켜고 끕니다.">
        {!m ? <div className="b2b-loading">불러오는 중...</div> : (
          <>
            <SetRow label="상품마스터 변경알림" desc="끄면 아래 항목은 모두 보내지 않습니다"
              control={<OnOff label="상품마스터 변경알림" value={m.enabled} onChange={(v) => mn.setDraft({ ...m, enabled: v })} />} />
            {group("상품마스터").map((ev) => (
              <SetRow key={ev.key} label={ev.label}
                control={<OnOff label={ev.label} value={evOn(ev.key)} onChange={(v) => setEv(ev.key, v)} disabled={!m.enabled} />} />
            ))}
          </>
        )}
      </SetCard>

      <SetCard title="주간 생산 요청서 초안" pill={!dr ? null : dr.auto ? <Pill state="on">자동 작성 켜짐</Pill> : <Pill state="off">자동 작성 꺼짐</Pill>}
        desc="매주 수요일, 권장 수량으로 제조사 요청서 초안을 만들어 Teams 변경알림 채널(생산 요청 등록 알림)에 올립니다.">
        {!dr ? <div className="b2b-loading">불러오는 중...</div> : (
          <>
            <SetRow label="자동 작성" desc="끄면 수요일에 초안을 만들지 않습니다(생산 요청은 직접 만듭니다)"
              note={<>마지막 자동 작성: <strong>{lastRun || "기록 없음"}</strong>{!cronKey && <> · <span style={{ color: "var(--sm-danger)" }}>예약 실행 키가 없어 중계 서버(수 13:50)로만 실행됩니다</span></>}</>}
              control={<OnOff label="주간 초안 자동 작성" value={dr.auto} onChange={(v) => draft.setDraft({ ...dr, auto: v })} />} />
            <SetRow label="작성 시각" desc="매주 수요일, 한국시간 · 5분 단위"
              control={<input type="time" className="b2b-input set-time-input" step={300} value={dr.time} disabled={!dr.auto} aria-label="작성 시각"
                onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); if (!Number.isNaN(h) && !Number.isNaN(m)) draft.setDraft({ ...dr, time: `${String(h).padStart(2, "0")}:${String(Math.floor(m / 5) * 5).padStart(2, "0")}` }); }} />} />
            <SetRow label="AI 검토 포인트 붙이기" desc="초안에 AI 가 본 주의할 점을 덧붙입니다. 꺼도 초안(수식 수량)은 만들어집니다"
              control={<OnOff label="AI 검토 포인트" value={dr.ai} onChange={(v) => draft.setDraft({ ...dr, ai: v })} disabled={!dr.auto} />} />
          </>
        )}
      </SetCard>

      <SetCard title="권장생산 기준" desc="생산 일정(영업일): 작성 D → 컨펌 D+1 → 생산 시작 D+3 → 생산 마감 D+7 → 판매 가능 D+8. 날짜로 계산되어 바꿀 값은 없습니다.">
        {sched && <ul className="set-list">
          <li><strong>목표</strong> = 평상시 하루 출고 × <strong>{sched.horizonDays}일</strong> (오늘 → 다음 요청일 {dateShort(sched.nextDraft)} 요청분 판매 가능일 {dateShort(sched.nextSellable)})</li>
          <li><strong>부족</strong> = 현재고 + 입고 예정이 하루 출고 × <strong>{sched.leadDays}일</strong> (오늘 → 오늘 요청분 판매 가능일 {dateShort(sched.sellable)}) 미만</li>
          <li><strong>권장생산</strong> = 소매 모자란 양 + 도매 모자란 양 − 입고 예정</li>
        </ul>}
      </SetCard>

      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} msg={saveMsg} />
    </>
  );
}
