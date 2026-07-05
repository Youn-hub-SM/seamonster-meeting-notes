"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BOX_CATEGORIES } from "@/app/lib/order-fulfill";

type Boxes = Record<string, number>;
type Row = {
  log_date: string; boxes_normal: Boxes; boxes_guar: Boxes;
  base_fee_normal: number; base_fee_guar: number;
  extra_fee: number; guar_extra_fee: number; pado_fee: number; pado_extra: number; pado_cod: number;
  dryice_full: number; dryice_half: number; memo: string | null;
};
type EditKey = "extra_fee" | "guar_extra_fee" | "pado_fee" | "pado_extra" | "pado_cod" | "dryice_full" | "dryice_half" | "memo";

const won = (n: unknown) => (Number(n) || 0).toLocaleString();
const sumBoxes = (o: Boxes) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
const DRY_FULL = 28600, DRY_HALF = 19800;
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const weekday = (iso: string) => WD[new Date(`${iso}T00:00:00`).getDay()];

export default function DeliveryLogPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [range, setRange] = useState({ from: "", to: "" });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Record<string, Partial<Record<EditKey, string>>>>({});

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

  const cur = (r: Row, k: EditKey): number => Number(draft[r.log_date]?.[k] ?? (r[k] as number)) || 0;
  const curMemo = (r: Row): string => draft[r.log_date]?.memo ?? (r.memo ?? "");
  const setField = (date: string, k: EditKey, v: string) => setDraft((d) => ({ ...d, [date]: { ...d[date], [k]: v } }));

  async function save(date: string) {
    const d = draft[date]; if (!d) return;
    try {
      const res = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ log_date: date, ...d }) });
      const j = await res.json(); if (!j.ok) throw new Error(j.error);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
  }
  async function removeDay(date: string) {
    if (!window.confirm(`${date} 배송일지 행을 삭제할까요?`)) return;
    await fetch(`/api/fulfill/log?log_date=${date}`, { method: "DELETE" });
    await load();
  }

  const feeTotal = (r: Row) => r.base_fee_normal + r.base_fee_guar + cur(r, "extra_fee") + cur(r, "guar_extra_fee") + cur(r, "pado_fee") + cur(r, "pado_extra") + cur(r, "pado_cod");
  const dryAmt = (r: Row) => cur(r, "dryice_full") * DRY_FULL + cur(r, "dryice_half") * DRY_HALF;

  const totals = useMemo(() => ({
    normal: rows.reduce((s, r) => s + sumBoxes(r.boxes_normal), 0),
    guar: rows.reduce((s, r) => s + sumBoxes(r.boxes_guar), 0),
    fee: rows.reduce((s, r) => s + feeTotal(r), 0),
    dry: rows.reduce((s, r) => s + dryAmt(r), 0),
  }), [rows, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const numInput = (r: Row, k: EditKey, w = 78) => (
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
            날짜별 <strong>택배량·운임</strong> 기록. 택배량·씨몬 기본운임은 <Link href="/fulfill">발주처리</Link>에서 자동 기록되고, 추가운임·파도·드라이아이스·비고는 직접 수정합니다.
          </p>
        </div>
        <div className="b2b-page-actions"><button className="b2b-btn-secondary" onClick={load} disabled={loading}>{loading ? "..." : "새로고침"}</button></div>
      </header>

      <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input type="date" className="b2b-input" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} />
        <span style={{ color: "var(--sm-text-light)" }}>~</span>
        <input type="date" className="b2b-input" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }} />
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
          <div className="b2b-empty"><div className="b2b-empty-icon">🚚</div>기록이 없습니다. <Link href="/fulfill">발주처리</Link>에서 &lsquo;배송일지에 기록&rsquo;하면 채워집니다.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table" style={{ fontSize: 12.5 }}>
              <thead><tr>
                <th></th><th>날짜</th><th className="num">일반</th><th className="num">도착보장</th>
                <th className="num">씨몬 기본운임</th><th className="num">씨몬 추가</th>
                <th className="num">파도 운임</th><th className="num">도착보장 추가</th>
                <th className="num">총 운임</th><th className="num">드라이(풀/반)</th><th>비고</th><th></th>
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
                        <td className="num b2b-money sm-faint">{won(r.base_fee_normal + r.base_fee_guar)}</td>
                        <td className="num">{numInput(r, "extra_fee")}</td>
                        <td className="num">{numInput(r, "pado_fee")}</td>
                        <td className="num">{numInput(r, "guar_extra_fee")}</td>
                        <td className="num b2b-money" style={{ fontWeight: 700 }}>{won(feeTotal(r))}</td>
                        <td className="num" style={{ whiteSpace: "nowrap" }}>{numInput(r, "dryice_full", 46)}/{numInput(r, "dryice_half", 46)}</td>
                        <td><input className="b2b-input" style={{ width: 130, padding: "4px 6px", fontSize: 12 }} value={curMemo(r)} onChange={(e) => setField(r.log_date, "memo", e.target.value)} onBlur={() => save(r.log_date)} /></td>
                        <td><button className="b2b-link-btn" onClick={() => removeDay(r.log_date)} style={{ color: "var(--sm-danger)" }}>삭제</button></td>
                      </tr>
                      {o && (
                        <tr>
                          <td colSpan={12} style={{ background: "var(--sm-bg)", padding: 12 }}>
                            <div className="sm-row" style={{ gap: 24, flexWrap: "wrap", fontSize: 12 }}>
                              <div>
                                <div style={{ fontWeight: 700, marginBottom: 4 }}>택배량 (박스종류)</div>
                                <table className="b2b-table" style={{ background: "var(--sm-white)", fontSize: 12 }}>
                                  <thead><tr><th></th>{BOX_CATEGORIES.map((c) => <th key={c} className="num">{c}</th>)}</tr></thead>
                                  <tbody>
                                    <tr><td>일반</td>{BOX_CATEGORIES.map((c) => <td key={c} className="num">{r.boxes_normal?.[c] || "-"}</td>)}</tr>
                                    <tr><td style={{ color: "var(--sm-orange)" }}>도착보장</td>{BOX_CATEGORIES.map((c) => <td key={c} className="num">{r.boxes_guar?.[c] || "-"}</td>)}</tr>
                                  </tbody>
                                </table>
                              </div>
                              <div>
                                <div style={{ fontWeight: 700, marginBottom: 4 }}>파도 · 드라이아이스</div>
                                <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                                  <label style={{ fontSize: 12 }}>파도 추가 {numInput(r, "pado_extra")}</label>
                                  <label style={{ fontSize: 12 }}>파도 착불 {numInput(r, "pado_cod")}</label>
                                  <span className="sm-faint">드라이 금액 {won(dryAmt(r))}원 (풀 {DRY_FULL.toLocaleString()}·반 {DRY_HALF.toLocaleString()})</span>
                                </div>
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
