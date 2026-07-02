"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function SalesHome() {
  const [b, setB] = useState<{ min_date: string | null; max_date: string | null; total_rows: number } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/sales/bounds").then((r) => r.json()).then((j) => { if (j.ok) setB(j); else setErr(j.error || ""); }).catch((e) => setErr(String(e)));
  }, []);

  return (
    <div className="b2b-container" style={{ maxWidth: 900 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">매출</h1>
          <p className="b2b-page-subtitle">주문 데이터를 업로드하면 일일/주간 리포트·대시보드·주문검색이 채워집니다.</p>
        </div>
      </header>

      <section className="b2b-card">
        {err ? (
          <p style={{ color: "var(--sm-warning)", fontSize: 13 }}>데이터 조회 실패: {err}<br /><span className="sm-faint">마이그레이션 039를 Supabase에 아직 적용하지 않았다면 먼저 적용하세요.</span></p>
        ) : b ? (
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
            <div className="b2b-card" style={{ padding: 14, textAlign: "center" }}>
              <div className="sm-faint" style={{ fontSize: 12 }}>누적 행 수</div>
              <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{b.total_rows.toLocaleString()}</div>
            </div>
            <div className="b2b-card" style={{ padding: 14, textAlign: "center" }}>
              <div className="sm-faint" style={{ fontSize: 12 }}>데이터 기간</div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 8 }}>{b.min_date && b.max_date ? `${b.min_date} ~ ${b.max_date}` : "데이터 없음"}</div>
            </div>
          </div>
        ) : (
          <p className="sm-faint">불러오는 중…</p>
        )}
        {b && b.total_rows === 0 && <p className="sm-faint" style={{ fontSize: 13, marginTop: 10 }}>아직 매출 데이터가 없습니다. 과거 전체는 백필 스크립트로, 이후는 <Link href="/sales/upload" style={{ color: "var(--sm-orange)" }}>데이터 업로드</Link>로 채우세요.</p>}
      </section>

      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginTop: 12 }}>
        <NavCard href="/sales/upload" title="데이터 업로드" desc="주문 파일 첨부 → 미리보기 → 적용(멱등)" />
        <NavCard href="/sales/report" title="리포트" desc="일일·주간 매출 리포트 생성·메일 발송" />
        <NavCard href="/sales/search" title="주문 검색" desc="전화번호로 구매/재구매 이력 조회" />
      </div>
      <p className="sm-faint" style={{ fontSize: 12, marginTop: 14 }}>대시보드 지표·리포트·주문검색은 순차 구축 중입니다. 먼저 데이터 업로드/백필로 매출을 채워주세요.</p>
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
