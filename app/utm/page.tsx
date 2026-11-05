"use client";

// UTM 만들기 — 광고·SNS 링크 + CRM 메시지 링크(규칙 자동). 2026-11-06 정적 HTML(iframe) → React 전환.
//  규칙은 app/lib/utm-rules.ts 하나(CRM 엑셀 가져오기 검사와 공유). 설정·히스토리는 /api/utm/*.
//  기획: docs/utm-crm-builder-plan.md (대표 결정 1~7 전부 (가)).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import {
  CRM_MEDIA, CRM_SOURCE, DEFAULT_CONTENT_SLUGS, DEFAULT_SOURCE_MEDIUM_MAP, DEFAULT_URL_PRESETS,
  buildUtmUrl, checkCommon, checkCrmUtm, isTrackedUrl, slugify,
  type CrmButton, type UtmIssue,
} from "@/app/lib/utm-rules";

type Preset = { label: string; value: string };
type MediumMap = Record<string, string[]>;
type Slugs = Record<string, string>;
type Link = { id: string; created_at: string; base_url: string; source: string; medium: string; campaign: string; content: string; term: string; note: string; full_url: string; purpose?: string; crm_campaign?: string };
type Campaign = { campaign: string; medium: string; title: string; active: boolean };
type Mode = "ad" | "crm";

const MODE_KEY = "utm.mode";
const kst = (iso: string) => (iso ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json", ...(init.headers || {}) } : init?.headers });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || "요청 실패");
  return j as T;
}

