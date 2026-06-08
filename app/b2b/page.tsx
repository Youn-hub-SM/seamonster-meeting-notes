import Link from "next/link";
import { supabaseAdmin } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

type DashStats = {
  companies: number;
  products: number;
  todayProduction: number;
  todayShip: number;
  unpaidCount: number;
  unpaidTotal: number;
  schemaReady: boolean;
  error?: string;
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadStats(): Promise<DashStats> {
  try {
    const sb = supabaseAdmin();
    const today = todayIso();
    // head:true 로 카운트만 받으면 테이블이 없을 때도 status 204 / error null 로 와서
    // 마스킹됨. limit(0) 으로 빈 select 를 보내 PGRST 에러를 제대로 받음.
    const [c, p, prod, ship, unpaid] = await Promise.all([
      sb.from("companies").select("id", { count: "exact" }).limit(0),
      sb.from("products").select("id", { count: "exact" }).limit(0),
      sb
        .from("orders")
        .select("id", { count: "exact" })
        .limit(0)
        .eq("production_date", today)
        .not("status", "in", "(발송완료,취소)"),
      sb
        .from("orders")
        .select("id", { count: "exact" })
        .limit(0)
        .eq("ship_date", today)
        .not("status", "in", "(발송완료,취소)"),
      sb
        .from("orders")
        .select("id, total")
        .in("payment_status", ["미입금", "부분입금"]),
    ]);
    if (c.error) throw c.error;
    if (p.error) throw p.error;
    if (prod.error) throw prod.error;
    if (ship.error) throw ship.error;
    if (unpaid.error) throw unpaid.error;

    // payments 합계 — 미입금 발주의 잔액 정확히 구하려면 payments 합산 필요
    const unpaidIds = (unpaid.data ?? []).map((o: { id: string }) => o.id);
    let paidByOrder = new Map<string, number>();
    if (unpaidIds.length > 0) {
      const { data: pays, error: pErr } = await sb
        .from("payments")
        .select("order_id, amount")
        .in("order_id", unpaidIds);
      if (pErr) throw pErr;
      paidByOrder = new Map<string, number>();
      for (const pp of pays ?? []) {
        paidByOrder.set(pp.order_id, (paidByOrder.get(pp.order_id) || 0) + Number(pp.amount || 0));
      }
    }
    const unpaidTotal = (unpaid.data ?? []).reduce((s, o: { id: string; total: number }) => {
      const paid = paidByOrder.get(o.id) || 0;
      return s + Math.max(0, Number(o.total) - paid);
    }, 0);

    return {
      companies: c.count ?? 0,
      products: p.count ?? 0,
      todayProduction: prod.count ?? 0,
      todayShip: ship.count ?? 0,
      unpaidCount: (unpaid.data ?? []).length,
      unpaidTotal,
      schemaReady: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      companies: 0,
      products: 0,
      todayProduction: 0,
      todayShip: 0,
      unpaidCount: 0,
      unpaidTotal: 0,
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
          {stats.todayProduction === 0 && stats.todayShip === 0 ? (
            <div className="b2b-stat-card-value" style={{ fontSize: 16, fontWeight: 500, color: "var(--sm-text-light)" }}>
              오늘 일정 없음
            </div>
          ) : (
            <div className="b2b-stat-card-value" style={{ fontSize: 22 }}>
              <span style={{ color: "#0A66C2" }}>생산 {stats.todayProduction}</span>
              <span style={{ color: "var(--sm-text-light)", margin: "0 8px", fontWeight: 400 }}>·</span>
              <span style={{ color: "var(--sm-orange)" }}>발송 {stats.todayShip}</span>
            </div>
          )}
          <div className="b2b-quick-actions">
            <Link href="/b2b/orders" className="b2b-btn-secondary">
              발주 열기
            </Link>
          </div>
        </div>

        <div className="b2b-stat-card" style={stats.unpaidCount > 0 ? { borderColor: "#f5c6c6" } : undefined}>
          <div className="b2b-stat-card-label" style={stats.unpaidCount > 0 ? { color: "#c92a2a" } : undefined}>
            미수금
          </div>
          {stats.unpaidCount === 0 ? (
            <div className="b2b-stat-card-value" style={{ fontSize: 16, fontWeight: 500, color: "var(--sm-text-light)" }}>
              미입금 없음
            </div>
          ) : (
            <>
              <div className="b2b-stat-card-value b2b-money" style={{ color: "#c92a2a" }}>
                {stats.unpaidTotal.toLocaleString()}
              </div>
              <div className="b2b-stat-card-hint">{stats.unpaidCount}건 미입금/부분입금</div>
            </>
          )}
          <div className="b2b-quick-actions" style={{ marginTop: stats.unpaidCount === 0 ? 8 : 0 }}>
            <Link href="/b2b/payments" className="b2b-btn-secondary">
              입금 확인 열기
            </Link>
          </div>
        </div>
      </div>

      <section className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">바로가기</h2>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link href="/b2b/orders/new" className="b2b-btn-primary">+ 새 발주</Link>
          <Link href="/b2b/orders" className="b2b-btn-secondary">발주 목록 (캘린더·주간)</Link>
          <Link href="/b2b/reports" className="b2b-btn-secondary">매출 집계</Link>
          <Link href="/b2b/companies" className="b2b-btn-secondary">업체 주소록</Link>
          <Link href="/b2b/products" className="b2b-btn-secondary">원가표</Link>
        </div>
      </section>
    </>
  );
}
