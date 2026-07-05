"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BOX_CATEGORIES } from "@/app/lib/order-fulfill";

type Boxes = Record<string, number>;
type Row = {
  log_date: string; boxes_normal: Boxes; boxes_guar: Boxes;
  base_fee_normal: number; base_fee_guar: number;
  extra_fee: number; guar_extra_fee: number; pado_fee: number; pado_extra: number; pado_cod: number;
  dryice_full: number; dryice_half: number; memo: string | null;
};
type EditKey = "base_fee_normal" | "base_fee_guar" | "extra_fee" | "guar_extra_fee" | "pado_fee" | "pado_extra" | "pado_cod" | "dryice_full" | "dryice_half" | "memo";
type BoxDraft = Record<string, { n?: Record<string, string>; g?: Record<string, string> }>;

const won = (n: unknown) => (Number(n) || 0).toLocaleString();
const sumBoxes = (o: Boxes) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
const DRY_FULL = 30800, DRY_HALF = 19800; // 드라이아이스 단가: 1박스 30,800 · 1/2박스 19,800
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
  const [boxDraft, setBoxDraft] = useState<BoxDraft>({});

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = new URLSearchParams(); if (from) p.set("from", from); if (to) p.set("to", to);
      const j = await (await fetch(`/api/fulfill/log?${p.toString()}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []); setRange({ from: j.from, to: j.to }); setDraft({}); setBoxDraft({});
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  // 최신 상태 ref — 디바운스 저장 시 stale 클로저 방지
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const draftRef = useRef(draft); draftRef.current = draft;
  const boxDraftRef = useRef(boxDraft); boxDraftRef.current = boxDraft;
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const cur = (r: Row, k: EditKey): number => Number(draft[r.log_date]?.[k] ?? (r[k] as number)) || 0;
  const curMemo = (r: Row): string => draft[r.log_date]?.memo ?? (r.memo ?? "");
  const setField = (date: string, k: EditKey, v: string) => setDraft((d) => ({ ...d, [date]: { ...d[date], [k]: v } }));

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json(); if (!j.ok) throw new Error(j.error || "저장 실패");
  }

  async function save(date: string) {
    const d = draftRef.current[date]; if (!d) return;
    try {
      await post({ log_date: date, ...d });
      setRows((rs) => rs.map((r) => (r.log_date === date ? applyDraft(r, d) : r)));
      setDraft((prev) => { const n = { ...prev }; delete n[date]; return n; });
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
  }

  const boxVal = (r: Row, side: "n" | "g", cat: string): string =>
    boxDraft[r.log_date]?.[side]?.[cat] ?? String((side === "n" ? r.boxes_normal : r.boxes_guar)?.[cat] || "");
  const setBox = (date: string, side: "n" | "g", cat: string, v: string) =>
    setBoxDraft((bd) => ({ ...bd, [date]: { ...bd[date], [side]: { ...bd[date]?.[side], [cat]: v } } }));

  async function saveBoxes(date: string) {
    const r = rowsRef.current.find((x) => x.log_date === date); if (!r) return;
    const build = (side: "n" | "g"): Boxes => {
      const base = side === "n" ? r.boxes_normal : r.boxes_guar;
      const dr = boxDraftRef.current[date]?.[side] || {};
      const out: Boxes = {};
      for (const c of BOX_CATEGORIES) { const v = c in dr ? Number(dr[c]) || 0 : Number(base?.[c]) || 0; if (v > 0) out[c] = Math.round(v); }
      return out;
    };
    const bn = build("n"), bg = build("g");
    try {
      await post({ log_date: date, boxes_normal: bn, boxes_guar: bg });
      setRows((rs) => rs.map((x) => (x.log_date === date ? { ...x, boxes_normal: bn, boxes_guar: bg } : x)));
      setBoxDraft((prev) => { const n = { ...prev }; delete n[date]; return n; });
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
  }

  // 디바운스 저장(연타 후 한 번만 저장)
  const schedule = (key: string, fn: () => void, ms = 500) => { clearTimeout(timers.current[key]); timers.current[key] = setTimeout(fn, ms); };
  const scheduleSave = (date: string) => schedule("f:" + date, () => save(date));
  const scheduleBoxSave = (date: string) => schedule("b:" + date, () => saveBoxes(date));

  // +/- 개수 조절 — 함수형 업데이트로 연타 안전
  function bumpBox(date: string, side: "n" | "g", cat: string, delta: number) {
    setBoxDraft((bd) => {
      const s = bd[date]?.[side]?.[cat];
      const base = s !== undefined ? Number(s) || 0 : Number((rowsRef.current.find((r) => r.log_date === date)?.[side === "n" ? "boxes_normal" : "boxes_guar"])?.[cat]) || 0;
      return { ...bd, [date]: { ...bd[date], [side]: { ...bd[date]?.[side], [cat]: String(Math.max(0, base + delta)) } } };
    });
    scheduleBoxSave(date);
  }
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
  const stepBox = (r: Row, side: "n" | "g", c: string) => (
    <Stepper value={boxVal(r, side, c)} onBump={(d) => bumpBox(r.log_date, side, c, d)}
      onType={(v) => { setBox(r.log_date, side, c, v); scheduleBoxSave(r.log_date); }} onCommit={() => saveBoxes(r.log_date)} w={50} />
  );

  async function addDay() {
    if (!newDate) return;
    if (rows.some((r) => r.log_date === newDate)) { setError("이미 있는 날짜입니다."); setOpen((s) => new Set(s).add(newDate)); return; }
    try {
      await post({ log_date: newDate });
      const blank: Row = { log_date: newDate, boxes_normal: {}, boxes_guar: {}, base_fee_normal: 0, base_fee_guar: 0, extra_fee: 0, guar_extra_fee: 0, pado_fee: 0, pado_extra: 0, pado_cod: 0, dryice_full: 0, dryice_half: 0, memo: null };
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

  const feeTotal = (r: Row) => cur(r, "base_fee_normal") + cur(r, "base_fee_guar") + cur(r, "extra_fee") + cur(r, "guar_extra_fee") + cur(r, "pado_fee") + cur(r, "pado_extra") + cur(r, "pado_cod");
  const dryAmt = (r: Row) => cur(r, "dryice_full") * DRY_FULL + cur(r, "dryice_half") * DRY_HALF;

  const totals = useMemo(() => ({
    normal: rows.reduce((s, r) => s + sumBoxes(r.boxes_normal), 0),
    guar: rows.reduce((s, r) => s + sumBoxes(r.boxes_guar), 0),
    fee: rows.reduce((s, r) => s + feeTotal(r), 0),
    dry: rows.reduce((s, r) => s + dryAmt(r), 0),
  }), [rows, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const numInput = (r: Row, k: EditKey, w = 76) => (
    <input type="number" className="b2b-input b2b-money" style={{ width: w, padding: "4px 6px", fontSize: 12, textAlign: "right" }}
      value={draft[r.log_date]?.[k] ?? String((r[k] as number) || "")}
      onChange={(e) => setField(r.log_date, k, e.target.value)} onBlur={() => save(r.log_date)} />
  );

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">배송일지</h1>
          <p className="b2b-page-subtitle">
            날짜별 <strong>택배량·운임·드라이아이스</strong> 기록. 택배량·기본운임은 <Link href="/fulfill">발주처리</Link>에서 자동 기록되며,
            <strong> 모든 칸을 직접 추가·수정·삭제</strong>할 수 있습니다.
          </p>
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input type="date" className="b2b-input" value={newDate} onChange={(e) => setNewDate(e.target.value)} style={{ width: "auto" }} title="추가할 날짜" />
          <button className="b2b-btn-primary" onClick={addDay}>+ 날짜 추가</button>
          <Link className="b2b-btn-secondary" href="/fulfill/stats">발송 통계</Link>
          <button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button>
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
          <div className="b2b-empty"><div className="b2b-empty-icon">🚚</div>기록이 없습니다. <Link href="/fulfill">발주처리</Link>에서 &lsquo;배송일지에 기록&rsquo;하거나 위 &lsquo;+ 날짜 추가&rsquo;로 시작하세요.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table" style={{ fontSize: 12.5 }}>
              <thead><tr>
                <th></th><th>날짜</th><th className="num">일반</th><th className="num">도착보장</th>
                <th className="num">씨몬 기본운임</th><th className="num">씨몬 추가</th>
                <th className="num">파도 운임</th><th className="num">도착보장 추가</th>
                <th className="num">총 운임</th>
                <th className="num" title="드라이아이스 박스 (풀/반)">드라이(풀/반)</th><th className="num">드라이 금액</th>
                <th>비고</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const o = open.has(r.log_date);
                  return (
                    <FragmentRows key={r.log_date}>
                      <tr>
                        <td><button className="b2b-link-btn" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(r.log_date)) n.delete(r.log_date); else n.add(r.log_date); return n; })} style={{ color: "var(--sm-text-light)" }}>{o ? "▾" : "▸"}</button></td>
                        <td style={{ whiteSpace: "nowrap" }}><strong>{r.log_date.slice(5)}</strong> <span className="sm-faint">({weekday(r.log_date)})</span></td>
                        <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(sumBoxes(r.boxes_normal))}</td>
                        <td className="num b2b-money" style={{ fontWeight: 700, color: "var(--sm-orange)" }}>{won(sumBoxes(r.boxes_guar))}</td>
                        <td className="num b2b-money sm-faint">{won(cur(r, "base_fee_normal") + cur(r, "base_fee_guar"))}</td>
                        <td className="num">{numInput(r, "extra_fee")}</td>
                        <td className="num">{numInput(r, "pado_fee")}</td>
                        <td className="num">{numInput(r, "guar_extra_fee")}</td>
                        <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(feeTotal(r))}</td>
                        <td className="num" style={{ whiteSpace: "nowrap" }}>{stepField(r, "dryice_full", 46)}<span style={{ margin: "0 5px", color: "var(--sm-text-light)" }}>/</span>{stepField(r, "dryice_half", 46)}</td>
                        <td className="num b2b-money">{won(dryAmt(r))}</td>
                        <td><input className="b2b-input" style={{ width: 120, padding: "4px 6px", fontSize: 12 }} value={curMemo(r)} onChange={(e) => setField(r.log_date, "memo", e.target.value)} onBlur={() => save(r.log_date)} /></td>
                        <td><button className="b2b-link-btn" onClick={() => removeDay(r.log_date)} style={{ color: "var(--sm-danger)" }}>삭제</button></td>
                      </tr>
                      {o && (
                        <tr>
                          <td colSpan={13} style={{ background: "var(--sm-bg)", padding: 12 }}>
                            <div className="sm-col" style={{ gap: 12 }}>
                              <div>
                                <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>택배량 직접 수정 <span className="sm-faint" style={{ fontWeight: 400 }}>(박스종류별)</span></div>
                                <table className="b2b-table" style={{ background: "var(--sm-white)", fontSize: 12 }}>
                                  <thead><tr><th></th>{BOX_CATEGORIES.map((c) => <th key={c} className="num">{c}</th>)}<th></th></tr></thead>
                                  <tbody>
                                    {(["n", "g"] as const).map((side) => (
                                      <tr key={side}>
                                        <td style={{ color: side === "g" ? "var(--sm-orange)" : undefined, whiteSpace: "nowrap" }}>{side === "n" ? "일반" : "도착보장"}</td>
                                        {BOX_CATEGORIES.map((c) => (
                                          <td key={c} className="num" style={{ padding: "4px 3px" }}>{stepBox(r, side, c)}</td>
                                        ))}
                                        <td />
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <div className="sm-row" style={{ gap: 16, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
                                <label>씨몬 기본운임(일반) {numInput(r, "base_fee_normal")}</label>
                                <label>도착보장 기본운임 {numInput(r, "base_fee_guar")}</label>
                                <label>파도 추가 {numInput(r, "pado_extra")}</label>
                                <label>파도 착불 {numInput(r, "pado_cod")}</label>
                                <span className="sm-faint">드라이 단가: 풀 {DRY_FULL.toLocaleString()} · 반 {DRY_HALF.toLocaleString()}</span>
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
