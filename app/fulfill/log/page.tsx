"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BOX_CATEGORIES } from "@/app/lib/order-fulfill";
import { DEFAULT_RATES, DEFAULT_EFFECTIVE, ratesFor, type RateVersion } from "@/app/lib/fulfill-rates";
import { mergeCounts, manualFeeDelta, sumCounts, type ManualEntry, type RecordEntry } from "@/app/lib/delivery-log";

type Boxes = Record<string, number>;
type Row = {
  log_date: string;
  boxes_normal: Boxes; boxes_guar: Boxes;            // 최종(자동+보정) — 서버 병합
  base_fee_normal: number; base_fee_guar: number;    // 최종 기본운임
  boxes_normal_auto: Boxes; boxes_guar_auto: Boxes;  // 자동입력(발주처리 기록, 수정 불가)
  base_fee_normal_auto: number; base_fee_guar_auto: number;
  boxes_normal_manual: Boxes; boxes_guar_manual: Boxes; // 직접수정 보정 합(±, 내역 합산)
  manual_entries: ManualEntry[];                     // 건별 내역(사유 포함)
  record_entries: RecordEntry[];                     // 자동입력 배치 이력(되돌리기용)
  manual_updated_at: string | null;                  // 직접수정 최종 시각
  extra_fee: number; guar_extra_fee: number; pado_fee: number; pado_extra: number; pado_cod: number;
  dryice_full: number; dryice_half: number; memo: string | null;
};
type EditKey = "base_fee_normal" | "base_fee_guar" | "extra_fee" | "guar_extra_fee" | "pado_fee" | "pado_extra" | "pado_cod" | "dryice_full" | "dryice_half" | "memo";

