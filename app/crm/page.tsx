"use client";

// CRM 메시지맵 — 판매 채널(고객군) 세그먼트 + 목록·여정·성과·살펴보기(메시지 하나씩, 2026-11-09) + 드로어. 2026-11-06 개편(docs/crm-map-redesign-plan.md, 대표 결정 1~6 전부 (가)).
//  데이터·API 는 그대로(/api/crm/messages·options·ga-stats·stats). 메시지 편집은 드로어 한 곳.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm, useToast } from "@/app/components/Feedback";
import {
  CrmMessage, CrmMessageInput, EMPTY_CRM_MESSAGE,
  CRM_CHANNEL_LABEL, CRM_CUSTOMER_LABEL, CRM_MSG_TYPE_LABEL, statusKey, isTracked,
  DEFAULT_CRM_OPTIONS, type CrmOption, type CrmOptions,
} from "@/app/lib/crm";
import { matchKoQuery } from "@/app/lib/hangul";
import { qty } from "@/app/lib/format";
import ImportModal from "./ImportModal";
import OptionsModal from "./OptionsModal";
import ListView from "./ListView";
import JourneyView from "./JourneyView";
import WeeklyStats from "./WeeklyStats";
import MessageView from "./MessageView";
import Drawer from "./Drawer";
import type { Channel, GaStat, GaState, Labels, Stage } from "./types";

const VIEW_KEY = "crm.view";
const CH_KEY = "crm.channel";
type View = "list" | "journey" | "perf" | "msg";
const optLabel = (list: CrmOption[], fallback: Record<string, string>) => {
  const m = Object.fromEntries(list.map((o) => [o.key, o.label]));
  return (k: string) => m[k] || fallback[k] || k;
};

