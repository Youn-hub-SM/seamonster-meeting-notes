"use client";

import { useEffect, useMemo, useState } from "react";
import { Product, ProductInput, EMPTY_PRODUCT, CostHistory, TAX_TYPES, TAX_TYPE_LABEL } from "@/app/lib/b2b-types";
import BundleEditor from "@/app/components/BundleEditor";

type Modal = { mode: "create" | "edit"; data: ProductInput } | null;

type DiffChange = { label: string; from: string; to: string };
type ImportPreview = {
  summary: { creates: number; updates: number; unchanged: number; errors: number };
  creates: { name: string; row: ProductInput }[];
  updates: { id: string; name: string; changes: DiffChange[]; row: ProductInput }[];
  errors: { line: number; msg: string }[];
};

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [showBundles, setShowBundles] = useState(false); // 묶음(세트) 상품 표시 여부 — 기본 숨김
  const [modal, setModal] = useState<Modal>(null);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState(""); // 모달 안에서 보여줄 저장 오류(SKU 중복 등) — 페이지 배너가 모달 뒤에 가려지는 문제 대응
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<CostHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [bundleFor, setBundleFor] = useState<Product | null>(null);

  async function reload() {
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
  }

  useEffect(() => {
    reload();
  }, []);

  const bundleCount = useMemo(() => products.filter((p) => p.is_bundle).length, [products]);

  const filtered = useMemo(() => {
    let arr = products;
    if (!showInactive) arr = arr.filter((p) => p.active);
    if (!showBundles) arr = arr.filter((p) => !p.is_bundle); // 묶음(세트) 상품 숨김
    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter((p) =>
        [p.name, p.sku, p.spec, p.notes].filter(Boolean).some((v) => v!.toLowerCase().includes(q))
      );
    }
    return arr;
  }, [products, search, showInactive, showBundles]);

  async function handleSave() {
    if (!modal) return;
    if (!modal.data.name.trim()) {
      setModalError("품목명은 필수입니다.");
      return;
    }
    setSaving(true);
    setModalError("");
    try {
      const method = modal.mode === "create" ? "POST" : "PUT";
      const res = await fetch("/api/b2b/products", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modal.data),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "저장 실패");

      const saved = data.product as Product;
      if (modal.mode === "create") {
        setProducts((prev) =>
          [...prev, saved].sort(
            (a, b) =>
              Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "ko")
          )
        );
      } else {
        // is_bundle/bundle_count 는 PUT 응답에 없으므로(파생값) 기존 값을 보존 — 배지 유지.
        setProducts((prev) => prev.map((p) => (p.id === saved.id ? { ...saved, is_bundle: p.is_bundle, bundle_count: p.bundle_count } : p)));
      }
      setModal(null);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "저장 중 오류");
    }
    setSaving(false);
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`"${name}" 제품을 삭제하시겠어요?\n발주 이력이 있으면 삭제 안 됨 — 대신 '미사용' 처리하세요.`)) return;
    setError("");
    const snapshot = products;
    setProducts((prev) => prev.filter((p) => p.id !== id));
    try {
      const res = await fetch(`/api/b2b/products?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setProducts(snapshot);
        throw new Error(data.error || "삭제 실패");
      }
      if (modal && modal.data.id === id) setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 중 오류");
    }
  }

  async function toggleHistory(productId: string) {
    if (historyFor === productId) {
      setHistoryFor(null);
      setHistory([]);
      return;
    }
    setHistoryFor(productId);
    setHistory([]);
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/b2b/products/cost-history?product_id=${productId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "이력 조회 실패");
      setHistory(data.history || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "이력 조회 중 오류");
      setHistoryFor(null);
    }
    setHistoryLoading(false);
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/b2b/products/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "파일 분석 실패");
      setPreview(j as ImportPreview);
    } catch (e) {
      setError(e instanceof Error ? e.message : "파일 분석 실패");
    }
    setImporting(false);
  }

  async function applyImport() {
    if (!preview) return;
    setApplying(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/products/import/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creates: preview.creates.map((c) => c.row),
          updates: preview.updates.map((u) => u.row),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "적용 실패");
      setPreview(null);
      await reload();
      if (j.errors && j.errors.length) setError(`일부 실패: ${j.errors.join("; ")}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "적용 실패");
    }
    setApplying(false);
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">상품 마스터 (원가표)</h1>
          <p className="b2b-page-subtitle">여기서 수정하면 모든 도구에 반영됩니다</p>
        </div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href="/b2b/products/history" title="상품 마스터 변경(등록·수정·삭제) 기록">
            변경 기록
          </a>
          <a className="b2b-btn-secondary" href="/api/b2b/products/export" title="전 품목을 엑셀로 내려받기(ID 포함, 수정 후 재업로드 가능)">
            엑셀 추출
          </a>
          <label className="b2b-btn-secondary" style={{ cursor: importing ? "default" : "pointer" }} title="추출한 엑셀을 수정해 업로드 — 변경 내역 확인 후 반영">
            {importing ? "분석 중…" : "엑셀 업로드"}
            <input
              type="file"
              accept=".xlsx"
              style={{ display: "none" }}
              disabled={importing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ""; }}
            />
          </label>
          <button className="b2b-btn-secondary" onClick={reload} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
          <button
            className="b2b-btn-primary"
            onClick={() => { setModalError(""); setModal({ mode: "create", data: { ...EMPTY_PRODUCT } }); }}
          >
            + 제품 추가
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-card">
        <div className="b2b-card-head" style={{ gap: 12, flexWrap: "wrap" }}>
          <input
            type="text"
            className="b2b-search"
            placeholder="품목명·SKU·옵션·메모 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--sm-text-mid)" }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            미사용 제품도 표시
          </label>
          <label
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--sm-text-mid)" }}
            title="세트/묶음으로 구성한 상품을 목록에 표시합니다. 기본은 숨김."
          >
            <input
              type="checkbox"
              checked={showBundles}
              onChange={(e) => setShowBundles(e.target.checked)}
            />
            묶음 상품 표시{bundleCount > 0 ? ` (${bundleCount})` : ""}
          </label>
        </div>

        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="b2b-empty">
            {products.length === 0
              ? "등록된 제품이 없습니다. 우측 상단 [+ 제품 추가] 를 눌러 시작하세요."
              : "검색 결과가 없습니다."}
          </div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table is-responsive">
              <thead>
                <tr>
                  <th>품목명</th>
                  <th>옵션</th>
                  <th>단위</th>
                  <th className="num">원가</th>
                  <th className="num">소비자가</th>
                  <th className="num">b2b도매가</th>
                  <th className="num">b2b마진</th>
                  <th>상태</th>
                  <th className="actions"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const margin = p.sale_price - p.cost_price;
                  const marginPct = p.sale_price > 0 ? (margin / p.sale_price) * 100 : 0;
                  const isExpanded = historyFor === p.id;
                  return (
                    <FragmentRows key={p.id}>
                      <tr
                        onClick={() => {
                          setModalError("");
                          setModal({
                            mode: "edit",
                            data: {
                              id: p.id,
                              sku: p.sku ?? "",
                              name: p.name,
                              spec: p.spec ?? "",
                              unit: p.unit,
                              cost_price: p.cost_price,
                              purchase_price: p.purchase_price ?? 0,
                              retail_price: p.retail_price ?? 0,
                              sale_price: p.sale_price,
                              tax_type: p.tax_type,
                              active: p.active,
                              origin: p.origin ?? "",
                              attrs: p.attrs ?? "",
                              notes: p.notes ?? "",
                              cost_material: p.cost_material ?? 0,
                              pkg_inner: p.pkg_inner ?? 0,
                              pkg_label: p.pkg_label ?? 0,
                              pkg_outer: p.pkg_outer ?? 0,
                              volume_kg: p.volume_kg ?? null,
                              courier_name: p.courier_name ?? "",
                              courier_weight: p.courier_weight ?? 0,
                              scan_name: p.scan_name ?? "",
                              is_bundle: p.is_bundle,   // 묶음상품이면 송장스캔명 숨김용
                            },
                          });
                        }}
                      >
                        <td data-label="품목명">
                          <strong>{p.name}</strong>
                          {p.sku && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--sm-text-light)" }}>{p.sku}</span>}
                          <span
                            className="b2b-status-pill"
                            style={{
                              marginLeft: 8,
                              background: p.tax_type === "exempt" ? "var(--sm-info-bg)" : "var(--sm-warning-bg)",
                              color: p.tax_type === "exempt" ? "var(--sm-info)" : "var(--sm-warning)",
                            }}
                          >
                            {TAX_TYPE_LABEL[p.tax_type]}
                          </span>
                          {p.is_bundle && (
                            <span
                              className="b2b-status-pill"
                              style={{ marginLeft: 6, background: "var(--sm-info-bg)", color: "var(--sm-info)" }}
                              title={`묶음(세트) 상품 — 구성품 ${p.bundle_count ?? 0}종`}
                            >
                              묶음{p.bundle_count ? ` ${p.bundle_count}` : ""}
                            </span>
                          )}
                        </td>
                        <td data-label="옵션">{p.spec || "-"}</td>
                        <td data-label="단위">{p.unit}</td>
                        <td data-label="원가" className="num b2b-money">{p.cost_price.toLocaleString()}</td>
                        <td data-label="소비자가" className="num b2b-money">{p.retail_price ? p.retail_price.toLocaleString() : "-"}</td>
                        <td data-label="b2b도매가" className="num b2b-money">{p.sale_price.toLocaleString()}</td>
                        <td data-label="b2b마진" className="num b2b-money" style={{ color: margin >= 0 ? "var(--sm-dark)" : "var(--sm-danger)" }}>
                          {margin >= 0 ? "+" : ""}{margin.toLocaleString()}
                          {p.sale_price > 0 && (
                            <span style={{ marginLeft: 6, fontSize: 11, color: "var(--sm-text-light)" }}>
                              ({marginPct.toFixed(0)}%)
                            </span>
                          )}
                        </td>
                        <td data-label="상태">
                          {p.active ? (
                            <span style={{ fontSize: 11, color: "var(--sm-success)", fontWeight: 600 }}>사용</span>
                          ) : (
                            <span style={{ fontSize: 11, color: "var(--sm-text-light)" }}>미사용</span>
                          )}
                        </td>
                        <td className="actions" onClick={(e) => e.stopPropagation()}>
                          <button className="b2b-btn-secondary" onClick={() => setBundleFor(p)} style={{ padding: "4px 10px", fontSize: 11 }} title="묶음(세트) 구성 편집">묶음</button>
                          <button
                            className="b2b-btn-secondary"
                            onClick={() => toggleHistory(p.id)}
                            style={{ padding: "4px 10px", fontSize: 11, marginLeft: 6 }}
                          >
                            {isExpanded ? "이력 닫기" : "원가 이력"}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={9} style={{ background: "var(--sm-bg)", padding: 16 }}>
                            <HistoryPanel loading={historyLoading} history={history} />
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

      {modal && (
        <ProductModal
          mode={modal.mode}
          data={modal.data}
          saving={saving}
          error={modalError}
          onChange={(data) => setModal({ ...modal, data })}
          onSave={handleSave}
          onClose={() => { setModalError(""); setModal(null); }}
          onDelete={
            modal.mode === "edit" && modal.data.id
              ? () => handleDelete(modal.data.id!, modal.data.name)
              : undefined
          }
          onCopy={
            modal.mode === "edit"
              ? () => {
                  // 현재 입력값을 복사해 '새 제품 등록' 모드로 전환.
                  // SKU 는 유일(073)하므로 비워서 새 코드 입력을 유도.
                  setModalError("");
                  setModal({ mode: "create", data: { ...modal.data, id: undefined, sku: "" } });
                }
              : undefined
          }
        />
      )}

      {preview && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">엑셀 업로드 — 변경 확인</h2>
              <button className="b2b-modal-close" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                <span>신규 <strong style={{ color: "var(--sm-success)" }}>{preview.summary.creates}</strong></span>
                <span>변경 <strong style={{ color: "var(--sm-info)" }}>{preview.summary.updates}</strong></span>
                <span className="sm-faint">동일 {preview.summary.unchanged}</span>
                {preview.summary.errors > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.summary.errors}</span>}
              </div>

              {preview.summary.creates + preview.summary.updates === 0 && (
                <div className="b2b-empty" style={{ padding: 20 }}>반영할 변경이 없습니다.</div>
              )}

              {preview.updates.length > 0 && (
                <section style={{ marginBottom: 12 }}>
                  <div className="b2b-field-label" style={{ fontWeight: 700 }}>변경 ({preview.updates.length})</div>
                  {preview.updates.map((u) => (
                    <div key={u.id} style={{ padding: "8px 10px", border: "1px solid var(--sm-border)", borderRadius: 8, marginTop: 6 }}>
                      <strong>{u.name}</strong>
                      <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12 }}>
                        {u.changes.map((c, i) => (
                          <li key={i}>{c.label}: <span className="sm-faint" style={{ textDecoration: "line-through" }}>{c.from}</span> → <strong>{c.to}</strong></li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>
              )}

              {preview.creates.length > 0 && (
                <section style={{ marginBottom: 12 }}>
                  <div className="b2b-field-label" style={{ fontWeight: 700 }}>신규 ({preview.creates.length})</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 13 }}>
                    {preview.creates.map((c, i) => <li key={i}>{c.name}</li>)}
                  </ul>
                </section>
              )}

              {preview.errors.length > 0 && (
                <section>
                  <div className="b2b-field-label" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>오류 ({preview.errors.length}) — 해당 행은 제외됩니다</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--sm-danger)" }}>
                    {preview.errors.map((e, i) => <li key={i}>{e.line}행: {e.msg}</li>)}
                  </ul>
                </section>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setPreview(null)} disabled={applying}>취소</button>
                <button
                  className="b2b-btn-primary"
                  onClick={applyImport}
                  disabled={applying || preview.summary.creates + preview.summary.updates === 0}
                >
                  {applying ? "적용 중…" : `${preview.summary.creates + preview.summary.updates}건 적용`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {bundleFor && (
        <BundleEditor
          parent={{ id: bundleFor.id, name: bundleFor.name, sku: bundleFor.sku }}
          products={products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, spec: p.spec }))}
          onClose={() => setBundleFor(null)}
          onSaved={reload}
        />
      )}
    </>
  );
}

