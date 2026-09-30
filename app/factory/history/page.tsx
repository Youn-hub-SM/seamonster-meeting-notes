"use client";

// 파도소리 히스토리 — 입고·출고·조정 기록(거래일 기준) + 기록 취소 + 품목 변경(등록·수정·원가·판매가·삭제).
//  기록 취소는 모든 계정이 할 수 있고, 취소한 기록은 지워지지 않고 '취소됨'으로 남는다.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchKoQuery } from "@/app/lib/hangul";
import { HIST_COLOR, FIELD_LABEL, boxStr, kgStr, lotLabel, type HistEvent, type HistKind } from "@/app/lib/factory";
import { today, daysAgo } from "../util";

const KINDS: ("전체" | HistKind)[] = ["전체", "입고", "출고", "조정", "취소", "변경"];
const PRESETS = [["오늘", 0], ["7일", 6], ["30일", 29]] as const;

const hm = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "");
const money = (field: string, v: string | null | undefined) =>
  v == null ? "없음" : (field === "cost" || field === "price") && /^\d+$/.test(v) ? `${Number(v).toLocaleString("ko-KR")}원` : v;
// 입력 시각 — 기록일과 같은 날이면 시:분만, 다르면 '월-일 시:분 입력'
const stamp = (e: HistEvent) => { const s = hm(e.at); return s.slice(0, 5) === e.date.slice(5) ? s.slice(6) : `${s} 입력`; };
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("ko-KR")}`;

// 이벤트 한 줄 설명
function describe(e: HistEvent): string {
  if (e.kind === "변경") {
    const f = e.field || "";
    if (f === "등록") return `품목 등록${e.new_value ? ` (${e.new_value})` : ""}`;
    if (f === "삭제") return "품목 삭제";
    return `${FIELD_LABEL[f] || f} ${money(f, e.old_value)} → ${money(f, e.new_value)}`;
  }
  const lot = lotLabel({ mfg_date: e.mfg_date ?? null, box_kg: e.box_kg ?? 0 });
  const head = e.kind === "취소" ? `${e.txn_type} 기록 취소 · ` : "";
  const adj = e.txn_type === "조정" && e.target != null && e.boxes != null ? ` · 실사 ${e.target}박스(이전 ${e.target - e.boxes})` : "";
  return `${head}${lot}${adj}${e.partner ? ` · ${e.partner}` : ""}`;
}

export default function FactoryHistoryPage() {
  const [events, setEvents] = useState<HistEvent[]>([]);
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const [kind, setKind] = useState<"전체" | HistKind>("전체");
  const [kw, setKw] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [capped, setCapped] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0); // 기간을 빨리 바꿀 때 늦게 온 이전 응답이 덮어쓰지 않게

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setError("");
    try {
      const j = await (await fetch(`/api/factory/txns?from=${from}&to=${to}`, { cache: "no-store" })).json();
      if (my !== seq.current) return;
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setEvents(j.events || []);
      setCapped(!!j.capped);
    } catch (e) { if (my === seq.current) setError(e instanceof Error ? e.message : "조회 오류"); }
    if (my === seq.current) setLoading(false);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => {
    const q = kw.trim();
    return events
      .filter((e) => kind === "전체" || e.kind === kind)
      .filter((e) => !q || matchKoQuery(`${e.name || ""} ${e.sku || ""} ${e.who || ""} ${e.partner || ""} ${e.memo || ""}`, q));
  }, [events, kind, kw]);

  // 기간 합계 — 거래일이 기간 안이고 취소 안 된 기록만(입력만 기간 안인 지난 날짜 기록은 빼고)
  const sums = useMemo(() => {
    const s = { 입고: 0, 출고: 0, 조정: 0 };
    for (const e of events)
      if ((e.kind === "입고" || e.kind === "출고" || e.kind === "조정") && !e.cancelled_at && e.date >= from && e.date <= to) s[e.kind] += e.boxes || 0;
    return s;
  }, [events, from, to]);

  async function cancel(e: HistEvent) {
    if (!e.txn_id) return;
    if (!confirm(`이 ${e.txn_type} 기록을 취소할까요?\n${e.name} · ${describe(e)} · ${boxStr(e.boxes || 0)}`)) return;
    setBusy(e.txn_id); setError(""); setNotice("");
    try {
      const res = await fetch(`/api/factory/txns/${e.txn_id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "취소 실패");
      setNotice("기록을 취소했습니다.");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "취소 실패"); }
    setBusy(null);
  }

  const isTxn = (e: HistEvent) => e.kind === "입고" || e.kind === "출고" || e.kind === "조정";
  const pill = (e: HistEvent) => (
    <span className="b2b-status-pill" style={{ background: HIST_COLOR[e.kind].bg, color: HIST_COLOR[e.kind].fg }}>{e.kind}</span>
  );
  // 취소 = 그 기록의 반대 효과(입고 3박스 취소 → −3박스)
  const qty = (e: HistEvent) => {
    if (e.boxes == null || e.kind === "변경") return null;
    const b = e.kind === "취소" ? -e.boxes : e.boxes;
    return { b, kg: b * (e.box_kg || 0) };
  };
  const cancelBtn = (e: HistEvent) => isTxn(e) && !e.cancelled_at ? (
    <button className="b2b-link-btn fac-cancel" disabled={busy === e.txn_id} onClick={() => cancel(e)}>{busy === e.txn_id ? "취소 중..." : "기록 취소"}</button>
  ) : null;
  const cancelledNote = (e: HistEvent) => isTxn(e) && e.cancelled_at
    ? <span className="fac-cancelled">취소됨 · {e.cancelled_by || "-"} · {hm(e.cancelled_at)}</span> : null;

  return (
    <div className="b2b-container fac-hist">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">히스토리</h1>
          <p className="b2b-page-subtitle">입고 {boxStr(sums.입고)} · 출고 {boxStr(Math.abs(sums.출고))} · 조정 {signed(sums.조정)}박스</p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {notice && <div className="sm-success">{notice}</div>}

      <div className="fac-toolbar">
        <div className="sm-tabs">
          {PRESETS.map(([label, n]) => (
            <button key={label} type="button" className={`sm-tab ${from === daysAgo(n) && to === today() ? "is-active" : ""}`}
              onClick={() => { setFrom(daysAgo(n)); setTo(today()); }}>{label}</button>
          ))}
        </div>
        <div className="fac-range">
          <input type="date" className="b2b-input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <span className="sm-faint">~</span>
          <input type="date" className="b2b-input" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <div className="fac-toolbar">
        <div className="sm-tabs">
          {KINDS.map((k) => (
            <button key={k} type="button" className={`sm-tab ${kind === k ? "is-active" : ""}`} onClick={() => setKind(k)}>{k}</button>
          ))}
        </div>
        <input className="b2b-input fac-search" value={kw} onChange={(e) => setKw(e.target.value)} placeholder="품목·SKU·담당·메모 검색" />
      </div>
      {capped && <div className="sm-warn">기록이 많아 일부만 보입니다 — 기간을 줄이세요.</div>}

      {loading ? <div className="b2b-loading">불러오는 중...</div> : list.length === 0 ? (
        <div className="b2b-empty">해당 기간 기록이 없습니다.</div>
      ) : (
        <>
          <div className="b2b-table-wrap fac-hist-table">
            <table className="b2b-table">
              <thead><tr>
                <th>날짜</th><th>유형</th><th>품목</th><th>내용</th>
                <th className="num">박스</th><th className="num">중량</th><th>담당</th><th>메모</th><th></th>
              </tr></thead>
              <tbody>
                {list.map((e) => {
                  const q = qty(e);
                  return (
                    <tr key={e.key} className={e.cancelled_at && isTxn(e) ? "fac-row-cancelled" : ""}>
                      <td className="sm-nowrap">{e.date}<div className="fac-sub">{stamp(e)}</div></td>
                      <td>{pill(e)}</td>
                      <td><strong>{e.name || "-"}</strong><div className="fac-sub">{e.sku || ""}</div></td>
                      <td>{describe(e)}{cancelledNote(e) && <div>{cancelledNote(e)}</div>}</td>
                      <td className="num fac-num">{q ? signed(q.b) : "-"}</td>
                      <td className="num fac-num">{q ? `${q.kg > 0 ? "+" : ""}${kgStr(q.kg)}` : "-"}</td>
                      <td className="sm-nowrap">{e.who || "-"}</td>
                      <td className="sm-faint">{e.memo || "-"}</td>
                      <td className="sm-nowrap">{cancelBtn(e)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="fac-list">
            {list.map((e) => {
              const q = qty(e);
              return (
                <div key={e.key} className={`fac-hist-item ${e.cancelled_at && isTxn(e) ? "fac-row-cancelled" : ""}`}>
                  <div className="fac-hist-top">
                    {pill(e)}
                    <span className="fac-hist-name">{e.name || "-"}</span>
                    {q && <span className="fac-hist-qty fac-num">{signed(q.b)}<small>박스</small></span>}
                  </div>
                  <div className="fac-hist-desc">{describe(e)}{q ? ` · ${q.kg > 0 ? "+" : ""}${kgStr(q.kg)}` : ""}</div>
                  <div className="fac-hist-meta">
                    <span>{e.date} {stamp(e)}</span>
                    <span>{e.who || "-"}</span>
                    {e.memo && <span>{e.memo}</span>}
                  </div>
                  {(cancelledNote(e) || cancelBtn(e)) && (
                    <div className="fac-hist-foot">{cancelledNote(e)}{cancelBtn(e)}</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
