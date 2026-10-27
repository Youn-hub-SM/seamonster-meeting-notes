"use client";

import { useCallback, useEffect, useState } from "react";
import { qtyText } from "@/app/lib/format";
import { OnOff, Pill, SetCard, SetRow, SaveBar, Result, useReportDirty, api, errText, hhmm, type Msg, type SectionProps } from "../ui";

// 연결 — 외부 채널 주소·키는 이 한 곳에만(2026-10-21 중복 정리). Teams 채널 5개 + 전체 발송, 아사나, Tally, Microsoft 365 문서(2026-10-25).
//  주소·키는 화면에 다시 보이지 않는다(꼬리만) — 새 값을 넣거나 [지우기]를 고른 뒤 [저장].

type TeamsSaved = { enabled: boolean; has: Record<Ch, boolean>; tail: Record<Ch, string> };
type Ch = "url" | "helperUrl" | "claimsUrl" | "inquiryUrl" | "otpUrl";
const CHANNELS: { key: Ch; label: string; empty: string }[] = [
  { key: "url", label: "B2B 알림 채널", empty: "발주 알림·아침 일정 알림이 들어오는 채널" },
  { key: "helperUrl", label: "업무도우미 변경알림 채널", empty: "비우면 B2B 채널로 함께 발송" },
  { key: "claimsUrl", label: "클레임 알림 채널", empty: "비우면 변경알림·B2B 채널로 발송" },
  { key: "inquiryUrl", label: "고객문의 알림 채널", empty: "비우면 클레임 채널로 발송" },
  { key: "otpUrl", label: "인증번호 알림 채널", empty: "알리고 인증 문자의 인증번호 — 비우면 B2B 채널로 발송" }, // 2026-10-22
];
const NO_CH = { url: "", helperUrl: "", claimsUrl: "", inquiryUrl: "", otpUrl: "" };
const NO_CLEAR = { url: false, helperUrl: false, claimsUrl: false, inquiryUrl: false, otpUrl: false };

type AsanaSaved = { hasPat: boolean; project: string; assignee: string };
type TallySaved = { hasKey: boolean; formId: string };
type MsSaved = { configured: boolean; text: string }; // text = '주소 | 이름' 한 줄에 하나(화면 편집용)
const msToText = (s: { url: string; label: string }[]) => s.map((x) => (x.label ? `${x.url} | ${x.label}` : x.url)).join("\n");
const msFromText = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [url, ...rest] = l.split("|"); return { url: url.trim(), label: rest.join("|").trim() }; });

