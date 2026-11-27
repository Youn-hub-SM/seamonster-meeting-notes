"use client";

// 파도소리 입고 및 출고 — 씨몬스터 업무도우미 '입고 및 출고'와 같은 틀(2026-11-27 대표 지시).
//  머리에 [입고][출고][조정](·보관처가 둘 이상이면 [이동]) → 재고 목록과 같은 기록 창(TxnForm). 아래 '입고·출고 내역' 카드에
//  기록(입고·출고·조정)만 보인다 — 품목 변경·취소 이력까지는 히스토리 메뉴. 기록 취소는 여기서도 된다.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchKoQuery, hangulInputValue } from "@/app/lib/hangul";
import { DEFAULT_FACTORY_FIELDS, DEFAULT_STORAGE, HIST_COLOR, kgStr, signedKg, type FactoryFields, type HistEvent, type StockRow } from "@/app/lib/factory";
import TxnForm from "../TxnForm";
import { today, daysAgo } from "../util";
import { describe, hm, qtyBox, qtyKg, stamp } from "../hist-util";

type FormType = React.ComponentProps<typeof TxnForm>["initialType"];
type Tab = "전체" | "입고" | "출고" | "조정";
const TABS: Tab[] = ["전체", "입고", "출고", "조정"];
const PRESETS = [["오늘", 0, 0], ["어제", 1, 1], ["7일", 6, 0], ["30일", 29, 0]] as const;

