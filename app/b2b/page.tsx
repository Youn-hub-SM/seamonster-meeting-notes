import Link from "next/link";
import { supabaseAdmin } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

type DashStats = {
  companies: number;
  products: number;
  schemaReady: boolean;
  error?: string;
};

async function loadStats(): Promise<DashStats> {
  try {
    const sb = supabaseAdmin();
    // head:true 로 카운트만 받으면 테이블이 없을 때도 status 204 / error null 로 와서
    // 마스킹됨. limit(0) 으로 빈 select 를 보내 PGRST 에러를 제대로 받음.
    const [c, p] = await Promise.all([
      sb.from("companies").select("id", { count: "exact" }).limit(0),
      sb.from("products").select("id", { count: "exact" }).limit(0),
    ]);
    if (c.error) throw c.error;
    if (p.error) throw p.error;
    return {
      companies: c.count ?? 0,
      products: p.count ?? 0,
      schemaReady: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      companies: 0,
      products: 0,
      schemaReady: false,
      error: msg,
    };
  }
}

export default async function B2BDashboard() {
  const stats = await loadStats();

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">B2B 관리 대시보드</h1>
          <p className="b2b-page-subtitle">씨몬스터 B2B 발주·생산·발송·매출을 한곳에서 관리합니다.</p>
        </div>
      </header>

      {!stats.schemaReady && (
        <div className="b2b-error">
          <strong>Supabase 스키마가 아직 적용되지 않았어요.</strong>
          <br />
          <code style={{ fontSize: 12 }}>meeting-notes/supabase/migrations/001_b2b_init.sql</code>{" "}
          파일 내용을 Supabase Dashboard {">"}  SQL Editor 에 붙여넣고 Run 해주세요.
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "#666" }}>에러 자세히 보기</summary>
            <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: "pre-wrap", color: "#666" }}>
              {stats.error}
            </pre>
          </details>
        </div>
      )}

      <div className="b2b-dash-grid">
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">등록된 업체</div>
          <div className="b2b-stat-card-value b2b-money">{stats.companies.toLocaleString()}</div>
          <div className="b2b-quick-actions">
            <Link href="/b2b/companies" className="b2b-btn-secondary">
              주소록 열기
            </Link>
          </div>
        </div>

        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">등록된 제품</div>
          <div className="b2b-stat-card-value b2b-money">{stats.products.toLocaleString()}</div>
          <div className="b2b-quick-actions">
            <Link href="/b2b/products" className="b2b-btn-secondary">
              원가표 열기
            </Link>
          </div>
        </div>

        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">오늘 일정</div>
          <div className="b2b-stat-card-value" style={{ fontSize: 16, fontWeight: 500, color: "var(--sm-text-light)" }}>
            발주 모듈 준비 중
          </div>
          <div className="b2b-stat-card-hint">Phase 2 에서 추가 예정</div>
        </div>

        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">미입금</div>
          <div className="b2b-stat-card-value" style={{ fontSize: 16, fontWeight: 500, color: "var(--sm-text-light)" }}>
            입금 모듈 준비 중
          </div>
          <div className="b2b-stat-card-hint">Phase 5 에서 추가 예정</div>
        </div>
      </div>

      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">시작하기</h2>
        </div>
        <ol style={{ paddingLeft: 20, lineHeight: 1.9, color: "var(--sm-dark)" }}>
          <li>
            <strong>업체 등록</strong> — <Link href="/b2b/companies" style={{ color: "var(--sm-orange)" }}>주소록</Link>에서 거래처 정보 (사업자번호·담당자·결제조건) 입력
          </li>
          <li>
            <strong>제품 등록</strong> — <Link href="/b2b/products" style={{ color: "var(--sm-orange)" }}>원가표</Link>에서 품목·규격·원가·판매가 입력
          </li>
          <li>
            <strong>발주 등록</strong> — Phase 2 에서 추가 예정
          </li>
        </ol>
      </section>
    </>
  );
}
