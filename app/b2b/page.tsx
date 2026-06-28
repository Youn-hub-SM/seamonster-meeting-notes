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

// 서버는 UTC 로 돌므로 한국 날짜는 +9h 보정해서 계산
function kstNow(): Date {
  return new Date(Date.now() + 9 * 3600 * 1000);
}

function todayIso(): string {
  const d = kstNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
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
        .neq("production_status", "생산완료")
        .neq("status", "취소"),
      // 오늘 발송: 분할발송 차수(shipments) 기준 — 헤더 단일 발송일이 아니라 차수별 발송일로 집계
      sb
        .from("shipments")
        .select("id, order:order_id(status)")
        .eq("ship_date", today)
        .not("status", "in", "(발송완료,취소)"),
      sb
        .from("orders")
        .select("id, total")
        .in("payment_status", ["입금전", "일부입금"]),
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

    // 오늘 발송 차수 수 (취소된 발주 제외)
    type ShipTodayRow = { order: { status: string } | { status: string }[] | null };
    const todayShip = ((ship.data as unknown as ShipTodayRow[] | null) ?? []).filter((s) => {
      const ord = Array.isArray(s.order) ? s.order[0] : s.order;
      return ord ? ord.status !== "취소" : true;
    }).length;

    return {
      companies: c.count ?? 0,
      products: p.count ?? 0,
      todayProduction: prod.count ?? 0,
      todayShip,
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

// ─────────────────────────────────────────────
// 이번 주 일정 (월~일) — 생산·발송 한눈에
// ─────────────────────────────────────────────
type WeekEntry = {
  kind: "production" | "ship";
  orderId: string;
  company: string;
  seqLabel: string; // 분할 발송 차수 표기 ("2차" 등, 없으면 "")
  done: boolean;    // 끝난 일정 (희미하게 표시)
};

type WeekDay = {
  iso: string;
  dayNum: number;
  weekday: string;
  isToday: boolean;
  entries: WeekEntry[];
};

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

function weekRange(): { start: string; end: string; days: { iso: string; dayNum: number }[] } {
  const now = kstNow();
  const dow = now.getUTCDay(); // 0=일
  const diff = dow === 0 ? -6 : 1 - dow; // 월요일 시작
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  const days: { iso: string; dayNum: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    days.push({
      iso: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
      dayNum: d.getUTCDate(),
    });
  }
  return { start: days[0].iso, end: days[6].iso, days };
}

type CompJoin = { name?: string } | { name?: string }[] | null;
function compName(c: CompJoin): string {
  const one = Array.isArray(c) ? c[0] : c;
  return one?.name ?? "(미지정)";
}

async function loadWeekSchedule(): Promise<{ days: WeekDay[]; label: string } | null> {
  try {
    const sb = supabaseAdmin();
    const { start, end, days } = weekRange();
    const today = todayIso();

    const [prodRes, shipRes, headerShipRes] = await Promise.all([
      // 이번 주 생산일
      sb
        .from("orders")
        .select("id, production_date, production_status, companies:company_id(name)")
        .gte("production_date", start)
        .lte("production_date", end)
        .neq("status", "취소"),
      // 이번 주 발송 차수 (분할 발송 포함)
      sb
        .from("shipments")
        .select("id, seq, ship_date, status, order:order_id(id, status, companies:company_id(name))")
        .gte("ship_date", start)
        .lte("ship_date", end)
        .neq("status", "취소"),
      // 발송 차수에 날짜가 없는 과거 발주 — 헤더 발송일로 폴백
      sb
        .from("orders")
        .select("id, ship_date, status, companies:company_id(name)")
        .gte("ship_date", start)
        .lte("ship_date", end)
        .neq("status", "취소"),
    ]);
    if (prodRes.error) throw prodRes.error;
    if (shipRes.error) throw shipRes.error;
    if (headerShipRes.error) throw headerShipRes.error;

    const byDate = new Map<string, WeekEntry[]>();
    const push = (iso: string | null, e: WeekEntry) => {
      if (!iso) return;
      const arr = byDate.get(iso) ?? [];
      arr.push(e);
      byDate.set(iso, arr);
    };

    type ProdRow = { id: string; production_date: string; production_status: string; companies: CompJoin };
    for (const o of (prodRes.data as unknown as ProdRow[] | null) ?? []) {
      push(o.production_date, {
        kind: "production",
        orderId: o.id,
        company: compName(o.companies),
        seqLabel: "",
        done: o.production_status === "생산완료",
      });
    }

    type ShipRow = {
      id: string;
      seq: number;
      ship_date: string;
      status: string;
      order: { id: string; status: string; companies: CompJoin } | { id: string; status: string; companies: CompJoin }[] | null;
    };
    const coveredOrderIds = new Set<string>();
    for (const s of (shipRes.data as unknown as ShipRow[] | null) ?? []) {
      const order = Array.isArray(s.order) ? s.order[0] : s.order;
      if (!order || order.status === "취소") continue;
      coveredOrderIds.add(order.id);
      push(s.ship_date, {
        kind: "ship",
        orderId: order.id,
        company: compName(order.companies),
        seqLabel: s.seq > 1 ? `${s.seq}차` : "",
        done: s.status === "발송완료",
      });
    }

    type HeaderRow = { id: string; ship_date: string; status: string; companies: CompJoin };
    for (const o of (headerShipRes.data as unknown as HeaderRow[] | null) ?? []) {
      if (coveredOrderIds.has(o.id)) continue; // 차수 발송으로 이미 표시됨
      push(o.ship_date, {
        kind: "ship",
        orderId: o.id,
        company: compName(o.companies),
        seqLabel: "",
        done: o.status === "발송완료",
      });
    }

    const weekDays: WeekDay[] = days.map((d, i) => ({
      iso: d.iso,
      dayNum: d.dayNum,
      weekday: WEEKDAYS[i],
      isToday: d.iso === today,
      entries: (byDate.get(d.iso) ?? []).sort((a, b) =>
        a.kind === b.kind ? a.company.localeCompare(b.company, "ko") : a.kind === "production" ? -1 : 1
      ),
    }));

    const [sy, sm, sd] = start.split("-").map(Number);
    const [, em, ed] = end.split("-").map(Number);
    const label = sm === em ? `${sy}년 ${sm}월 ${sd}일 ~ ${ed}일` : `${sy}년 ${sm}월 ${sd}일 ~ ${em}월 ${ed}일`;

    return { days: weekDays, label };
  } catch {
    return null; // 스키마 미적용 등 — 위젯만 조용히 숨김 (스탯 카드가 에러 안내)
  }
}

export default async function B2BDashboard() {
  const [stats, week] = await Promise.all([loadStats(), loadWeekSchedule()]);

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">B2B 관리 대시보드</h1>
          <p className="b2b-page-subtitle">씨몬스터 B2B 발주·생산·발송·매출을 한곳에서 관리합니다.</p>
        </div>
        <div className="b2b-page-actions">
          <Link href="/b2b/orders/new" className="b2b-btn-primary">+ 새 발주</Link>
        </div>
      </header>

      {!stats.schemaReady && (
        <div className="b2b-error">
          <strong>Supabase 스키마가 아직 적용되지 않았어요.</strong>
          <br />
          <code style={{ fontSize: 10 }}>meeting-notes/supabase/migrations/001_b2b_init.sql</code>{" "}
          파일 내용을 Supabase Dashboard {">"}  SQL Editor 에 붙여넣고 Run 해주세요.
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: 10, color: "#666" }}>에러 자세히 보기</summary>
            <pre style={{ marginTop: 8, fontSize: 9, whiteSpace: "pre-wrap", color: "#666" }}>
              {stats.error}
            </pre>
          </details>
        </div>
      )}

      <div className="b2b-dash-grid">
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">등록된 업체</div>
          <div className="b2b-stat-card-value b2b-money">{stats.companies.toLocaleString()}</div>
        </div>

        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">등록된 제품</div>
          <div className="b2b-stat-card-value b2b-money">{stats.products.toLocaleString()}</div>
        </div>

        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">오늘 일정</div>
          {stats.todayProduction === 0 && stats.todayShip === 0 ? (
            <div className="b2b-stat-card-value" style={{ fontSize: 14, fontWeight: 500, color: "var(--sm-text-light)" }}>
              오늘 일정 없음
            </div>
          ) : (
            <div className="b2b-stat-card-value" style={{ fontSize: 20 }}>
              <span style={{ color: "#0A66C2" }}>생산 {stats.todayProduction}</span>
              <span style={{ color: "var(--sm-text-light)", margin: "0 8px", fontWeight: 400 }}>·</span>
              <span style={{ color: "var(--sm-orange)" }}>발송 {stats.todayShip}</span>
            </div>
          )}
        </div>

        <div className="b2b-stat-card" style={stats.unpaidCount > 0 ? { borderColor: "#f5c6c6" } : undefined}>
          <div className="b2b-stat-card-label" style={stats.unpaidCount > 0 ? { color: "#c92a2a" } : undefined}>
            미수금
          </div>
          {stats.unpaidCount === 0 ? (
            <div className="b2b-stat-card-value" style={{ fontSize: 14, fontWeight: 500, color: "var(--sm-text-light)" }}>
              미수금 없음
            </div>
          ) : (
            <>
              <div className="b2b-stat-card-value b2b-money" style={{ color: "#c92a2a" }}>
                {stats.unpaidTotal.toLocaleString()}
              </div>
              <div className="b2b-stat-card-hint">{stats.unpaidCount}건 입금전/일부입금</div>
            </>
          )}
        </div>
      </div>

      {week && (
        <section className="b2b-card">
          <div className="b2b-card-head">
            <div>
              <h2 className="b2b-card-title">이번 주 일정</h2>
              <span style={{ fontSize: 10.5, color: "var(--sm-text-light)" }}>{week.label}</span>
            </div>
            <Link href="/b2b/orders" className="b2b-btn-secondary" style={{ padding: "6px 12px", fontSize: 11 }}>
              발주 캘린더
            </Link>
          </div>
          <div className="b2b-week-glance">
            {week.days.map((d) => (
              <div key={d.iso} className={`b2b-week-glance-day ${d.isToday ? "is-today" : ""}`}>
                <div className="b2b-week-glance-day-head">
                  <span className="b2b-week-glance-weekday">{d.weekday}</span>
                  <span className="b2b-week-glance-date">{d.dayNum}</span>
                </div>
                <div className="b2b-week-glance-entries">
                  {d.entries.length === 0 ? (
                    <span className="b2b-week-glance-empty">-</span>
                  ) : (
                    d.entries.map((e, i) => (
                      <Link
                        key={`${e.orderId}-${e.kind}-${i}`}
                        href={`/b2b/orders/${e.orderId}`}
                        className={`b2b-week-glance-entry ${e.done ? "is-done" : ""}`}
                        title={`${e.kind === "production" ? "생산" : "발송"} · ${e.company}${e.seqLabel ? ` (${e.seqLabel})` : ""}`}
                      >
                        <span className={`b2b-week-glance-kind is-${e.kind}`}>
                          {e.kind === "production" ? "생산" : "발송"}
                        </span>
                        <span className="b2b-week-glance-company">
                          {e.company}
                          {e.seqLabel && <em> {e.seqLabel}</em>}
                        </span>
                      </Link>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
