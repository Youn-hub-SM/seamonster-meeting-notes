"use client";

// 데이터라이즈 점검 창 — 맵과 실제의 차이(2026-11-24). 데이터라이즈 리포팅 API 를 읽기만 한다(/api/crm/datarize).
//  ① 데이터라이즈에서 켜져 있는데 맵에 없는 캠페인  ② 맵에는 있는데 데이터라이즈에서 꺼졌거나 지워진 메시지.
//  잇는 기준 = 소재 링크의 utm_campaign 과 맵 메시지의 utm_campaign(+별칭). 목록은 1시간 보관 — [다시 확인]이 새로 받는다.
import { useCallback, useEffect, useState } from "react";
import { qty, dateTime } from "@/app/lib/format";

type Campaign = { id: string; name: string; channel: string; status: string; audience: string; sendTime: string; sendDays: number[]; utms: string[] };
type Off = { id: string; title: string; campaign: string; campaigns: { name: string; status: string }[] };
type Check = { at: string; activeCampaigns: number; linkedMessages: number; unmapped: Campaign[]; off: Off[] };
export const DTR_CHANNEL: Record<string, string> = { alimtalk: "알림톡", brand_message: "브랜드메시지", text_message: "문자", line: "LINE" };
export const DTR_STATUS: Record<string, string> = { active: "켜짐", inactive: "꺼짐", draft: "작성 중", ready: "준비됨", removed: "지움", deleted: "지움" };
const DAY = ["일", "월", "화", "수", "목", "금", "토"];
const days = (d: number[]) => (d.length === 7 ? "매일" : d.length ? d.map((x) => DAY[x] || "").join("") : "");

