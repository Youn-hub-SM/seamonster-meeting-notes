"use client";

import { useEffect, useMemo, useState } from "react";
import { Product, TAX_TYPE_LABEL } from "@/app/lib/b2b-types";
import { computeMargin } from "@/app/lib/b2b-margin";

const won = (n: number) => Math.round(n).toLocaleString();

export default function MarginPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch("/api/b2b/products", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "조회 실패");
        setProducts(data.products || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "조회 중 오류");
      }
      setLoading(false);
    })();
  }, []);

  // 원가 데이터가 있는 활성 제품만
  const costed = useMemo(
    () => products.filter((p) => p.active && Number(p.cost_price) > 0),
    [products]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return costed;
    return costed.filter((p) =>
      [p.name, p.sku, p.spec].filter(Boolean).some((v) => v!.toLowerCase().includes(q))
    );
  }, [costed, search]);

  const rows = useMemo(
    () =>
      filtered.map((p) => ({
        p,
        m: computeMargin({ salePrice: p.sale_price, taxType: p.tax_type, cost: p.cost_price }),
      })),
    [filtered]
  );

  const kpi = useMemo(() => {
    if (rows.length === 0) return { avg: 0, profit: 0, loss: 0 };
    const sum = rows.reduce((s, r) => s + r.m.marginPct, 0);
    const profit = rows.filter((r) => r.m.profit >= 0).length;
    return { avg: sum / rows.length, profit, loss: rows.length - profit };
  }, [rows]);

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">이익률</h1>
          <p className="b2b-page-subtitle">
            도매가 기준 이익률 — 매출 대비 제품 단위 원가(제품원가 + 포장재). 과세 제품은 공급가(÷1.1) 기준.
          </p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head" style={{ gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            className="b2b-search"
            placeholder="제품명·SKU·옵션 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginLeft: "auto" }}>
            <Kpi label="대상 제품" value={`${rows.length}개`} />
            <Kpi label="평균 이익률" value={`${kpi.avg.toFixed(1)}%`} tone={kpi.avg >= 0 ? "pos" : "neg"} />
            <Kpi label="흑자 / 적자" value={`${kpi.profit} / ${kpi.loss}`} tone={kpi.loss > 0 ? "neg" : "pos"} />
          </div>
        </div>
      </div>

      <div className="b2b-card">
        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : rows.length === 0 ? (
          <div className="b2b-empty">
            <div className="b2b-empty-icon">📊</div>
            {costed.length === 0
              ? "원가가 입력된 제품이 없습니다. 원가표에서 제품 원가를 등록하세요."
              : "검색 결과가 없습니다."}
          </div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table is-responsive">
              <thead>
                <tr>
                  <th>제품</th>
                  <th className="num">도매가</th>
                  <th className="num">매출(공급가)</th>
                  <th className="num">원가</th>
                  <th className="num">이익</th>
                  <th className="num">이익률</th>
                  <th className="actions"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, m }) => {
                  const isExp = expanded === p.id;
                  const tone = m.profit >= 0 ? "var(--sm-dark)" : "#c92a2a";
                  return (
                    <FragmentRow key={p.id}>
                      <tr>
                        <td data-label="제품">
                          <strong>{p.name}</strong>
                          {p.spec && <span style={{ color: "var(--sm-text-mid)" }}> {p.spec}</span>}
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 11,
                              fontWeight: 700,
                              padding: "1px 6px",
                              borderRadius: 10,
                              background: p.tax_type === "exempt" ? "#E0F0FF" : "#FFF4E0",
                              color: p.tax_type === "exempt" ? "#0A66C2" : "#B86E00",
                            }}
                          >
                            {TAX_TYPE_LABEL[p.tax_type]}
                          </span>
                          {p.sku && (
                            <span style={{ display: "block", fontSize: 11, color: "var(--sm-text-light)" }}>{p.sku}</span>
                          )}
                        </td>
                        <td data-label="도매가" className="num b2b-money">{won(p.sale_price)}</td>
                        <td data-label="매출(공급가)" className="num b2b-money">
                          {m.vatExcluded ? won(m.revenue) : "—"}
                        </td>
                        <td data-label="원가" className="num b2b-money">{won(m.cost)}</td>
                        <td data-label="이익" className="num b2b-money" style={{ color: tone, fontWeight: 700 }}>
                          {m.profit >= 0 ? "+" : ""}{won(m.profit)}
                        </td>
                        <td data-label="이익률" className="num" style={{ color: tone, fontWeight: 700 }}>
                          {m.marginPct.toFixed(1)}%
                        </td>
                        <td className="actions">
                          <button
                            className="b2b-btn-secondary"
                            style={{ padding: "4px 10px", fontSize: 12 }}
                            onClick={() => setExpanded(isExp ? null : p.id)}
                          >
                            {isExp ? "닫기" : "원가"}
                          </button>
                        </td>
                      </tr>
                      {isExp && (
                        <tr>
                          <td colSpan={7} style={{ background: "var(--sm-bg)", padding: 16 }}>
                            <CostDetail p={p} revenue={m.revenue} vatExcluded={m.vatExcluded} />
                          </td>
                        </tr>
                      )}
                    </FragmentRow>
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

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  const color = tone === "neg" ? "#c92a2a" : tone === "pos" ? "#22863a" : "var(--sm-dark)";
  return (
    <div style={{ padding: "8px 14px", background: "var(--sm-bg)", borderRadius: 10, minWidth: 110 }}>
      <div style={{ fontSize: 11, color: "var(--sm-text-light)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function CostDetail({ p, revenue, vatExcluded }: { p: Product; revenue: number; vatExcluded: boolean }) {
  const Row = ({ k, v, strong }: { k: string; v: string; strong?: boolean }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 13, fontWeight: strong ? 700 : 400, color: strong ? undefined : "var(--sm-text-mid)" }}>
      <span>{k}</span>
      <span className="b2b-money">{v}</span>
    </div>
  );
  const pkg = (Number(p.pkg_inner) || 0) + (Number(p.pkg_label) || 0) + (Number(p.pkg_outer) || 0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 20 }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 4 }}>원가 구성</div>
        <Row k="제품원가" v={won(p.cost_material)} />
        <Row k="내포장지" v={won(p.pkg_inner)} />
        <Row k="라벨" v={won(p.pkg_label)} />
        <Row k="외포장지" v={won(p.pkg_outer)} />
        <Row k="포장재 소계" v={won(pkg)} />
        <Row k="제품 단위 원가" v={won(p.cost_price)} strong />
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 4 }}>손익</div>
        <Row k="도매가" v={won(p.sale_price)} />
        {vatExcluded && <Row k="└ 공급가 (÷1.1)" v={won(revenue)} />}
        <Row k="원가" v={won(p.cost_price)} />
        <Row k="이익" v={`${revenue - p.cost_price >= 0 ? "+" : ""}${won(revenue - p.cost_price)}`} strong />
      </div>
    </div>
  );
}
