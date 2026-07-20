"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CrmMessage, CrmMessageInput, CrmPerf, EMPTY_CRM_MESSAGE,
  CRM_CHANNELS, CRM_CHANNEL_LABEL, CRM_STATUSES, CRM_STATUS_LABEL, CRM_LINK_TYPES, crmTags, crmOnDate,
} from "@/app/lib/crm";
import { TrendChart, BarList, PieCard, moneyCompact } from "@/app/components/charts";

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 기간 표시: "7/1~7/15" · 시작만 "7/1~" · 종료만 "~7/15"
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const periodLabel = (m: Pick<CrmMessage, "start_date" | "end_date">) =>
  m.start_date || m.end_date ? `${m.start_date ? md(m.start_date) : ""}~${m.end_date ? md(m.end_date) : ""}` : "";

// 색은 전부 b2b.css 의 .crm-* 클래스(채널 팔레트·시맨틱 토큰) — 인라인 hex 금지.
const CH_KEYS = new Set(CRM_CHANNELS.map((c) => c.key));
const ST_KEYS = new Set(CRM_STATUSES.map((s) => s.key));
const chipCls = (k: string) => `crm-chip ${CH_KEYS.has(k) ? `crm-ch-${k}` : ""}`;
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
  const [datesSupported, setDatesSupported] = useState(true); // migration 074 미적용이면 false → 날짜 기능 숨김
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"flow" | "table" | "stats">("flow");
  const [search, setSearch] = useState("");
  const [chFilter, setChFilter] = useState("");
  const [asof, setAsof] = useState(""); // 기준일(YYYY-MM-DD) — 비면 전체, 고르면 그날 진행 중만(흐름)
  const [msgOpen, setMsgOpen] = useState(false); // 흐름: 모든 카드의 메시지 초안 펼침 — 톤앤매너 일괄 검수용
  const [stageSel, setStageSel] = useState(""); // 표 필터: 스테이지
  const [stSel, setStSel] = useState("");       // 표 필터: 상태

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
      // 폴백 응답엔 날짜 컬럼이 없음 → ""로 채워 화면 로직을 단일화
      setMessages(((j.messages || []) as CrmMessage[]).map((m) => ({ ...m, start_date: m.start_date || "", end_date: m.end_date || "" })));
      setDatesSupported(j.datesSupported !== false);
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

  // 기준일 필터(흐름 전용) — 그날 진행 중이 아닌 것(기간 밖·중단)을 뺀다. 표·통계엔 미적용.
  const dateFiltered = useMemo(
    () => (asof ? filtered.filter((m) => crmOnDate(m, asof)) : filtered),
    [filtered, asof],
  );

  // 표 전용 필터 — 스테이지·상태(공통 채널·검색 위에 얹힘)
  const tableFiltered = useMemo(
    () => filtered.filter((m) => (!stageSel || (m.stage || "(미분류)") === stageSel) && (!stSel || m.status === stSel)),
    [filtered, stageSel, stSel],
  );

  const stages: Stage[] = useMemo(() => {
    const map = new Map<string, Stage>();
    for (const m of dateFiltered) {
      const key = m.stage || "(미분류)";
      if (!map.has(key)) map.set(key, { stage: key, sub: m.sub, stage_num: m.stage_num, msgs: [] });
      const s = map.get(key)!;
      if (!s.sub && m.sub) s.sub = m.sub;
      s.msgs.push(m);
    }
    return [...map.values()].sort((a, b) => a.stage_num - b.stage_num || a.stage.localeCompare(b.stage, "ko"));
  }, [dateFiltered]);

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

  // ── 1회성 가져오기(빈 상태 전용) — 원본 맵 시드 30개 또는 시트 CSV 붙여넣기 ──
  const [importing, setImporting] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState("");
  async function runImport(mode: "seed" | "csv") {
    if (mode === "seed" && !confirm("원본 CRM 맵 데이터(8단계 · 30개 메시지)를 가져올까요?")) return;
    setImporting(true); setError("");
    try {
      const r = await fetch("/api/crm/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mode === "csv" ? { mode, csv: csvText } : { mode }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "가져오기 실패");
      setCsvOpen(false); setCsvText("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "가져오기 오류"); }
    setImporting(false);
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
          <button className={`sm-tab ${tab === "flow" ? "is-active" : ""}`} onClick={() => setTab("flow")}>흐름</button>
          <button className={`sm-tab ${tab === "table" ? "is-active" : ""}`} onClick={() => setTab("table")}>표(편집)</button>
          <button className={`sm-tab ${tab === "stats" ? "is-active" : ""}`} onClick={() => setTab("stats")}>통계</button>
        </div>
        <div className="crm-summary-spacer" />
        {/* 흐름: 메시지 초안 전체 펼침 — 모든 메시지가 같은 톤앤매너인지 한눈에 검수 */}
        {tab === "flow" && (
          <button className={`b2b-btn-secondary crm-date-btn${msgOpen ? " crm-msgopen-on" : ""}`} onClick={() => setMsgOpen((v) => !v)}>
            {msgOpen ? "메시지 닫기" : "메시지 열기"}
          </button>
        )}
        {/* 기준일 — 그날 진행 중인 메시지만(흐름). 기간은 각 메시지 '상세'에서 설정 */}
        {datesSupported && tab === "flow" && (
          <div className="sm-row crm-datebar">
            <span className="crm-datebar-label">기준일</span>
            <input type="date" className="b2b-input crm-date-input" value={asof} onChange={(e) => setAsof(e.target.value)} aria-label="기준일" />
            {asof !== kstToday() && <button className="b2b-btn-secondary crm-date-btn" onClick={() => setAsof(kstToday())}>오늘</button>}
            {asof && <button className="b2b-btn-secondary crm-date-btn" onClick={() => setAsof("")}>전체</button>}
          </div>
        )}
        {/* 표: 스테이지·상태 필터 — 원하는 메시지만 좁혀서 편집 */}
        {tab === "table" && (
          <>
            <select className="b2b-select crm-ch-filter" value={stageSel} onChange={(e) => setStageSel(e.target.value)} aria-label="스테이지 필터">
              <option value="">전체 스테이지</option>
              {stageNames.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="b2b-select crm-ch-filter" value={stSel} onChange={(e) => setStSel(e.target.value)} aria-label="상태 필터">
              <option value="">전체 상태</option>
              {CRM_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </>
        )}
        {tab !== "stats" && (
          <>
            <select className="b2b-select crm-ch-filter" value={chFilter} onChange={(e) => setChFilter(e.target.value)}>
              <option value="">전체 채널</option>
              {CRM_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <input className="b2b-input crm-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="메시지·스테이지·태그 검색" />
          </>
        )}
      </div>

      {/* 기준일 안내 — 몇 개가 걸러졌는지 명시(조용히 사라지면 '데이터가 없어졌다'로 오해) */}
      {asof && tab === "flow" && (
        <p className="sm-faint crm-asof-hint">
          {asof} 기준 진행 중 {dateFiltered.length}개 표시 · 기간 밖/중단 {filtered.length - dateFiltered.length}개 숨김
        </p>
      )}

      {/* utm_campaign 은 달았는데 GA env 가 없을 때만 안내(설정되면 카드에 자동 표시) */}
      {campaigns.length > 0 && ga && !ga.configured && (
        <p className="sm-faint crm-ga-hint">GA 연동 대기 — <code>GA4_PROPERTY_ID</code>·<code>GA_SA_EMAIL</code>·<code>GA_SA_PRIVATE_KEY</code> 를 넣으면 UTM 캠페인 성과(세션·구매·매출)가 카드에 자동 표시됩니다.</p>
      )}

      {loading ? <div className="b2b-loading">불러오는 중...</div> :
        messages.length === 0 ? (
          <div className="b2b-empty">
            <p className="crm-empty-lead">아직 등록된 메시지가 없습니다.</p>
            <div className="sm-row-wrap crm-empty-actions">
              <button className="b2b-btn-primary" onClick={() => runImport("seed")} disabled={importing}>
                {importing ? "가져오는 중..." : "원본 맵 데이터 가져오기 (8단계 · 30개)"}
              </button>
              <button className="b2b-btn-secondary" onClick={() => openNew()}>+ 빈 상태에서 직접 추가</button>
              <button className="b2b-link-btn" onClick={() => setCsvOpen((v) => !v)}>시트 CSV 붙여넣기</button>
            </div>
            {csvOpen && (
              <div className="crm-csv-box">
                <p className="sm-faint crm-csv-hint">구글시트(메시지 맵)를 전체 선택 → 복사해 붙여넣으세요. 헤더(스테이지·메시지명·상태...) 포함.</p>
                <textarea className="b2b-textarea" rows={6} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="스테이지,부제,메시지명,상태,채널,발송시점,..." spellCheck={false} />
                <button className="b2b-btn-primary" onClick={() => runImport("csv")} disabled={importing || !csvText.trim()}>
                  {importing ? "가져오는 중..." : "CSV 가져오기"}
                </button>
              </div>
            )}
          </div>
        ) : tab === "flow" ? (
          <FlowView stages={stages} gaOf={gaOf} msgOpen={msgOpen} onCard={openEdit} onAdd={(st) => openNew({ stage: st.stage, sub: st.sub, stage_num: st.stage_num })} />
        ) : tab === "table" ? (
          <>
            {(stageSel || stSel) && (
              <p className="sm-faint crm-asof-hint">필터 결과 {tableFiltered.length}개 / 전체 {filtered.length}개</p>
            )}
            <TableView msgs={tableFiltered} stageNames={stageNames} savingId={savingId} onField={setStr} onSave={saveRow} onEdit={openEdit} />
          </>
        ) : (
          <StatsView messages={messages} campaigns={campaigns} gaConfigured={ga?.configured} />
        )}

      {edit && (
        <EditModal
          data={edit} onChange={setEdit} onClose={() => setEdit(null)} onSave={save}
          onDelete={() => remove(edit.id)} saving={saving} datesSupported={datesSupported}
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

// ── 흐름 뷰 — 여정 리본(정거장 레일) + 단계 안 발송시점 타임라인. 공백은 점선 카드(흐름의 구멍) ──
function FlowView({ stages, gaOf, msgOpen, onCard, onAdd }: { stages: Stage[]; gaOf: (m: CrmMessage) => GaStat | undefined; msgOpen: boolean; onCard: (m: CrmMessage) => void; onAdd: (s: Stage) => void }) {
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
                  const tags = crmTags(m.tags);
                  const links = CRM_LINK_TYPES.filter((l) => m.links?.[l.key]);
                  return (
                    <div key={m.id} className={`crm-fmsg ${ST_KEYS.has(m.status) ? `is-${m.status}` : ""}`}>
                      {m.timing && <div className="crm-ftime">{m.timing}</div>}
                      {/* div+onClick(버튼 아님) — 카드 안에 바로가기 <a> 가 있어 중첩 인터랙티브를 피한다 */}
                      <div className={`crm-fcard${m.status === "gap" ? " is-gap" : ""}`} onClick={() => onCard(m)}>
                        <span className="crm-ft">{m.title || "(제목 없음)"}</span>
                        <span className="sm-row-wrap crm-fchips">
                          <span className={chipCls(m.channel)}>{CRM_CHANNEL_LABEL[m.channel] || m.channel || "미지정"}</span>
                          {periodLabel(m) && <span className="crm-chip crm-chip-period">{periodLabel(m)}</span>}
                          {m.status === "gap" && <span className="crm-chip crm-chip-gap">미운영</span>}
                          {m.status === "auto" && <span className="crm-chip crm-chip-auto">자동</span>}
                          {m.status === "paused" && <span className="crm-chip crm-chip-paused">중단</span>}
                          {tags.map((t) => <span key={t} className="crm-tag">{t}</span>)}
                        </span>
                        {/* 메시지 열기 — 초안 전문을 펼쳐 톤앤매너를 나란히 검수. 없는 것도 표시해 초안 누락이 보이게 */}
                        {msgOpen && (
                          m.msg
                            ? <span className="crm-fdraft">{m.msg}</span>
                            : <span className="crm-fdraft is-empty">(초안 없음)</span>
                        )}
                        {perf && <span className="crm-fperf">{perf}</span>}
                        {gl && <span className="crm-ga" title="GA · utm_campaign 세션 귀속 · 최근 90일">GA {gl}</span>}
                        {links.length > 0 && (
                          <span className="sm-row-wrap crm-flinks">
                            {links.map((l) => (
                              <a key={l.key} className="crm-link" href={m.links[l.key]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{l.label} ↗</a>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
                <button type="button" className="crm-add" onClick={() => onAdd(s)}>+ 이 단계에 추가</button>
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

// ── 통계 뷰 ── 맵 구조(채널·단계별 공백) + GA 추이(일자별 세션·매출, 캠페인 순위).
//  GA 축은 utm_campaign 이 달린 메시지들만 — 수동 perf 는 스냅샷이라 추이를 만들 수 없다.
type GaDaily = { date: string; campaign: string; sessions: number; purchases: number; revenue: number };
const STATS_RANGES = [{ d: 7, label: "7일" }, { d: 30, label: "30일" }, { d: 90, label: "90일" }];

function StatsView({ messages, campaigns, gaConfigured }: { messages: CrmMessage[]; campaigns: string[]; gaConfigured?: boolean }) {
  const [days, setDays] = useState(30);
  const [daily, setDaily] = useState<GaDaily[] | null>(null);
  const [gaErr, setGaErr] = useState("");
  const [loading, setLoading] = useState(false);

  const campaignsKey = campaigns.join(",");
  useEffect(() => {
    if (!campaignsKey || gaConfigured === false) { setDaily(null); return; }
    let alive = true;
    setLoading(true); setGaErr("");
    (async () => {
      try {
        const j = await (await fetch(`/api/crm/ga-stats?campaigns=${encodeURIComponent(campaignsKey)}&days=${days}&daily=1`, { cache: "no-store" })).json();
        if (!alive) return;
        if (!j.ok) throw new Error(j.error || "GA 조회 실패");
        setDaily(j.configured ? (j.daily || []) : null);
      } catch (e) { if (alive) { setDaily(null); setGaErr(e instanceof Error ? e.message : "GA 조회 실패"); } }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [campaignsKey, days, gaConfigured]);

  // 맵 구조 — GA 없이도 항상
  const byChannel = useMemo<[string, number][]>(() => {
    const m = new Map<string, number>();
    for (const msg of messages) { const l = CRM_CHANNEL_LABEL[msg.channel] || msg.channel || "미지정"; m.set(l, (m.get(l) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [messages]);
  const gapByStage = useMemo<[string, number][]>(() => {
    const m = new Map<string, number>();
    for (const msg of messages) if (msg.status === "gap") { const s = msg.stage || "(미분류)"; m.set(s, (m.get(s) || 0) + 1); }
    return [...m.entries()];
  }, [messages]);

  // GA 집계 — 일자별 합산 추이(60일 초과는 7일 묶음) + 캠페인 순위
  const ga = useMemo(() => {
    if (!daily) return null;
    const byDate = new Map<string, { sessions: number; purchases: number; revenue: number }>();
    const byCampaign = new Map<string, { sessions: number; purchases: number; revenue: number }>();
    for (const r of daily) {
      const d = byDate.get(r.date) || { sessions: 0, purchases: 0, revenue: 0 };
      d.sessions += r.sessions; d.purchases += r.purchases; d.revenue += r.revenue; byDate.set(r.date, d);
      const c = byCampaign.get(r.campaign) || { sessions: 0, purchases: 0, revenue: 0 };
      c.sessions += r.sessions; c.purchases += r.purchases; c.revenue += r.revenue; byCampaign.set(r.campaign, c);
    }
    const dates = [...byDate.keys()].sort();
    type Pt = { label: string; sessions: number; revenue: number };
    let pts: Pt[];
    if (days <= 60) {
      pts = dates.map((d) => ({ label: md(d), sessions: byDate.get(d)!.sessions, revenue: byDate.get(d)!.revenue }));
    } else {
      // 7일 묶음(첫 날짜 기준) — 90일을 일 단위로 그리면 축 라벨이 뭉개진다
      const chunks = new Map<number, Pt>();
      const t0 = dates.length ? Date.parse(dates[0]) : 0;
      for (const d of dates) {
        const i = Math.floor((Date.parse(d) - t0) / (7 * 86_400e3));
        const p = chunks.get(i) || { label: `${md(new Date(t0 + i * 7 * 86_400e3).toISOString().slice(0, 10))}~`, sessions: 0, revenue: 0 };
        p.sessions += byDate.get(d)!.sessions; p.revenue += byDate.get(d)!.revenue;
        chunks.set(i, p);
      }
      pts = [...chunks.keys()].sort((a, b) => a - b).map((k) => chunks.get(k)!);
    }
    const totals = [...byDate.values()].reduce((t, v) => ({ sessions: t.sessions + v.sessions, purchases: t.purchases + v.purchases, revenue: t.revenue + v.revenue }), { sessions: 0, purchases: 0, revenue: 0 });
    const rank: [string, number][] = [...byCampaign.entries()].map(([c, v]) => [c, v.revenue]);
    const rankSub = (label: string) => { const v = byCampaign.get(label); return v ? `세션 ${v.sessions.toLocaleString("ko-KR")} · 구매 ${v.purchases.toLocaleString("ko-KR")}` : null; };
    return { pts, totals, rank, rankSub };
  }, [daily, days]);

  return (
    <div className="sm-col crm-stats">
      {/* GA 추이 */}
      <div className="sm-row-wrap crm-stats-head">
        <h2 className="crm-stats-title">캠페인 성과 추이 <span className="sm-faint crm-stats-note">GA · utm_campaign 세션 귀속 · 어제까지</span></h2>
        <div className="crm-summary-spacer" />
        <div className="sm-tabs">
          {STATS_RANGES.map((r) => (
            <button key={r.d} className={`sm-tab ${days === r.d ? "is-active" : ""}`} onClick={() => setDays(r.d)}>{r.label}</button>
          ))}
        </div>
      </div>

      {gaConfigured === false ? (
        <p className="sm-faint crm-asof-hint">GA 연동 대기 — env(GA4_PROPERTY_ID·GA_SA_EMAIL·GA_SA_PRIVATE_KEY)를 넣으면 여기에 추이가 표시됩니다.</p>
      ) : !campaignsKey ? (
        <p className="sm-faint crm-asof-hint">utm_campaign 이 달린 메시지가 없습니다 — 메시지 상세에서 UTM 캠페인을 넣으면 추이가 생깁니다.</p>
      ) : gaErr ? (
        <div className="b2b-error">{gaErr}</div>
      ) : loading && !ga ? (
        <div className="b2b-loading">GA 불러오는 중...</div>
      ) : ga && (
        <>
          <div className="sm-row-wrap crm-stats-kpi">
            <div className="crm-stat"><div className="crm-stat-label">세션</div><div className="crm-stat-value">{ga.totals.sessions.toLocaleString("ko-KR")}</div></div>
            <div className="crm-stat"><div className="crm-stat-label">구매</div><div className="crm-stat-value">{ga.totals.purchases.toLocaleString("ko-KR")}</div></div>
            <div className="crm-stat"><div className="crm-stat-label">매출</div><div className="crm-stat-value">{moneyCompact(ga.totals.revenue)}</div></div>
          </div>
          <div className="crm-stats-grid">
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">일자별 세션</span></div>
              <TrendChart data={ga.pts.map((p) => ({ label: p.label, value: p.sessions, tip: `${p.label} · 세션 ${p.sessions.toLocaleString("ko-KR")}` }))} />
            </section>
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">일자별 매출</span></div>
              <TrendChart data={ga.pts.map((p) => ({ label: p.label, value: p.revenue, tip: `${p.label} · ${p.revenue.toLocaleString("ko-KR")}원` }))} fmtAxis={moneyCompact} />
            </section>
            <BarList title="캠페인별 매출" caption={`최근 ${days}일 · 막대 = 매출`} data={ga.rank} fmt={moneyCompact} sub={ga.rankSub} sorted minPct={2} empty="기간 내 매출 없음" />
          </div>
        </>
      )}

      {/* 맵 구조 */}
      <h2 className="crm-stats-title crm-stats-title-2">메시지 구성</h2>
      <div className="crm-stats-grid">
        <PieCard title="채널별 메시지" data={byChannel} />
        <BarList title="단계별 공백(미운영)" caption="공백이 많은 단계 = 여정이 끊기는 곳" data={gapByStage} sorted minPct={4} empty="공백 없음" />
      </div>
    </div>
  );
}

// ── 편집 모달 ──
function EditModal({ data, onChange, onClose, onSave, onDelete, saving, datesSupported }: {
  data: CrmMessageInput; onChange: (d: CrmMessageInput) => void; onClose: () => void;
  onSave: () => void; onDelete: () => void; saving: boolean; datesSupported: boolean;
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
          {datesSupported && (
            <div className="b2b-field-row">
              <label className="b2b-field"><span className="b2b-field-label">진행 시작일 (선택)</span>
                <input type="date" className="b2b-input" value={data.start_date || ""} onChange={(e) => set("start_date", e.target.value)} /></label>
              <label className="b2b-field"><span className="b2b-field-label">진행 종료일 (선택)</span>
                <input type="date" className="b2b-input" value={data.end_date || ""} onChange={(e) => set("end_date", e.target.value)} /></label>
            </div>
          )}
          {datesSupported && (data.start_date || data.end_date) ? (
            <p className="sm-faint crm-field-hint">기준일 필터에서 이 기간 안의 날짜에만 표시됩니다. 비우면 상시.</p>
          ) : null}
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
