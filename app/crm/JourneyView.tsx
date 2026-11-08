"use client";

// 여정 — D+n × 트리거 타임라인(피로도). 행 = D+n(값 있는 것만, 위에서 아래로 시간 순), 열 = 트리거, 칸 = 그날 나가는 메시지. 2개 이상이면 칸을 붉게.
//  상시·행사·D+n 없는 메시지는 아래 띠. (2026-11-06 개편 · 2026-11-09 대표 "세로축 D-day, 가로축 트리거"로 축 교체)
import { useMemo } from "react";
import { CRM_TRIGGERS, statusKey, type CrmMessage } from "@/app/lib/crm";
import { qty } from "@/app/lib/format";

export default function JourneyView({ msgs, onOpen }: { msgs: CrmMessage[]; onOpen: (m: CrmMessage) => void }) {
  const model = useMemo(() => {
    const timed = msgs.filter((m) => m.trigger && m.trigger !== "always" && m.trigger !== "event" && m.offset_days != null);
    const band = msgs.filter((m) => !timed.includes(m));
    const days = [...new Set(timed.map((m) => m.offset_days as number))].sort((a, b) => a - b);
    const triggers = CRM_TRIGGERS.filter((t) => timed.some((m) => m.trigger === t.key));
    const rows = days.map((d) => ({
      day: d,
      cells: triggers.map((t) => timed.filter((m) => m.trigger === t.key && m.offset_days === d)),
    }));
    const crowded = rows.reduce((n, r) => n + r.cells.filter((c) => c.length >= 2).length, 0);
    return { triggers, rows, band, timedCount: timed.length, crowded };
  }, [msgs]);

  if (msgs.length === 0) return <div className="b2b-empty">메시지가 없습니다.</div>;
  const chip = (m: CrmMessage) => (
    <button key={m.id} type="button" className={`crm-jchip${statusKey(m.status) === "inactive" ? " is-inactive" : ""}`} title={m.title} onClick={() => onOpen(m)}>{m.title || "(제목 없음)"}</button>
  );
  const dayLabel = (d: number) => `D${d >= 0 ? "+" : "-"}${Math.abs(d)}`;
  return (
    <div>
      {model.rows.length === 0 ? (
        <div className="b2b-empty">트리거와 D+n 이 있는 메시지가 없습니다.</div>
      ) : (
        <div className="b2b-table-wrap crm-journey-wrap">
          <table className="crm-journey" style={{ minWidth: 72 + model.triggers.length * 140 }}>
            <thead>
              <tr>
                <th className="crm-jday">D-day</th>
                {model.triggers.map((t) => <th key={t.key}>{t.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {model.rows.map((r) => (
                <tr key={r.day}>
                  <th className="crm-jday">{dayLabel(r.day)}</th>
                  {r.cells.map((cell, i) => (
                    <td key={i} className="crm-jcell">
                      {cell.length > 0 && (
                        <div className={`crm-jcell-in${cell.length >= 2 ? " is-crowded" : ""}`}>
                          {cell.length >= 2 && <span className="crm-jcrowd">같은 날 {qty(cell.length)}통</span>}
                          {cell.map(chip)}
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="crm-journey-note">칸 = 그 트리거 뒤 그날 나가는 메시지. 같은 날 2통 이상이면 붉은 칸. 타임라인 {qty(model.timedCount)}건{model.crowded ? ` · 겹치는 칸 ${qty(model.crowded)}` : ""}</p>
      {model.band.length > 0 && (
        <div className="crm-band">
          <div className="crm-band-title">상시 · 행사 · D+n 없음 <span className="crm-group-count">{qty(model.band.length)}</span></div>
          <div className="crm-band-chips">{model.band.map(chip)}</div>
        </div>
      )}
    </div>
  );
}