export default function CrmPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [messages, setMessages] = useState<CrmMessage[]>([]);
  const [datesSupported, setDatesSupported] = useState(true);
  const [fieldsSupported, setFieldsSupported] = useState(true);
  const [triggersSupported, setTriggersSupported] = useState(true);
  const [solapiTpls, setSolapiTpls] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("list");
  const [channel, setChannel] = useState<Channel>("");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<CrmMessageInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [ga, setGa] = useState<GaState | null>(null);
  const [opts, setOpts] = useState<CrmOptions>(DEFAULT_CRM_OPTIONS);
  const [showOpts, setShowOpts] = useState(false);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY); if (v === "list" || v === "journey" || v === "perf" || v === "msg") setView(v);
      const c = localStorage.getItem(CH_KEY); if (c != null) setChannel(c);
    } catch { /* 저장 안 됨 */ }
    fetch("/api/crm/stats/solapi", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) setSolapiTpls(j.templates || []); }).catch(() => {});
    (async () => { try { const j = await (await fetch("/api/crm/options", { cache: "no-store" })).json(); if (j.ok && j.options) setOpts(j.options); } catch { /* 기본값 */ } })();
  }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* 무시 */ } };
  const pickChannel = (c: Channel) => { setChannel(c); try { localStorage.setItem(CH_KEY, c); } catch { /* 무시 */ } };

  const labels = useMemo<Labels>(() => ({
    ch: optLabel(opts.channels, CRM_CHANNEL_LABEL),
    cust: optLabel(opts.customers, CRM_CUSTOMER_LABEL),
    type: optLabel(opts.msgTypes, CRM_MSG_TYPE_LABEL),
  }), [opts]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/crm/messages", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "메시지를 불러오지 못했습니다. [다시 불러오기]를 누르세요");
      setMessages(((j.messages || []) as CrmMessage[]).map((m) => ({ ...m, start_date: m.start_date || "", end_date: m.end_date || "", customer: m.customer || "", msg_type: m.msg_type || "" })));
      setDatesSupported(j.datesSupported !== false); setFieldsSupported(j.fieldsSupported !== false); setTriggersSupported(j.triggersSupported !== false);
    } catch (e) { setError(e instanceof Error ? e.message : "메시지를 불러오지 못했습니다. [다시 불러오기]를 누르세요"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // GA 성과(90일) — utm_campaign 이 달린 메시지가 있을 때만 1회
  const allCampaigns = useMemo(() => [...new Set(messages.map((m) => (m.links?.utm_campaign || "").trim()).filter(Boolean))], [messages]);
  const allKey = allCampaigns.join(",");
  useEffect(() => {
    if (!allKey) { setGa(null); return; }
    let alive = true;
    (async () => {
      try { const j = await (await fetch(`/api/crm/ga-stats?campaigns=${encodeURIComponent(allKey)}`, { cache: "no-store" })).json(); if (alive && j.ok) setGa({ configured: !!j.configured, stats: j.stats || {} }); }
      catch { /* 부가 정보 */ }
    })();
    return () => { alive = false; };
  }, [allKey]);
  const gaOf = useCallback((m: CrmMessage): GaStat | undefined => { const c = (m.links?.utm_campaign || "").trim(); return c ? ga?.stats?.[c] : undefined; }, [ga]);

  // 세그먼트(판매 채널 = 고객군) + 검색
  const byChannel = useMemo(() => messages.filter((m) => !channel || m.customer === channel), [messages, channel]);
  const filtered = useMemo(() => {
    const q = search.trim();
    return q ? byChannel.filter((m) => matchKoQuery([m.title, m.stage, m.sub, m.timing, m.offset_note, m.tags, m.links?.utm_campaign || ""].filter(Boolean).join(" "), q)) : byChannel;
  }, [byChannel, search]);
  const stages: Stage[] = useMemo(() => {
    const map = new Map<string, Stage>();
    for (const m of filtered) {
      const key = m.stage || "(미분류)";
      if (!map.has(key)) map.set(key, { stage: key, sub: m.sub, stage_num: m.stage_num, msgs: [] });
      const s = map.get(key)!; if (!s.sub && m.sub) s.sub = m.sub; s.msgs.push(m);
    }
    return [...map.values()].sort((a, b) => a.stage_num - b.stage_num || a.stage.localeCompare(b.stage, "ko"));
  }, [filtered]);
  const kpi = useMemo(() => {
    const active = byChannel.filter((m) => statusKey(m.status) === "active").length;
    const tracked = byChannel.filter(isTracked).length;
    const sessions = byChannel.reduce((n, m) => n + (gaOf(m)?.sessions ?? 0), 0);
    return { total: byChannel.length, active, tracked, sessions };
  }, [byChannel, gaOf]);
  const channelCounts = useMemo(() => { const c: Record<string, number> = {}; for (const m of messages) c[m.customer || ""] = (c[m.customer || ""] || 0) + 1; return c; }, [messages]);
  const stageNames = useMemo(() => [...new Set(messages.map((m) => m.stage).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")), [messages]);

  function openNew(seed?: Partial<CrmMessageInput>) {
    const maxStageNum = messages.reduce((mx, m) => Math.max(mx, m.stage_num), 0);
    setEdit({ ...EMPTY_CRM_MESSAGE, stage_num: maxStageNum, customer: channel, ...seed });
  }
  const openEdit = (m: CrmMessage) => setEdit({ ...m, links: { ...m.links }, perf: { ...m.perf } });

  async function save() {
    if (!edit) return;
    if (!edit.title.trim()) { toast.error("메시지명을 입력하세요"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/crm/messages", { method: edit.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edit) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "메시지를 저장하지 못했습니다. 입력값을 확인하세요");
      setEdit(null); toast.success(edit.id ? "메시지를 저장했습니다" : "메시지를 등록했습니다"); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "메시지를 저장하지 못했습니다. 입력값을 확인하세요"); }
    setSaving(false);
  }
  async function remove(id?: string) {
    if (!id) { setEdit(null); return; }
    if (!(await confirm({ title: "메시지 삭제", body: "이 메시지가 CRM 맵에서 지워집니다. 되돌릴 수 없습니다.", action: "메시지 삭제" }))) return;
    setSaving(true);
    try { await fetch("/api/crm/messages?id=" + encodeURIComponent(id), { method: "DELETE" }); setEdit(null); toast.success("메시지를 삭제했습니다"); load(); }
    catch { toast.error("메시지를 삭제하지 못했습니다. 다시 시도하세요"); }
    setSaving(false);
  }

  const gaForEdit = edit?.id ? gaOf(messages.find((m) => m.id === edit.id) as CrmMessage) : undefined;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">CRM 메시지맵</h1></div>
        <div className="b2b-page-actions sm-row sm-gap-2">
          <button className="b2b-btn-primary" onClick={() => openNew()}>메시지 추가</button>
          <button className="b2b-btn-secondary" onClick={() => setShowImport(true)}>엑셀로 가져오기</button>
          {messages.length > 0 && <a className="b2b-btn-secondary crm-xlsx-btn" href="/api/crm/export">엑셀 내려받기</a>}
          <button className="b2b-btn-secondary" onClick={() => setShowOpts(true)}>선택지 관리하기</button>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "다시 불러오기"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {view !== "perf" && view !== "msg" && (
      <div className="crm-kpis">
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">메시지</div><div className="b2b-stat-card-value">{qty(kpi.total)}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">활성</div><div className="b2b-stat-card-value">{qty(kpi.active)}</div>{kpi.total - kpi.active > 0 && <div className="b2b-stat-card-hint">비활성 {qty(kpi.total - kpi.active)}</div>}</div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">추적(UTM)</div><div className="b2b-stat-card-value">{qty(kpi.tracked)}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">GA 세션 90일</div><div className="b2b-stat-card-value">{ga ? qty(kpi.sessions) : "-"}</div>{ga && ga.configured === false && <div className="b2b-stat-card-hint">GA 연동 없음</div>}</div>
      </div>
      )}

      <div className="crm-bar">
        <div className="sm-tabs" role="tablist" aria-label="판매 채널">
          <button className={`sm-tab${channel === "" ? " is-active" : ""}`} role="tab" onClick={() => pickChannel("")}>전체<span className="sm-tab-count">{qty(messages.length)}</span></button>
          {opts.customers.map((c) => (
            <button key={c.key} className={`sm-tab${channel === c.key ? " is-active" : ""}`} role="tab" onClick={() => pickChannel(c.key)}>{c.label}<span className="sm-tab-count">{qty(channelCounts[c.key] || 0)}</span></button>
          ))}
        </div>
        <span className="crm-bar-gap" />
        <div className="sm-tabs" role="tablist" aria-label="보기">
          <button className={`sm-tab${view === "list" ? " is-active" : ""}`} role="tab" onClick={() => pickView("list")}>목록</button>
          <button className={`sm-tab${view === "journey" ? " is-active" : ""}`} role="tab" onClick={() => pickView("journey")}>여정</button>
          <button className={`sm-tab${view === "perf" ? " is-active" : ""}`} role="tab" onClick={() => pickView("perf")}>성과</button>
          <button className={`sm-tab${view === "msg" ? " is-active" : ""}`} role="tab" onClick={() => pickView("msg")}>살펴보기</button>
        </div>
        <span className="crm-bar-spacer" />
        {view !== "perf" && view !== "msg" && <input className="b2b-input crm-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="검색" aria-label="메시지·단계·캠페인 검색" />}
      </div>

      {loading ? <div className="b2b-loading">불러오는 중...</div>
        : messages.length === 0 ? (
          <div className="b2b-empty">등록된 메시지가 없습니다.<div className="b2b-empty-action"><button className="b2b-btn-secondary" onClick={() => setShowImport(true)}>엑셀로 가져오기</button></div></div>
        ) : view === "perf" ? (
          <WeeklyStats channel={channel} />
        ) : view === "msg" ? (
          byChannel.length === 0 ? <div className="b2b-empty">이 채널에 메시지가 없습니다.</div> : <MessageView msgs={byChannel} labels={labels} onOpen={openEdit} />
        ) : filtered.length === 0 ? (
          <div className="b2b-empty">조건에 맞는 메시지가 없습니다.<div className="b2b-empty-action"><button className="b2b-btn-secondary" onClick={() => { setSearch(""); pickChannel(""); }}>조건 지우기</button></div></div>
        ) : view === "journey" ? (
          <JourneyView msgs={filtered} onOpen={openEdit} />
        ) : (
          <ListView stages={stages} labels={labels} gaOf={gaOf} onOpen={openEdit} onAdd={(s) => openNew({ stage: s.stage, sub: s.sub, stage_num: s.stage_num })} />
        )}

      {edit && (
        <Drawer data={edit} onChange={setEdit} onClose={() => setEdit(null)} onSave={save} onDelete={() => remove(edit.id)} saving={saving}
          datesSupported={datesSupported} fieldsSupported={fieldsSupported} triggersSupported={triggersSupported} solapiTpls={solapiTpls} opts={opts} labels={labels} ga={gaForEdit} stageNames={stageNames} />
      )}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={() => { load(); }} />}
      {showOpts && <OptionsModal current={opts} onClose={() => setShowOpts(false)} onSaved={(o) => { setOpts(o); setShowOpts(false); }} />}
    </div>
  );
}