// React fragment with key support (just <>...</> 처럼 쓰지만 key 받음)
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function HistoryPanel({ loading, history }: { loading: boolean; history: CostHistory[] }) {
  if (loading) return <div className="b2b-loading" style={{ padding: 12 }}>이력 불러오는 중...</div>;
  if (history.length === 0) {
    return <div className="b2b-empty" style={{ padding: "16px 12px" }}>원가 변경 이력이 없습니다.</div>;
  }
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sm-text-mid)", marginBottom: 8 }}>
        원가 변경 이력 (최근 {history.length}건)
      </div>
      <table className="b2b-table" style={{ background: "var(--sm-white)" }}>
        <thead>
          <tr>
            <th>변경 시각</th>
            <th className="num">원가</th>
            <th>사유</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id} style={{ cursor: "default" }}>
              <td>{new Date(h.changed_at).toLocaleString("ko-KR")}</td>
              <td className="num b2b-money">{h.cost_price.toLocaleString()}</td>
              <td>{h.reason || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductModal({
  mode,
  data,
  saving,
  error,
  onChange,
  onSave,
  onClose,
  onDelete,
  onCopy,
}: {
  mode: "create" | "edit";
  data: ProductInput;
  saving: boolean;
  error?: string;
  onChange: (d: ProductInput) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
}) {
  function set<K extends keyof ProductInput>(key: K, value: ProductInput[K]) {
    onChange({ ...data, [key]: value });
  }

  // 묶음(세트)상품은 송장 스캔 시 구성품 합으로 펼쳐져 나오므로, 묶음 자체 표시명은 불필요 → 필드 숨김.
  const isBundle = mode === "edit" && !!data.is_bundle;

  // 원가 상세가 있으면 제품 단위 원가 = 제품원가+포장재 합, 없으면 직접 입력한 cost_price.
  const detailSum =
    (Number(data.cost_material) || 0) +
    (Number(data.pkg_inner) || 0) +
    (Number(data.pkg_label) || 0) +
    (Number(data.pkg_outer) || 0);
  const effCost = detailSum > 0 ? detailSum : Number(data.cost_price) || 0;
  const margin = (Number(data.sale_price) || 0) - effCost;
  const marginPct = Number(data.sale_price) > 0 ? (margin / Number(data.sale_price)) * 100 : 0;
  const retail = Number(data.retail_price) || 0;
  const b2bDiscountPct = retail > 0 && Number(data.sale_price) > 0 ? ((retail - Number(data.sale_price)) / retail) * 100 : null;

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">{mode === "create" ? "새 제품 등록" : "제품 수정"}</h2>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="b2b-modal-body">
          {/* ── 판매담당 입력 구역 — 품목·가격·분류 ── */}
          <div style={{ background: "var(--sm-info-bg)", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "var(--sm-info)", marginBottom: 10 }}>판매담당 입력 <span style={{ fontWeight: 500, color: "var(--sm-text-mid)" }}>· 품목 정보 · 가격 · 분류</span></div>
          <Field label="품목명" required>
            <input
              type="text"
              className="b2b-input"
              value={data.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="예: 대구순살"
              autoFocus
            />
          </Field>

          <div className="b2b-field-row">
            <Field label="SKU (내부코드)">
              <input
                type="text"
                className="b2b-input"
                value={data.sku ?? ""}
                onChange={(e) => set("sku", e.target.value)}
                placeholder="예: COD-100"
              />
            </Field>
            <Field label="단위">
              <input
                type="text"
                className="b2b-input"
                value={data.unit}
                onChange={(e) => set("unit", e.target.value)}
                placeholder="개, kg, 박스"
              />
            </Field>
          </div>

          <Field label="옵션">
            <input
              type="text"
              className="b2b-input"
              value={data.spec ?? ""}
              onChange={(e) => set("spec", e.target.value)}
              placeholder="예: 100g"
            />
          </Field>

          <Field label="과세 유형">
            <select
              className="b2b-select"
              value={data.tax_type}
              onChange={(e) => set("tax_type", e.target.value as ProductInput["tax_type"])}
              style={{ maxWidth: 200 }}
            >
              {TAX_TYPES.map((t) => (
                <option key={t} value={t}>{TAX_TYPE_LABEL[t]}</option>
              ))}
            </select>
            <span style={{ fontSize: 11, color: "var(--sm-text-light)" }}>
              면세로 두면 발주 시 부가세 계산에서 제외됩니다.
            </span>
          </Field>

          <div className="b2b-field-row">
            <Field label="소비자 판매가 (원)">
              <input
                type="number"
                inputMode="numeric"
                className="b2b-input b2b-money"
                value={data.retail_price}
                onChange={(e) => {
                  const v = Number(e.target.value) || 0;
                  const next = { ...data, retail_price: v };
                  if (!Number(data.sale_price)) next.sale_price = Math.round(v * 0.9); // b2b 비어있으면 10% 할인가 자동제안
                  onChange(next);
                }}
                min={0}
                step={1}
                placeholder="소비자몰 판매가"
              />
            </Field>
            <Field label="b2b 도매가 (원)">
              <input
                type="number"
                inputMode="numeric"
                className="b2b-input b2b-money"
                value={data.sale_price}
                onChange={(e) => set("sale_price", Number(e.target.value) || 0)}
                min={0}
                step={1}
              />
            </Field>
          </div>
          {b2bDiscountPct !== null && (
            <p className="sm-faint" style={{ fontSize: 12, margin: "-4px 0 4px" }}>
              b2b 도매가는 소비자가 대비 {b2bDiscountPct >= 0 ? "−" : "+"}{Math.abs(b2bDiscountPct).toFixed(0)}% 할인
              {Math.abs(b2bDiscountPct - 10) > 0.5 ? " · 기준(10%)과 다름" : ""}
            </p>
          )}

          <div className="b2b-field-row">
            <Field label="매입단가 (원)">
              <input type="number" inputMode="numeric" className="b2b-input b2b-money"
                value={data.purchase_price}
                onChange={(e) => set("purchase_price", Number(e.target.value) || 0)}
                min={0} step={1} placeholder="구매 단가(외포장 등 제외)" />
            </Field>
            <Field label="원산지">
              <input type="text" className="b2b-input" value={data.origin ?? ""} onChange={(e) => set("origin", e.target.value)} placeholder="예: 국내산 · 수입" />
            </Field>
          </div>
          <Field label="속성 / 분류">
            <input type="text" className="b2b-input" value={data.attrs ?? ""} onChange={(e) => set("attrs", e.target.value)} placeholder="예: 패키지 · 냉동 · 소분" />
          </Field>
          </div>

          {/* ── 생산담당 입력 구역 — 원가 상세 · 택배 발주 · 송장 스캔 ── */}
          <div style={{ background: "var(--sm-orange-light)", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "var(--sm-orange)", marginBottom: 10 }}>생산담당 입력 <span style={{ fontWeight: 500, color: "var(--sm-text-mid)" }}>· 원가 상세 · 택배 발주 · 송장 스캔</span></div>
          <div className="b2b-field-label" style={{ fontWeight: 700 }}>
            원가 상세 (이익률 계산용)
          </div>
          <div className="b2b-field-row">
            <Field label="제품원가 (원)">
              <input
                type="number"
                inputMode="numeric"
                className="b2b-input b2b-money"
                value={data.cost_material}
                onChange={(e) => set("cost_material", Number(e.target.value) || 0)}
                min={0}
                step={1}
              />
            </Field>
            <Field label="내포장지 (원)">
              <input
                type="number"
                inputMode="numeric"
                className="b2b-input b2b-money"
                value={data.pkg_inner}
                onChange={(e) => set("pkg_inner", Number(e.target.value) || 0)}
                min={0}
                step={1}
              />
            </Field>
          </div>
          <div className="b2b-field-row">
            <Field label="라벨 (원)">
              <input
                type="number"
                inputMode="numeric"
                className="b2b-input b2b-money"
                value={data.pkg_label}
                onChange={(e) => set("pkg_label", Number(e.target.value) || 0)}
                min={0}
                step={1}
              />
            </Field>
            <Field label="외포장지 (원)">
              <input
                type="number"
                inputMode="numeric"
                className="b2b-input b2b-money"
                value={data.pkg_outer}
                onChange={(e) => set("pkg_outer", Number(e.target.value) || 0)}
                min={0}
                step={1}
              />
            </Field>
          </div>
          <Field label="제품부피 (kg) — 포장비·배송비 산정 기준">
            <input
              type="number"
              inputMode="decimal"
              className="b2b-input"
              value={data.volume_kg ?? ""}
              onChange={(e) => set("volume_kg", e.target.value === "" ? null : Number(e.target.value))}
              min={0}
              step={0.1}
              placeholder="예: 0.1, 1, 10"
              style={{ maxWidth: 200 }}
            />
          </Field>

          <div className="b2b-field-label" style={{ marginTop: 4, fontWeight: 700 }}>
            택배 발주(CNplus) 정보
          </div>
          <Field label="택배 상품명">
            <input
              type="text"
              className="b2b-input"
              value={data.courier_name ?? ""}
              onChange={(e) => set("courier_name", e.target.value)}
              placeholder="발주서에 찍힐 품목명 (예: 진공 씨몬스터 참돔순살 100g)"
            />
          </Field>
          <Field label="택배 주문당 총중량 (kg) — 박스타입·운임 기준">
            <input
              type="number"
              inputMode="decimal"
              className="b2b-input"
              value={data.courier_weight || ""}
              onChange={(e) => set("courier_weight", Number(e.target.value) || 0)}
              min={0}
              step={0.1}
              placeholder="예: 0.5, 1, 9"
              style={{ maxWidth: 200 }}
            />
            <span style={{ fontSize: 11, color: "var(--sm-text-light)" }}>
              같은 주문의 라인 중량을 합해 박스타입(≤2.7→1, ≤5.2→2, 초과→3)과 운임을 정합니다. 제품부피와 다를 수 있어요.
            </span>
          </Field>
          {isBundle ? (
            <Field label="송장 스캔 표시명">
              <span style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>
                묶음(세트)상품이라 송장 스캔 시 <strong>구성품의 합</strong>으로 나옵니다. 표시명은 각 구성품에서 지정하세요.
              </span>
            </Field>
          ) : (
            <Field label="송장 스캔 표시명">
              <input
                type="text"
                className="b2b-input"
                value={data.scan_name ?? ""}
                onChange={(e) => set("scan_name", e.target.value)}
                placeholder="송장 스캔 피킹 리스트에 나올 이름 (비우면 품목명 사용)"
              />
              <span style={{ fontSize: 11, color: "var(--sm-text-light)" }}>
                온라인 발주 &gt; 송장 스캔의 &lsquo;가지러 갈 상품&rsquo;·인쇄에 이 이름이 나옵니다. 비어 있으면 품목명을 씁니다.
              </span>
            </Field>
          )}
          </div>

          {(effCost > 0 || data.sale_price > 0) && (
            <div style={{ padding: "10px 12px", background: "var(--sm-bg)", borderRadius: 8, fontSize: 12 }}>
              제품 단위 원가 <strong className="b2b-money">{effCost.toLocaleString()}원</strong>
              {" · "}
              마진(배송 제외):{" "}
              <strong style={{ color: margin >= 0 ? "var(--sm-dark)" : "var(--sm-danger)" }}>
                {margin >= 0 ? "+" : ""}{margin.toLocaleString()}원
                {data.sale_price > 0 && ` (${marginPct.toFixed(1)}%)`}
              </strong>
            </div>
          )}

          <Field label="상태">
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={data.active}
                onChange={(e) => set("active", e.target.checked)}
              />
              사용 중 (체크 해제 시 발주 등록에서 노출 안 됨)
            </label>
          </Field>

          <Field label="비고">
            <textarea
              className="b2b-textarea"
              value={data.notes ?? ""}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
            />
          </Field>
        </div>

        {error && <div className="b2b-error" style={{ margin: "0 0 10px" }}>{error}</div>}

        <div className="b2b-modal-foot">
          <div style={{ display: "flex", gap: 8 }}>
            {onDelete && (
              <button className="b2b-btn-danger" onClick={onDelete} disabled={saving}>
                삭제
              </button>
            )}
            {onCopy && (
              <button
                className="b2b-btn-secondary"
                onClick={onCopy}
                disabled={saving}
                title="이 제품 정보를 복사해 새 제품으로 등록"
              >
                복사하기
              </button>
            )}
          </div>
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>
              취소
            </button>
            <button className="b2b-btn-primary" onClick={onSave} disabled={saving || !data.name.trim()}>
              {saving ? "저장 중..." : mode === "create" ? "등록" : "수정"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="b2b-field">
      <label className="b2b-field-label">
        {label}
        {required && <span className="req">*</span>}
      </label>
      {children}
    </div>
  );
}
