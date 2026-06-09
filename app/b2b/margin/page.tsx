"use client";

import { useEffect, useMemo, useState } from "react";
import { Product, TAX_TYPE_LABEL } from "@/app/lib/b2b-types";
import {
  SEASONS,
  Season,
  SEASON_MONTHS,
  seasonForMonth,
  computeMargin,
} from "@/app/lib/b2b-margin";

const won = (n: number) => Math.round(n).toLocaleString();

export default function MarginPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [season, setSeason] = useState<Season>(() => seasonForMonth(new Date().getMonth() + 1));
  const [globalQty, setGlobalQty] = useState(1);
  const [boxQty, setBoxQty] = useState<Record<string, number>>({});
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

  // 원가 데이터가 있는 제품만 (제품원가 또는 부피가 입력된 것)
  const costed = useMemo(
    () => products.filter((p) => p.active && (Number(p.cost_material) > 0 || p.volume_kg != null)),
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
      filtered.map((p) => {
        const n = boxQty[p.id] ?? 1;
        const m = computeMargin({
          salePrice: p.sale_price,
          taxType: p.tax_type,
          costMaterial: p.cost_material,
          pkgInner: p.pkg_inner,
          pkgLabel: p.pkg_label,
          pkgOuter: p.pkg_outer,
          volumeKg: p.volume_kg,
          season,
          unitsPerBox: n,
        });
        return { p, n, m };
      }),
    [filtered, boxQty, season]
  );

  // 요약 KPI
  const kpi = useMemo(() => {
    if (rows.length === 0) return { avg: 0, profit: 0, loss: 0 };
    const sum = rows.reduce((s, r) => s + r.m.marginPct, 0);
    const profit = rows.filter((r) => r.m.profit >= 0).length;
    return { avg: sum / rows.length, profit, loss: rows.length - profit };
  }, [rows]);

  function setQty(id: string, v: number) {
    setBoxQty((prev) => ({ ...prev, [id]: Math.max(1, Math.floor(v) || 1) }));
  }
  function applyGlobalQty() {
    const next: Record<string, number> = {};
    for (const p of costed) next[p.id] = Math.max(1, Math.floor(globalQty) || 1);
    setBoxQty(next);
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">이익률</h1>
          <p className="b2b-page-subtitle">
            도매가 기준 이익률 — 제품원가·포장재 + 배송 1건 비용(아이스박스·운반비·보냉비)을 박스당 수량으로 배분해 계산합니다.
            {" "}과세 제품은 공급가(÷1.1) 기준.
          </p>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {/* 컨트롤 바 */}
      <div className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-card-head" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--sm-text-mid)" }}>
            계절 (보냉비)
            <select
              className="b2b-select"
              value={season}
              onChange={(e) => setSeason(e.target.value as Season)}
              style={{ width: "auto", minWidth: 180 }}
            >
              {SEASONS.map((s) => (
                <option key={s} value={s}>{s} ({SEASON_MONTHS[s]})</option>
              ))}
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--sm-text-mid)" }}>
            박스당 수량 일괄 적용
            <span style={{ display: "flex", gap: 6 }}>
              <input
                type="number"
                inputMode="numeric"
                className="b2b-input"
                value={globalQty}
                min={1}
                step={1}
                onChange={(e) => setGlobalQty(Number(e.target.value) || 1)}
                style={{ width: 90 }}
              />
              <button type="button" className="b2b-btn-secondary" onClick={applyGlobalQty}>
                전체 적용
              </button>
            </span>
          </label>

          <input
            type="text"
            className="b2b-search"
            placeholder="제품명·SKU·옵션 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 240, marginLeft: "auto" }}
          />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "0 4px 4px" }}>
          <Kpi label="대상 제품" value={`${rows.length}개`} />
          <Kpi label="평균 이익률" value={`${kpi.avg.toFixed(1)}%`} tone={kpi.avg >= 0 ? "pos" : "neg"} />
          <Kpi label="흑자 / 적자" value={`${kpi.profit} / ${kpi.loss}`} tone={kpi.loss > 0 ? "neg" : "pos"} />
        </div>
      </div>

      <div className="b2b-card">
        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : rows.length === 0 ? (
          <div className="b2b-empty">
            <div className="b2b-empty-icon">📊</div>
            {costed.length === 0
              ? "원가 상세(제품원가·부피)가 입력된 제품이 없습니다. 원가표에서 제품을 등록하거나 원가표 CSV를 반영하세요."
              : "검색 결과가 없습니다."}
          </div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table is-responsive">
              <thead>
                <tr>
                  <th>제품</th>
                  <th className="num">도매가</th>
                  <th className="num">제품원가</th>
                  <th className="num" style={{ minWidth: 92 }}>박스당</th>
                  <th className="num">배송비/개</th>
                  <th className="num">총원가</th>
                  <th className="num">이익</th>
                  <th className="num">이익률</th>
                  <th className="actions"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, n, m }) => {
                  const isExp = expanded === p.id;
                  const tone = m.profit >= 0 ? "var(--sm-dark)" : "#c92a2a";
                  return (
                    <FragmentRow key={p.id}>
                      <tr>
                        <td data-label="제품">
                          <strong>{p.name}</strong>
                          {p.spec && <span style={{ color: "var(--sm-text-mid)" }}> · {p.spec}</span>}
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
                        <td data-label="도매가" className="num b2b-money">
                          {won(p.sale_price)}
                          {m.vatExcluded && (
                            <span style={{ display: "block", fontSize: 11, color: "var(--sm-text-light)" }}>
                              공급가 {won(m.revenue)}
                            </span>
                          )}
                        </td>
                        <td data-label="제품원가" className="num b2b-money">{won(m.productCost)}</td>
                        <td data-label="박스당" className="num">
                          <input
                            type="number"
                            inputMode="numeric"
                            className="b2b-input"
                            value={n}
                            min={1}
                            step={1}
                            onChange={(e) => setQty(p.id, Number(e.target.value))}
                            style={{ width: 72, textAlign: "right" }}
                            disabled={!m.hasVolume}
                            title={m.hasVolume ? "박스당 수량" : "부피 미입력 — 배송비 계산 제외"}
                          />
                        </td>
                        <td data-label="배송비/개" className="num b2b-money">
                          {m.hasVolume ? won(m.shipPerUnit) : "-"}
                        </td>
                        <td data-label="총원가" className="num b2b-money">{won(m.totalCost)}</td>
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
                            {isExp ? "닫기" : "상세"}
                          </button>
                        </td>
                      </tr>
                      {isExp && (
                        <tr>
                          <td colSpan={9} style={{ background: "var(--sm-bg)", padding: 16 }}>
                            <MarginDetail p={p} n={n} m={m} season={season} />
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
    <div style={{ padding: "8px 14px", background: "var(--sm-bg)", borderRadius: 10, minWidth: 120 }}>
      <div style={{ fontSize: 11, color: "var(--sm-text-light)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function MarginDetail({
  p,
  n,
  m,
  season,
}: {
  p: Product;
  n: number;
  m: ReturnType<typeof computeMargin>;
  season: Season;
}) {
  const Row = ({ k, v, sub }: { k: string; v: string; sub?: boolean }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 13, paddingLeft: sub ? 14 : 0, color: sub ? "var(--sm-text-mid)" : undefined }}>
      <span>{k}</span>
      <span className="b2b-money">{v}</span>
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 20 }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 4 }}>제품 단위 원가</div>
        <Row k="제품원가" v={won(p.cost_material)} sub />
        <Row k="내포장지" v={won(p.pkg_inner)} sub />
        <Row k="라벨" v={won(p.pkg_label)} sub />
        <Row k="외포장지" v={won(p.pkg_outer)} sub />
        <Row k="소계" v={won(m.productCost)} />
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 4 }}>
          배송 1건 비용 {m.hasVolume ? `(부피 ${m.boxVolume}kg · ${n}개 배분)` : "(부피 미입력)"}
        </div>
        {m.hasVolume ? (
          <>
            <Row k="아이스박스" v={won(m.icebox)} sub />
            <Row k="운반비" v={won(m.delivery)} sub />
            <Row k={`보냉비 (${season})`} v={won(m.cooling)} sub />
            <Row k="배송 1건 합계" v={won(m.shipPerBox)} />
            <Row k={`÷ ${n}개 = 개당 배송비`} v={won(m.shipPerUnit)} />
          </>
        ) : (
          <div style={{ fontSize: 13, color: "var(--sm-text-light)" }}>제품부피(kg)를 입력하면 배송비가 계산됩니다.</div>
        )}
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 4 }}>손익</div>
        <Row k="매출 (도매가)" v={won(p.sale_price)} sub />
        {m.vatExcluded && <Row k="└ 공급가 (÷1.1)" v={won(m.revenue)} sub />}
        <Row k="총원가" v={won(m.totalCost)} sub />
        <Row k="이익" v={`${m.profit >= 0 ? "+" : ""}${won(m.profit)}`} />
        <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 14, fontWeight: 700, color: m.profit >= 0 ? "#22863a" : "#c92a2a" }}>
          <span>이익률</span>
          <span>{m.marginPct.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}
