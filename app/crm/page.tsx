"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CrmMessage, CrmMessageInput, EMPTY_CRM_MESSAGE,
  CRM_CHANNELS, CRM_CHANNEL_LABEL, CRM_STATUSES, CRM_STATUS_LABEL, CRM_LINK_TYPES, crmTags,
} from "@/app/lib/crm";

// ── 배지 색 (인라인) ──
const CH_COLOR: Record<string, { bg: string; fg: string }> = {
  kakao: { bg: "#FFF8E1", fg: "#8D6E00" },
  cafe24: { bg: "#E6F1FB", fg: "#185FA5" },
  manual: { bg: "#F1EFE8", fg: "#4A4946" },
  custom: { bg: "#F0EBF8", fg: "#6B45B0" },
  onsite: { bg: "#E0F2F1", fg: "#00695C" },
  leaflet: { bg: "#E8F5EE", fg: "#0F6E56" },
};
const ST_COLOR: Record<string, string> = { active: "var(--sm-success)", auto: "var(--sm-info)", gap: "var(--sm-danger)", paused: "var(--sm-text-light)" };
const chColor = (k: string) => CH_COLOR[k] || { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" };

type Stage = { stage: string; sub: string; stage_num: number; msgs: CrmMessage[] };

export default function CrmPage() {
  const [messages, setMessages] = useState<CrmMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"board" | "table">("board");
  const [search, setSearch] = useState("");
  const [chFilter, setChFilter] = useState("");

  const [edit, setEdit] = useState<CrmMessageInput | null>(null);
  const [saving, setSaving] = useState(false);

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
        <div className="b2b-page-actions sm-row" style={{ gap: 6, alignItems: "center" }}>
          <button className="b2b-btn-primary" onClick={() => openNew()}>+ 메시지 추가</button>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* 요약 스트립 */}
      <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <Stat label="메시지" value={summary.total} />
        <Stat label="스테이지" value={summary.stageCount} />
        <Stat label="활성" value={summary.active} color="var(--sm-success)" />
        {summary.gap > 0 && <Stat label="공백·미완" value={summary.gap} color="var(--sm-danger)" />}
        <div style={{ flex: 1 }} />
        {CRM_CHANNELS.filter((c) => summary.byCh[c.key]).map((c) => (
          <span key={c.key} style={{ ...pill(chColor(c.key)) }}>{c.label} {summary.byCh[c.key]}</span>
        ))}
      </div>

      {/* 탭 + 필터 */}
      <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div className="sm-tabs" style={{ margin: 0 }}>
          <button className={`sm-tab ${tab === "board" ? "is-active" : ""}`} onClick={() => setTab("board")}>보드</button>
          <button className={`sm-tab ${tab === "table" ? "is-active" : ""}`} onClick={() => setTab("table")}>표(편집)</button>
        </div>
        <div style={{ flex: 1 }} />
        <select className="b2b-select" value={chFilter} onChange={(e) => setChFilter(e.target.value)} style={{ width: "auto" }}>
          <option value="">전체 채널</option>
          {CRM_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <input className="b2b-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="메시지·스테이지·태그 검색" style={{ width: 200 }} />
      </div>

      {loading ? <div className="b2b-loading">불러오는 중...</div> :
        messages.length === 0 ? (
          <div className="b2b-empty">
            아직 등록된 메시지가 없습니다. <button className="b2b-link-btn" onClick={() => openNew()}>+ 메시지 추가</button>로 시작하거나,
            migration 063 적용 후 기존 시트 데이터를 이관하세요.
          </div>
        ) : tab === "board" ? (
          <BoardView stages={stages} onCard={openEdit} onAdd={(st) => openNew({ stage: st.stage, sub: st.sub, stage_num: st.stage_num })} />
        ) : (
          <TableView msgs={filtered} onEdit={openEdit} />
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

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ border: "1px solid var(--sm-border)", borderRadius: 10, padding: "8px 14px", background: "var(--sm-white)" }}>
      <div style={{ fontSize: 11, color: "var(--sm-text-light)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || "var(--sm-dark)" }}>{value}</div>
    </div>
  );
}
const pill = (c: { bg: string; fg: string }): React.CSSProperties => ({ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: c.bg, color: c.fg, whiteSpace: "nowrap" });

// ── 보드 뷰 (스테이지 컬럼) ──
function BoardView({ stages, onCard, onAdd }: { stages: Stage[]; onCard: (m: CrmMessage) => void; onAdd: (s: Stage) => void }) {
  return (
    <div style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 12, alignItems: "flex-start" }}>
      {stages.map((s) => (
        <div key={s.stage} style={{ flex: "0 0 300px", width: 300 }}>
          <div style={{ background: "var(--sm-dark)", color: "#fff", borderRadius: 12, padding: "12px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "var(--sm-orange)", fontWeight: 700 }}>STAGE {s.stage_num || "-"}</div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{s.stage}</div>
            {s.sub && <div style={{ fontSize: 11, color: "rgba(255,255,255,.7)", marginTop: 2 }}>{s.sub}</div>}
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginTop: 6 }}>{s.msgs.length}개</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {s.msgs.map((m) => <Card key={m.id} m={m} onClick={() => onCard(m)} />)}
            <button onClick={() => onAdd(s)} style={{ border: "1px dashed var(--sm-border)", background: "transparent", borderRadius: 10, padding: "8px", fontSize: 12, color: "var(--sm-text-light)", cursor: "pointer" }}>+ 이 단계에 추가</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Card({ m, onClick }: { m: CrmMessage; onClick: () => void }) {
  const c = chColor(m.channel);
  return (
    <div onClick={onClick} style={{ border: "1px solid var(--sm-border)", borderRadius: 10, padding: "10px 12px", background: "var(--sm-white)", cursor: "pointer", boxShadow: "0 1px 2px rgba(0,0,0,.03)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: ST_COLOR[m.status] || "var(--sm-border)", flexShrink: 0 }} title={CRM_STATUS_LABEL[m.status] || m.status} />
        <strong style={{ fontSize: 13, color: "var(--sm-dark)", lineHeight: 1.3 }}>{m.title || "(제목 없음)"}</strong>
      </div>
      <div className="sm-row" style={{ gap: 5, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ ...pill(c), fontSize: 10, padding: "2px 8px" }}>{CRM_CHANNEL_LABEL[m.channel] || m.channel || "미지정"}</span>
        {m.timing && <span style={{ fontSize: 11, color: "var(--sm-text-mid)" }}>· {m.timing}</span>}
      </div>
      {crmTags(m.tags).length > 0 && (
        <div className="sm-row" style={{ gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {crmTags(m.tags).map((t) => <span key={t} style={{ fontSize: 10, color: "var(--sm-text-light)", background: "var(--sm-bg-subtle)", borderRadius: 4, padding: "1px 6px" }}>{t}</span>)}
        </div>
      )}
      {CRM_LINK_TYPES.some((l) => m.links?.[l.key]) && (
        <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {CRM_LINK_TYPES.filter((l) => m.links?.[l.key]).map((l) => (
            <a key={l.key} href={m.links[l.key]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: 10.5, color: "var(--sm-info)", textDecoration: "none", border: "1px solid var(--sm-border)", borderRadius: 6, padding: "1px 6px" }}>{l.label} ↗</a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 표(편집) 뷰 ──
function TableView({ msgs, onEdit }: { msgs: CrmMessage[]; onEdit: (m: CrmMessage) => void }) {
  return (
    <div className="b2b-table-wrap">
      <table className="b2b-table">
        <thead><tr><th>스테이지</th><th>메시지명</th><th>채널</th><th>발송시점</th><th>상태</th><th>태그</th><th></th></tr></thead>
        <tbody>
          {msgs.map((m) => (
            <tr key={m.id}>
              <td style={{ whiteSpace: "nowrap" }}><span style={{ color: "var(--sm-text-light)", fontSize: 11 }}>{m.stage_num || "-"}</span> {m.stage}</td>
              <td><strong>{m.title || "(제목 없음)"}</strong>{m.detail && <div className="sm-faint" style={{ fontSize: 11, maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.detail}</div>}</td>
              <td style={{ whiteSpace: "nowrap" }}><span style={pill(chColor(m.channel))}>{CRM_CHANNEL_LABEL[m.channel] || m.channel || "-"}</span></td>
              <td style={{ fontSize: 12 }}>{m.timing || "-"}</td>
              <td style={{ whiteSpace: "nowrap" }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: ST_COLOR[m.status] || "var(--sm-border)", display: "inline-block", marginRight: 5 }} />{CRM_STATUS_LABEL[m.status] || m.status || "-"}</td>
              <td style={{ fontSize: 11, color: "var(--sm-text-light)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.tags || "-"}</td>
              <td><button className="b2b-btn-secondary" style={{ padding: "3px 10px", fontSize: 11 }} onClick={() => onEdit(m)}>편집</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">{data.id ? "메시지 수정" : "새 메시지"}</h2>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">스테이지</span>
              <input className="b2b-input" value={data.stage} onChange={(e) => set("stage", e.target.value)} placeholder="예: 유입/인지" /></label>
            <label className="b2b-field" style={{ maxWidth: 110 }}><span className="b2b-field-label">순서(번호)</span>
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

          <div className="b2b-field-label" style={{ marginTop: 6, fontWeight: 700 }}>링크 (선택)</div>
          <div className="b2b-field-row" style={{ flexWrap: "wrap" }}>
            {CRM_LINK_TYPES.map((l) => (
              <label key={l.key} className="b2b-field" style={{ minWidth: 160, flex: 1 }}>
                <span className="b2b-field-label">{l.label}</span>
                <input className="b2b-input" value={data.links[l.key] || ""} onChange={(e) => setLink(l.key, e.target.value)} placeholder="https://" spellCheck={false} />
              </label>
            ))}
          </div>
          <label className="sm-row" style={{ gap: 8, fontSize: 13, marginTop: 8, cursor: "pointer" }}>
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
