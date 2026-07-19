"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CrmMessage, CrmMessageInput, CrmPerf, EMPTY_CRM_MESSAGE,
  CRM_CHANNELS, CRM_CHANNEL_LABEL, CRM_STATUSES, CRM_STATUS_LABEL, CRM_LINK_TYPES, crmTags,
} from "@/app/lib/crm";

// 색은 전부 b2b.css 의 .crm-* 클래스(채널 팔레트·시맨틱 토큰) — 인라인 hex 금지.
const CH_KEYS = new Set(CRM_CHANNELS.map((c) => c.key));
const ST_KEYS = new Set(CRM_STATUSES.map((s) => s.key));
const chipCls = (k: string) => `crm-chip ${CH_KEYS.has(k) ? `crm-ch-${k}` : ""}`;
const dotCls = (st: string) => `crm-dot ${ST_KEYS.has(st) ? `is-${st}` : ""}`;
const stSelCls = (st: string) => `b2b-status-select ${ST_KEYS.has(st) ? `crm-stsel-${st}` : ""}`;
const chSelCls = (k: string) => `b2b-status-select ${CH_KEYS.has(k) ? `crm-chsel-${k}` : ""}`;

// 성과 한 줄 요약 — 값이 있는 지표만.
const wonCompact = (n: number) => (n >= 10000 ? `${(n / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}만원` : `${n.toLocaleString("ko-KR")}원`);
function perfLine(p?: CrmPerf): string {
  if (!p) return "";
  const parts: string[] = [];
  if (p.sent) parts.push(`발송 ${p.sent.toLocaleString("ko-KR")}`);
  if (p.opened) parts.push(`열람 ${p.opened.toLocaleString("ko-KR")}`);
  if (p.clicked) parts.push(`클릭 ${p.clicked.toLocaleString("ko-KR")}`);
  if (p.converted) parts.push(`전환 ${p.converted.toLocaleString("ko-KR")}`);
  if (p.revenue) parts.push(wonCompact(p.revenue));
  return parts.join(" · ");
}

// GA 성과(utm_campaign 세션 귀속, 최근 90일) 한 줄 — 카드에 자동 표시.
type GaStat = { sessions: number; users: number; purchases: number; revenue: number };
type GaState = { configured: boolean; stats: Record<string, GaStat> };
function gaLine(g?: GaStat): string {
  if (!g) return "";
  const parts = [`세션 ${g.sessions.toLocaleString("ko-KR")}`];
  if (g.purchases) parts.push(`구매 ${g.purchases.toLocaleString("ko-KR")}`);
  if (g.revenue) parts.push(wonCompact(g.revenue));
  return parts.join(" · ");
}

type Stage = { stage: string; sub: string; stage_num: number; msgs: CrmMessage[] };

