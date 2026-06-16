"use client";

import { useEffect, useMemo, useState } from "react";
import { Product, ProductInput, EMPTY_PRODUCT, CostHistory, TAX_TYPES, TAX_TYPE_LABEL } from "@/app/lib/b2b-types";

type Modal = { mode: "create" | "edit"; data: ProductInput } | null;

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [saving, setSaving] = useState(false);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<CostHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

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

  const filtered = useMemo(() => {
    let arr = products;
    if (!showInactive) arr = arr.filter((p) => p.active);
    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter((p) =>
        [p.name, p.sku, p.spec, p.notes].filter(Boolean).some((v) => v!.toLowerCase().includes(q))
      );
    }
    return arr;
  }, [products, search, showInactive]);

  async function handleSave() {
    if (!modal) return;
    if (!modal.data.name.trim()) {
      setError("품목명은 필수입니다.");
      return;
    }
    setSaving(true);
    setError("");
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
        setProducts((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
      }
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 중 오류");
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

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">원가표</h1>
          <p className="b2b-page-subtitle">
            제품·옵션·원가·판매가를 관리합니다. 원가를 수정하면 이력이 자동 기록됩니다.
            {products.length > 0 && ` (전체 ${products.length}개)`}
          </p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={reload} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
          <button
            className="b2b-btn-primary"
            onClick={() => setModal({ mode: "create", data: { ...EMPTY_PRODUCT } })}
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
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            미사용 제품도 표시
          </label>
        </div>

        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="b2b-empty">
            <div className="b2b-empty-icon">📦</div>
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
                  <th className="num">판매가</th>
                  <th className="num">마진</th>
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
                        onClick={() =>
                          setModal({
                            mode: "edit",
                            data: {
                              id: p.id,
                              sku: p.sku ?? "",
                              name: p.name,
                              spec: p.spec ?? "",
                              unit: p.unit,
                              cost_price: p.cost_price,
                              sale_price: p.sale_price,
                              tax_type: p.tax_type,
                              active: p.active,
                              notes: p.notes ?? "",
                              cost_material: p.cost_material ?? 0,
                              pkg_inner: p.pkg_inner ?? 0,
                              pkg_label: p.pkg_label ?? 0,
                              pkg_outer: p.pkg_outer ?? 0,
                              volume_kg: p.volume_kg ?? null,
                            },
                          })
                        }
                      >
                        <td data-label="품목명">
                          <strong>{p.name}</strong>
                          {p.sku && <span style={{ marginLeft: 8, fontSize: 12, color: "var(--sm-text-light)" }}>{p.sku}</span>}
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: 11,
                              fontWeight: 700,
                              padding: "2px 6px",
                              borderRadius: 10,
                              background: p.tax_type === "exempt" ? "#E0F0FF" : "#FFF4E0",
                              color: p.tax_type === "exempt" ? "#0A66C2" : "#B86E00",
                            }}
                          >
                            {TAX_TYPE_LABEL[p.tax_type]}
                          </span>
                        </td>
                        <td data-label="옵션">{p.spec || "-"}</td>
                        <td data-label="단위">{p.unit}</td>
                        <td data-label="원가" className="num b2b-money">{p.cost_price.toLocaleString()}</td>
                        <td data-label="판매가" className="num b2b-money">{p.sale_price.toLocaleString()}</td>
                        <td data-label="마진" className="num b2b-money" style={{ color: margin >= 0 ? "var(--sm-dark)" : "#c92a2a" }}>
                          {margin >= 0 ? "+" : ""}{margin.toLocaleString()}
                          {p.sale_price > 0 && (
                            <span style={{ marginLeft: 6, fontSize: 12, color: "var(--sm-text-light)" }}>
                              ({marginPct.toFixed(0)}%)
                            </span>
                          )}
                        </td>
                        <td data-label="상태">
                          {p.active ? (
                            <span style={{ fontSize: 12, color: "#22863a", fontWeight: 600 }}>사용</span>
                          ) : (
                            <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>미사용</span>
                          )}
                        </td>
                        <td className="actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="b2b-btn-secondary"
                            onClick={() => toggleHistory(p.id)}
                            style={{ padding: "4px 10px", fontSize: 12 }}
                          >
                            {isExpanded ? "이력 닫기" : "원가 이력"}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={8} style={{ background: "var(--sm-bg)", padding: 16 }}>
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
          onChange={(data) => setModal({ ...modal, data })}
          onSave={handleSave}
          onClose={() => setModal(null)}
          onDelete={
            modal.mode === "edit" && modal.data.id
              ? () => handleDelete(modal.data.id!, modal.data.name)
              : undefined
          }
          onCopy={
            modal.mode === "edit"
              ? () =>
                  // 현재 입력값 그대로 복사해 '새 제품 등록' 모드로 전환.
                  // SKU 중복 허용이라 SKU 도 그대로 복사 (필요 시 수정).
                  setModal({ mode: "create", data: { ...modal.data, id: undefined } })
              : undefined
          }
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
    return <div style={{ fontSize: 13, color: "var(--sm-text-light)" }}>원가 변경 이력이 없습니다.</div>;
  }
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-text-mid)", marginBottom: 8 }}>
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
  onChange,
  onSave,
  onClose,
  onDelete,
  onCopy,
}: {
  mode: "create" | "edit";
  data: ProductInput;
  saving: boolean;
  onChange: (d: ProductInput) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
}) {
  function set<K extends keyof ProductInput>(key: K, value: ProductInput[K]) {
    onChange({ ...data, [key]: value });
  }

  // 원가 상세가 있으면 제품 단위 원가 = 제품원가+포장재 합, 없으면 직접 입력한 cost_price.
  const detailSum =
    (Number(data.cost_material) || 0) +
    (Number(data.pkg_inner) || 0) +
    (Number(data.pkg_label) || 0) +
    (Number(data.pkg_outer) || 0);
  const effCost = detailSum > 0 ? detailSum : Number(data.cost_price) || 0;
  const margin = (Number(data.sale_price) || 0) - effCost;
  const marginPct = Number(data.sale_price) > 0 ? (margin / Number(data.sale_price)) * 100 : 0;

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <h2 className="b2b-modal-title">{mode === "create" ? "새 제품 등록" : "제품 수정"}</h2>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="b2b-modal-body">
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
            <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>
              면세로 두면 발주 시 부가세 계산에서 제외됩니다.
            </span>
          </Field>

          <Field label="기본 판매가 (도매가, 원)">
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

          <div className="b2b-field-label" style={{ marginTop: 4, fontWeight: 700 }}>
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

          {(effCost > 0 || data.sale_price > 0) && (
            <div style={{ padding: "10px 12px", background: "var(--sm-bg)", borderRadius: 8, fontSize: 13 }}>
              제품 단위 원가 <strong className="b2b-money">{effCost.toLocaleString()}원</strong>
              {" · "}
              마진(배송 제외):{" "}
              <strong style={{ color: margin >= 0 ? "var(--sm-dark)" : "#c92a2a" }}>
                {margin >= 0 ? "+" : ""}{margin.toLocaleString()}원
                {data.sale_price > 0 && ` (${marginPct.toFixed(1)}%)`}
              </strong>
            </div>
          )}

          <Field label="상태">
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              <input
                type="checkbox"
                checked={data.active}
                onChange={(e) => set("active", e.target.checked)}
              />
              사용 중 (체크 해제 시 발주 등록에서 노출 안 됨)
            </label>
          </Field>

          <Field label="메모">
            <textarea
              className="b2b-textarea"
              value={data.notes ?? ""}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
            />
          </Field>
        </div>

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