export default function DatarizeCheck({ onClose, onOpenMessage }: { onClose: () => void; onOpenMessage: (id: string) => void }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch(`/api/crm/datarize${refresh ? "?refresh=1" : ""}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error);
      if (!j.configured) throw new Error("데이터라이즈 API 키가 없습니다(Vercel 환경 변수 DATARIZE_API_KEY).");
      setCheck(j.check);
    } catch (e) { setError(e instanceof Error ? e.message : "데이터라이즈를 확인하지 못했습니다."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal crm-dz-modal" role="dialog" aria-modal="true" aria-label="데이터라이즈 점검" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">데이터라이즈 점검</span>
          <button type="button" className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {error && <div className="b2b-error">{error}</div>}
          {loading && !check && <div className="b2b-loading">데이터라이즈에서 불러오는 중...</div>}
          {check && (<>
            <div className="crm-ga-line">켜진 캠페인 {qty(check.activeCampaigns)}개 · 맵과 이어진 메시지 {qty(check.linkedMessages)}개 · {dateTime(check.at)} 기준</div>

            <div className="crm-sec-title">켜져 있는데 맵에 없는 캠페인 {qty(check.unmapped.length)}개</div>
            {check.unmapped.length === 0 ? <div className="b2b-empty">켜진 캠페인이 모두 맵에 있습니다.</div> : (
              <div className="b2b-table-wrap crm-dz-table">
                <table className="b2b-table">
                  <thead><tr><th>캠페인</th><th>수단</th><th>대상</th><th>발송</th><th>utm_campaign</th></tr></thead>
                  <tbody>
                    {check.unmapped.map((c) => (
                      <tr key={c.id}>
                        <td className="crm-dz-name">{c.name}</td>
                        <td className="sm-nowrap">{DTR_CHANNEL[c.channel] || c.channel}</td>
                        <td className="crm-dz-name">{c.audience || "-"}</td>
                        <td className="sm-nowrap">{[days(c.sendDays), c.sendTime].filter(Boolean).join(" ") || "-"}</td>
                        <td className="crm-dz-utm">{c.utms.length ? c.utms.join(", ") : "링크에 utm_campaign 없음"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="crm-sec-title">맵에는 있는데 꺼졌거나 지워진 메시지 {qty(check.off.length)}개</div>
            {check.off.length === 0 ? <div className="b2b-empty">맵의 메시지가 모두 켜져 있습니다.</div> : (
              <div className="b2b-table-wrap crm-dz-table">
                <table className="b2b-table">
                  <thead><tr><th>맵 메시지</th><th>utm_campaign</th><th>데이터라이즈 캠페인</th><th /></tr></thead>
                  <tbody>
                    {check.off.map((m) => (
                      <tr key={m.id}>
                        <td className="crm-dz-name">{m.title}</td>
                        <td className="crm-dz-utm">{m.campaign}</td>
                        <td className="crm-dz-name">{m.campaigns.map((c) => `${c.name}(${DTR_STATUS[c.status] || c.status})`).join(", ")}</td>
                        <td className="actions sm-nowrap"><button type="button" className="b2b-link-btn" onClick={() => onOpenMessage(m.id)}>메시지 열기</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>)}
        </div>
        <div className="b2b-modal-foot">
          <button type="button" className="b2b-btn-secondary" onClick={() => load(true)} disabled={loading}>{loading ? "확인 중" : "다시 확인"}</button>
          <div className="b2b-modal-foot-right"><button type="button" className="b2b-btn-secondary" onClick={onClose}>닫기</button></div>
        </div>
      </div>
    </div>
  );
}

// ── 드로어 안 — 이 메시지로 지금 나가는 실제 소재 ──
type Creative = { campaignId: string; id: string; name: string; format: string; status: string; title: string; header: string; message: string; buttons: { label: string; url: string }[]; campaign: string; campaignStatus: string; channel: string; audience: string; sendTime: string };
export function DatarizeCreatives({ messageId, campaign }: { messageId: string; campaign: string }) {
  const [list, setList] = useState<Creative[] | null>(null);
  const [error, setError] = useState("");
  const [off, setOff] = useState(false); // 키가 없으면 구역을 그리지 않는다
  useEffect(() => {
    let alive = true;
    setList(null); setError("");
    if (!campaign.trim()) { setList([]); return; }
    fetch(`/api/crm/datarize?message=${encodeURIComponent(messageId)}`, { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!alive) return;
      if (!j.ok) throw new Error(j.error);
      if (!j.configured) { setOff(true); return; }
      setList(j.creatives || []);
    }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : "데이터라이즈 소재를 불러오지 못했습니다."); });
    return () => { alive = false; };
  }, [messageId, campaign]);
  if (off || (list && list.length === 0 && !error)) return null; // 데이터라이즈로 보내는 메시지가 아니면 구역 자체가 없다
  return (
    <section className="crm-sec">
      <div className="crm-sec-title">데이터라이즈 실제 소재{list ? ` ${qty(list.length)}개` : ""}</div>
      {error && <div className="b2b-error">{error}</div>}
      {!list && !error && <div className="crm-ga-line">불러오는 중...</div>}
      {list?.map((c) => {
        const on = c.campaignStatus === "active" && c.status === "active";
        return (
          <div className="crm-dz-creative" key={`${c.campaignId}:${c.id}`}>
            <div className="crm-dz-creative-head">
              <span className="b2b-status-pill" style={on ? { background: "var(--sm-success-bg)", color: "var(--sm-success)" } : { background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{on ? "켜짐" : DTR_STATUS[c.campaignStatus === "active" ? c.status : c.campaignStatus] || "꺼짐"}</span>
              <span className="crm-dz-creative-name">{c.campaign}</span>
            </div>
            <div className="crm-ga-line">{[DTR_CHANNEL[c.channel] || c.channel, c.audience && `대상 ${c.audience}`, c.sendTime && `${c.sendTime} 발송`, c.name].filter(Boolean).join(" · ")}</div>
            {(c.header || c.title) && <div className="crm-dz-creative-title">{[c.header, c.title].filter(Boolean).join(" · ")}</div>}
            {c.message && <div className="crm-dz-creative-msg">{c.message}</div>}
            {c.buttons.length > 0 && <div className="crm-ga-line">{c.buttons.map((b, i) => <div key={i} className="crm-dz-btn">[{b.label || "버튼"}] {b.url}</div>)}</div>}
          </div>
        );
      })}
    </section>
  );
}