export default function ConnectSection({ onDirty }: SectionProps) {
  const [err, setErr] = useState("");
  // Teams
  const [teams, setTeams] = useState<TeamsSaved | null>(null);
  const [tEnabled, setTEnabled] = useState(false);
  const [tNew, setTNew] = useState<Record<Ch, string>>(NO_CH);
  const [tClear, setTClear] = useState<Record<Ch, boolean>>(NO_CLEAR);
  const [tMsg, setTMsg] = useState<Msg | null>(null);
  // 아사나
  const [asana, setAsana] = useState<AsanaSaved | null>(null);
  const [aPat, setAPat] = useState("");
  const [aPatClear, setAPatClear] = useState(false);
  const [aProject, setAProject] = useState("");
  const [aAssignee, setAAssignee] = useState("");
  const [aMsg, setAMsg] = useState<Msg | null>(null);
  // Tally
  const [tally, setTally] = useState<TallySaved | null>(null);
  const [kNew, setKNew] = useState("");
  const [kClear, setKClear] = useState(false);
  const [formId, setFormId] = useState("");
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);
  const [yMsg, setYMsg] = useState<Msg | null>(null);
  // Microsoft 365 문서
  const [ms, setMs] = useState<MsSaved | null>(null);
  const [msText, setMsText] = useState("");
  const [mMsg, setMMsg] = useState<Msg | null>(null);

  const [busy, setBusy] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<Msg | null>(null);

  const loadTeams = useCallback(async () => {
    const j = await api<{ enabled: boolean; hasUrl: boolean; urlTail: string; hasHelperUrl: boolean; helperTail: string; hasClaimsUrl: boolean; claimsTail: string; hasInquiryUrl: boolean; inquiryTail: string; hasOtpUrl: boolean; otpTail: string }>("/api/b2b/settings/teams");
    const s: TeamsSaved = {
      enabled: !!j.enabled,
      has: { url: !!j.hasUrl, helperUrl: !!j.hasHelperUrl, claimsUrl: !!j.hasClaimsUrl, inquiryUrl: !!j.hasInquiryUrl, otpUrl: !!j.hasOtpUrl },
      tail: { url: j.urlTail || "", helperUrl: j.helperTail || "", claimsUrl: j.claimsTail || "", inquiryUrl: j.inquiryTail || "", otpUrl: j.otpTail || "" },
    };
    setTeams(s); setTEnabled(s.enabled); setTNew(NO_CH); setTClear(NO_CLEAR);
  }, []);
  const loadAsana = useCallback(async () => {
    const j = await api<{ hasPat: boolean; project: string; assignee: string }>("/api/voc/asana-config");
    const s = { hasPat: !!j.hasPat, project: j.project || "", assignee: j.assignee || "" };
    setAsana(s); setAPat(""); setAPatClear(false); setAProject(s.project); setAAssignee(s.assignee);
  }, []);
  const loadTally = useCallback(async () => {
    const j = await api<{ hasApiKey: boolean; formId: string }>("/api/voc/tally-config");
    const s = { hasKey: !!j.hasApiKey, formId: j.formId || "" };
    setTally(s); setKNew(""); setKClear(false); setFormId(s.formId);
  }, []);
  const loadMs = useCallback(async () => {
    const j = await api<{ configured: boolean; sources: { url: string; label: string }[] }>("/api/b2b/settings/ms365");
    const s = { configured: !!j.configured, text: msToText(j.sources || []) };
    setMs(s); setMsText(s.text);
  }, []);

  useEffect(() => {
    Promise.all([loadTeams(), loadAsana(), loadTally(), loadMs()]).catch((e) => setErr(errText(e, "연결 설정을 불러오지 못했습니다. 새로고침하세요")));
  }, [loadTeams, loadAsana, loadTally, loadMs]);

  const teamsDirty = !!teams && (tEnabled !== teams.enabled || CHANNELS.some((c) => tNew[c.key].trim() || tClear[c.key]));
  const asanaDirty = !!asana && (!!aPat.trim() || aPatClear || aProject.trim() !== asana.project || aAssignee.trim() !== asana.assignee);
  const tallyDirty = !!tally && (!!kNew.trim() || kClear || formId !== tally.formId);
  const msDirty = !!ms && msText.trim() !== ms.text.trim();
  const dirty = teamsDirty || asanaDirty || tallyDirty || msDirty;
  useReportDirty(dirty, onDirty);

  function reset() {
    if (teams) { setTEnabled(teams.enabled); setTNew(NO_CH); setTClear(NO_CLEAR); }
    if (asana) { setAPat(""); setAPatClear(false); setAProject(asana.project); setAAssignee(asana.assignee); }
    if (tally) { setKNew(""); setKClear(false); setFormId(tally.formId); }
    if (ms) setMsText(ms.text);
    setSaveMsg(null);
  }

  async function save() {
    setSaving(true); setSaveMsg(null);
    try {
      if (teamsDirty) {
        const body: Record<string, unknown> = { enabled: tEnabled, clear: CHANNELS.filter((c) => tClear[c.key]).map((c) => c.key) };
        for (const c of CHANNELS) if (tNew[c.key].trim() && !tClear[c.key]) body[c.key] = tNew[c.key].trim();
        await api("/api/b2b/settings/teams", "PUT", body);
        await loadTeams();
      }
      if (asanaDirty && asana) {
        if (aPatClear) await api("/api/voc/asana-config", "POST", { pat: "" });
        else if (aPat.trim()) await api("/api/voc/asana-config", "POST", { pat: aPat.trim() });
        if (aProject.trim() !== asana.project) await api("/api/voc/asana-config", "POST", { project: aProject.trim() });
        if (aAssignee.trim() !== asana.assignee) await api("/api/voc/asana-config", "POST", { assignee: aAssignee.trim() });
        await loadAsana();
      }
      if (tallyDirty && tally) {
        if (kClear) await api("/api/voc/tally-config", "POST", { apiKey: "" });
        else if (kNew.trim()) await api("/api/voc/tally-config", "POST", { apiKey: kNew.trim() });
        if (formId !== tally.formId) await api("/api/voc/tally-config", "POST", { formId });
        await loadTally();
      }
      if (msDirty) {
        await api("/api/b2b/settings/ms365", "PUT", { sources: msFromText(msText) });
        await loadMs();
      }
      setSaveMsg({ ok: true, text: `저장했습니다 (${hhmm()})` });
    } catch (e) { setSaveMsg({ ok: false, text: errText(e, "저장하지 못했습니다. 입력값을 확인하세요") }); }
    setSaving(false);
  }

  // 실행 버튼 — 저장된 값으로 동작한다(바꾼 것이 있으면 먼저 저장)
  async function run(tag: string, fn: () => Promise<void>) { setBusy(tag); try { await fn(); } finally { setBusy(""); } }
  const testTeams = () => run("teams", async () => {
    setTMsg(null);
    try { const j = await api<{ detail: string }>("/api/b2b/settings/teams", "POST"); setTMsg({ ok: true, text: `테스트를 보냈습니다 — ${j.detail || "채널 확인"}` }); }
    catch (e) { setTMsg({ ok: false, text: errText(e, "테스트를 보내지 못했습니다. 채널 주소를 확인하세요") }); }
  });
  const testAsana = () => run("asana", async () => {
    setAMsg(null);
    try { const j = await api<{ detail: string }>("/api/voc/asana-config", "POST", { test: true }); setAMsg({ ok: true, text: j.detail || "연결을 확인했습니다" }); }
    catch (e) { setAMsg({ ok: false, text: errText(e, "연결을 확인하지 못했습니다. 토큰과 프로젝트를 확인하세요") }); }
  });
  const loadForms = () => run("forms", async () => {
    setYMsg(null);
    try { const j = await api<{ forms: { id: string; name: string }[] }>("/api/voc/tally/forms"); setForms(j.forms || []); if (!j.forms?.length) setYMsg({ ok: false, text: "폼이 없습니다. Tally 에서 폼을 만든 뒤 다시 불러오세요" }); }
    catch (e) { setYMsg({ ok: false, text: errText(e, "폼을 불러오지 못했습니다. API 키를 확인하세요") }); }
  });
  const testMs = () => run("ms", async () => {
    setMMsg(null);
    try { const j = await api<{ detail: string }>("/api/b2b/settings/ms365", "POST"); setMMsg({ ok: true, text: `연결됨 — ${j.detail || ""}` }); }
    catch (e) { setMMsg({ ok: false, text: errText(e, "연결을 확인하지 못했습니다. 사이트 주소와 앱 권한을 확인하세요") }); }
  });
  const indexMs = () => run("msidx", async () => {
    setMMsg(null);
    try {
      const j = await api<{ summary: { scanned: number; indexed: number; skipped: number; errors: number; pending: number; deleted: number; partial: boolean; note: string } }>("/api/b2b/settings/ms365/index", "POST");
      const s = j.summary;
      setMMsg({ ok: true, text: `색인 갱신 — 파일 ${s.scanned}개 중 새로 읽음 ${s.indexed}, 이름만 ${s.skipped}, 실패 ${s.errors}${s.pending ? `, 다음에 이어서 ${s.pending}` : ""}${s.deleted ? `, 정리 ${s.deleted}` : ""}${s.partial ? " (일부만 봄 — 한 번 더 누르면 이어집니다)" : ""}${s.note ? ` · ${s.note}` : ""}` });
    } catch (e) { setMMsg({ ok: false, text: errText(e, "색인을 갱신하지 못했습니다") }); }
  });
  const importNow = () => run("import", async () => {
    setYMsg(null);
    try { const j = await api<{ imported: number; skipped: number; scanned: number }>("/api/voc/tally/import", "POST"); setYMsg({ ok: true, text: `응답을 가져왔습니다 — 새로 ${qtyText(j.imported, "건")} (이미 있음 ${j.skipped} / 조회 ${j.scanned})` }); }
    catch (e) { setYMsg({ ok: false, text: errText(e, "응답을 가져오지 못했습니다. API 키와 폼을 확인하세요") }); }
  });

  const anyUrl = !!teams && Object.values(teams.has).some(Boolean);
  const secret = (has: boolean, tail: string, val: string, setVal: (v: string) => void, clear: boolean, setClear: (v: boolean) => void, label: string, placeholder: string) => (
    <div className="sm-row-wrap" style={{ gap: "var(--sm-space-2)", flex: 1, minWidth: 0 }}>
      <input className="b2b-input set-secret" type="password" autoComplete="off" value={clear ? "" : val} disabled={clear}
        onChange={(e) => setVal(e.target.value)} placeholder={has ? `저장됨 ${tail} — 바꿀 때만 입력` : placeholder} aria-label={label} />
      {has && (
        <label className="sm-row" style={{ gap: "var(--sm-space-1)", fontSize: "var(--sm-fs-sm)" }}>
          <input type="checkbox" className="b2b-checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} /> 지우기
        </label>
      )}
    </div>
  );

  return (
    <>
      {err && <div className="b2b-error">{err}</div>}

      <SetCard title="Teams" pill={!teams ? null : !anyUrl ? <Pill state="err">주소 없음</Pill> : teams.enabled ? <Pill state="on">발송 중</Pill> : <Pill state="off">꺼짐</Pill>}
        desc="모든 Teams 알림(발주·아침 일정·변경알림·클레임·고객문의·인증번호)이 나가는 채널입니다. 전체 발송을 끄면 알림이 하나도 나가지 않습니다."
        actions={<button type="button" className="b2b-btn-secondary" onClick={testTeams} disabled={busy === "teams" || !anyUrl || teamsDirty}>{busy === "teams" ? "보내는 중..." : "테스트 발송"}</button>}>
        <SetRow label="Teams로 발송" desc="꺼 두면 아래 모든 채널로 보내지 않습니다"
          control={<OnOff label="Teams로 발송" value={tEnabled} onChange={setTEnabled} disabled={!teams} />} />
        {CHANNELS.map((c) => (
          <SetRow key={c.key} label={c.label} desc={teams?.has[c.key] ? undefined : c.empty}
            control={teams && secret(teams.has[c.key], teams.tail[c.key], tNew[c.key], (v) => setTNew((p) => ({ ...p, [c.key]: v })), tClear[c.key], (v) => setTClear((p) => ({ ...p, [c.key]: v })), `${c.label} 주소`, "https://...")} />
        ))}
        {teamsDirty && <p className="set-row-note">테스트 발송은 저장한 뒤에 켜집니다</p>}
        <Result msg={tMsg} />
      </SetCard>

      <SetCard title="아사나" pill={!asana ? null : asana.hasPat && asana.project ? <Pill state="on">연결됨</Pill> : <Pill state="err">연결 안 됨</Pill>}
        desc="VOC 를 아사나 업무로 올릴 때 씁니다."
        actions={<button type="button" className="b2b-btn-secondary" onClick={testAsana} disabled={busy === "asana" || !asana?.hasPat || asanaDirty}>{busy === "asana" ? "확인 중..." : "연결 확인"}</button>}>
        <SetRow label="개인 액세스 토큰(PAT)" desc={asana?.hasPat ? undefined : "아사나에서 발급한 토큰을 붙여넣습니다"}
          control={asana && secret(asana.hasPat, "", aPat, setAPat, aPatClear, setAPatClear, "아사나 토큰", "토큰")} />
        <SetRow label="프로젝트" desc="아사나에서 프로젝트를 연 주소 또는 gid — 업무는 '개선요청' 섹션에 등록됩니다"
          control={<input className="b2b-input set-secret" value={aProject} onChange={(e) => setAProject(e.target.value)} placeholder="https://app.asana.com/0/1234567890/list" aria-label="아사나 프로젝트" />} />
        <SetRow label="기본 담당자" desc="워크스페이스 멤버 이메일, 비우면 담당자 없음"
          control={<input className="b2b-input set-secret" type="email" value={aAssignee} onChange={(e) => setAAssignee(e.target.value)} placeholder="name@seamonster.kr" aria-label="아사나 기본 담당자" />} />
        <Result msg={aMsg} />
      </SetCard>

      <SetCard title="Tally" pill={!tally ? null : tally.hasKey && tally.formId ? <Pill state="on">연결됨</Pill> : <Pill state="err">연결 안 됨</Pill>}
        desc="설문 응답을 VOC 로 가져옵니다. 이미 가져온 응답은 건너뛰고, 처음 가져올 때는 최근 60일입니다."
        actions={<>
          <button type="button" className="b2b-btn-secondary" onClick={loadForms} disabled={busy === "forms" || !tally?.hasKey || tallyDirty}>{busy === "forms" ? "불러오는 중..." : "폼 불러오기"}</button>
          <button type="button" className="b2b-btn-secondary" onClick={importNow} disabled={busy === "import" || !tally?.hasKey || !tally?.formId || tallyDirty}>{busy === "import" ? "가져오는 중..." : "응답 가져오기"}</button>
        </>}>
        <SetRow label="API 키" control={tally && secret(tally.hasKey, "", kNew, setKNew, kClear, setKClear, "Tally API 키", "tally_xxxxxxxx")} />
        <SetRow label="가져올 폼" desc={forms.length ? undefined : formId ? `지금 ${formId} — 바꾸려면 [폼 불러오기]` : "[폼 불러오기]를 누른 뒤 고릅니다"}
          control={forms.length > 0 ? (
            <select className="b2b-select set-secret" value={formId} onChange={(e) => setFormId(e.target.value)} aria-label="가져올 폼">
              <option value="">폼 선택</option>
              {forms.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.id})</option>)}
            </select>
          ) : undefined} />
        {tallyDirty && <p className="set-row-note">폼 불러오기·응답 가져오기는 저장한 뒤에 켜집니다</p>}
        <Result msg={yMsg} />
      </SetCard>

      <SetCard title="Microsoft 365 문서" pill={!ms ? null : !ms.configured ? <Pill state="err">자격 없음</Pill> : ms.text.trim() ? <Pill state="on">연결됨</Pill> : <Pill state="warn">문서함 없음</Pill>}
        desc="AI 비서가 읽는 회사 공용 문서함(SharePoint 사이트·OneDrive). 읽기만 하고, 여기 적은 곳만 읽습니다. 앱 자격(테넌트·클라이언트 ID·시크릿)은 Vercel 환경 변수에 두고 절차는 docs/ms365-setup.md 를 따릅니다."
        actions={<>
          <button type="button" className="b2b-btn-secondary" onClick={testMs} disabled={busy === "ms" || !ms?.configured || !ms?.text.trim() || msDirty}>{busy === "ms" ? "확인 중..." : "연결 확인"}</button>
          <button type="button" className="b2b-btn-secondary" onClick={indexMs} disabled={busy === "msidx" || !ms?.configured || !ms?.text.trim() || msDirty}>{busy === "msidx" ? "색인 중..." : "문서 색인 갱신"}</button>
        </>}>
        <SetRow label="읽을 문서함" desc="한 줄에 하나 — 사이트 주소, 그 뒤에 ' | 이름'(비서가 부르는 이름). 예: https://회사.sharepoint.com/sites/docs | 공용 문서"
          control={<textarea className="b2b-input set-secret" rows={4} value={msText} onChange={(e) => setMsText(e.target.value)} placeholder={"https://회사.sharepoint.com/sites/docs | 공용 문서\nhttps://회사-my.sharepoint.com/personal/이름_회사_com | 대표 OneDrive"} aria-label="읽을 문서함" disabled={!ms} style={{ fontFamily: "inherit", resize: "vertical" }} />} />
        {msDirty && <p className="set-row-note">연결 확인·문서 색인 갱신은 저장한 뒤에 켜집니다</p>}
        <Result msg={mMsg} />
      </SetCard>

      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} msg={saveMsg} />
    </>
  );
}
