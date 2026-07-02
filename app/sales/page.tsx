"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

type Bounds = { min_date: string | null; max_date: string | null; total_rows: number };
type Dash = {
  ok: boolean; base_date: string; is_sunday: boolean;
  window_sales: number; window_start: string; window_end: string;
  this_month_sales: number; prev_month_sales: number; month_rr_pct: number | null;
  this_year_sales: number; last_year_sales: number; year_rr_pct: number | null;
  order_count: number; aov: number; new_cust: number; repeat_cust: number;
  channels: { name: string; month: number; prev_month: number }[];
  top10: { rank: number; code: string; revenue: number }[];
};

const won = (n: number) => `${Math.round(n || 0).toLocaleString()}원`;
function wonEok(v: number) { v = Math.round(v || 0); const eok = Math.floor(v / 1e8), man = Math.floor((v % 1e8) / 1e4); return eok > 0 ? `${eok}억 ${man.toLocaleString()}만` : `${man.toLocaleString()}만`; }
function pctBadge(p: number | null) {
  if (p === null) return <span style={{ color: "var(--sm-faint)", fontWeight: 700 }}>신규</span>;
  const up = p >= 0;
  return <span style={{ color: up ? "var(--sm-success)" : "var(--sm-danger)", fontWeight: 700 }}>{up ? "▲" : "▼"} {Math.abs(p).toFixed(1)}%</span>;
}

export default function SalesHome() {
  const [b, setB] = useState<Bounds | null>(null);
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/sales/bounds").then((r) => r.json()).then((j) => { if (j.ok) setB(j); else setErr(j.error || ""); }).catch((e) => setErr(String(e)));
    fetch("/api/sales/dashboard").then((r) => r.json()).then((j) => { if (j.ok) setD(j); }).catch(() => {});
  }, []);

  const hasData = b && b.total_rows > 0;
  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">매출</h1>
          <p className="b2b-page-subtitle">주문 데이터 업로드 → 일일/주간 리포트 · 대시보드 · 주문검색. 기준일 {d?.base_date || b?.max_date || "-"}.</p>
        </div>
      </header>

      {err && <section className="b2b-card"><p style={{ color: "var(--sm-warning)", fontSize: 13 }}>데이터 조회 실패: {err}<br /><span className="sm-faint">마이그레이션 039를 Supabase에 아직 적용하지 않았다면 먼저 적용하세요.</span></p></section>}

      {hasData && d && (
        <>
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
            <Kpi label={d.is_sunday ? "최근 3일(금~일)" : "어제 매출"} value={won(d.window_sales)} sub={`주문 ${d.order_count}건 · 객단가 ${won(d.aov)}`} />
            <Kpi label="이번달 누적" value={`${wonEok(d.this_month_sales)} 원`} sub={<>전월 대비 환산 {pctBadge(d.month_rr_pct)}</>} />
            <Kpi label="올해 누적" value={`${wonEok(d.this_year_sales)} 원`} sub={<>전년 대비 페이스 {pctBadge(d.year_rr_pct)}</>} accent />
            <Kpi label="신규 : 재구매" value={`${d.new_cust} : ${d.repeat_cust}`} sub={`${d.is_sunday ? "최근 3일" : "어제"} 기준 고객 수`} />
          </div>

          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 12, marginTop: 12 }}>
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">채널별 이번달 (월 누적)</span></div>
              {d.channels.length ? (
                <table className="b2b-table" style={{ fontSize: 13 }}>
                  <tbody>{d.channels.map((c) => (
                    <tr key={c.name}><td>{c.name}</td><td style={{ textAlign: "right", fontWeight: 700 }}>{won(c.month)}</td><td style={{ textAlign: "right", width: 70 }}>{pctBadge(c.prev_month === 0 ? null : (c.month - c.prev_month) / c.prev_month * 100)}</td></tr>
                  ))}</tbody>
                </table>
              ) : <p className="sm-faint">데이터 없음</p>}
            </section>
            <section className="b2b-card">
              <div className="b2b-card-head"><span className="b2b-card-title">{d.is_sunday ? "최근 3일" : "어제"} 잘 팔린 상품 Top 5</span></div>
              {d.top10.length ? (
                <table className="b2b-table" style={{ fontSize: 13 }}>
                  <tbody>{d.top10.map((t) => (
                    <tr key={t.rank}><td style={{ width: 28 }}>{t.rank}</td><td style={{ fontFamily: "monospace" }}>{t.code}</td><td style={{ textAlign: "right", fontWeight: 700 }}>{won(t.revenue)}</td></tr>
                  ))}</tbody>
                </table>
              ) : <p className="sm-faint">데이터 없음</p>}
            </section>
          </div>
        </>
      )}

      <section className="b2b-card" style={{ marginTop: 12 }}>
        <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          <div className="b2b-card" style={{ padding: 14, textAlign: "center" }}>
            <div className="sm-faint" style={{ fontSize: 12 }}>누적 행 수</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{b ? b.total_rows.toLocaleString() : "…"}</div>
          </div>
          <div className="b2b-card" style={{ padding: 14, textAlign: "center" }}>
            <div className="sm-faint" style={{ fontSize: 12 }}>데이터 기간</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 8 }}>{b?.min_date && b?.max_date ? `${b.min_date} ~ ${b.max_date}` : "데이터 없음"}</div>
          </div>
        </div>
        {b && b.total_rows === 0 && <p className="sm-faint" style={{ fontSize: 13, marginTop: 10 }}>아직 매출 데이터가 없습니다. 과거 전체는 백필 스크립트로, 이후는 <Link href="/sales/upload" style={{ color: "var(--sm-orange)" }}>데이터 업로드</Link>로 채우세요.</p>}
      </section>

      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginTop: 12 }}>
        <NavCard href="/sales/upload" title="데이터 업로드" desc="주문 파일 첨부 → 미리보기 → 적용(멱등)" />
        <NavCard href="/sales/report" title="리포트" desc="일일·주간 매출 리포트 생성·메일 발송" />
        <NavCard href="/sales/search" title="주문 검색" desc="전화번호로 구매/재구매 이력 · 엑셀 추출" />
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub: ReactNode; accent?: boolean }) {
  return (
    <div className="b2b-card" style={{ padding: 16, borderColor: accent ? "var(--sm-orange)" : undefined }}>
      <div className="sm-faint" style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: accent ? "var(--sm-orange)" : "var(--sm-text)" }}>{value}</div>
      <div style={{ fontSize: 12.5, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function NavCard({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href} className="b2b-card" style={{ padding: 16, textDecoration: "none", display: "block" }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: "var(--sm-text)" }}>{title}</div>
      <div className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>{desc}</div>
      <div style={{ marginTop: 8, color: "var(--sm-orange)", fontWeight: 700, fontSize: 13 }}>열기 →</div>
    </Link>
  );
}