export default function UtmPage() {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("ad");
  const [presets, setPresets] = useState<Preset[]>(DEFAULT_URL_PRESETS);
  const [mediumMap, setMediumMap] = useState<MediumMap>(DEFAULT_SOURCE_MEDIUM_MAP);
  const [slugs, setSlugs] = useState<Slugs>(DEFAULT_CONTENT_SLUGS);
  const [history, setHistory] = useState<Link[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [tab, setTab] = useState<"history" | "settings">("history");

  useEffect(() => {
    try { const m = localStorage.getItem(MODE_KEY); if (m === "crm" || m === "ad") setMode(m); } catch { /* 저장 안 됨 */ }
  }, []);
  const pickMode = (m: Mode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* 무시 */ } };

  const load = useCallback(async () => {
    setLoadErr("");
    try {
      const s = await api<{ presets: Preset[]; sourceMediumMap: MediumMap; contentSlugs: Slugs }>("/api/utm/settings");
      setPresets(s.presets || []); setMediumMap(s.sourceMediumMap || {}); setSlugs(s.contentSlugs || {});
    } catch (e) { setLoadErr(e instanceof Error ? e.message : "설정을 불러오지 못했습니다. 새로고침하세요"); }
    try { setHistory((await api<{ links: Link[] }>("/api/utm/links")).links || []); } catch { toast.error("히스토리를 불러오지 못했습니다. 새로고침하세요"); }
    try { setCampaigns((await api<{ campaigns: Campaign[] }>("/api/utm/campaigns")).campaigns || []); } catch { /* CRM 표가 없어도 화면은 뜬다 */ }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async (patch: { presets?: Preset[]; sourceMediumMap?: MediumMap; contentSlugs?: Slugs }) => {
    await api("/api/utm/settings", { method: "PUT", body: JSON.stringify(patch) });
  };

  const addLink = async (row: Omit<Link, "id" | "created_at">, dedupe: boolean) => {
    const j = await api<{ link: Link; deduped?: boolean }>("/api/utm/links", {
      method: "POST",
      body: JSON.stringify({ baseUrl: row.base_url, source: row.source, medium: row.medium, campaign: row.campaign, content: row.content, term: row.term, note: row.note, fullUrl: row.full_url, purpose: row.purpose, crmCampaign: row.crm_campaign, dedupe }),
    });
    if (!j.deduped && j.link) setHistory((h) => [j.link, ...h].slice(0, 100));
    return j;
  };

  const copyText = async (text: string, msg = "복사했습니다") => {
    try { await navigator.clipboard.writeText(text); toast.success(msg); } catch { toast.error("복사하지 못했습니다. 주소를 직접 선택해 복사하세요"); }
  };

  return (
    <div className="b2b-container">
      <div className="b2b-page-head">
        <h1 className="b2b-page-title">UTM 만들기</h1>
      </div>
      {loadErr && <div className="b2b-error">{loadErr}</div>}

      <div className="sm-tabbar utm-mode" role="tablist">
        <button className={`sm-tab${mode === "ad" ? " is-active" : ""}`} role="tab" aria-selected={mode === "ad"} onClick={() => pickMode("ad")}>광고·SNS</button>
        <button className={`sm-tab${mode === "crm" ? " is-active" : ""}`} role="tab" aria-selected={mode === "crm"} onClick={() => pickMode("crm")}>CRM 메시지</button>
      </div>

      {mode === "ad" ? (
        <AdMode presets={presets} mediumMap={mediumMap} history={history} onSavePresets={async (p) => { setPresets(p); await saveSettings({ presets: p }); }} addLink={addLink} copyText={copyText} />
      ) : (
        <CrmMode slugs={slugs} campaigns={campaigns} addLink={addLink} copyText={copyText} onLearnSlug={async (k, v) => { const next = { ...slugs, [k]: v }; setSlugs(next); try { await saveSettings({ contentSlugs: next }); } catch { /* 사전 저장 실패는 조용히 */ } }} />
      )}

      <div className="b2b-card" style={{ marginTop: "var(--sm-space-5)" }}>
        <div className="sm-tabbar" role="tablist">
          <button className={`sm-tab${tab === "history" ? " is-active" : ""}`} role="tab" onClick={() => setTab("history")}>생성 기록<span className="sm-tab-count">{history.length}</span></button>
          <button className={`sm-tab${tab === "settings" ? " is-active" : ""}`} role="tab" onClick={() => setTab("settings")}>즐겨찾기·사전</button>
        </div>
        {tab === "history" ? (
          <History history={history} setHistory={setHistory} copyText={copyText} />
        ) : (
          <Settings presets={presets} mediumMap={mediumMap} slugs={slugs} onSave={async (p) => { if (p.presets) setPresets(p.presets); if (p.sourceMediumMap) setMediumMap(p.sourceMediumMap); if (p.contentSlugs) setSlugs(p.contentSlugs); await saveSettings(p); }} />
        )}
      </div>
    </div>
  );
}

// ───────────────────────── 광고·SNS ─────────────────────────
function AdMode({ presets, mediumMap, history, onSavePresets, addLink, copyText }: {
  presets: Preset[]; mediumMap: MediumMap; history: Link[];
  onSavePresets: (p: Preset[]) => Promise<void>;
  addLink: (row: Omit<Link, "id" | "created_at">, dedupe: boolean) => Promise<unknown>;
  copyText: (t: string, msg?: string) => Promise<void>;
}) {
  const toast = useToast();
  const [preset, setPreset] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://");
  const [source, setSource] = useState("");
  const [medium, setMedium] = useState("");
  const [campaign, setCampaign] = useState("");
  const [content, setContent] = useState("");
  const [term, setTerm] = useState("");
  const [note, setNote] = useState("");
  const [qr, setQr] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [askLabel, setAskLabel] = useState(false);
  const lastSaved = useRef("");

  const sources = Object.keys(mediumMap);
  const mediums = mediumMap[source] || [];
  const campaignOptions = useMemo(() => [...new Set(history.map((h) => h.campaign).filter(Boolean))], [history]);
  const issues = useMemo(() => checkCommon({ baseUrl, source, medium, campaign, content, term }), [baseUrl, source, medium, campaign, content, term]);
  const issueOf = (f: string) => issues.find((i) => i.field === f);
  const ready = baseUrl.trim() && baseUrl.trim() !== "https://" && source.trim() && medium.trim();
  const fullUrl = ready ? buildUtmUrl(baseUrl, { source, medium, campaign, content, term }, { forceHttps: false }) : "";
  const alreadySaved = presets.some((p) => p.value === baseUrl.trim());

  const row = (): Omit<Link, "id" | "created_at"> => ({ base_url: baseUrl.trim(), source: source.trim(), medium: medium.trim(), campaign: campaign.trim(), content: content.trim(), term: term.trim(), note: note.trim(), full_url: fullUrl, purpose: "ad", crm_campaign: "" });

  async function copyOnly() {
    if (!fullUrl) return;
    await copyText(fullUrl, "주소를 복사했습니다");
    if (lastSaved.current === fullUrl) return;
    try { await addLink(row(), true); lastSaved.current = fullUrl; } catch { /* 복사는 됐다 */ }
  }
  async function saveAndCopy() {
    if (!fullUrl) return;
    try { await addLink(row(), false); lastSaved.current = fullUrl; await copyText(fullUrl, "기록에 저장하고 주소를 복사했습니다"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "기록에 저장하지 못했습니다. 다시 시도하세요"); }
  }
  async function savePreset() {
    const value = baseUrl.trim();
    if (!value || alreadySaved) return;
    let label = newLabel.trim();
    if (!label) { try { label = new URL(value).hostname; } catch { label = value; } }
    await onSavePresets([...presets, { label, value }]);
    setAskLabel(false); setNewLabel(""); setPreset(value);
    toast.success(`즐겨찾기에 "${label}" 을 추가했습니다`);
  }
  function reset() { setPreset(""); setBaseUrl("https://"); setSource(""); setMedium(""); setCampaign(""); setContent(""); setTerm(""); setNote(""); }

  const field = ({ id, label, value, set, list, req, opt }: { id: string; label: string; value: string; set: (v: string) => void; list?: string; req?: boolean; opt?: string }) => {
    const iss = issueOf(id);
    return (
      <div className="b2b-field">
        <label className="b2b-field-label" htmlFor={`ad-${id}`}>{label}{req && <span className="req">*</span>}{opt && <span className="opt"> {opt}</span>}</label>
        <input id={`ad-${id}`} className="b2b-input" value={value} onChange={(e) => set(e.target.value)} list={list} autoComplete="off" aria-invalid={iss ? true : undefined} />
        {iss && <div className="b2b-field-error">{iss.msg}{iss.fix ? <> <button className="b2b-link-btn" onClick={() => set(iss.fix!)}>고친 값으로</button></> : null}</div>}
      </div>
    );
  };

  return (
    <div className="utm-grid">
      <div className="b2b-form-section utm-form">
        <div className="b2b-field">
          <label className="b2b-field-label" htmlFor="ad-base">기본 주소<span className="req">*</span></label>
          <div className="utm-inline">
            <select className="b2b-input" value={preset} onChange={(e) => { const v = e.target.value; setPreset(v); setBaseUrl(v || "https://"); }} aria-label="랜딩 즐겨찾기">
              <option value="">즐겨찾기</option>
              {presets.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <input id="ad-base" className="b2b-input" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setPreset(""); }} aria-invalid={issueOf("baseUrl") ? true : undefined} />
            {baseUrl.trim() && baseUrl.trim() !== "https://" && !alreadySaved && !askLabel && <button className="b2b-btn-secondary" onClick={() => setAskLabel(true)}>즐겨찾기 추가</button>}
          </div>
          {issueOf("baseUrl") && <div className="b2b-field-error">{issueOf("baseUrl")!.msg} <button className="b2b-link-btn" onClick={() => setBaseUrl(issueOf("baseUrl")!.fix!)}>고친 값으로</button></div>}
          {askLabel && (
            <div className="utm-inline" style={{ marginTop: 6 }}>
              <input className="b2b-input" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="씨몬스터 블로그" aria-label="즐겨찾기 이름" onKeyDown={(e) => { if (e.key === "Enter") savePreset(); }} />
              <button className="b2b-btn-primary" onClick={savePreset}>즐겨찾기 저장</button>
              <button className="b2b-btn-secondary" onClick={() => setAskLabel(false)}>그만두기</button>
            </div>
          )}
        </div>
        <div className="b2b-field">
          <label className="b2b-field-label" htmlFor="ad-source">utm_source<span className="req">*</span><span className="opt"> 유입 채널</span></label>
          <div className="utm-inline">
            <select className="b2b-input" value={sources.includes(source) ? source : ""} onChange={(e) => { setSource(e.target.value); setMedium(""); }} aria-label="소스 선택">
              <option value="">직접 입력</option>
              {sources.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input id="ad-source" className="b2b-input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="naver" aria-invalid={issueOf("source") ? true : undefined} />
          </div>
          {issueOf("source") && <div className="b2b-field-error">{issueOf("source")!.msg} <button className="b2b-link-btn" onClick={() => setSource(issueOf("source")!.fix!)}>고친 값으로</button></div>}
        </div>
        <div className="b2b-field">
          <label className="b2b-field-label" htmlFor="ad-medium">utm_medium<span className="req">*</span><span className="opt"> 매체 유형</span></label>
          <input id="ad-medium" className="b2b-input" value={medium} onChange={(e) => setMedium(e.target.value)} placeholder="cpc" aria-invalid={issueOf("medium") ? true : undefined} />
          {mediums.length > 0 && (
            <div className="utm-chips" role="group" aria-label="추천 매체">
              {mediums.map((m) => <button key={m} type="button" className={`utm-chip${medium === m ? " is-active" : ""}`} onClick={() => setMedium(m)}>{m}</button>)}
            </div>
          )}
          {issueOf("medium") && <div className="b2b-field-error">{issueOf("medium")!.msg} <button className="b2b-link-btn" onClick={() => setMedium(issueOf("medium")!.fix!)}>고친 값으로</button></div>}
        </div>
        {field({ id: "campaign", label: "utm_campaign", value: campaign, set: setCampaign, list: "utm-campaigns", opt: "캠페인명" })}
        <datalist id="utm-campaigns">{campaignOptions.map((c) => <option key={c} value={c} />)}</datalist>
        <div className="b2b-field-row">
          {field({ id: "content", label: "utm_content", value: content, set: setContent, opt: "소재 구분" })}
          {field({ id: "term", label: "utm_term", value: term, set: setTerm, opt: "검색 키워드" })}
        </div>
        <div className="b2b-field">
          <label className="b2b-field-label" htmlFor="ad-note">비고<span className="opt"> 내부 메모</span></label>
          <input id="ad-note" className="b2b-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="4월 인플루언서 협찬" />
        </div>
      </div>

      <div className="b2b-form-section">
        <div className="b2b-form-section-title">완성 주소</div>
        <Preview base={baseUrl} url={fullUrl} empty={!ready ? "기본 주소·utm_source·utm_medium 을 채우면 주소가 만들어집니다" : ""} />
        <div className="utm-actions">
          <button className="b2b-btn-primary" onClick={saveAndCopy} disabled={!fullUrl}>저장하고 복사</button>
          <button className="b2b-btn-secondary" onClick={copyOnly} disabled={!fullUrl}>주소만 복사</button>
          <button className="b2b-btn-secondary" onClick={() => setQr(fullUrl)} disabled={!fullUrl}>QR 보기</button>
          <button className="b2b-link-btn" onClick={reset}>입력 지우기</button>
        </div>
      </div>
      {qr && <QrModal url={qr} onClose={() => setQr("")} copyText={copyText} />}
    </div>
  );
}

function Preview({ base, url, empty }: { base: string; url: string; empty: string }) {
  if (!url) return <div className="utm-preview"><span className="base">{empty || base}</span></div>;
  const [path, q = ""] = url.split("?");
  return (
    <div className="utm-preview">
      <span className="base">{path}</span>{q ? "?" : ""}
      {q.split("&").map((kv, i) => { const [k, v] = kv.split("="); return <span key={i}>{i > 0 ? "&" : ""}<span className="k">{k}</span>=<span className="v">{v}</span></span>; })}
    </div>
  );
}

function QrModal({ url, onClose, copyText }: { url: string; onClose: () => void; copyText: (t: string, msg?: string) => Promise<void> }) {
  const src = (size: number) => `/api/qr?data=${encodeURIComponent(url)}&size=${size}`;
  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="b2b-modal-head"><h2 className="b2b-modal-title">QR</h2><button className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button></div>
        <div className="b2b-modal-body" style={{ textAlign: "center" }}>
          <img src={src(280)} alt="QR" width={260} height={260} style={{ border: "1px solid var(--sm-border)", borderRadius: 8 }} />
          <div className="utm-url" style={{ marginTop: 10, cursor: "default" }}>{url}</div>
          <div className="utm-actions" style={{ justifyContent: "center" }}>
            <a className="b2b-btn-secondary" href={`${src(1024)}&download=1&name=utm`}>PNG 내려받기</a>
            <button className="b2b-btn-secondary" onClick={() => copyText(url, "주소를 복사했습니다")}>주소 복사</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── CRM 메시지 ─────────────────────────
type BtnRow = CrmButton & { key: number };
let seq = 1;
const newRow = (): BtnRow => ({ key: seq++, label: "", url: "", content: "" });

function CrmMode({ slugs, campaigns, addLink, copyText, onLearnSlug }: {
  slugs: Slugs; campaigns: Campaign[];
  addLink: (row: Omit<Link, "id" | "created_at">, dedupe: boolean) => Promise<unknown>;
  copyText: (t: string, msg?: string) => Promise<void>;
  onLearnSlug: (k: string, v: string) => Promise<void>;
}) {
  const toast = useToast();
  const [medium, setMedium] = useState("");
  const [campaign, setCampaign] = useState("");
  const [term, setTerm] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<BtnRow[]>(() => [newRow(), newRow()]);
  const [issues, setIssues] = useState<UtmIssue[] | null>(null); // null = 아직 검사 안 함
  const [results, setResults] = useState<{ label: string; content: string; url: string; tracked: boolean }[] | null>(null);
  const [saving, setSaving] = useState(false);

  const campaignNames = useMemo(() => [...new Set(campaigns.map((c) => c.campaign))], [campaigns]);
  const dup = useMemo(() => {
    const c = campaign.trim(); if (!c) return [];
    return campaigns.filter((x) => x.campaign === c && (!medium || !x.medium || x.medium === medium));
  }, [campaign, medium, campaigns]);
  const campaignSuggest = useMemo(() => (/[가-힣]/.test(campaign) ? slugify(campaign, slugs) : ""), [campaign, slugs]);

  const setRow = (key: number, patch: Partial<BtnRow>) => setRows((rs) => rs.map((r) => {
    if (r.key !== key) return r;
    const next = { ...r, ...patch };
    // 버튼명을 적으면 content 를 사전에서 제안(직접 고친 뒤엔 건드리지 않는다)
    if (patch.label !== undefined && (!r.content || r.content === slugify(r.label, slugs))) next.content = slugify(patch.label, slugs);
    return next;
  }));

  const issueOf = (f: string) => (issues || []).find((i) => i.field === f);
  const input = () => ({ source: CRM_SOURCE, medium, campaign: campaign.trim(), buttons: rows.filter((r) => r.label.trim() || r.url.trim()), term });

  function build() {
    const i = input();
    const found = checkCrmUtm(i);
    setIssues(found);
    if (found.length) { setResults(null); return; }
    setResults(i.buttons.map((b) => {
      const tracked = isTrackedUrl(b.url);
      return { label: b.label.trim() || b.content, content: b.content.trim(), tracked, url: tracked ? buildUtmUrl(b.url, { source: CRM_SOURCE, medium, campaign: i.campaign, content: b.content.trim(), term }) : b.url.trim() };
    }).filter((r) => r.url));
    // 직원이 고친 슬러그는 사전에 남긴다(다음부터 자동 제안)
    for (const b of i.buttons) { const lab = b.label.trim(), c = b.content.trim(); if (lab && c && /[가-힣]/.test(lab) && slugify(lab, slugs) !== c) void onLearnSlug(lab, c); }
  }
  function applyFixes() {
    for (const i of issues || []) {
      if (!i.fix) continue;
      if (i.field === "campaign") setCampaign(i.fix);
      else if (i.field === "term") setTerm(i.fix);
      else { const m = i.field.match(/^button\.(\d+)\.(url|content)$/); if (m) { const b = input().buttons[Number(m[1])]; if (b) setRow((b as BtnRow).key, { [m[2]]: i.fix } as Partial<BtnRow>); } }
    }
    setIssues(null);
  }
  const trackedResults = (results || []).filter((r) => r.tracked);
  const excelCells = () => {
    const urls = trackedResults.map((r) => r.url).join("\n");
    const cell = (s: string) => (/[\t\n"]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s);
    return [cell(urls), campaign.trim(), medium].join("\t");
  };
  async function saveAll() {
    if (!trackedResults.length) return;
    setSaving(true);
    try {
      for (const r of trackedResults) await addLink({ base_url: r.url.split("?")[0], source: CRM_SOURCE, medium, campaign: campaign.trim(), content: r.content, term, note: note.trim(), full_url: r.url, purpose: "crm", crm_campaign: campaign.trim() }, false);
      toast.success(`링크 ${trackedResults.length}개를 기록에 저장했습니다`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "기록에 저장하지 못했습니다. 다시 시도하세요"); }
    setSaving(false);
  }
  const fixable = (issues || []).some((i) => i.fix);
  const btnIndex = (key: number) => input().buttons.findIndex((b) => (b as BtnRow).key === key);

  return (
    <div className="utm-grid">
      <div className="b2b-form-section utm-form">
        <div className="b2b-field">
          <span className="b2b-field-label">발송 수단<span className="req">*</span></span>
          <div className="utm-chips" role="group" aria-label="발송 수단">
            {CRM_MEDIA.map((m) => <button key={m.value} type="button" className={`utm-chip${medium === m.value ? " is-active" : ""}`} onClick={() => setMedium(m.value)}>{m.label}<span className="utm-chip-sub">{m.value}</span></button>)}
          </div>
          {issueOf("medium") && <div className="b2b-field-error">{issueOf("medium")!.msg}</div>}
        </div>
        <div className="b2b-field">
          <label className="b2b-field-label" htmlFor="crm-campaign">캠페인<span className="req">*</span><span className="opt"> utm_campaign · 메시지 하나에 하나</span></label>
          <input id="crm-campaign" className="b2b-input" value={campaign} onChange={(e) => setCampaign(e.target.value)} list="crm-campaigns" autoComplete="off" placeholder="review-30d" aria-invalid={issueOf("campaign") ? true : undefined} />
          <datalist id="crm-campaigns">{campaignNames.map((c) => <option key={c} value={c} />)}</datalist>
          {campaignSuggest && !issueOf("campaign") && <div className="b2b-field-hint">영문 제안: <button className="b2b-link-btn" onClick={() => setCampaign(campaignSuggest)}>{campaignSuggest}</button></div>}
          {issueOf("campaign") && <div className="b2b-field-error">{issueOf("campaign")!.msg}{issueOf("campaign")!.fix ? <> <button className="b2b-link-btn" onClick={() => setCampaign(issueOf("campaign")!.fix!)}>고친 값으로</button></> : null}</div>}
          {dup.length > 0 && <div className="b2b-field-hint">이미 쓰는 캠페인: {dup.map((d) => d.title).join(", ")} — 같은 메시지를 다시 만드는 게 아니면 다른 이름으로</div>}
        </div>
        <div className="b2b-field">
          <span className="b2b-field-label">버튼<span className="req">*</span><span className="opt"> 링크 없는 버튼(채널추가)은 비워 둔다</span></span>
          <div className="utm-btn-rows">
            <div className="utm-btn-row"><span className="utm-btn-head">버튼명</span><span className="utm-btn-head">content</span><span className="utm-btn-head">링크 주소</span><span /></div>
            {rows.map((r) => {
              const idx = btnIndex(r.key);
              const uIss = idx >= 0 ? issueOf(`button.${idx}.url`) : undefined;
              const cIss = idx >= 0 ? issueOf(`button.${idx}.content`) : undefined;
              const ext = r.url.trim() && /^https?:\/\//i.test(r.url) && !isTrackedUrl(r.url);
              return (
                <div key={r.key}>
                  <div className="utm-btn-row">
                    <input className="b2b-input" value={r.label} onChange={(e) => setRow(r.key, { label: e.target.value })} placeholder="쿠폰 사용하기" aria-label="버튼명" />
                    <input className="b2b-input" value={r.content} onChange={(e) => setRow(r.key, { content: e.target.value })} placeholder="coupon" aria-label="utm_content" aria-invalid={cIss ? true : undefined} />
                    <input className="b2b-input utm-btn-url" value={r.url} onChange={(e) => setRow(r.key, { url: e.target.value })} placeholder="https://seamonster.kr/" aria-label="링크 주소" aria-invalid={uIss ? true : undefined} />
                    <button className="b2b-link-btn" onClick={() => setRows((rs) => rs.length > 1 ? rs.filter((x) => x.key !== r.key) : rs)} aria-label="버튼 삭제">삭제</button>
                  </div>
                  {(uIss || cIss || ext) && (
                    <div className="utm-btn-note">
                      {ext && <span className="utm-ext">우리 도메인 밖 — UTM 안 붙임</span>}
                      {cIss && <span className="b2b-field-error"> content: {cIss.msg}{cIss.fix ? <> <button className="b2b-link-btn" onClick={() => setRow(r.key, { content: cIss.fix })}>고친 값으로</button></> : null}</span>}
                      {uIss && <span className="b2b-field-error"> 주소: {uIss.msg}{uIss.fix ? <> <button className="b2b-link-btn" onClick={() => setRow(r.key, { url: uIss.fix })}>고친 값으로</button></> : null}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="utm-btn-add"><button className="b2b-btn-secondary" onClick={() => setRows((rs) => [...rs, newRow()])}>버튼 추가</button></div>
          {issueOf("buttons") && <div className="b2b-field-error" style={{ marginTop: 6 }}>{issueOf("buttons")!.msg}</div>}
        </div>
        <div className="b2b-field-row">
          <div className="b2b-field">
            <span className="b2b-field-label">A/B 변형<span className="opt"> utm_term</span></span>
            <div className="utm-seg" role="group" aria-label="A/B 변형">
              {[["", "없음"], ["a", "a"], ["b", "b"]].map(([v, l]) => <button key={v} type="button" className={`utm-chip${term === v ? " is-active" : ""}`} onClick={() => setTerm(v)}>{l}</button>)}
            </div>
            {issueOf("term") && <div className="b2b-field-error">{issueOf("term")!.msg}</div>}
          </div>
          <div className="b2b-field">
            <label className="b2b-field-label" htmlFor="crm-note">비고<span className="opt"> 메시지명 등</span></label>
            <input id="crm-note" className="b2b-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="1회 구매고객 장기 이탈 방지 (A)" />
          </div>
        </div>
        <div className="utm-actions">
          <button className="b2b-btn-primary" onClick={build}>링크 만들기</button>
          {issues && issues.length > 0 && fixable && <button className="b2b-btn-secondary utm-fix" onClick={applyFixes}>고친 값 전부 적용</button>}
        </div>
        {issues && issues.length > 0 && (
          <div className="b2b-error" style={{ marginTop: 12 }}>
            규칙에 어긋난 곳 {issues.length}건
            <ul>{issues.map((i, k) => <li key={k}>{labelOf(i.field, input().buttons)} — {i.msg}</li>)}</ul>
          </div>
        )}
      </div>

      <div className="b2b-form-section">
        <div className="b2b-form-section-title">완성 링크</div>
        {!results ? (
          <div className="utm-preview"><span className="base">발송 수단·캠페인·버튼을 채우고 [링크 만들기]를 누르면 버튼별 주소가 나옵니다</span></div>
        ) : results.length === 0 ? (
          <div className="b2b-empty">만들 링크가 없습니다.</div>
        ) : (
          <>
            <div className="b2b-table-wrap">
              <table className="b2b-table is-compact">
                <thead><tr><th>버튼</th><th>content</th><th>주소</th><th /></tr></thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td>{r.label}</td>
                      <td>{r.tracked ? r.content : <span className="utm-ext">UTM 없음</span>}</td>
                      <td className="utm-url" title="누르면 복사" onClick={() => copyText(r.url, "주소를 복사했습니다")}>{r.url}</td>
                      <td><button className="b2b-link-btn" onClick={() => copyText(r.url, "주소를 복사했습니다")}>복사</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="utm-actions">
              <button className="b2b-btn-primary" onClick={saveAll} disabled={saving || !trackedResults.length}>{saving ? "저장 중..." : "기록에 저장"}</button>
              <button className="b2b-btn-secondary" onClick={() => copyText(trackedResults.map((r) => r.url).join("\n"), "주소를 전부 복사했습니다")} disabled={!trackedResults.length}>전체 복사</button>
              <button className="b2b-btn-secondary" onClick={() => copyText(excelCells(), "엑셀의 링크 URL 칸에 붙여 넣으세요(캠페인·매체 칸까지 채워집니다)")} disabled={!trackedResults.length}>엑셀 칸으로 복사</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function labelOf(field: string, buttons: CrmButton[]): string {
  const m = field.match(/^button\.(\d+)\.(url|content)$/);
  if (m) { const b = buttons[Number(m[1])]; const name = b?.label?.trim() || `버튼 ${Number(m[1]) + 1}`; return `${name} ${m[2] === "url" ? "주소" : "content"}`; }
  return { source: "utm_source", medium: "발송 수단", campaign: "캠페인", term: "A/B", buttons: "버튼" }[field] || field;
}

// ───────────────────────── 생성 기록 ─────────────────────────
function History({ history, setHistory, copyText }: { history: Link[]; setHistory: (f: (h: Link[]) => Link[]) => void; copyText: (t: string, msg?: string) => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [bulkMsg, setBulkMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? history.filter((h) => [h.campaign, h.source, h.medium, h.note, h.base_url, h.content, h.crm_campaign].some((v) => (v || "").toLowerCase().includes(s))) : history;
  }, [history, q]);

  async function del(id: string) {
    if (!(await confirm({ title: "기록 삭제", body: "팀 공용 기록이라 모두에게서 사라집니다.", action: "기록 삭제" }))) return;
    try { await api(`/api/utm/links?id=${encodeURIComponent(id)}`, { method: "DELETE" }); setHistory((h) => h.filter((x) => x.id !== id)); toast.success("기록을 삭제했습니다"); }
    catch { toast.error("기록을 삭제하지 못했습니다. 다시 시도하세요"); }
  }
  async function clearAll() {
    if (!(await confirm({ title: "기록 전체 삭제", body: `${history.length}건이 모든 사용자에게서 사라집니다. 되돌릴 수 없습니다.`, action: "전체 삭제" }))) return;
    try { await api("/api/utm/links?all=1", { method: "DELETE" }); setHistory(() => []); toast.success("기록을 전부 삭제했습니다"); }
    catch { toast.error("기록을 삭제하지 못했습니다. 다시 시도하세요"); }
  }
  function exportCsv() {
    const cell = (v: string) => `"${(v || "").replace(/"/g, "\"\"")}"`;
    const lines = ["생성일시,용도,기본URL,Source,Medium,Campaign,Content,Term,비고,전체URL", ...history.map((h) => [kst(h.created_at), h.purpose === "crm" ? "CRM" : "광고", h.base_url, h.source, h.medium, h.campaign, h.content, h.term, h.note, h.full_url].map(cell).join(","))];
    download(`씨몬스터_UTM_기록_${today()}.csv`, "﻿" + lines.join("\r\n"));
  }
  function downloadTemplate() {
    const lines = ["기본URL,소스,미디움,캠페인,콘텐트,텀,비고", "https://seamonster.kr,naver,blog,spring-sale,banner-a,새우,예시 행 — 지우고 입력", "https://seamonster.kr/product/123,instagram,social,spring-sale,,,예시 행 — 지우고 입력"];
    download(`씨몬스터_UTM_대량등록_양식_${today()}.csv`, "﻿" + lines.join("\r\n"));
  }
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
    const text = await f.text();
    const grid = parseCsv(text);
    const rows: Record<string, string>[] = []; let missing = 0;
    grid.forEach((c, idx) => {
      const [baseUrl = "", source = "", medium = "", campaign = "", content = "", term = "", note = ""] = c.map((s) => (s || "").trim());
      if (idx === 0 && (baseUrl === "기본URL" || baseUrl.toLowerCase() === "url" || source === "소스")) return;
      if (!baseUrl && !source && !medium && !campaign && !content && !term && !note) return;
      if (!baseUrl || !source || !medium) { missing++; return; }
      rows.push({ baseUrl, source, medium, campaign, content, term, note, fullUrl: buildUtmUrl(baseUrl, { source, medium, campaign, content, term }, { forceHttps: false }) });
    });
    if (!rows.length) { setBulkMsg(`등록할 행이 없습니다${missing ? ` (기본URL·소스·미디움 누락 ${missing}건 제외)` : ""}`); return; }
    if (!(await confirm({ title: `링크 ${rows.length}건 등록`, body: `${f.name} 의 행을 기록에 추가합니다.${missing ? ` 필수값 누락 ${missing}건은 뺍니다.` : ""}`, action: "기록에 추가", danger: false }))) return;
    try {
      const j = await api<{ inserted: number; skipped: number }>("/api/utm/links/import", { method: "POST", body: JSON.stringify({ rows }) });
      setHistory(() => []);
      const fresh = await api<{ links: Link[] }>("/api/utm/links"); setHistory(() => fresh.links || []);
      setBulkMsg(`완료: ${j.inserted}건 추가${j.skipped ? `, ${j.skipped}건 중복 제외` : ""}${missing ? `, 누락 ${missing}건 제외` : ""}`);
      toast.success(`링크 ${j.inserted}건을 추가했습니다`);
    } catch (err) { setBulkMsg(`업로드 실패: ${err instanceof Error ? err.message : ""}`); }
  }

  return (
    <div>
      <div className="utm-history-bar">
        <input className="b2b-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색" aria-label="캠페인·소스·매체·비고 검색" />
        {q && <button className="b2b-link-btn" onClick={() => setQ("")}>조건 지우기</button>}
        <button className="b2b-btn-secondary" onClick={exportCsv} disabled={!history.length}>CSV 내려받기</button>
        <button className="b2b-btn-danger" onClick={clearAll} disabled={!history.length}>전체 삭제</button>
      </div>
      {history.length === 0 ? (
        <div className="b2b-empty">만든 링크가 없습니다.</div>
      ) : shown.length === 0 ? (
        <div className="b2b-empty">조건에 맞는 기록이 없습니다.<div className="b2b-empty-action"><button className="b2b-btn-secondary" onClick={() => setQ("")}>조건 지우기</button></div></div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table is-compact">
            <thead><tr><th>일시</th><th>용도</th><th>source</th><th>medium</th><th>campaign</th><th>content</th><th>비고</th><th>주소</th><th /></tr></thead>
            <tbody>
              {shown.map((h) => (
                <tr key={h.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{kst(h.created_at)}</td>
                  <td><span className="b2b-status-pill">{h.purpose === "crm" ? "CRM" : "광고"}</span></td>
                  <td>{h.source}</td><td>{h.medium}</td><td>{h.campaign}</td><td>{h.content}{h.term ? ` · ${h.term}` : ""}</td>
                  <td className="sm-faint">{h.note}</td>
                  <td className="utm-url" title="누르면 복사" onClick={() => copyText(h.full_url, "주소를 복사했습니다")}>{h.full_url}</td>
                  <td><button className="b2b-link-btn" onClick={() => del(h.id)}>삭제</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="utm-bulk">
        <button className="b2b-btn-secondary" onClick={downloadTemplate}>양식 내려받기 (CSV)</button>
        <button className="b2b-btn-secondary" onClick={() => fileRef.current?.click()}>CSV 로 대량 추가</button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={upload} />
        {bulkMsg && <span>{bulkMsg}</span>}
      </div>
    </div>
  );
}

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8;" }));
  a.download = name; a.click();
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cur = "", inQ = false;
  const t = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) { if (c === "\"") { if (t[i + 1] === "\"") { cur += "\""; i++; } else inQ = false; } else cur += c; }
    else if (c === "\"") inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ───────────────────────── 즐겨찾기·소스·사전 ─────────────────────────
function Settings({ presets, mediumMap, slugs, onSave }: { presets: Preset[]; mediumMap: MediumMap; slugs: Slugs; onSave: (p: { presets?: Preset[]; sourceMediumMap?: MediumMap; contentSlugs?: Slugs }) => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [map, setMap] = useState<MediumMap>(mediumMap);
  const [dict, setDict] = useState<[string, string][]>(Object.entries(slugs));
  const [newSrc, setNewSrc] = useState("");
  const [newMed, setNewMed] = useState<Record<string, string>>({});
  const [newK, setNewK] = useState(""); const [newV, setNewV] = useState("");
  const [pLabel, setPLabel] = useState(""); const [pUrl, setPUrl] = useState("");
  useEffect(() => { setMap(mediumMap); }, [mediumMap]);
  useEffect(() => { setDict(Object.entries(slugs)); }, [slugs]);

  const save = async (p: Parameters<typeof onSave>[0], msg: string) => { try { await onSave(p); toast.success(msg); } catch { toast.error("저장하지 못했습니다. 다시 시도하세요"); } };

  return (
    <div>
      <div className="b2b-form-section" style={{ marginBottom: "var(--sm-space-4)" }}>
        <div className="b2b-form-section-title">랜딩 즐겨찾기</div>
        {presets.length === 0 ? <div className="b2b-empty">저장한 랜딩 주소가 없습니다.</div> : presets.map((p, i) => (
          <div className="utm-preset" key={p.value}>
            <div className="utm-preset-body"><div className="utm-preset-label">{p.label}</div><div className="utm-preset-url">{p.value}</div></div>
            <button className="b2b-link-btn" onClick={() => save({ presets: presets.filter((_, k) => k !== i) }, "즐겨찾기를 삭제했습니다")}>삭제</button>
          </div>
        ))}
        <div className="utm-inline" style={{ marginTop: 8 }}>
          <input className="b2b-input" value={pLabel} onChange={(e) => setPLabel(e.target.value)} placeholder="씨몬스터 블로그" aria-label="즐겨찾기 이름" />
          <input className="b2b-input" value={pUrl} onChange={(e) => setPUrl(e.target.value)} placeholder="https://blog.seamonster.kr" aria-label="주소" />
          <button className="b2b-btn-secondary" onClick={() => { const v = pUrl.trim(); if (!v) return; save({ presets: [...presets, { label: pLabel.trim() || v, value: v }] }, "즐겨찾기를 추가했습니다"); setPLabel(""); setPUrl(""); }}>즐겨찾기 추가</button>
        </div>
      </div>

      <div className="b2b-form-section" style={{ marginBottom: "var(--sm-space-4)" }}>
        <div className="b2b-form-section-title">소스 · 추천 매체 (광고·SNS)</div>
        {Object.keys(map).map((src) => (
          <div className="utm-kw-row" key={src}>
            <div className="utm-kw-src">{src}</div>
            <div>
              <div className="utm-chips">
                {map[src].map((m) => <button key={m} type="button" className="utm-chip" onClick={() => setMap({ ...map, [src]: map[src].filter((x) => x !== m) })} title="누르면 뺀다">{m}<span className="utm-chip-x">✕</span></button>)}
              </div>
              <div className="utm-kw-add">
                <input className="b2b-input" value={newMed[src] || ""} onChange={(e) => setNewMed({ ...newMed, [src]: e.target.value })} placeholder="cpc" aria-label={`${src} 매체 추가`} onKeyDown={(e) => { if (e.key === "Enter") { const v = (newMed[src] || "").trim().toLowerCase(); if (v && !map[src].includes(v)) setMap({ ...map, [src]: [...map[src], v] }); setNewMed({ ...newMed, [src]: "" }); } }} />
                <button className="b2b-btn-secondary" onClick={() => { const v = (newMed[src] || "").trim().toLowerCase(); if (v && !map[src].includes(v)) setMap({ ...map, [src]: [...map[src], v] }); setNewMed({ ...newMed, [src]: "" }); }}>매체 추가</button>
              </div>
            </div>
            <button className="b2b-link-btn" onClick={async () => { if (await confirm({ title: `소스 ${src} 삭제`, body: "추천 매체 목록이 함께 지워집니다.", action: "소스 삭제" })) { const n = { ...map }; delete n[src]; setMap(n); } }}>소스 삭제</button>
          </div>
        ))}
        <div className="utm-kw-add">
          <input className="b2b-input" value={newSrc} onChange={(e) => setNewSrc(e.target.value)} placeholder="threads" aria-label="새 소스" />
          <button className="b2b-btn-secondary" onClick={() => { const v = newSrc.trim().toLowerCase(); if (!v) return; if (map[v]) { toast.error("이미 있는 소스입니다"); return; } setMap({ ...map, [v]: [] }); setNewSrc(""); }}>소스 추가</button>
        </div>
        <div className="utm-settings-foot"><button className="b2b-btn-primary" onClick={() => save({ sourceMediumMap: map }, "소스·매체를 저장했습니다")}>변경 저장</button></div>
      </div>

      <div className="b2b-form-section">
        <div className="b2b-form-section-title">버튼명 → content 사전 (CRM)</div>
        <div className="b2b-field-hint is-block">버튼명에 이 말이 들어 있으면 content 가 자동으로 채워집니다</div>
        {dict.map(([k, v], i) => (
          <div className="utm-dict-row" key={i}>
            <input className="b2b-input" value={k} onChange={(e) => setDict(dict.map((d, j) => (j === i ? [e.target.value, d[1]] : d)))} aria-label="버튼명" />
            <input className="b2b-input" value={v} onChange={(e) => setDict(dict.map((d, j) => (j === i ? [d[0], e.target.value] : d)))} aria-label="content" />
            <button className="b2b-link-btn" onClick={() => setDict(dict.filter((_, j) => j !== i))}>삭제</button>
          </div>
        ))}
        <div className="utm-dict-row">
          <input className="b2b-input" value={newK} onChange={(e) => setNewK(e.target.value)} placeholder="쿠폰" aria-label="새 버튼명" />
          <input className="b2b-input" value={newV} onChange={(e) => setNewV(e.target.value)} placeholder="coupon" aria-label="새 content" />
          <button className="b2b-btn-secondary" onClick={() => { if (!newK.trim() || !newV.trim()) return; setDict([...dict, [newK.trim(), newV.trim().toLowerCase()]]); setNewK(""); setNewV(""); }}>사전에 추가</button>
        </div>
        <div className="utm-settings-foot"><button className="b2b-btn-primary" onClick={() => save({ contentSlugs: Object.fromEntries(dict.filter(([k, v]) => k.trim() && v.trim())) }, "사전을 저장했습니다")}>변경 저장</button></div>
      </div>
    </div>
  );
}