export default function CrmPage() {
  const [messages, setMessages] = useState<CrmMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"board" | "flow" | "table">("board");
  const [search, setSearch] = useState("");
  const [chFilter, setChFilter] = useState("");

  const [edit, setEdit] = useState<CrmMessageInput | null>(null);
  const [saving, setSaving] = useState(false);

  const [savingId, setSavingId] = useState<string | null>(null);
  const [ga, setGa] = useState<GaState | null>(null);
  const messagesRef = useRef<CrmMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // GA 성과 — utm_campaign 이 달린 메시지가 있을 때만 조회. 실패해도 화면은 수동 perf 로 동작.
  const campaigns = useMemo(
    () => [...new Set(messages.map((m) => (m.links?.utm_campaign || "").trim()).filter(Boolean))],
    [messages],
  );
  const campaignsKey = campaigns.join(","); // 문자열 키 — 내용이 같으면 재조회하지 않음(인라인 저장마다 배열 참조가 바뀌므로)
  useEffect(() => {
    if (!campaignsKey) { setGa(null); return; }
    let alive = true;
    (async () => {
      try {
        const j = await (await fetch(`/api/crm/ga-stats?campaigns=${encodeURIComponent(campaignsKey)}`, { cache: "no-store" })).json();
        if (alive && j.ok) setGa({ configured: !!j.configured, stats: j.stats || {} });
      } catch { /* GA는 부가 정보 — 실패는 조용히 */ }
    })();
    return () => { alive = false; };
  }, [campaignsKey]);
  const gaOf = useCallback((m: CrmMessage): GaStat | undefined => {
    const c = (m.links?.utm_campaign || "").trim();
    return c ? ga?.stats?.[c] : undefined;
  }, [ga]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/crm/messages", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setMessages(j.messages || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // ── 인라인 편집 ── 인라인으로 고치는 필드는 전부 문자열(스테이지·제목·시점·태그·채널·상태).
  //  타이핑 중엔 로컬만 갱신(setStr), 저장은 blur/select-change 때 해당 행 전체를 PUT.
  const setStr = (id: string, key: keyof CrmMessage, value: string) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? ({ ...m, [key]: value } as CrmMessage) : m)));

  // override = select 처럼 로컬 반영(비동기) 전에 저장할 때 새 값을 주입.
  const saveRow = useCallback(async (id: string, override?: Partial<CrmMessage>) => {
    const base = messagesRef.current.find((m) => m.id === id);
    if (!base) return;
    const row = override ? { ...base, ...override } : base;
    setSavingId(id); setError("");
    try {
      const r = await fetch("/api/crm/messages", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(row) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setMessages((prev) => prev.map((m) => (m.id === id ? (j.message as CrmMessage) : m))); // 서버 정규화 결과로 교체
    } catch (e) { setError(e instanceof Error ? e.message : "저장 오류"); load(); } // 실패 시 서버 상태로 재동기
    setSavingId(null);
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return messages.filter((m) => {
      if (chFilter && m.channel !== chFilter) return false;
      if (!q) return true;
      return [m.title, m.stage, m.sub, m.timing, m.detail, m.tags].some((s) => (s || "").toLowerCase().includes(q));
    });
  }, [messages, search, chFilter]);

  const stages: Stage[] = useMemo(() => {
    const map = new Map<string, Stage>();
    for (const m of filtered) {
      const key = m.stage || "(미분류)";
      if (!map.has(key)) map.set(key, { stage: key, sub: m.sub, stage_num: m.stage_num, msgs: [] });
      const s = map.get(key)!;
      if (!s.sub && m.sub) s.sub = m.sub;
      s.msgs.push(m);
    }
    return [...map.values()].sort((a, b) => a.stage_num - b.stage_num || a.stage.localeCompare(b.stage, "ko"));
  }, [filtered]);

  const summary = useMemo(() => {
    const total = messages.length;
    const active = messages.filter((m) => m.status === "active").length;
    const gap = messages.filter((m) => m.status === "gap").length;
    const byCh: Record<string, number> = {};
    for (const m of messages) byCh[m.channel] = (byCh[m.channel] || 0) + 1;
    const stageCount = new Set(messages.map((m) => m.stage || "(미분류)")).size;
    return { total, active, gap, byCh, stageCount };
  }, [messages]);

  // 스테이지 자동완성 목록 — 인라인 편집 시 오타로 새 스테이지가 생기지 않게 기존값 제안.
  const stageNames = useMemo(
    () => [...new Set(messages.map((m) => m.stage).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    [messages],
  );

  function openNew(seed?: Partial<CrmMessageInput>) {
    const maxStageNum = messages.reduce((mx, m) => Math.max(mx, m.stage_num), 0);
    setEdit({ ...EMPTY_CRM_MESSAGE, stage_num: maxStageNum, ...seed });
  }
  function openEdit(m: CrmMessage) {
    setEdit({ ...m, links: { ...m.links }, perf: { ...m.perf } });
  }

  async function save() {
    if (!edit) return;
    setSaving(true); setError("");
    try {
      const method = edit.id ? "PUT" : "POST";
      const r = await fetch("/api/crm/messages", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(edit) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setEdit(null); load();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 오류"); }
    setSaving(false);
  }
  async function remove(id?: string) {
    if (!id) { setEdit(null); return; }
    if (!confirm("이 메시지를 삭제할까요?")) return;
    setSaving(true);
    try {
      await fetch("/api/crm/messages?id=" + encodeURIComponent(id), { method: "DELETE" });
      setEdit(null); load();
    } catch { /* 무시 */ }
    setSaving(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">CRM 메시지맵</h1>
        </div>
        <div className="b2b-page-actions sm-row sm-gap-2">
          <button className="b2b-btn-primary" onClick={() => openNew()}>+ 메시지 추가</button>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* 요약 스트립 */}
      <div className="crm-summary">
        <Stat label="메시지" value={summary.total} />
        <Stat label="스테이지" value={summary.stageCount} />
        <Stat label="활성" value={summary.active} tone="success" />
        {summary.gap > 0 && <Stat label="공백·미완" value={summary.gap} tone="danger" />}
        <div className="crm-summary-spacer" />
        {CRM_CHANNELS.filter((c) => summary.byCh[c.key]).map((c) => (
          <span key={c.key} className={chipCls(c.key)}>{c.label} {summary.byCh[c.key]}</span>
        ))}
      </div>

      {/* 탭 + 필터 */}
      <div className="crm-toolbar">
        <div className="sm-tabs">
          <button className={`sm-tab ${tab === "board" ? "is-active" : ""}`} onClick={() => setTab("board")}>보드</button>
          <button className={`sm-tab ${tab === "flow" ? "is-active" : ""}`} onClick={() => setTab("flow")}>흐름</button>
          <button className={`sm-tab ${tab === "table" ? "is-active" : ""}`} onClick={() => setTab("table")}>표(편집)</button>
        </div>
        <div className="crm-summary-spacer" />
        <select className="b2b-select crm-ch-filter" value={chFilter} onChange={(e) => setChFilter(e.target.value)}>
          <option value="">전체 채널</option>
          {CRM_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <input className="b2b-input crm-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="메시지·스테이지·태그 검색" />
      </div>

      {/* utm_campaign 은 달았는데 GA env 가 없을 때만 안내(설정되면 카드에 자동 표시) */}
      {campaigns.length > 0 && ga && !ga.configured && (
        <p className="sm-faint crm-ga-hint">GA 연동 대기 — <code>GA4_PROPERTY_ID</code>·<code>GA_SA_EMAIL</code>·<code>GA_SA_PRIVATE_KEY</code> 를 넣으면 UTM 캠페인 성과(세션·구매·매출)가 카드에 자동 표시됩니다.</p>
      )}

      {loading ? <div className="b2b-loading">불러오는 중...</div> :
        messages.length === 0 ? (
          <div className="b2b-empty">
            아직 등록된 메시지가 없습니다. <button className="b2b-link-btn" onClick={() => openNew()}>+ 메시지 추가</button>로 시작하거나,
            migration 063 적용 후 기존 시트 데이터를 이관하세요.
          </div>
        ) : tab === "board" ? (
          <BoardView stages={stages} gaOf={gaOf} onCard={openEdit} onAdd={(st) => openNew({ stage: st.stage, sub: st.sub, stage_num: st.stage_num })} />
        ) : tab === "flow" ? (
          <FlowView stages={stages} gaOf={gaOf} onCard={openEdit} onAdd={(st) => openNew({ stage: st.stage, sub: st.sub, stage_num: st.stage_num })} />
        ) : (
          <TableView msgs={filtered} stageNames={stageNames} savingId={savingId} onField={setStr} onSave={saveRow} onEdit={openEdit} />
        )}

      {edit && (
        <EditModal
          data={edit} onChange={setEdit} onClose={() => setEdit(null)} onSave={save}
          onDelete={() => remove(edit.id)} saving={saving}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  return (
    <div className={`crm-stat${tone ? ` is-${tone}` : ""}`}>
      <div className="crm-stat-label">{label}</div>
      <div className="crm-stat-value">{value}</div>
    </div>
  );
}

// ── 보드 뷰 (스테이지 컬럼) ──
function BoardView({ stages, gaOf, onCard, onAdd }: { stages: Stage[]; gaOf: (m: CrmMessage) => GaStat | undefined; onCard: (m: CrmMessage) => void; onAdd: (s: Stage) => void }) {
  return (
    <div className="crm-board">
      {stages.map((s) => (
        <div key={s.stage} className="crm-bstage">
          <div className="crm-bhead">
            <div className="crm-bhead-no">STAGE {s.stage_num || "-"}</div>
            <div className="crm-bhead-name">{s.stage}</div>
            {s.sub && <div className="crm-bhead-sub">{s.sub}</div>}
            <div className="crm-bhead-n">{s.msgs.length}개</div>
          </div>
          <div className="crm-bcol">
            {s.msgs.map((m) => <Card key={m.id} m={m} ga={gaOf(m)} onClick={() => onCard(m)} />)}
            <button type="button" className="crm-add" onClick={() => onAdd(s)}>+ 이 단계에 추가</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Card({ m, ga, onClick }: { m: CrmMessage; ga?: GaStat; onClick: () => void }) {
  const gl = gaLine(ga);
  return (
    <div className="crm-card" onClick={onClick}>
      <div className="crm-card-head">
        <span className={dotCls(m.status)} title={CRM_STATUS_LABEL[m.status] || m.status} />
        <strong className="crm-card-title">{m.title || "(제목 없음)"}</strong>
      </div>
      <div className="sm-row-wrap crm-card-meta-row">
        <span className={chipCls(m.channel)}>{CRM_CHANNEL_LABEL[m.channel] || m.channel || "미지정"}</span>
        {m.timing && <span className="crm-card-meta">· {m.timing}</span>}
      </div>
      {crmTags(m.tags).length > 0 && (
        <div className="sm-row-wrap crm-card-tags">
          {crmTags(m.tags).map((t) => <span key={t} className="crm-tag">{t}</span>)}
        </div>
      )}
      {gl && <div className="crm-ga" title="GA · utm_campaign 세션 귀속 · 최근 90일">GA {gl}</div>}
      {CRM_LINK_TYPES.some((l) => m.links?.[l.key]) && (
        <div className="sm-row-wrap crm-card-links">
          {CRM_LINK_TYPES.filter((l) => m.links?.[l.key]).map((l) => (
            <a key={l.key} className="crm-link" href={m.links[l.key]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{l.label} ↗</a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 흐름 뷰 — 여정 리본(정거장 레일) + 단계 안 발송시점 타임라인. 공백은 점선 카드(흐름의 구멍) ──
function FlowView({ stages, gaOf, onCard, onAdd }: { stages: Stage[]; gaOf: (m: CrmMessage) => GaStat | undefined; onCard: (m: CrmMessage) => void; onAdd: (s: Stage) => void }) {
  return (
    <div className="crm-flow-wrap">
      <div className="crm-flow">
        {stages.map((s, i) => {
          const gapN = s.msgs.filter((m) => m.status === "gap").length;
          return (
            <div key={s.stage} className="crm-fstage">
              <div className="crm-fhead">
                <div className="crm-fno">STAGE {s.stage_num || i + 1}</div>
                <div className="crm-fname">{s.stage}</div>
                {s.sub && <div className="crm-fsub">{s.sub}</div>}
                <div className="crm-fmeta">
                  {s.msgs.length}개
                  {gapN > 0 && <> · <span className="crm-fgapn">공백 {gapN}{gapN === s.msgs.length ? " — 전부 구멍" : ""}</span></>}
                </div>
              </div>
              <div className="crm-ftl">
                {s.msgs.map((m) => {
                  const perf = perfLine(m.perf);
                  const gl = gaLine(gaOf(m));
                  return (
                    <div key={m.id} className={`crm-fmsg ${ST_KEYS.has(m.status) ? `is-${m.status}` : ""}`}>
                      {m.timing && <div className="crm-ftime">{m.timing}</div>}
                      <button type="button" className={`crm-fcard${m.status === "gap" ? " is-gap" : ""}`} onClick={() => onCard(m)}>
                        <span className="crm-ft">{m.title || "(제목 없음)"}</span>
                        <span className="sm-row-wrap crm-fchips">
                          <span className={chipCls(m.channel)}>{CRM_CHANNEL_LABEL[m.channel] || m.channel || "미지정"}</span>
                          {m.status === "gap" && <span className="crm-chip crm-chip-gap">미운영</span>}
                          {m.status === "auto" && <span className="crm-chip crm-chip-auto">자동</span>}
                          {m.status === "paused" && <span className="crm-chip crm-chip-paused">중단</span>}
                        </span>
                        {perf && <span className="crm-fperf">{perf}</span>}
                        {gl && <span className="crm-ga" title="GA · utm_campaign 세션 귀속 · 최근 90일">GA {gl}</span>}
                      </button>
                    </div>
                  );
                })}
                <button type="button" className="crm-add" onClick={() => onAdd(s)}>+ 추가</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 표(편집) 뷰 — 셀에서 바로 편집(자동저장). 깊은 필드(상세·초안·링크·성과)는 '상세' 버튼→모달 ──
function TableView({ msgs, stageNames, savingId, onField, onSave, onEdit }: {
  msgs: CrmMessage[]; stageNames: string[]; savingId: string | null;
  onField: (id: string, key: keyof CrmMessage, value: string) => void;
  onSave: (id: string, override?: Partial<CrmMessage>) => void;
  onEdit: (m: CrmMessage) => void;
}) {
  return (
    <>
      <datalist id="crm-stage-names">{stageNames.map((s) => <option key={s} value={s} />)}</datalist>
      <div className="b2b-table-wrap">
        <table className="b2b-table">
          <thead><tr>
            <th className="crm-col-stage">스테이지</th><th className="crm-col-title">메시지명</th>
            <th className="crm-col-select">채널</th><th className="crm-col-timing">발송시점</th>
            <th className="crm-col-select">상태</th><th className="crm-col-tags">태그</th><th className="crm-col-actions"></th>
          </tr></thead>
          <tbody>
            {msgs.map((m) => (
              <tr key={m.id}>
                <td><CellText id={m.id} value={m.stage} field="stage" placeholder="스테이지" list="crm-stage-names" onField={onField} onSave={onSave} /></td>
                <td><CellText id={m.id} value={m.title} field="title" placeholder="메시지명" onField={onField} onSave={onSave} /></td>
                <td>
                  <select className={chSelCls(m.channel)} value={m.channel} aria-label="채널"
                    onChange={(e) => { onField(m.id, "channel", e.target.value); onSave(m.id, { channel: e.target.value }); }}>
                    {CRM_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </td>
                <td><CellText id={m.id} value={m.timing} field="timing" placeholder="예: 결제 후 1시간" onField={onField} onSave={onSave} /></td>
                <td>
                  <select className={stSelCls(m.status)} value={m.status} aria-label="상태"
                    onChange={(e) => { onField(m.id, "status", e.target.value); onSave(m.id, { status: e.target.value }); }}>
                    {CRM_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </td>
                <td><CellText id={m.id} value={m.tags} field="tags" placeholder="쉼표로 구분" onField={onField} onSave={onSave} /></td>
                <td className="actions">
                  {savingId === m.id
                    ? <span className="crm-saving">저장 중…</span>
                    : <button className="b2b-btn-secondary crm-detail-btn" onClick={() => onEdit(m)}>상세</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sm-faint crm-table-hint">셀을 눌러 바로 수정하면 자동 저장됩니다. 상세 설명·메시지 초안·링크·성과는 <b>상세</b>에서 편집하세요.</p>
    </>
  );
}

// 표 셀의 인라인 텍스트 — 타이핑 중엔 로컬 갱신, 값이 바뀐 채 포커스를 잃으면 저장.
function CellText({ id, value, field, placeholder, list, onField, onSave }: {
  id: string; value: string; field: keyof CrmMessage; placeholder?: string; list?: string;
  onField: (id: string, key: keyof CrmMessage, value: string) => void;
  onSave: (id: string) => void;
}) {
  const focusVal = useRef("");
  return (
    <input className="crm-cell" value={value || ""} placeholder={placeholder} list={list} spellCheck={false}
      onChange={(e) => onField(id, field, e.target.value)}
      onFocus={(e) => { focusVal.current = e.target.value; }}
      onBlur={(e) => { if (e.target.value !== focusVal.current) onSave(id); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

// ── 편집 모달 ──
function EditModal({ data, onChange, onClose, onSave, onDelete, saving }: {
  data: CrmMessageInput; onChange: (d: CrmMessageInput) => void; onClose: () => void;
  onSave: () => void; onDelete: () => void; saving: boolean;
}) {
  const set = <K extends keyof CrmMessageInput>(k: K, v: CrmMessageInput[K]) => onChange({ ...data, [k]: v });
  const setLink = (k: string, v: string) => onChange({ ...data, links: { ...data.links, [k]: v } });

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal crm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">{data.id ? "메시지 수정" : "새 메시지"}</h2>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">스테이지</span>
              <input className="b2b-input" value={data.stage} onChange={(e) => set("stage", e.target.value)} placeholder="예: 유입/인지" /></label>
            <label className="b2b-field crm-field-num"><span className="b2b-field-label">순서(번호)</span>
              <input type="number" className="b2b-input" value={data.stage_num} onChange={(e) => set("stage_num", Number(e.target.value) || 0)} /></label>
          </div>
          <label className="b2b-field"><span className="b2b-field-label">스테이지 부제(선택)</span>
            <input className="b2b-input" value={data.sub} onChange={(e) => set("sub", e.target.value)} placeholder="예: 첫 접점" /></label>
          <label className="b2b-field"><span className="b2b-field-label">메시지명</span>
            <input className="b2b-input" value={data.title} onChange={(e) => set("title", e.target.value)} placeholder="예: 체험단 안내 링크" /></label>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">채널</span>
              <select className="b2b-select" value={data.channel} onChange={(e) => set("channel", e.target.value)}>
                {CRM_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select></label>
            <label className="b2b-field"><span className="b2b-field-label">상태</span>
              <select className="b2b-select" value={data.status} onChange={(e) => set("status", e.target.value)}>
                {CRM_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select></label>
            <label className="b2b-field"><span className="b2b-field-label">발송 시점</span>
              <input className="b2b-input" value={data.timing} onChange={(e) => set("timing", e.target.value)} placeholder="예: 선정 시 / 상시" /></label>
          </div>
          <label className="b2b-field"><span className="b2b-field-label">상세 설명</span>
            <textarea className="b2b-textarea" value={data.detail} onChange={(e) => set("detail", e.target.value)} rows={2} placeholder="어떤 메시지인지·자동화 여부 등" /></label>
          <label className="b2b-field"><span className="b2b-field-label">메시지 내용/초안(선택)</span>
            <textarea className="b2b-textarea" value={data.msg} onChange={(e) => set("msg", e.target.value)} rows={3} /></label>
          <label className="b2b-field"><span className="b2b-field-label">태그(콤마 구분)</span>
            <input className="b2b-input" value={data.tags} onChange={(e) => set("tags", e.target.value)} placeholder="예: 신규, 자동화" /></label>

          <div className="b2b-field-label crm-links-title">링크 (선택)</div>
          <div className="b2b-field-row crm-links-row">
            {CRM_LINK_TYPES.map((l) => (
              <label key={l.key} className="b2b-field crm-link-field">
                <span className="b2b-field-label">{l.label}</span>
                <input className="b2b-input" value={data.links[l.key] || ""} onChange={(e) => setLink(l.key, e.target.value)} placeholder="https://" spellCheck={false} />
              </label>
            ))}
          </div>
          <label className="b2b-field"><span className="b2b-field-label">UTM 캠페인 (GA 성과 연동)</span>
            <input className="b2b-input" value={data.links.utm_campaign || ""} onChange={(e) => setLink("utm_campaign", e.target.value)}
              placeholder="이 메시지 링크의 utm_campaign 값 — 예: crm_60d_winback" spellCheck={false} />
            <span className="sm-faint crm-field-hint">UTM 만들기에서 쓴 캠페인명과 똑같이 넣으면 GA 세션·구매·매출이 카드에 자동 표시됩니다.</span></label>
          <label className="sm-row sm-gap-2 crm-active-check">
            <input type="checkbox" checked={data.active} onChange={(e) => set("active", e.target.checked)} /> 목록에 표시(체크 해제 시 숨김)
          </label>
        </div>
        <div className="b2b-modal-foot">
          <div>{data.id && <button className="b2b-btn-danger" onClick={onDelete} disabled={saving}>삭제</button>}</div>
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose}>취소</button>
            <button className="b2b-btn-primary" onClick={onSave} disabled={saving}>{saving ? "저장 중..." : "저장"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
