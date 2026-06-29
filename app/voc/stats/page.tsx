"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { VOC_CATEGORIES, type Voc } from "@/app/lib/voc";

type Range = "전체" | "올해" | "90일" | "30일";

function rangeStart(r: Range): string {
  if (r === "전체") return "0000-00-00";
  const now = new Date(Date.now() + 9 * 3600_000);
  if (r === "올해") return `${now.getFullYear()}-01-01`;
  const days = r === "90일" ? 90 : 30;
  const d = new Date(now.getTime() - days * 86400_000);
  return d.toISOString().slice(0, 10);
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

function BarList({ title, data, accent }: { title: string; data: [string, number][]; accent?: string }) {
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
                <strong>{n}</strong>
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
  const byMonth = useMemo(() => {
    const m = countBy(shown, (r) => r.received_at?.slice(0, 7));
    return m.sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">VOC 통계·리포트</h1>
          <p className="b2b-page-subtitle">클레임을 유형·채널·기간으로 집계해 한눈에 봅니다. PDF 보고서는 <Link href="/voc/reports" className="change-link">보고서·요청서</Link>에서.</p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="prod-range-tabs" style={{ marginBottom: 16, flexWrap: "wrap" }}>
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

          {byMonth.length > 0 && <BarList title="월별 접수 추세" data={byMonth} />}
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginTop: 14 }}>
            <BarList title="클레임 유형별" data={byCategory} />
            <BarList title="접수채널별" data={byChannel} accent="var(--sm-info)" />
            <BarList title="수집경로별" data={bySource} accent="var(--sm-info)" />
            <BarList title="구매처별" data={byPlace} accent="var(--sm-warning)" />
            <BarList title="상태별" data={byStatus} accent="var(--sm-text-mid)" />
          </div>
        </>
      )}
    </div>
  );
}
