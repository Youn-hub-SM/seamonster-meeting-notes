"use client";

// 드로어 — 메시지 하나를 보고 고치는 유일한 곳(인라인 편집 폐지, 2026-11-06). 본문 미리보기·버튼 링크·트리거·UTM·성과·기간·태그.
import { useMemo, useState } from "react";
import { CRM_STATUSES, CRM_TRIGGERS, statusKey, type CrmMessageInput, type CrmOption, type CrmOptions } from "@/app/lib/crm";
import { CRM_MEDIA, isTrackedUrl, parseUtm } from "@/app/lib/utm-rules";
import { qty, wonText } from "@/app/lib/format";
import type { GaStat, Labels } from "./types";

export default function Drawer({ data, onChange, onClose, onSave, onDelete, saving, datesSupported, fieldsSupported, triggersSupported, solapiTpls, opts, labels, ga, stageNames }: {
  data: CrmMessageInput; onChange: (d: CrmMessageInput) => void; onClose: () => void;
  onSave: () => void; onDelete: () => void; saving: boolean; datesSupported: boolean; fieldsSupported: boolean; triggersSupported: boolean;
  solapiTpls: { id: string; name: string }[]; opts: CrmOptions; labels: Labels; ga?: GaStat; stageNames: string[];
}) {
  const [editBody, setEditBody] = useState(!data.id || !data.msg);
  const set = <K extends keyof CrmMessageInput>(k: K, v: CrmMessageInput[K]) => onChange({ ...data, [k]: v });
  const setLink = (k: "url" | "utm_campaign" | "utm_term", v: string) => onChange({ ...data, links: { ...data.links, [k]: v } });
  const urls = useMemo(() => (data.links.urls?.length ? data.links.urls : data.links.url ? [data.links.url] : []), [data.links]);
  const setUrls = (text: string) => {
    const list = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    onChange({ ...data, links: { ...data.links, urls: list, url: list.find(isTrackedUrl) ?? list[0] ?? "" } });
  };
  const legacyOpt = (list: CrmOption[], value: string, label: (k: string) => string) =>
    value && !list.some((o) => o.key === value) ? <option value={value}>{label(value)} (구)</option> : null;
  const utmHref = `/utm`;

  return (
    <div className="crm-drawer-backdrop" onClick={onClose}>
      <aside className="crm-drawer" role="dialog" aria-label={data.id ? "메시지 수정" : "새 메시지"} onClick={(e) => e.stopPropagation()}>
        <div className="crm-drawer-head">
          <h2 className="crm-drawer-title">{data.id ? data.title || "(제목 없음)" : "새 메시지"}</h2>
          <select className="b2b-status-select" value={statusKey(data.status)} aria-label="상태" onChange={(e) => set("status", e.target.value)}>
            {CRM_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <button className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="crm-drawer-body">
          <section className="crm-sec">
            <div className="crm-sec-title">기본</div>
            <label className="b2b-field"><span className="b2b-field-label">메시지명<span className="req">*</span></span>
              <input className="b2b-input" value={data.title} onChange={(e) => set("title", e.target.value)} /></label>
            <div className="b2b-field-row">
              <label className="b2b-field"><span className="b2b-field-label">단계</span>
                <input className="b2b-input" value={data.stage} list="crm-stage-names" onChange={(e) => set("stage", e.target.value)} />
                <datalist id="crm-stage-names">{stageNames.map((s) => <option key={s} value={s} />)}</datalist></label>
              <label className="b2b-field crm-field-num"><span className="b2b-field-label">단계 순서</span>
                <input type="number" className="b2b-input" value={data.stage_num} onChange={(e) => set("stage_num", Number(e.target.value) || 0)} /></label>
            </div>
            <div className="b2b-field-row">
              {fieldsSupported && (
                <label className="b2b-field"><span className="b2b-field-label">판매 채널(고객군)</span>
                  <select className="b2b-select" value={data.customer} onChange={(e) => set("customer", e.target.value)}>
                    <option value="">미지정</option>
                    {legacyOpt(opts.customers, data.customer, labels.cust)}
                    {opts.customers.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select></label>
              )}
              <label className="b2b-field"><span className="b2b-field-label">발송 수단</span>
                <select className="b2b-select" value={data.channel} onChange={(e) => set("channel", e.target.value)}>
                  {legacyOpt(opts.channels, data.channel, labels.ch)}
                  {opts.channels.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select></label>
              {fieldsSupported && (
                <label className="b2b-field"><span className="b2b-field-label">유형</span>
                  <select className="b2b-select" value={data.msg_type} onChange={(e) => set("msg_type", e.target.value)}>
                    <option value="">미지정</option>
                    {legacyOpt(opts.msgTypes, data.msg_type, labels.type)}
                    {opts.msgTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select></label>
              )}
            </div>
          </section>

          <section className="crm-sec">
            <div className="crm-sec-title">본문 <button className="b2b-link-btn" onClick={() => setEditBody((v) => !v)}>{editBody ? "미리보기" : "고치기"}</button></div>
            {editBody ? (
              <textarea className="b2b-textarea crm-msg-edit" value={data.msg} onChange={(e) => set("msg", e.target.value)} aria-label="본문" />
            ) : (
              <div className={`crm-msg-box${data.msg ? "" : " is-empty"}`}>{data.msg || "(본문 없음)"}</div>
            )}
          </section>

          <section className="crm-sec">
            <div className="crm-sec-title">버튼 링크 <a className="b2b-link-btn" href={utmHref} target="_blank" rel="noreferrer">UTM 만들기 ↗</a></div>
            {urls.length > 0 && (
              <ul className="crm-links">
                {urls.map((u, i) => { const p = parseUtm(u); const tracked = isTrackedUrl(u); return (
                  <li key={i} className="crm-link-row">
                    <span className="crm-link-slug">{tracked ? (p.content || `링크 ${i + 1}`) : <span className="crm-link-ext">UTM 없음</span>}</span>
                    <span className="crm-link-url">{u}</span>
                  </li>
                ); })}
              </ul>
            )}
            <label className="b2b-field"><span className="b2b-field-label">링크 주소 <span className="opt">버튼마다 한 줄</span></span>
              <textarea className="b2b-textarea" rows={Math.min(6, Math.max(2, urls.length + 1))} value={urls.join("\n")} onChange={(e) => setUrls(e.target.value)} spellCheck={false} /></label>
            <div className="b2b-field-row">
              <label className="b2b-field"><span className="b2b-field-label">UTM 캠페인</span>
                <input className="b2b-input" value={data.links.utm_campaign || ""} onChange={(e) => setLink("utm_campaign", e.target.value)} spellCheck={false} /></label>
              {triggersSupported && (
                <label className="b2b-field"><span className="b2b-field-label">UTM 매체</span>
                  <input className="b2b-input" value={data.utm_medium || ""} list="crm-media" onChange={(e) => set("utm_medium", e.target.value)} spellCheck={false} />
                  <datalist id="crm-media">{CRM_MEDIA.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</datalist></label>
              )}
              <label className="b2b-field crm-field-num"><span className="b2b-field-label">A/B</span>
                <select className="b2b-select" value={data.links.utm_term || ""} onChange={(e) => setLink("utm_term", e.target.value)}>
                  <option value="">없음</option><option value="a">a</option><option value="b">b</option>
                </select></label>
            </div>
            {ga && <div className="crm-ga-line">GA 90일 · 세션 {qty(ga.sessions)} · 구매 {qty(ga.purchases)}{ga.revenue ? ` · ${wonText(ga.revenue)}` : ""}</div>}
          </section>

          {triggersSupported && (
            <section className="crm-sec">
              <div className="crm-sec-title">발송 시점</div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">트리거</span>
                  <select className="b2b-select" value={data.trigger || ""} onChange={(e) => set("trigger", e.target.value)}>
                    <option value="">없음</option>
                    {CRM_TRIGGERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select></label>
                <label className="b2b-field crm-field-num"><span className="b2b-field-label">D+n <span className="opt">전이면 음수</span></span>
                  <input className="b2b-input" type="number" value={data.offset_days == null ? "" : String(data.offset_days)} onChange={(e) => set("offset_days", e.target.value === "" ? null : Number(e.target.value))} /></label>
              </div>
              <label className="b2b-field"><span className="b2b-field-label">조건 메모</span>
                <textarea className="b2b-textarea" rows={2} value={data.offset_note || ""} onChange={(e) => set("offset_note", e.target.value)} /></label>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">발송 시점 설명</span>
                  <input className="b2b-input" value={data.timing} onChange={(e) => set("timing", e.target.value)} /></label>
                <label className="b2b-field crm-field-num"><span className="b2b-field-label">목표 클릭률(%)</span>
                  <input className="b2b-input" type="number" step="0.1" min={0} value={data.target_ctr == null ? "" : String(data.target_ctr)} onChange={(e) => set("target_ctr", e.target.value === "" ? null : Number(e.target.value))} /></label>
              </div>
              <label className="b2b-field"><span className="b2b-field-label">솔라피 템플릿 <span className="opt">네이버 솔라피만</span></span>
                {solapiTpls.length ? (
                  <select className="b2b-select" value={data.solapi_template_id || ""} onChange={(e) => set("solapi_template_id", e.target.value)}>
                    <option value="">없음</option>
                    {data.solapi_template_id && !solapiTpls.some((t) => t.id === data.solapi_template_id) && <option value={data.solapi_template_id}>{data.solapi_template_id}</option>}
                    {solapiTpls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                ) : <input className="b2b-input" value={data.solapi_template_id || ""} onChange={(e) => set("solapi_template_id", e.target.value)} spellCheck={false} />}</label>
            </section>
          )}

          <section className="crm-sec">
            <div className="crm-sec-title">기간 · 메모</div>
            {datesSupported && (
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">시작일</span>
                  <input type="date" className="b2b-input" value={data.start_date || ""} onChange={(e) => set("start_date", e.target.value)} /></label>
                <label className="b2b-field"><span className="b2b-field-label">종료일</span>
                  <input type="date" className="b2b-input" value={data.end_date || ""} onChange={(e) => set("end_date", e.target.value)} /></label>
              </div>
            )}
            <label className="b2b-field"><span className="b2b-field-label">태그 <span className="opt">콤마 구분</span></span>
              <input className="b2b-input" value={data.tags} onChange={(e) => set("tags", e.target.value)} /></label>
            <label className="b2b-field"><span className="b2b-field-label">상세 설명</span>
              <textarea className="b2b-textarea" rows={2} value={data.detail} onChange={(e) => set("detail", e.target.value)} /></label>
            <label className="crm-active-check">
              <input type="checkbox" checked={data.active} onChange={(e) => set("active", e.target.checked)} /> 목록에 표시
            </label>
          </section>
        </div>
        <div className="crm-drawer-foot">
          <div>{data.id && <button className="b2b-btn-danger" onClick={onDelete} disabled={saving}>메시지 삭제</button>}</div>
          <div className="crm-drawer-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>그만두기</button>
            <button className="b2b-btn-primary" onClick={onSave} disabled={saving}>{saving ? "저장 중..." : "변경 저장"}</button>
          </div>
        </div>
      </aside>
    </div>
  );
}
