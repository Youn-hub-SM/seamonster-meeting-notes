"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { VOC_CATEGORIES, type Voc } from "@/app/lib/voc";

type Range = "전체" | "올해" | "90일" | "30일";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // KST

function rangeStart(r: Range): string {
  if (r === "전체") return "0000-00-00";
  const now = new Date(Date.now() + 9 * 3600_000);
  if (r === "올해") return `${now.getFullYear()}-01-01`;
  const days = r === "90일" ? 90 : 30;
  const d = new Date(now.getTime() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

type Unit = "주별" | "월별";

// 해당 날짜가 속한 주의 월요일(YYYY-MM-DD). 주별 집계 키.
function weekStart(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // 월=0 … 일=6
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}
function periodKey(dateStr: string, unit: Unit): string {
  if (!dateStr) return "미지정";
  return unit === "주별" ? weekStart(dateStr) : dateStr.slice(0, 7);
}
function periodLabel(key: string, unit: Unit): string {
  if (unit === "월별") return key;
  // 주별: "M/D 주(~D)" 형태
  const s = new Date(key + "T00:00:00");
  const e = new Date(s.getTime() + 6 * 86400_000);
  const f = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${f(s)}~${f(e)}`;
}

// 키별 집계 → [label, count] 내림차순
function countBy(rows: Voc[], key: (r: Voc) => string | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = (key(r) || "").trim() || "미지정";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function BarList({ title, data, accent, fmt }: { title: string; data: [string, number][]; accent?: string; fmt?: (n: number) => string }) {
  const max = data.length ? Math.max(...data.map((d) => d[1])) : 1;
  return (
    <section className="b2b-card">
      <div className="b2b-card-head"><span className="b2b-card-title">{title}</span></div>
      {data.length === 0 ? (
        <div className="sm-faint" style={{ padding: "8px 2px", fontSize: 13 }}>데이터 없음</div>
      ) : (
        <div className="sm-col" style={{ gap: 8 }}>
          {data.map(([label, n]) => (
            <div key={label} className="sm-col" style={{ gap: 3 }}>
              <div className="sm-between" style={{ fontSize: 13 }}>
                <span className="sm-ellipsis" style={{ maxWidth: "75%" }}>{label}</span>
                <strong>{fmt ? fmt(n) : n}</strong>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: "var(--sm-bg-subtle)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.round((n / max) * 100)}%`, background: accent || "var(--sm-orange)", borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <section className="b2b-card" style={{ padding: "16px 18px" }}>
      <div className="sm-faint" style={{ fontSize: 12, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent || "var(--sm-black)" }}>{value}</div>
      {sub && <div className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>{sub}</div>}
    </section>
  );
}

export default function VocStatsPage() {
  const [rows, setRows] = useState<Voc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [range, setRange] = useState<Range>("올해");
  const [unit, setUnit] = useState<Unit>("주별");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/voc", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const from = rangeStart(range);
    return rows.filter((r) => (r.received_at || "") >= from);
  }, [rows, range]);

  const kpi = useMemo(() => {
    const total = shown.length;
    const open = shown.filter((r) => r.status !== "완료").length;
    const done = shown.filter((r) => r.status === "완료").length;
    const loss = shown.reduce((s, r) => s + (r.loss_amount || 0), 0);
    const rate = total ? Math.round((done / total) * 100) : 0;
    return { total, open, done, rate, loss };
  }, [shown]);

  const byCategory = useMemo(() => {
    const counts = countBy(shown, (r) => r.category);
    const order = new Map(VOC_CATEGORIES.map((c, i) => [c as string, i]));
    return counts.sort((a, b) => (b[1] - a[1]) || ((order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99)));
  }, [shown]);
  const byChannel = useMemo(() => countBy(shown, (r) => r.channel), [shown]);
  const bySource = useMemo(() => countBy(shown, (r) => r.source), [shown]);
  const byPlace = useMemo(() => countBy(shown, (r) => r.purchase_place), [shown]);
  const byStatus = useMemo(() => countBy(shown, (r) => r.status), [shown]);

  // 단위(주/월)별 접수 건수 + 손해금액 — 시간순
  const trend = useMemo(() => {
    const m = new Map<string, { count: number; loss: number }>();
    for (const r of shown) {
      const k = periodKey(r.received_at || "", unit);
      const cur = m.get(k) || { count: 0, loss: 0 };
      cur.count += 1; cur.loss += r.loss_amount || 0;
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => ({ key: k, label: periodLabel(k, unit), count: v.count, loss: v.loss }));
  }, [shown, unit]);

  // 유형별 손해금액 (내림차순)
  const lossByCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of shown) if (r.loss_amount) m.set(r.category, (m.get(r.category) || 0) + r.loss_amount);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [shown]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">VOC 통계·보고서</h1>
          <p className="b2b-page-subtitle no-print">클레임을 유형·채널·기간으로 집계합니다. 제조사 제출용은 <Link href="/voc/reports" className="change-link">개선요청서</Link>에서.</p>
          <p className="print-only" style={{ fontSize: 13, color: "var(--sm-text-mid)", marginTop: 4 }}>씨몬스터 · 작성일 {TODAY()} · 대상 {range === "전체" ? "전체 기간" : `최근 ${range}`}</p>
        </div>
        <div className="b2b-page-actions no-print">
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || rows.length === 0}>🖨 보고서 인쇄 / PDF</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="prod-range-tabs no-print" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {(["30일", "90일", "올해", "전체"] as Range[]).map((r) => (
          <button key={r} className={`prod-range-tab ${range === r ? "is-active" : ""}`} onClick={() => setRange(r)}>{r === "전체" ? "전체" : `최근 ${r}`}</button>
        ))}
      </div>

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div className="b2b-empty"><div className="b2b-empty-icon">📭</div>아직 집계할 VOC가 없습니다. <Link href="/voc" className="change-link">처리 상태</Link>에서 먼저 등록하세요.</div>
      ) : (
        <>
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", marginBottom: 16 }}>
            <KpiCard label="총 접수" value={`${kpi.total}건`} />
            <KpiCard label="진행 중(미완료)" value={`${kpi.open}건`} accent="var(--sm-warning)" />
            <KpiCard label="완료율" value={`${kpi.rate}%`} sub={`${kpi.done}건 완료`} accent="var(--sm-success)" />
            <KpiCard label="총 손해/보상" value={`${kpi.loss.toLocaleString()}원`} accent="var(--sm-danger)" />
          </div>

          {/* 접수·손해 추세 — 주별/월별 토글 */}
          <section className="b2b-card">
            <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="b2b-card-title">접수·손해 추세</span>
              <div className="prod-range-tabs" style={{ margin: 0 }}>
                {(["주별", "월별"] as Unit[]).map((u) => (
                  <button key={u} className={`prod-range-tab ${unit === u ? "is-active" : ""}`} onClick={() => setUnit(u)}>{u}</button>
                ))}
              </div>
            </div>
            {trend.length === 0 ? (
              <div className="sm-faint" style={{ fontSize: 13 }}>데이터 없음</div>
            ) : (
              <div className="sm-col" style={{ gap: 9 }}>
                {trend.map((t) => {
                  const maxC = Math.max(...trend.map((x) => x.count), 1);
                  return (
                    <div key={t.key} className="sm-col" style={{ gap: 3 }}>
                      <div className="sm-between" style={{ fontSize: 13 }}>
                        <span>{t.label}</span>
                        <span><strong>{t.count}건</strong>{t.loss > 0 && <span style={{ marginLeft: 8, color: "var(--sm-danger)" }}>손해 {t.loss.toLocaleString()}원</span>}</span>
                      </div>
                      <div style={{ height: 7, borderRadius: 4, background: "var(--sm-bg-subtle)", overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${Math.round((t.count / maxC) * 100)}%`, background: "var(--sm-orange)", borderRadius: 4 }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 손해금액 집계 */}
          {kpi.loss > 0 && (
            <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginTop: 14 }}>
              <BarList title="유형별 손해금액(원)" data={lossByCategory} accent="var(--sm-danger)" fmt={(n) => n.toLocaleString()} />
              <BarList title={`${unit} 손해금액(원)`} data={trend.filter((t) => t.loss > 0).map((t) => [t.label, t.loss] as [string, number])} accent="var(--sm-danger)" fmt={(n) => n.toLocaleString()} />
            </div>
          )}

          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginTop: 14 }}>
            <BarList title="클레임 유형별" data={byCategory} />
            <BarList title="접수채널별" data={byChannel} accent="var(--sm-info)" />
            <BarList title="수집경로별" data={bySource} accent="var(--sm-info)" />
            <BarList title="구매처별" data={byPlace} accent="var(--sm-warning)" />
            <BarList title="상태별" data={byStatus} accent="var(--sm-text-mid)" />
          </div>

          {/* 상세 내역 — 보고서용 전체 목록 */}
          <section className="b2b-card" style={{ marginTop: 14 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">상세 내역 ({shown.length}건)</span></div>
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead><tr><th>접수일</th><th>채널</th><th>유형</th><th>내용</th><th>처리내용</th><th className="num">손해(원)</th><th>상태</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{r.received_at?.slice(2)}</td>
                      <td>{r.channel || "-"}</td>
                      <td>{r.category}</td>
                      <td style={{ maxWidth: 280 }}>{r.content}</td>
                      <td style={{ maxWidth: 200 }}>{r.resolution || "-"}</td>
                      <td className="num">{r.loss_amount ? r.loss_amount.toLocaleString() : "-"}</td>
                      <td>{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
