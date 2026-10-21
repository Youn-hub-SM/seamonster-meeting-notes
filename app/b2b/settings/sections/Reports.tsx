"use client";

import { useEffect, useState } from "react";
import { Pill, SetCard, SetRow, SaveBar, useDraft, useReportDirty, api, errText, hhmm, type Msg, type SectionProps } from "../ui";

// 매출·리포트 — 종합 리포트 메일 받는 사람(옛 종합 리포트 화면 카드를 옮김) · 발송완료 매출 반영(안내).

export default function ReportsSection({ onDirty }: SectionProps) {
  const [err, setErr] = useState("");
  const mail = useDraft<string>(null);
  const [mailDefault, setMailDefault] = useState("");
  const [smtpReady, setSmtpReady] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<Msg | null>(null);

  useEffect(() => {
    api<{ mailTo: string; mailDefault: string | string[]; smtpReady: boolean }>("/api/briefing/settings")
      .then((j) => { mail.load(j.mailTo || ""); setMailDefault(Array.isArray(j.mailDefault) ? j.mailDefault.join(", ") : j.mailDefault || ""); setSmtpReady(j.smtpReady !== false); })
      .catch((e) => setErr(errText(e, "리포트 설정을 불러오지 못했습니다. 새로고침하세요")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useReportDirty(mail.dirty, onDirty);
  const reset = () => { mail.reset(); setSaveMsg(null); };
  async function save() {
    setSaving(true); setSaveMsg(null);
    try { await api("/api/briefing/settings", "PUT", { mailTo: mail.draft ?? "" }); mail.load((mail.draft ?? "").trim()); setSaveMsg({ ok: true, text: `저장했습니다 (${hhmm()})` }); }
    catch (e) { setSaveMsg({ ok: false, text: errText(e, "저장하지 못했습니다. 메일 주소를 확인하세요") }); }
    setSaving(false);
  }

  return (
    <>
      {err && <div className="b2b-error">{err}</div>}

      <SetCard title="종합 리포트 메일" pill={!smtpReady ? <Pill state="err">메일 서버 없음</Pill> : undefined}
        desc="종합 리포트(일일·주간·월간)에서 [보내기]를 누르면 이 사람들에게 메일로 갑니다. 자동 발송은 없습니다.">
        {mail.draft === null ? (!err && <div className="b2b-loading">불러오는 중...</div>) : (
          <SetRow label="받는 사람" desc={`쉼표로 여러 명. 비우면 기본 받는 사람(${mailDefault || "설정 없음"})에게 보냅니다`}
            control={<input className="b2b-input set-secret" value={mail.draft} onChange={(e) => mail.setDraft(e.target.value)} placeholder={mailDefault || "name@seamonster.kr"} aria-label="종합 리포트 받는 사람" />} />
        )}
      </SetCard>

      <SetCard title="발송완료 매출 반영" pill={<Pill state="on">자동</Pill>}
        desc="도매 발주가 발송완료되면 매출 데이터(채널 '도매')에 발송일 기준으로 자동 반영됩니다. 바꿀 값은 없습니다." />

      <SaveBar dirty={mail.dirty} saving={saving} onSave={save} onReset={reset} msg={saveMsg} />
    </>
  );
}