const won = (n: unknown) => (Number(n) || 0).toLocaleString();
const sumBoxes = (o: Boxes) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
// 직접수정 최종 시각 — KST 초 단위 "YYYY-MM-DD HH:mm:ss"
const kstStamp = (iso: string): string => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 19)}`;
};
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const weekday = (iso: string) => WD[new Date(`${iso}T00:00:00`).getDay()];
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const kstDate = (back = 0) => { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - back); return d; };
const isoOf = (d: Date) => d.toISOString().slice(0, 10);
// 기간 프리셋(KST 기준)
const PRESETS: { key: string; range: () => { from: string; to: string } }[] = [
  { key: "오늘", range: () => ({ from: kstToday(), to: kstToday() }) },
  { key: "어제", range: () => { const y = isoOf(kstDate(1)); return { from: y, to: y }; } },
  { key: "7일", range: () => ({ from: isoOf(kstDate(6)), to: kstToday() }) },
  { key: "14일", range: () => ({ from: isoOf(kstDate(13)), to: kstToday() }) },
  { key: "지난달", range: () => { const n = kstDate(0); return { from: isoOf(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1))), to: isoOf(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0))) }; } },
  { key: "이번달", range: () => { const n = kstDate(0); return { from: isoOf(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1))), to: kstToday() }; } },
];

export default function DeliveryLogPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [range, setRange] = useState({ from: "", to: "" });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preset, setPreset] = useState("");
  const [newDate, setNewDate] = useState(kstToday());
  const applyPreset = (p: { key: string; range: () => { from: string; to: string } }) => { const r = p.range(); setFrom(r.from); setTo(r.to); setPreset(p.key); };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Record<string, Partial<Record<EditKey, string>>>>({});
  // 직접수정 내역 추가 모달
  const [entryFor, setEntryFor] = useState<string | null>(null); // 대상 날짜
  const [eSide, setESide] = useState<"n" | "g">("n");
  const [eCat, setECat] = useState<string>(BOX_CATEGORIES[0]);
  const [eMode, setEMode] = useState<"add" | "sub">("add");
  const [eQty, setEQty] = useState("1");
  const [eNote, setENote] = useState("");
  const [eBusy, setEBusy] = useState(false);
  const [history, setHistory] = useState<RateVersion[]>([{ ...DEFAULT_RATES, effectiveFrom: DEFAULT_EFFECTIVE }]);
  useEffect(() => { fetch("/api/fulfill/rates", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok && j.history?.length) setHistory(j.history); }).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = new URLSearchParams(); if (from) p.set("from", from); if (to) p.set("to", to);
      const j = await (await fetch(`/api/fulfill/log?${p.toString()}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []); setRange({ from: j.from, to: j.to }); setDraft({});
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  // 최신 상태 ref — 디바운스 저장 시 stale 클로저 방지
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const draftRef = useRef(draft); draftRef.current = draft;
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // 저장 직렬화 — 같은 날짜의 저장이 겹치면(연타·느린 네트워크) 오래된 응답이 최신 값을 덮어쓰지 않도록.
  const running = useRef<Set<string>>(new Set());
  const rerun = useRef<Set<string>>(new Set());
  const runExclusive = useCallback(async (key: string, fn: () => Promise<void>) => {
    if (running.current.has(key)) { rerun.current.add(key); return; } // 진행 중이면 끝난 뒤 한 번 더
    running.current.add(key);
    try { await fn(); } finally {
      running.current.delete(key);
      if (rerun.current.has(key)) { rerun.current.delete(key); runExclusive(key, fn); }
    }
  }, []);

  const cur = (r: Row, k: EditKey): number => Number(draft[r.log_date]?.[k] ?? (r[k] as number)) || 0;
  const curMemo = (r: Row): string => draft[r.log_date]?.memo ?? (r.memo ?? "");
  const setField = (date: string, k: EditKey, v: string) => setDraft((d) => ({ ...d, [date]: { ...d[date], [k]: v } }));

  // 직접수정 보정 합(± = 내역 합산, 서버 병합값)
  const curManualMap = (r: Row, side: "n" | "g"): Boxes => (side === "n" ? r.boxes_normal_manual : r.boxes_guar_manual) || {};
  // 최종 택배량 = 자동입력 + 보정(0 미만 방지)
  const finalBoxes = (r: Row, side: "n" | "g"): Boxes =>
    mergeCounts(side === "n" ? r.boxes_normal_auto : r.boxes_guar_auto, curManualMap(r, side));
  // 최종 기본운임 = 자동 운임(발주처리 주문 단위 정밀값) + 보정분(박스종류 대표단가). 도착보장 보정엔 가산 포함.
  const baseNormalOf = (r: Row): number =>
    Math.max(0, (Number(r.base_fee_normal_auto) || 0) + manualFeeDelta(curManualMap(r, "n"), ratesFor(history, r.log_date).boxTiers));
  const baseGuarOf = (r: Row): number => {
    const rt = ratesFor(history, r.log_date); const m = curManualMap(r, "g");
    return Math.max(0, (Number(r.base_fee_guar_auto) || 0) + manualFeeDelta(m, rt.boxTiers) + rt.guarSurcharge * sumCounts(m));
  };

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json(); if (!j.ok) throw new Error(j.error || "저장 실패");
  }

  async function save(date: string) {
    await runExclusive("f:" + date, async () => {
      const snap = draftRef.current[date]; if (!snap) return;
      try {
        await post({ log_date: date, ...snap });
        setRows((rs) => rs.map((r) => (r.log_date === date ? applyDraft(r, snap) : r)));
        // 방금 저장한 값과 같은 칸만 초기화 — 저장 중 바꾼 값은 유지(원복 방지)
        setDraft((prev) => reconcileFieldDraft(prev, date, snap));
      } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    });
  }

  // 직접수정 내역 추가 모달 열기
  function openEntry(date: string) {
    setEntryFor(date); setESide("n"); setECat(BOX_CATEGORIES[0]); setEMode("add"); setEQty("1"); setENote("");
  }
  async function addEntry() {
    if (!entryFor) return;
    const qty = Math.abs(Math.round(Number(eQty) || 0)) * (eMode === "sub" ? -1 : 1);
    if (qty === 0 || !eNote.trim()) return;
    setEBusy(true);
    try {
      const res = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ log_date: entryFor, add_entry: { side: eSide, category: eCat, qty, note: eNote.trim() } }) });
      const j = await res.json(); if (!j.ok) throw new Error(j.error || "추가 실패");
      const stamp = new Date().toISOString();
      setRows((rs) => rs.map((r) => {
        if (r.log_date !== entryFor) return r;
        const key = eSide === "n" ? "boxes_normal_manual" : "boxes_guar_manual";
        const agg = { ...(r[key] as Boxes) };
        const v = (agg[eCat] || 0) + qty; if (v === 0) delete agg[eCat]; else agg[eCat] = v;
        return { ...r, [key]: agg, manual_entries: j.entries || [...(r.manual_entries || []), j.entry], manual_updated_at: stamp };
      }));
      setEntryFor(null);
    } catch (e) { setError(e instanceof Error ? e.message : "추가 실패"); }
    setEBusy(false);
  }
  // 자동입력 배치 기록 되돌리기 — 그 배치의 박스·운임 기여분이 합계에서 빠진다
  async function delRecord(date: string, entry: RecordEntry) {
    const label = entry.mode === "baseline" ? "이전 기록 합계" : entry.mode === "replace" ? "덮어쓰기 기록" : "더하기 기록";
    if (!window.confirm(`이 ${label}을 되돌릴까요?\n일반 ${sumBoxes(entry.boxes_normal)}박스 · 도착보장 ${sumBoxes(entry.boxes_guar)}박스 · 운임 ${won(entry.base_fee_normal + entry.base_fee_guar)}원이 합계에서 빠집니다.`)) return;
    try {
      const res = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ log_date: date, del_record: { id: entry.id } }) });
      const j = await res.json(); if (!j.ok) throw new Error(j.error || "되돌리기 실패");
      setRows((rs) => rs.map((r) => (r.log_date === date ? {
        ...r,
        record_entries: j.entries || [],
        boxes_normal_auto: j.boxes_normal || {}, boxes_guar_auto: j.boxes_guar || {},
        base_fee_normal_auto: j.base_fee_normal || 0, base_fee_guar_auto: j.base_fee_guar || 0,
      } : r)));
    } catch (e) { setError(e instanceof Error ? e.message : "되돌리기 실패"); }
  }

  async function delEntry(date: string, entry: ManualEntry) {
    if (!window.confirm(`이 보정을 삭제할까요?\n${entry.side === "n" ? "일반" : "도착보장"} · ${entry.category} · ${entry.qty > 0 ? "+" : ""}${entry.qty} · ${entry.note}`)) return;
    try {
      const res = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ log_date: date, del_entry: { id: entry.id } }) });
      const j = await res.json(); if (!j.ok) throw new Error(j.error || "삭제 실패");
      const stamp = new Date().toISOString();
      setRows((rs) => rs.map((r) => {
        if (r.log_date !== date) return r;
        const key = entry.side === "n" ? "boxes_normal_manual" : "boxes_guar_manual";
        const agg = { ...(r[key] as Boxes) };
        const v = (agg[entry.category] || 0) - entry.qty; if (v === 0) delete agg[entry.category]; else agg[entry.category] = v;
        return { ...r, [key]: agg, manual_entries: (r.manual_entries || []).filter((e) => e.id !== entry.id), manual_updated_at: stamp };
      }));
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
  }

  // 디바운스 저장(연타 후 한 번만 저장)
  const schedule = (key: string, fn: () => void, ms = 500) => { clearTimeout(timers.current[key]); timers.current[key] = setTimeout(fn, ms); };
  const scheduleSave = (date: string) => schedule("f:" + date, () => save(date));

  function bumpField(date: string, k: EditKey, delta: number) {
    setDraft((d) => {
      const s = d[date]?.[k];
      const base = s !== undefined ? Number(s) || 0 : Number(rowsRef.current.find((r) => r.log_date === date)?.[k]) || 0;
      return { ...d, [date]: { ...d[date], [k]: String(Math.max(0, base + delta)) } };
    });
    scheduleSave(date);
  }
  const stepField = (r: Row, k: EditKey, w = 40) => (
    <Stepper value={draft[r.log_date]?.[k] ?? String((r[k] as number) || "")} onBump={(d) => bumpField(r.log_date, k, d)}
      onType={(v) => { setField(r.log_date, k, v); scheduleSave(r.log_date); }} onCommit={() => save(r.log_date)} w={w} />
  );
  async function addDay() {
    if (!newDate) return;
    if (rows.some((r) => r.log_date === newDate)) { setError("이미 있는 날짜입니다."); setOpen((s) => new Set(s).add(newDate)); return; }
    try {
      await post({ log_date: newDate });
      const blank: Row = {
        log_date: newDate, boxes_normal: {}, boxes_guar: {}, base_fee_normal: 0, base_fee_guar: 0,
        boxes_normal_auto: {}, boxes_guar_auto: {}, base_fee_normal_auto: 0, base_fee_guar_auto: 0,
        boxes_normal_manual: {}, boxes_guar_manual: {}, manual_entries: [], record_entries: [], manual_updated_at: null,
        extra_fee: 0, guar_extra_fee: 0, pado_fee: 0, pado_extra: 0, pado_cod: 0, dryice_full: 0, dryice_half: 0, memo: null,
      };
      setRows((rs) => [blank, ...rs.filter((r) => r.log_date !== newDate)].sort((a, b) => b.log_date.localeCompare(a.log_date)));
      setOpen((s) => new Set(s).add(newDate));
    } catch (e) { setError(e instanceof Error ? e.message : "추가 실패"); }
  }

  async function removeDay(date: string) {
    if (!window.confirm(`${date} 배송일지 행을 삭제할까요?`)) return;
    try {
      const res = await fetch(`/api/fulfill/log?log_date=${date}`, { method: "DELETE" });
      const j = await res.json(); if (!j.ok) throw new Error(j.error);
      setRows((rs) => rs.filter((r) => r.log_date !== date));
      setDraft((prev) => { const n = { ...prev }; delete n[date]; return n; });
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
  }

  // 채널별 운임 = 기본운임 + 추가운임(제주·도서산간 등 수동 가산). 파도는 착불 포함. 총 운임 공식은 기존과 동일.
  const normalFee = (r: Row) => baseNormalOf(r) + cur(r, "extra_fee");                 // 씨몬 일반 = 택배량 자동 기본운임 + 추가운임
  const guarFee = (r: Row) => baseGuarOf(r) + cur(r, "guar_extra_fee");                 // 도착보장 = 택배량 자동 기본운임(가산 포함) + 추가운임
  const padoFee = (r: Row) => cur(r, "pado_fee") + cur(r, "pado_extra") + cur(r, "pado_cod");     // 파도(기본+추가+착불)
  const feeTotal = (r: Row) => normalFee(r) + guarFee(r) + padoFee(r);
  const dryAmt = (r: Row) => { const rt = ratesFor(history, r.log_date); return cur(r, "dryice_full") * rt.dryFull + cur(r, "dryice_half") * rt.dryHalf; }; // 그 날짜에 유효했던 드라이 단가
  const toggle = (date: string) => setOpen((s) => { const n = new Set(s); if (n.has(date)) n.delete(date); else n.add(date); return n; });

  const totals = useMemo(() => ({
    normal: rows.reduce((s, r) => s + sumBoxes(finalBoxes(r, "n")), 0),
    guar: rows.reduce((s, r) => s + sumBoxes(finalBoxes(r, "g")), 0),
    fee: rows.reduce((s, r) => s + feeTotal(r), 0),
    dry: rows.reduce((s, r) => s + dryAmt(r), 0),
  }), [rows, draft, history]); // eslint-disable-line react-hooks/exhaustive-deps

  const numInput = (r: Row, k: EditKey, w = 76) => (
    <input type="number" className="b2b-input b2b-money" style={{ width: w, padding: "4px 6px", fontSize: 12, textAlign: "right" }}
      value={draft[r.log_date]?.[k] ?? String((r[k] as number) || "")}
      onChange={(e) => setField(r.log_date, k, e.target.value)} onBlur={() => save(r.log_date)} />
  );

  // 현재 조회 기간을 엑셀로 (미선택 시 서버가 해석한 기본 기간)
  const exportHref = () => {
    const p = new URLSearchParams();
    const f = from || range.from, t = to || range.to;
    if (f) p.set("from", f); if (t) p.set("to", t);
    return `/api/fulfill/log/export?${p.toString()}`;
  };

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">배송일지</h1>
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {/* 데스크톱 전용 — 모바일에선 현황 확인만 하도록 숨김 (.dlog-desk) */}
          <div className="dlog-desk sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <input type="date" className="b2b-input" value={newDate} onChange={(e) => setNewDate(e.target.value)} style={{ width: "auto" }} title="추가할 날짜" />
            <button className="b2b-btn-primary" onClick={addDay}>+ 날짜 추가</button>
            <Link className="b2b-btn-secondary" href="/fulfill/stats">발송 통계</Link>
            <Link className="b2b-btn-secondary" href="/fulfill/settings">설정</Link>
            <a className="b2b-btn-secondary" href={exportHref()} style={rows.length ? undefined : { pointerEvents: "none", opacity: 0.5 }} title="현재 기간을 엑셀로 추출">엑셀 추출</a>
          </div>
          {/* 새로고침 — 모바일에서도 유일하게 남는 버튼(아이콘형) */}
          <button className="b2b-btn-secondary dlog-refresh" onClick={load} disabled={loading} aria-label="새로고침" title="새로고침"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 40, height: 38, padding: "0 12px" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={loading ? "dlog-spin" : ""} aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>
      </header>

      <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div className="sm-tabs" style={{ margin: 0 }}>
          {PRESETS.map((p) => (
            <button key={p.key} className={`sm-tab ${preset === p.key ? "is-active" : ""}`} onClick={() => applyPreset(p)}>{p.key}</button>
          ))}
        </div>
        <input type="date" className="b2b-input" value={from} onChange={(e) => { setFrom(e.target.value); setPreset(""); }} style={{ width: "auto" }} />
        <span style={{ color: "var(--sm-text-light)" }}>~</span>
        <input type="date" className="b2b-input" value={to} onChange={(e) => { setTo(e.target.value); setPreset(""); }} style={{ width: "auto" }} />
        <span className="sm-faint" style={{ fontSize: 12 }}>{range.from} ~ {range.to} · {rows.length}일</span>
      </div>

      {error && <div className="b2b-error">{error}{error.includes("055") ? " — supabase/migrations/055_delivery_log.sql 를 먼저 적용하세요." : ""}</div>}

      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">일반 택배량</div><div className="b2b-stat-card-value b2b-money">{won(totals.normal)}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">도착보장 택배량</div><div className="b2b-stat-card-value b2b-money" style={{ color: "var(--sm-orange)" }}>{won(totals.guar)}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">운임 합계</div><div className="b2b-stat-card-value b2b-money">{won(totals.fee)}원</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">드라이아이스</div><div className="b2b-stat-card-value b2b-money">{won(totals.dry)}원</div></div>
      </div>

      <div className="b2b-card">
        {loading ? <div className="b2b-loading">불러오는 중...</div> : rows.length === 0 ? (
          <div className="b2b-empty">기록이 없습니다. <Link href="/fulfill">발주처리</Link>에서 &lsquo;배송일지에 기록&rsquo;하거나 위 &lsquo;+ 날짜 추가&rsquo;로 시작하세요.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table" style={{ fontSize: 12.5 }}>
              <thead><tr>
                <th></th><th>날짜</th><th className="num">일반</th><th className="num">도착보장</th>
                <th className="num">일반운임</th><th className="num">도착보장 운임</th><th className="num">파도 운임</th>
                <th className="num">총 운임</th>
                <th className="num" title="드라이아이스 박스 (풀/반)">드라이(풀/반)</th><th className="num">드라이 금액</th>
                <th>비고</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const o = open.has(r.log_date);
                  const rt = ratesFor(history, r.log_date); // 이 날짜에 유효했던 단가
                  return (
                    <FragmentRows key={r.log_date}>
                      <tr>
                        <td><button className="b2b-link-btn" onClick={() => toggle(r.log_date)} style={{ color: "var(--sm-text-light)" }}>{o ? "▾" : "▸"}</button></td>
                        <td style={{ whiteSpace: "nowrap" }}><strong>{r.log_date.slice(5)}</strong> <span className="sm-faint">({weekday(r.log_date)})</span></td>
                        <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(sumBoxes(finalBoxes(r, "n")))}</td>
                        <td className="num b2b-money" style={{ fontWeight: 700, color: "var(--sm-orange)" }}>{won(sumBoxes(finalBoxes(r, "g")))}</td>
                        <td className="num b2b-money" style={{ fontWeight: 700, cursor: "pointer" }} onClick={() => toggle(r.log_date)} title="세부 편집: 클릭">{won(normalFee(r))}</td>
                        <td className="num b2b-money" style={{ fontWeight: 700, color: "var(--sm-orange)", cursor: "pointer" }} onClick={() => toggle(r.log_date)} title="세부 편집: 클릭">{won(guarFee(r))}</td>
                        <td className="num b2b-money" style={{ cursor: "pointer" }} onClick={() => toggle(r.log_date)} title="세부 편집: 클릭">{won(padoFee(r))}</td>
                        <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(feeTotal(r))}</td>
                        <td className="num" style={{ whiteSpace: "nowrap" }}>{stepField(r, "dryice_full", 46)}<span style={{ margin: "0 5px", color: "var(--sm-text-light)" }}>/</span>{stepField(r, "dryice_half", 46)}</td>
                        <td className="num b2b-money">{won(dryAmt(r))}</td>
                        <td><input className="b2b-input" style={{ width: 120, padding: "4px 6px", fontSize: 12 }} value={curMemo(r)} onChange={(e) => setField(r.log_date, "memo", e.target.value)} onBlur={() => save(r.log_date)} /></td>
                        <td><button className="b2b-link-btn" onClick={() => removeDay(r.log_date)} style={{ color: "var(--sm-danger)" }}>삭제</button></td>
                      </tr>
                      {o && (
                        <tr>
                          <td colSpan={12} style={{ background: "var(--sm-bg)", padding: 12 }}>
                            <div className="sm-col" style={{ gap: 12 }}>
                              {/* ① 자동입력 — 발주처리 기록. 수정 불가 */}
                              <div>
                                <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>자동입력 <span className="sm-faint" style={{ fontWeight: 400 }}>· 발주처리 기록 — 수정 불가</span></div>
                                <table className="b2b-table" style={{ background: "var(--sm-white)", fontSize: 12 }}>
                                  <thead><tr><th></th>{BOX_CATEGORIES.map((c) => <th key={c} className="num">{c}</th>)}<th className="num">합계</th></tr></thead>
                                  <tbody>
                                    {(["n", "g"] as const).map((side) => {
                                      const auto = side === "n" ? r.boxes_normal_auto : r.boxes_guar_auto;
                                      return (
                                        <tr key={side}>
                                          <td style={{ color: side === "g" ? "var(--sm-orange)" : undefined, whiteSpace: "nowrap" }}>{side === "n" ? "일반" : "도착보장"}</td>
                                          {BOX_CATEGORIES.map((c) => (
                                            <td key={c} className="num b2b-money" style={{ color: auto?.[c] ? undefined : "var(--sm-text-light)" }}>{auto?.[c] || "-"}</td>
                                          ))}
                                          <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(sumBoxes(auto))}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                                {(r.record_entries || []).length > 0 && (
                                  <div style={{ marginTop: 6 }}>
                                    {[...r.record_entries].reverse().map((e) => (
                                      <div key={e.id} className="sm-row" style={{ gap: 8, alignItems: "center", fontSize: 12, padding: "3px 2px", flexWrap: "wrap" }}>
                                        <span className="sm-faint">{e.at ? kstStamp(e.at) : "-"}</span>
                                        <span style={{ fontWeight: 600, color: e.mode === "baseline" ? "var(--sm-text-light)" : "var(--sm-text-mid)" }}>
                                          {e.mode === "baseline" ? "이전 기록 합계" : e.mode === "replace" ? "덮어쓰기" : "더하기"}
                                        </span>
                                        <span>일반 {sumBoxes(e.boxes_normal)} · 도착보장 {sumBoxes(e.boxes_guar)}박스</span>
                                        <span className="b2b-money">{won(e.base_fee_normal + e.base_fee_guar)}원</span>
                                        {e.by && <span className="sm-faint">{e.by}</span>}
                                        <button className="b2b-link-btn" style={{ fontSize: 12, color: "var(--sm-danger)" }} onClick={() => delRecord(r.log_date, e)}>되돌리기</button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {/* ② 직접수정 — 사유가 있는 건별 보정. 최종 = 자동 + 보정 합 */}
                              <div>
                                <div className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                                  <span style={{ fontWeight: 700, fontSize: 12 }}>직접수정</span>
                                  {r.manual_updated_at && <span className="sm-faint" style={{ fontSize: 12 }}>수정일 {kstStamp(r.manual_updated_at)}</span>}
                                  <button className="b2b-btn-secondary" style={{ padding: "3px 12px", fontSize: 12 }} onClick={() => openEntry(r.log_date)}>+ 추가</button>
                                </div>
                                <table className="b2b-table" style={{ background: "var(--sm-white)", fontSize: 12 }}>
                                  <thead><tr><th></th>{BOX_CATEGORIES.map((c) => <th key={c} className="num">{c}</th>)}<th className="num">합계</th></tr></thead>
                                  <tbody>
                                    {(["n", "g"] as const).map((side) => {
                                      const man = curManualMap(r, side);
                                      const fin = finalBoxes(r, side);
                                      return (
                                        <FragmentRows key={side}>
                                          <tr>
                                            <td style={{ color: side === "g" ? "var(--sm-orange)" : undefined, whiteSpace: "nowrap" }}>{side === "n" ? "일반 보정" : "도착보장 보정"}</td>
                                            {BOX_CATEGORIES.map((c) => (
                                              <td key={c} className="num b2b-money" style={{ color: man[c] ? (man[c] > 0 ? "var(--sm-success)" : "var(--sm-danger)") : "var(--sm-text-light)" }}>
                                                {man[c] ? (man[c] > 0 ? `+${man[c]}` : man[c]) : "-"}
                                              </td>
                                            ))}
                                            <td className="num b2b-money">{won(sumCounts(man))}</td>
                                          </tr>
                                          <tr>
                                            <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>└ 최종</td>
                                            {BOX_CATEGORIES.map((c) => (
                                              <td key={c} className="num b2b-money" style={{ color: fin[c] ? undefined : "var(--sm-text-light)" }}>{fin[c] || "-"}</td>
                                            ))}
                                            <td className="num b2b-money" style={{ fontWeight: 700, color: side === "g" ? "var(--sm-orange)" : undefined }}>{won(sumBoxes(fin))}</td>
                                          </tr>
                                        </FragmentRows>
                                      );
                                    })}
                                  </tbody>
                                </table>
                                {(r.manual_entries || []).length > 0 && (
                                  <div style={{ marginTop: 6 }}>
                                    {[...r.manual_entries].reverse().map((e) => (
                                      <div key={e.id} className="sm-row" style={{ gap: 8, alignItems: "center", fontSize: 12, padding: "3px 2px", flexWrap: "wrap" }}>
                                        <span className="sm-faint">{e.at ? kstStamp(e.at) : "-"}</span>
                                        <span style={{ color: e.side === "g" ? "var(--sm-orange)" : "var(--sm-text-mid)", fontWeight: 600 }}>{e.side === "n" ? "일반" : "도착보장"}</span>
                                        <span style={{ fontWeight: 600 }}>{e.category}</span>
                                        <span style={{ fontWeight: 700, color: e.qty > 0 ? "var(--sm-success)" : "var(--sm-danger)" }}>{e.qty > 0 ? `+${e.qty}` : e.qty}</span>
                                        <span style={{ color: "var(--sm-text-mid)" }}>{e.note}</span>
                                        {e.by && <span className="sm-faint">{e.by}</span>}
                                        <button className="b2b-link-btn" style={{ fontSize: 12, color: "var(--sm-danger)" }} onClick={() => delEntry(r.log_date, e)}>삭제</button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div>
                                <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>운임 세부 <span className="sm-faint" style={{ fontWeight: 400 }}>(기본운임은 <strong>자동입력+직접수정에서 자동 계산</strong> · 제주·도서산간 등 추가금만 &lsquo;추가운임&rsquo;에 직접 입력)</span></div>
                                <table className="b2b-table" style={{ background: "var(--sm-white)", fontSize: 12, maxWidth: 480 }}>
                                  <thead><tr><th>채널</th><th className="num">기본운임 <span className="sm-faint" style={{ fontWeight: 400 }}>(자동)</span></th><th className="num">추가운임</th><th className="num">합계</th></tr></thead>
                                  <tbody>
                                    <tr>
                                      <td style={{ whiteSpace: "nowrap" }}>씨몬 일반</td>
                                      <td className="num b2b-money" title="택배량에서 자동 계산">{won(baseNormalOf(r))}</td>
                                      <td className="num">{numInput(r, "extra_fee")}</td>
                                      <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(normalFee(r))}</td>
                                    </tr>
                                    <tr>
                                      <td style={{ whiteSpace: "nowrap", color: "var(--sm-orange)" }}>도착보장</td>
                                      <td className="num b2b-money" title="택배량 + 도착보장 가산 자동 계산" style={{ color: "var(--sm-orange)" }}>{won(baseGuarOf(r))}</td>
                                      <td className="num">{numInput(r, "guar_extra_fee")}</td>
                                      <td className="num b2b-money" style={{ fontWeight: 700, color: "var(--sm-orange)" }}>{won(guarFee(r))}</td>
                                    </tr>
                                    <tr>
                                      <td style={{ whiteSpace: "nowrap" }}>파도</td>
                                      <td className="num">{numInput(r, "pado_fee")}</td>
                                      <td className="num">{numInput(r, "pado_extra")}</td>
                                      <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(cur(r, "pado_fee") + cur(r, "pado_extra"))}</td>
                                    </tr>
                                    <tr>
                                      <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>└ 파도 착불</td>
                                      <td className="num sm-faint">—</td>
                                      <td className="num">{numInput(r, "pado_cod")}</td>
                                      <td className="num b2b-money sm-faint">{won(cur(r, "pado_cod"))}</td>
                                    </tr>
                                  </tbody>
                                  <tfoot><tr>
                                    <td style={{ fontWeight: 700 }}>총 운임</td><td /><td />
                                    <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(feeTotal(r))}</td>
                                  </tr></tfoot>
                                </table>
                              </div>
                              <div className="sm-row" style={{ gap: 18, flexWrap: "wrap", fontSize: 12, marginTop: 2 }}>
                                <span className="sm-faint">도착보장 운임 = 기본 {won(baseGuarOf(r))}(도착보장 {won(rt.guarSurcharge)}원/건 포함) + 추가 {won(cur(r, "guar_extra_fee"))}(제주 등 수동) = <strong style={{ color: "var(--sm-orange)" }}>{won(guarFee(r))}원</strong></span>
                                <span className="sm-faint">파도 운임 {won(padoFee(r))}원 (기본+추가+착불)</span>
                                <span className="sm-faint">드라이 {won(dryAmt(r))}원 (풀 {won(rt.dryFull)}·반 {won(rt.dryHalf)})</span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </FragmentRows>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 직접수정 내역 추가 — 구분·박스종류·수량·내용(사유) */}
      {entryFor && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">직접수정 추가 <span className="sm-faint" style={{ fontSize: 13, fontWeight: 400 }}>· {entryFor}</span></h2>
              <button className="b2b-modal-close" onClick={() => setEntryFor(null)}>✕</button>
            </div>
            <div className="b2b-modal-body sm-col" style={{ gap: 12 }}>
              <div className="sm-row" style={{ gap: 16, flexWrap: "wrap" }}>
                <label className="sm-col" style={{ gap: 3, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>구분</span>
                  <div className="sm-tabs" style={{ margin: 0 }}>
                    <button className={`sm-tab ${eSide === "n" ? "is-active" : ""}`} onClick={() => setESide("n")}>일반</button>
                    <button className={`sm-tab ${eSide === "g" ? "is-active" : ""}`} onClick={() => setESide("g")}>도착보장</button>
                  </div>
                </label>
                <label className="sm-col" style={{ gap: 3, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>박스종류</span>
                  <select className="b2b-select" value={eCat} onChange={(e) => setECat(e.target.value)} style={{ width: "auto", padding: "6px 10px" }}>
                    {BOX_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label className="sm-col" style={{ gap: 3, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>수량</span>
                  <div className="sm-row" style={{ gap: 6 }}>
                    <div className="sm-tabs" style={{ margin: 0 }}>
                      <button className={`sm-tab ${eMode === "add" ? "is-active" : ""}`} onClick={() => setEMode("add")}>추가 +</button>
                      <button className={`sm-tab ${eMode === "sub" ? "is-active" : ""}`} onClick={() => setEMode("sub")}>빼기 −</button>
                    </div>
                    <input type="number" className="b2b-input" min={1} value={eQty} onChange={(e) => setEQty(e.target.value)} style={{ width: 70, textAlign: "right" }} />
                  </div>
                </label>
              </div>
              <label className="sm-col" style={{ gap: 3, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>내용 <span className="sm-faint" style={{ fontWeight: 400 }}>— 왜 보정하는지</span></span>
                <input className="b2b-input" value={eNote} onChange={(e) => setENote(e.target.value)} placeholder="예: CS 재발송 1건 / 발주 누락 보정" autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") addEntry(); }} />
              </label>
            </div>
            <div className="b2b-modal-foot">
              <button className="b2b-btn-secondary" onClick={() => setEntryFor(null)} disabled={eBusy}>취소</button>
              <button className="b2b-btn-primary" onClick={addEntry} disabled={eBusy || !eNote.trim() || Math.round(Number(eQty) || 0) === 0}>{eBusy ? "저장 중…" : "저장"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) { return <>{children}</>; }

// −/＋ 로 개수를 시원하게 조절. 직접 타이핑도 가능. onBump=버튼, onType=입력, onCommit=blur 즉시저장.
function Stepper({ value, onBump, onType, onCommit, w = 40 }: { value: string; onBump: (d: number) => void; onType: (v: string) => void; onCommit: () => void; w?: number }) {
  const btn: React.CSSProperties = { padding: "3px 9px", fontSize: 15, lineHeight: 1, fontWeight: 700, minWidth: 26 };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      <button type="button" className="b2b-btn-secondary" style={btn} onClick={() => onBump(-1)} aria-label="빼기">−</button>
      <input type="number" className="b2b-input" style={{ width: w, padding: "5px 4px", fontSize: 13, textAlign: "center" }} value={value} onChange={(e) => onType(e.target.value)} onBlur={onCommit} />
      <button type="button" className="b2b-btn-secondary" style={btn} onClick={() => onBump(1)} aria-label="더하기">+</button>
    </span>
  );
}

// 필드 저장 후: 방금 저장한 스냅샷과 값이 같은 칸만 초기화. 저장 중 사용자가 바꾼 칸은 유지(원복 방지).
function reconcileFieldDraft(prev: Record<string, Partial<Record<EditKey, string>>>, date: string, saved: Partial<Record<EditKey, string>>): Record<string, Partial<Record<EditKey, string>>> {
  const dd = prev[date]; if (!dd) return prev;
  const kept: Partial<Record<EditKey, string>> = {};
  for (const k of Object.keys(dd) as EditKey[]) { if (dd[k] !== saved[k]) kept[k] = dd[k]; }
  const next = { ...prev };
  if (Object.keys(kept).length) next[date] = kept; else delete next[date];
  return next;
}

// 저장 성공 시 서버와 동일 규칙으로 로컬 행에 draft 반영(memo→trim/null, dryice→소수, 나머지→반올림 정수)
function applyDraft(r: Row, d: Partial<Record<EditKey, string>>): Row {
  const next = { ...r };
  const n = next as unknown as Record<string, unknown>;
  for (const k of Object.keys(d) as EditKey[]) {
    if (k === "memo") n.memo = (d.memo ?? "").trim() || null;
    else if (k === "dryice_full" || k === "dryice_half") n[k] = Number(d[k]) || 0;
    else n[k] = Math.round(Number(d[k]) || 0);
  }
  return next;
}
