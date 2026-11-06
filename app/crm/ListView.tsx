"use client";

// 목록 — 단계별 묶음 표(접기·sticky 머리). 읽기 전용, 행 클릭 → 드로어. (2026-11-06 개편, docs/crm-map-redesign-plan.md)
import { useState } from "react";
import { crmTags, statusKey, triggerText, type CrmMessage } from "@/app/lib/crm";
import { isTrackedUrl } from "@/app/lib/utm-rules";
import { qty } from "@/app/lib/format";
import type { GaStat, Labels, Stage } from "./types";

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const periodLabel = (m: Pick<CrmMessage, "start_date" | "end_date">) =>
  m.start_date || m.end_date ? `${m.start_date ? md(m.start_date) : ""}~${m.end_date ? md(m.end_date) : ""}` : "";

export default function ListView({ stages, labels, gaOf, onOpen, onAdd }: {
  stages: Stage[]; labels: Labels; gaOf: (m: CrmMessage) => GaStat | undefined; onOpen: (m: CrmMessage) => void; onAdd: (s: Stage) => void;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const hasGa = stages.some((s) => s.msgs.some((m) => gaOf(m)));
  return (
    <div className="b2b-table-wrap is-sticky-head">
      <table className="b2b-table is-compact is-clickable">
        <thead>
          <tr>
            <th className="crm-title-cell">메시지</th>
            <th>발송 수단</th>
            <th>유형</th>
            <th>트리거</th>
            <th>링크</th>
            <th>상태</th>
            {hasGa && <th>세션 90일</th>}
          </tr>
        </thead>
        <tbody>
          {stages.map((s, i) => {
            const open = !closed[s.stage];
            const inactiveN = s.msgs.filter((m) => statusKey(m.status) === "inactive").length;
            return [
              <tr key={`g-${s.stage}`} className="crm-group-row">
                <td colSpan={hasGa ? 7 : 6}>
                  <div className="crm-group-btn">
                    <button type="button" className="crm-group-toggle" aria-expanded={open} onClick={() => setClosed((c) => ({ ...c, [s.stage]: !c[s.stage] }))}>
                      <span>{open ? "▾" : "▸"}</span>
                      <span>{s.stage_num ? `${s.stage_num}. ` : `${i + 1}. `}{s.stage}</span>
                      {s.sub && <span className="crm-group-sub">{s.sub}</span>}
                      <span className="crm-group-count">{qty(s.msgs.length)}{inactiveN ? ` · 비활성 ${qty(inactiveN)}` : ""}</span>
                    </button>
                    <span className="crm-bar-spacer" />
                    <button type="button" className="b2b-link-btn" onClick={() => onAdd(s)}>메시지 추가</button>
                  </div>
                </td>
              </tr>,
              ...(open ? s.msgs.map((m) => {
                const st = statusKey(m.status);
                const tags = crmTags(m.tags);
                const urls = (m.links?.urls?.length ? m.links.urls : m.links?.url ? [m.links.url] : []);
                const tracked = urls.filter(isTrackedUrl).length;
                const g = gaOf(m);
                const period = periodLabel(m);
                return (
                  <tr key={m.id} className={st === "inactive" ? "crm-row-inactive" : undefined} onClick={() => onOpen(m)}>
                    <td className="crm-title-cell">
                      <span className="crm-title">{m.title || "(제목 없음)"}</span>
                      {tags.length > 0 && <span className="crm-tags">{tags.map((t) => <span key={t} className="crm-tag">{t}</span>)}</span>}
                      {(m.timing || period) && <span className="crm-sub">{[m.timing, period].filter(Boolean).join(" · ")}</span>}
                    </td>
                    <td className="crm-cell-nowrap">{m.channel ? <span className="b2b-status-pill">{labels.ch(m.channel)}</span> : <span className="sm-faint">미지정</span>}</td>
                    <td className="crm-cell-nowrap">{m.msg_type ? labels.type(m.msg_type) : ""}</td>
                    <td>
                      <span className="crm-cell-nowrap">{triggerText({ trigger: m.trigger, offset_days: m.offset_days }) || <span className="sm-faint">없음</span>}</span>
                      {m.offset_note && <span className="crm-sub">{m.offset_note.split(/\r?\n/)[0]}</span>}
                    </td>
                    <td>
                      {urls.length === 0 ? <span className="sm-faint">없음</span> : (
                        <>
                          <span className="crm-cell-nowrap">링크 {qty(urls.length)}{tracked < urls.length ? ` · 추적 ${qty(tracked)}` : ""}</span>
                          {m.links?.utm_campaign && <span className="crm-sub">{m.links.utm_campaign}{m.links.utm_term ? ` · ${m.links.utm_term}` : ""}</span>}
                        </>
                      )}
                    </td>
                    <td className="crm-cell-nowrap"><span className="b2b-status-pill">{st === "active" ? "활성" : "비활성"}</span></td>
                    {hasGa && <td className="num">{g ? qty(g.sessions) : ""}</td>}
                  </tr>
                );
              }) : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