export default function FactoryTradePage() {
  // 기록 창에 줄 재고·설정 — 재고 목록과 같은 출처
  const [rows, setRows] = useState<StockRow[]>([]);
  const [fields, setFields] = useState<FactoryFields>(DEFAULT_FACTORY_FIELDS);
  const [suggest, setSuggest] = useState<{ partners: string[]; tape_colors: string[] }>({ partners: [], tape_colors: [] });
  const [kinds, setKinds] = useState(false);
  const [storages, setStorages] = useState<string[]>([DEFAULT_STORAGE]);
  const [admin, setAdmin] = useState(false);
  const [form, setForm] = useState<{ type: FormType } | null>(null);
  const [notice, setNotice] = useState("");
  const [doc, setDoc] = useState<{ batch_id: string; doc_no: string } | null>(null);
  const [error, setError] = useState("");

  // 내역
  const [events, setEvents] = useState<HistEvent[]>([]);
  const [tab, setTab] = useState<Tab>("전체");
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const [kw, setKw] = useState("");
  const [loading, setLoading] = useState(true);
  const [capped, setCapped] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const loadStock = useCallback(async () => {
    try {
      const j = await (await fetch("/api/factory/stock", { cache: "no-store" })).json();
      if (j.ok) setRows(j.rows || []); else setError(j.error || "재고를 불러오지 못했습니다. 새로고침하세요.");
    } catch { setError("재고를 불러오지 못했습니다. 새로고침하세요."); }
  }, []);
  const loadFields = useCallback(async () => {
    try {
      const j = await (await fetch("/api/factory/fields", { cache: "no-store" })).json();
      if (j.ok) {
        setFields(j.fields); setSuggest({ partners: j.partners || [], tape_colors: j.tape_colors || [] });
        setKinds(!!j.kinds); setAdmin(!!j.admin);
        if (Array.isArray(j.storages) && j.storages.length) setStorages(j.storages);
      }
    } catch { /* 설정을 못 읽으면 기본값 */ }
  }, []);
  const loadEvents = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const j = await (await fetch(`/api/factory/txns?from=${from}&to=${to}`, { cache: "no-store" })).json();
      if (my !== seq.current) return;
      if (!j.ok) throw new Error(j.error || "내역을 불러오지 못했습니다. 새로고침하세요.");
      // 기록만 — 취소·품목 변경 이벤트는 히스토리에서
      setEvents(((j.events || []) as HistEvent[]).filter((e) => e.kind === "입고" || e.kind === "출고" || e.kind === "조정"));
      setCapped(!!j.capped);
    } catch (e) { if (my === seq.current) setError(e instanceof Error ? e.message : "내역을 불러오지 못했습니다. 새로고침하세요."); }
    if (my === seq.current) setLoading(false);
  }, [from, to]);
  useEffect(() => { loadStock(); loadFields(); }, [loadStock, loadFields]);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  const list = useMemo(() => {
    const q = kw.trim();
    return events
      .filter((e) => tab === "전체" || e.kind === tab)
      .filter((e) => !q || matchKoQuery(`${e.name || ""} ${e.sku || ""} ${e.who || ""} ${e.partner || ""} ${e.tape_color || ""} ${e.memo || ""}`, q));
  }, [events, tab, kw]);
  const canMove = kinds && storages.length > 1;
  const openForm = (type: FormType) => { setNotice(""); setDoc(null); setError(""); setForm({ type }); };

  async function cancel(e: HistEvent) {
    if (!e.txn_id) return;
    if (!confirm(`이 ${e.txn_type} 기록을 취소할까요?\n${e.name} · ${describe(e)} · ${signedKg(e.kg || 0)}`)) return;
    setBusy(e.txn_id); setError(""); setNotice("");
    try {
      const res = await fetch(`/api/factory/txns/${e.txn_id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "취소 실패");
      setNotice("기록을 취소했습니다.");
      await Promise.all([loadEvents(), loadStock()]);
    } catch (err) { setError(err instanceof Error ? err.message : "취소 실패"); }
    setBusy(null);
  }

  const pill = (e: HistEvent) => <span className="b2b-status-pill" style={{ background: HIST_COLOR[e.kind].bg, color: HIST_COLOR[e.kind].fg }}>{e.kind}</span>;
  const cancelBtn = (e: HistEvent) => !e.cancelled_at ? (
    <button className="b2b-link-btn fac-cancel" disabled={busy === e.txn_id} onClick={() => cancel(e)}>{busy === e.txn_id ? "취소 중..." : "기록 취소"}</button>
  ) : null;
  // 출고증 — 취소 안 된 매출 출고(구분 없는 옛 출고 포함)
  const docBtn = (e: HistEvent) => kinds && e.kind === "출고" && !e.cancelled_at && e.batch_id && (!e.txn_kind || e.txn_kind === "매출") ? (
    <a className="b2b-link-btn" href={`/factory/outdoc?batch=${e.batch_id}`} target="_blank" rel="noreferrer">출고증</a>
  ) : null;
  const cancelledNote = (e: HistEvent) => e.cancelled_at ? <span className="fac-cancelled">취소됨 · {e.cancelled_by || "-"} · {hm(e.cancelled_at)}</span> : null;

  return (
    <div className="b2b-container fac-stock fac-trade">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">입고 및 출고</h1></div>
        <div className="b2b-page-actions fac-head-actions">
          <button className="b2b-btn-primary" onClick={() => openForm("입고")}>입고</button>
          <button className="b2b-btn-secondary" onClick={() => openForm("출고")}>출고</button>
          <button className="b2b-btn-secondary" onClick={() => openForm("조정")}>조정</button>
          {canMove && <button className="b2b-btn-secondary" onClick={() => openForm("이동")}>이동</button>}
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {notice && (
        <div className="sm-success">
          {notice}
          {doc && <> · <a className="b2b-link-btn" href={`/factory/outdoc?batch=${doc.batch_id}`} target="_blank" rel="noreferrer">출고증 {doc.doc_no}</a></>}
        </div>
      )}

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">입고·출고 내역</span></div>

        <div className="fac-toolbar">
          <div className="sm-tabs">
            {TABS.map((t) => <button key={t} type="button" className={`sm-tab ${tab === t ? "is-active" : ""}`} onClick={() => setTab(t)}>{t}</button>)}
          </div>
          <div className="sm-tabs">
            {PRESETS.map(([label, a, b]) => (
              <button key={label} type="button" className={`sm-tab ${from === daysAgo(a) && to === daysAgo(b) ? "is-active" : ""}`}
                onClick={() => { setFrom(daysAgo(a)); setTo(daysAgo(b)); }}>{label}</button>
            ))}
          </div>
          <div className="fac-range">
            <input type="date" className="b2b-input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <span className="sm-faint">~</span>
            <input type="date" className="b2b-input" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <input className="b2b-input fac-search" value={kw} onChange={(e) => setKw(hangulInputValue(e))} placeholder="품목·SKU·거래처 검색" />
        </div>
        {capped && <div className="sm-warn">기록이 많아 일부만 보입니다 — 기간을 줄이세요.</div>}

        {loading && events.length === 0 ? <div className="b2b-loading">불러오는 중...</div> : list.length === 0 ? (
          <div className="b2b-empty">{events.length === 0 ? "이 기간에 입고·출고 기록이 없습니다." : "조건에 맞는 기록이 없습니다."}</div>
        ) : (
          <>
            <div className="b2b-table-wrap fac-hist-table">
              <table className="b2b-table">
                <thead><tr>
                  <th>날짜</th><th>유형</th><th>품목</th><th>내용</th>
                  <th className="num">kg</th><th className="num">박스</th><th>담당</th><th>메모</th><th></th>
                </tr></thead>
                <tbody>
                  {list.map((e) => {
                    const q = qtyKg(e);
                    return (
                      <tr key={e.key} className={e.cancelled_at ? "fac-row-cancelled" : ""}>
                        <td className="sm-nowrap">{e.date}<div className="fac-sub">{stamp(e)}</div></td>
                        <td>{pill(e)}</td>
                        <td><strong>{e.name || "-"}</strong><div className="fac-sub">{e.sku || ""}</div></td>
                        <td>{describe(e)}{cancelledNote(e) && <div>{cancelledNote(e)}</div>}</td>
                        <td className="num fac-num">{q == null ? "-" : signedKg(q)}</td>
                        <td className="num fac-num">{qtyBox(e) ?? "-"}</td>
                        <td className="sm-nowrap">{e.who || "-"}</td>
                        <td className="sm-faint">{e.memo || "-"}</td>
                        <td className="sm-nowrap">{docBtn(e)}{cancelBtn(e)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="fac-list">
              {list.map((e) => {
                const q = qtyKg(e);
                return (
                  <div key={e.key} className={`fac-hist-item ${e.cancelled_at ? "fac-row-cancelled" : ""}`}>
                    <div className="fac-hist-top">
                      {pill(e)}
                      <span className="fac-hist-name">{e.name || "-"}</span>
                      {q != null && <span className="fac-hist-qty fac-num">{signedKg(q)}</span>}
                    </div>
                    <div className="fac-hist-desc">{describe(e)}{qtyBox(e) ? ` · ${qtyBox(e)}` : ""}</div>
                    <div className="fac-hist-meta">
                      <span>{e.date} {stamp(e)}</span>
                      <span>{e.who || "-"}</span>
                      {e.memo && <span>{e.memo}</span>}
                    </div>
                    {(cancelledNote(e) || docBtn(e) || cancelBtn(e)) && (
                      <div className="fac-hist-foot">{cancelledNote(e)}<span>{docBtn(e)}{cancelBtn(e)}</span></div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {form && (
        <TxnForm rows={rows} initialType={form.type}
          fields={fields} suggest={suggest} onFields={setFields}
          kinds={kinds} storages={storages} admin={admin} onStorages={setStorages}
          onClose={() => setForm(null)}
          onSaved={(msg, d) => { setForm(null); setNotice(msg); setDoc(d || null); loadStock(); loadFields(); loadEvents(); }} />
      )}
    </div>
  );
}
