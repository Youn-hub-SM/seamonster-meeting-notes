"use client";

import { useEffect, useState } from "react";
import { qtyText } from "@/app/lib/format";
import { OnOff, Pill, SetCard, SetRow, SaveBar, useDraft, useReportDirty, api, errText, hhmm, type Msg, type SectionProps } from "../ui";

// AI — AI 비서(켜기·월 상한) · 공통·기능별 모델 · 프롬프트(회의록·CS) · 비서 피드백·조회 범위(읽기 전용).
//  공지 작성기 톤 프롬프트는 공지 작성기 화면 안에서 편집한다(작성하면서 바로 보는 값이라).

type ModelKey = "haiku" | "sonnet" | "opus" | "fable";
type FeatureVal = ModelKey | "inherit";
type Option = { key: ModelKey; label: string; price: string };
type FeatureMeta = { key: string; label: string; inheritDefault?: ModelKey };
type Models = { global: ModelKey; features: Record<string, FeatureVal> };
type Asst = { off: boolean; cap: string };
type Prompt = { text: string; def: string };

export default function AiSection({ onDirty }: SectionProps) {
  const [err, setErr] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [meta, setMeta] = useState<FeatureMeta[]>([]);
  const models = useDraft<Models>(null);
  const asst = useDraft<Asst>(null);
  const [usage, setUsage] = useState<{ usd: number; questions: number } | null>(null);
  const meeting = useDraft<Prompt>(null);
  const cs = useDraft<Prompt>(null);
  const guide = useDraft<Prompt>(null); // 비서 지침(2026-10-27 지식 통합 — 동작 규칙만. 회사 지식은 셰어포인트 [비서] 페이지)
  const [knowledge, setKnowledge] = useState<{ core: { title: string; chars: number; included: boolean }[]; toc: number; chars: number; note: string } | null>(null);
  const [fb, setFb] = useState<{ good: number; bad: number; recentBad: { id: string; user_name: string; note: string; created_at: string }[] } | null>(null);
  const [audit, setAudit] = useState<{ fromDb: boolean; visible: number; noComment: string[]; jsonbNoComment: string[]; pii: { table: string; column: string }[] } | null>(null);
  const [capErr, setCapErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<Msg | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [m, a, mp, cp, gp] = await Promise.all([
          api<{ options: Option[]; featureMeta: FeatureMeta[]; global: ModelKey; features: Record<string, FeatureVal> }>("/api/b2b/settings/model"),
          api<{ off: boolean; capUsd: number; month: { usd: number; questions: number } }>("/api/b2b/settings/assistant"),
          api<{ prompt: string; default: string }>("/api/b2b/settings/meeting-prompt"),
          api<{ prompt: string; default: string }>("/api/b2b/settings/cs-prompt"),
          api<{ prompt: string; default: string; knowledge: { core: { title: string; chars: number; included: boolean }[]; toc: number; chars: number; note: string } }>("/api/b2b/settings/assistant-prompt"),
        ]);
        setOptions(m.options || []); setMeta(m.featureMeta || []);
        models.load({ global: m.global, features: m.features || {} });
        asst.load({ off: !!a.off, cap: String(Number(a.capUsd) || 0) }); setUsage({ usd: Number(a.month?.usd) || 0, questions: Number(a.month?.questions) || 0 });
        meeting.load({ text: mp.prompt || "", def: mp.default || "" });
        cs.load({ text: cp.prompt || "", def: cp.default || "" });
        guide.load({ text: gp.prompt || "", def: gp.default || "" }); setKnowledge(gp.knowledge || null);
      } catch (e) { setErr(errText(e, "AI 설정을 불러오지 못했습니다. 새로고침하세요")); }
    })();
    fetch("/api/report/feedback?stats=1", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j?.ok) setFb({ good: j.good, bad: j.bad, recentBad: j.recentBad || [] }); }).catch(() => {});
    fetch("/api/report/schema-audit", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j?.ok) setAudit({ fromDb: j.fromDb, visible: j.visible, noComment: j.noComment || [], jsonbNoComment: j.jsonbNoComment || [], pii: j.pii || [] }); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = models.dirty || asst.dirty || meeting.dirty || cs.dirty || guide.dirty;
  useReportDirty(dirty, onDirty);
  const reset = () => { models.reset(); asst.reset(); meeting.reset(); cs.reset(); guide.reset(); setCapErr(""); setSaveMsg(null); };

  async function save() {
    if (asst.dirty && asst.draft) {
      const n = Number(asst.draft.cap);
      if (asst.draft.cap.trim() === "" || !Number.isFinite(n) || n <= 0 || n > 10000) { setCapErr("1~10,000 사이 숫자를 넣으세요"); return; }
    }
    setCapErr(""); setSaving(true); setSaveMsg(null);
    try {
      if (models.dirty && models.draft && models.saved) {
        if (models.draft.global !== models.saved.global) await api("/api/b2b/settings/model", "PUT", { scope: "global", key: models.draft.global });
        for (const f of meta) {
          const a = models.draft.features[f.key] ?? "inherit", b = models.saved.features[f.key] ?? "inherit";
          if (a !== b) await api("/api/b2b/settings/model", "PUT", { scope: f.key, key: a });
        }
        models.load(models.draft);
      }
      if (asst.dirty && asst.draft && asst.saved) {
        const patch: { off?: boolean; capUsd?: number } = {};
        if (asst.draft.off !== asst.saved.off) patch.off = asst.draft.off;
        if (asst.draft.cap !== asst.saved.cap) patch.capUsd = Number(asst.draft.cap);
        await api("/api/b2b/settings/assistant", "PUT", patch);
        asst.load(asst.draft);
      }
      // 프롬프트 — 기본값과 같으면 빈 값으로 저장(= 기본값을 따름, 기본이 바뀌면 같이 바뀐다)
      for (const [p, url] of [[meeting, "/api/b2b/settings/meeting-prompt"], [cs, "/api/b2b/settings/cs-prompt"], [guide, "/api/b2b/settings/assistant-prompt"]] as const) {
        if (p.dirty && p.draft) {
          const j = await api<{ prompt: string }>(url, "PUT", { prompt: p.draft.text === p.draft.def ? "" : p.draft.text });
          p.load({ text: j.prompt || "", def: p.draft.def });
        }
      }
      setSaveMsg({ ok: true, text: `저장했습니다 (${hhmm()})` });
    } catch (e) { setSaveMsg({ ok: false, text: errText(e, "저장하지 못했습니다. 다시 누르세요") }); }
    setSaving(false);
  }

  const md = models.draft;
  const a = asst.draft;
  const globalLabel = options.find((o) => o.key === md?.global)?.label ?? md?.global ?? "";
  const label = (k: string) => options.find((x) => x.key === k)?.label ?? k;

  return (
    <>
      {err && <div className="b2b-error">{err}</div>}

      <SetCard title="AI 비서" pill={!a ? null : a.off ? <Pill state="off">꺼짐</Pill> : <Pill state="on">켜짐</Pill>}
        desc={usage ? `이달 사용 ${qtyText(usage.questions, "건")} · 약 $${usage.usd.toFixed(2)}` : undefined}>
        {!a ? (!err && <div className="b2b-loading">불러오는 중...</div>) : (
          <>
            <SetRow label="AI 비서" desc="끄면 누구도 질문할 수 없습니다"
              control={<OnOff label="AI 비서" value={!a.off} onChange={(v) => asst.setDraft({ ...a, off: !v })} />} />
            <SetRow label="월 상한(USD)" desc="넘으면 빠른 모델로 답합니다"
              control={<span className="sm-col" style={{ gap: "var(--sm-space-1)", alignItems: "flex-end" }}>
                <input className="b2b-input set-num" type="number" min={1} step={1} value={a.cap} aria-label="월 상한(USD)" aria-invalid={capErr ? "true" : undefined}
                  onChange={(e) => { asst.setDraft({ ...a, cap: e.target.value }); if (capErr) setCapErr(""); }} />
                {capErr && <span className="b2b-field-error">{capErr}</span>}
              </span>} />
          </>
        )}
      </SetCard>

      <SetCard title="AI 모델" desc="공통 모델은 기능별로 따로 고르지 않은 곳에 씁니다.">
        {!md ? (!err && <div className="b2b-loading">불러오는 중...</div>) : (
          <>
            <SetRow label="공통 기본 모델"
              control={<select className="b2b-select set-select" value={md.global} onChange={(e) => models.setDraft({ ...md, global: e.target.value as ModelKey })} aria-label="공통 기본 모델">
                {options.map((o) => <option key={o.key} value={o.key}>{o.label} · {o.price} / 1M 토큰</option>)}
              </select>} />
            {meta.map((f) => (
              <SetRow key={f.key} label={f.label}
                control={<select className="b2b-select set-select" value={md.features[f.key] ?? "inherit"} aria-label={`${f.label} 모델`}
                  onChange={(e) => models.setDraft({ ...md, features: { ...md.features, [f.key]: e.target.value as FeatureVal } })}>
                  <option value="inherit">{f.inheritDefault ? `기본 (${label(f.inheritDefault)})` : `공통 따름 (지금 ${globalLabel})`}</option>
                  {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>} />
            ))}
          </>
        )}
      </SetCard>

      {([["비서 지침", "AI 비서의 동작 규칙(역할·대화법·도구 사용법·SQL·판단·표기). 회사 기준·금액·담당자·용어는 여기 적지 말고 셰어포인트 매뉴얼의 '[비서]' 페이지에 적습니다 — 아래 현황의 페이지가 매 대화에 그대로 붙습니다.", guide], ["회의록 정리 프롬프트", "팀원 정보·회사 맥락·출력 형식(JSON)은 자동으로 덧붙습니다 — 넣지 마세요.", meeting], ["CS 응대 코칭 프롬프트", "AI 비서가 고객 문의 응대를 코칭할 때 쓰는 지침(코칭 방식). 응대 기준·보상 금액은 셰어포인트 매뉴얼의 '[비서] CS'·'CS 보상·판정 기준' 페이지에서 자동으로 덧붙고, 공지문 말투는 '[비서] 공지문 작성 기준' 페이지를 읽습니다 — 여기엔 넣지 마세요.", cs]] as const).map(([title, desc, p]) => (
        <SetCard key={title} title={title} desc={desc}
          pill={p.draft ? (p.draft.text === p.draft.def || !p.draft.text ? <Pill state="off">기본값</Pill> : <Pill state="warn">바꿔 씀</Pill>) : undefined}
          actions={p.draft ? <button type="button" className="b2b-btn-secondary" disabled={p.draft.text === p.draft.def} onClick={() => p.setDraft({ ...p.draft!, text: p.draft!.def })}>기본값으로</button> : undefined}>
          {p.draft && (
            <>
              <textarea className="b2b-textarea set-prompt" value={p.draft.text} spellCheck={false} aria-label={title} onChange={(e) => p.setDraft({ ...p.draft!, text: e.target.value })} />
              <p className="set-row-note">{qtyText(p.draft.text.length, "자")} · 모든 사용자 공용</p>
              {p === guide && knowledge && (
                <p className="set-row-note">매뉴얼 핵심 페이지 {qtyText(knowledge.core.length, "개")}({qtyText(knowledge.chars, "자")} 탑재, 상한 20,000자) · 목차 {qtyText(knowledge.toc, "페이지")}{knowledge.core.length ? ` — ${knowledge.core.map((c) => `${c.title}${c.included ? "" : "(제외)"}`).join(", ")}` : " — 제목이 '[비서]'로 시작하는 페이지가 없습니다"}{knowledge.note ? ` · ${knowledge.note}` : ""}</p>
              )}
            </>
          )}
        </SetCard>
      ))}

      {fb && (
        <SetCard title="AI 비서 피드백 (30일)" desc={`맞아요 ${qtyText(fb.good, "건")} · 틀려요 ${qtyText(fb.bad, "건")}`}>
          {fb.recentBad.length === 0 ? <div className="b2b-empty">'틀려요' 사유가 아직 없습니다.</div> : (
            <ul className="set-list">{fb.recentBad.map((r) => <li key={r.id}>{r.note} <span className="sm-faint">· {r.user_name} · {String(r.created_at).slice(0, 10)}</span></li>)}</ul>
          )}
        </SetCard>
      )}

      {audit && (
        <SetCard title="AI 비서 조회 범위" desc={`보이는 표·뷰 ${qtyText(audit.visible, "개")}${audit.fromDb ? "" : " · DB 설명 조회 실패(손 설명으로 동작)"}`}>
          {audit.pii.length > 0 && <div className="sm-warn">개인정보·비밀로 의심되는 컬럼이 막히지 않은 표에 있습니다 — 확인하고 필요하면 BLOCKED_RELATIONS 에 넣으세요: {audit.pii.map((x) => `${x.table}.${x.column}`).join(", ")}</div>}
          <ul className="set-list">
            <li>설명 없는 표 {qtyText(audit.noComment.length, "개")}{audit.noComment.length ? `: ${audit.noComment.slice(0, 12).join(", ")}${audit.noComment.length > 12 ? " …" : ""}` : ""}</li>
            <li>설명 없는 jsonb 컬럼 {qtyText(audit.jsonbNoComment.length, "개")}{audit.jsonbNoComment.length ? `: ${audit.jsonbNoComment.slice(0, 12).join(", ")}${audit.jsonbNoComment.length > 12 ? " …" : ""}` : ""} — 설명이 없으면 비서가 그 안의 값을 풀어 보지 못합니다</li>
          </ul>
        </SetCard>
      )}

      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} msg={saveMsg} />
    </>
  );
}
