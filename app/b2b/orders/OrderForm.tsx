"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Order,
  OrderInput,
  OrderItem,
  OrderItemInput,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  TAX_INVOICE_STATUSES,
  EMPTY_ORDER,
  EMPTY_ORDER_ITEM,
  EMPTY_SHIPMENT,
  Shipment,
  ShipmentInput,
  formatMoney,
} from "@/app/lib/b2b-orders";
import { Company, Product, TAX_TYPES, TAX_TYPE_LABEL } from "@/app/lib/b2b-types";

type Mode = "create" | "edit";

export default function OrderForm({
  mode,
  orderId,
  cloneFromId,
}: {
  mode: Mode;
  orderId?: string;
  cloneFromId?: string;
}) {
  const router = useRouter();

  const [companies, setCompanies] = useState<Company[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [data, setData] = useState<OrderInput>({ ...EMPTY_ORDER, items: [{ ...EMPTY_ORDER_ITEM }], shipment: { ...EMPTY_SHIPMENT } });
  const [originalOrder, setOriginalOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // ─────────────────────────────────────────────
  // 초기 데이터 로드
  // ─────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const [compRes, prodRes] = await Promise.all([
          fetch("/api/b2b/companies", { cache: "no-store" }),
          fetch("/api/b2b/products", { cache: "no-store" }),
        ]);
        const compJson = await compRes.json();
        const prodJson = await prodRes.json();
        if (!compJson.ok) throw new Error(compJson.error || "업체 조회 실패");
        if (!prodJson.ok) throw new Error(prodJson.error || "제품 조회 실패");
        setCompanies(compJson.companies || []);
        setProducts((prodJson.products as Product[] || []).filter((p) => p.active));

        if (mode === "edit" && orderId) {
          const orderRes = await fetch(`/api/b2b/orders/${orderId}`, { cache: "no-store" });
          const orderJson = await orderRes.json();
          if (!orderJson.ok) throw new Error(orderJson.error || "발주 조회 실패");
          const o = orderJson.order as Order & { items: OrderItem[]; company: Company; shipments: Shipment[] };
          setOriginalOrder(o);
          setData({
            id: o.id,
            company_id: o.company_id,
            order_date: o.order_date,
            production_date: o.production_date ?? "",
            ship_date: o.ship_date ?? "",
            status: o.status,
            payment_status: o.payment_status,
            tax_invoice_status: o.tax_invoice_status,
            notes: o.notes ?? "",
            items: (o.items || []).map((it) => ({
              id: it.id,
              product_id: it.product_id,
              product_name: it.product_name,
              option_label: it.option_label ?? "",
              spec: it.spec ?? "",
              qty: it.qty,
              unit_price: it.unit_price,
              cost_at_order: it.cost_at_order ?? "",
              tax_type: it.tax_type,
              sort_order: it.sort_order,
            })),
            shipment: o.shipments?.[0]
              ? {
                  id: o.shipments[0].id,
                  recipient_name: o.shipments[0].recipient_name ?? "",
                  recipient_phone: o.shipments[0].recipient_phone ?? "",
                  address: o.shipments[0].address ?? "",
                  delivery_memo: o.shipments[0].delivery_memo ?? "",
                  courier: o.shipments[0].courier ?? "",
                  tracking_no: o.shipments[0].tracking_no ?? "",
                }
              : { ...EMPTY_SHIPMENT },
          });
        } else if (mode === "create" && cloneFromId) {
          // 복제 모드: 원본 발주를 불러와 업체·라인·송장은 복사, 날짜·상태는 초기화
          const t = new Date();
          const todayIso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
          const orderRes = await fetch(`/api/b2b/orders/${cloneFromId}`, { cache: "no-store" });
          const orderJson = await orderRes.json();
          if (!orderJson.ok) throw new Error(orderJson.error || "복제할 발주 조회 실패");
          const o = orderJson.order as Order & { items: OrderItem[]; company: Company; shipments: Shipment[] };
          setData({
            // id 없음 (새 발주)
            company_id: o.company_id,
            order_date: todayIso,        // 발주일은 오늘
            production_date: "",         // 일정은 비움
            ship_date: "",
            status: "발주확인/생산대기", // 상태 초기화
            payment_status: "미입금",
            tax_invoice_status: "미발행",
            notes: o.notes ?? "",
            items: (o.items || []).map((it, idx) => ({
              // id 없음 (새 라인) — 원본 라인 id 는 복사하지 않음
              product_id: it.product_id,
              product_name: it.product_name,
              option_label: it.option_label ?? "",
              spec: it.spec ?? "",
              qty: it.qty,
              unit_price: it.unit_price,
              cost_at_order: it.cost_at_order ?? "",
              tax_type: it.tax_type,
              sort_order: idx,
            })),
            shipment: o.shipments?.[0]
              ? {
                  // id 없음 (새 송장)
                  recipient_name: o.shipments[0].recipient_name ?? "",
                  recipient_phone: o.shipments[0].recipient_phone ?? "",
                  address: o.shipments[0].address ?? "",
                  delivery_memo: o.shipments[0].delivery_memo ?? "",
                  courier: "",          // 운송장 정보는 비움 (건마다 다름)
                  tracking_no: "",
                }
              : { ...EMPTY_SHIPMENT },
          });
        } else {
          // create 모드: 발주일 기본값을 오늘로
          const t = new Date();
          const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
          setData((prev) => ({ ...prev, order_date: iso }));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "데이터 조회 중 오류");
      }
      setLoading(false);
    })();
  }, [mode, orderId, cloneFromId]);

  // ─────────────────────────────────────────────
  // 합계 계산 (입력 동안에는 클라이언트, 저장 후엔 트리거가 재계산)
  // ─────────────────────────────────────────────
  const totals = useMemo(() => {
    let taxable = 0;
    let exempt = 0;
    for (const it of data.items) {
      const qty = Number(it.qty) || 0;
      const price = Number(it.unit_price) || 0;
      const amt = qty * price;
      if (it.tax_type === "exempt") exempt += amt;
      else taxable += amt;
    }
    const subtotal = taxable + exempt;
    const vat = Math.round(taxable * 0.1);
    return { taxable, exempt, subtotal, vat, total: subtotal + vat };
  }, [data.items]);

  // ─────────────────────────────────────────────
  // 폼 필드 수정 핸들러
  // ─────────────────────────────────────────────
  function setField<K extends keyof OrderInput>(key: K, value: OrderInput[K]) {
    setData((prev) => ({ ...prev, [key]: value }));
  }

  function setShipment(patch: Partial<ShipmentInput>) {
    setData((prev) => ({ ...prev, shipment: { ...prev.shipment, ...patch } }));
  }

  // 업체 변경 시 송장 정보 자동 채움 (담당자·연락처·주소 → 수령인 정보)
  function selectCompany(companyId: string) {
    setData((prev) => {
      const c = companies.find((cc) => cc.id === companyId);
      if (!c) return { ...prev, company_id: companyId };
      return {
        ...prev,
        company_id: companyId,
        shipment: {
          ...prev.shipment,
          recipient_name: c.contact_name ?? prev.shipment.recipient_name,
          recipient_phone: c.contact_phone ?? prev.shipment.recipient_phone,
          address: c.address ?? prev.shipment.address,
        },
      };
    });
  }

  function updateItem(idx: number, patch: Partial<OrderItemInput>) {
    setData((prev) => ({
      ...prev,
      items: prev.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    }));
  }

  function pickProduct(idx: number, productId: string) {
    if (!productId) {
      updateItem(idx, { product_id: null });
      return;
    }
    const p = products.find((pp) => pp.id === productId);
    if (!p) return;
    updateItem(idx, {
      product_id: p.id,
      product_name: p.name,
      spec: p.spec ?? "",
      unit_price: p.sale_price,
      cost_at_order: p.cost_price,
      tax_type: p.tax_type,
    });
  }

  function addItemRow() {
    setData((prev) => ({
      ...prev,
      items: [...prev.items, { ...EMPTY_ORDER_ITEM, sort_order: prev.items.length }],
    }));
  }

  function removeItemRow(idx: number) {
    if (data.items.length === 1) {
      // 최소 1개는 유지 — 빈 줄로 초기화
      setData((prev) => ({ ...prev, items: [{ ...EMPTY_ORDER_ITEM }] }));
      return;
    }
    setData((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }));
  }

  // ─────────────────────────────────────────────
  // 저장 / 삭제
  // ─────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const url = mode === "create" ? "/api/b2b/orders" : `/api/b2b/orders/${orderId}`;
      const method = mode === "create" ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "저장 실패");

      // 저장 성공 — 리스트로 돌아감 (혹은 상세로?)
      router.push("/b2b/orders");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 중 오류");
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (mode !== "edit" || !orderId) return;
    const orderLabel = originalOrder?.order_no || orderId;
    if (!confirm(`발주 ${orderLabel} 을(를) 삭제하시겠어요?\n라인아이템·송장도 함께 삭제됩니다.`)) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/b2b/orders/${orderId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "삭제 실패");
      router.push("/b2b/orders");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 중 오류");
      setSaving(false);
    }
  }

  // ─────────────────────────────────────────────
  // 렌더
  // ─────────────────────────────────────────────
  if (loading) return <div className="b2b-loading">불러오는 중...</div>;

  const canSave =
    !!data.company_id && !!data.order_date && data.items.length > 0 && data.items.every((it) => it.product_name.trim() && Number(it.qty) > 0);

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">
            {mode === "create"
              ? cloneFromId
                ? "발주 복제"
                : "새 발주 등록"
              : `발주 수정 · ${originalOrder?.order_no ?? ""}`}
          </h1>
          <p className="b2b-page-subtitle">
            {mode === "create"
              ? cloneFromId
                ? "복제된 내용입니다. 발주일·일정·상태는 초기화됐어요. 확인 후 등록하세요."
                : "업체와 일정, 라인아이템을 입력하세요. 합계는 자동 계산됩니다."
              : "라인아이템을 수정하면 합계는 저장 후 자동으로 재계산됩니다."}
          </p>
        </div>
        <div className="b2b-page-actions">
          {mode === "edit" && orderId && (
            <button
              type="button"
              className="b2b-btn-secondary"
              onClick={() => router.push(`/b2b/orders/new?from=${orderId}`)}
              title="이 발주의 업체·라인아이템·송장 정보를 복사해 새 발주를 만듭니다"
            >
              복제
            </button>
          )}
          <Link href="/b2b/orders" className="b2b-btn-secondary">목록으로</Link>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <div className="b2b-form-sections">
        {/* ───── 기본 정보 ───── */}
        <section className="b2b-form-section">
          <div className="b2b-form-section-title">기본 정보</div>
          <div className="b2b-field-row">
            <div className="b2b-field">
              <label className="b2b-field-label">업체<span className="req">*</span></label>
              <select
                className="b2b-select"
                value={data.company_id}
                onChange={(e) => selectCompany(e.target.value)}
              >
                <option value="">업체 선택</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {companies.length === 0 && (
                <span style={{ fontSize: 12, color: "#c92a2a" }}>
                  등록된 업체가 없습니다 — <Link href="/b2b/companies" style={{ color: "var(--sm-orange)" }}>주소록에서 먼저 등록</Link>
                </span>
              )}
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">발주일<span className="req">*</span></label>
              <input
                type="date"
                className="b2b-input"
                value={data.order_date}
                onChange={(e) => setField("order_date", e.target.value)}
              />
            </div>
          </div>

          <div className="b2b-field-row" style={{ marginTop: 12 }}>
            <div className="b2b-field">
              <label className="b2b-field-label">생산예정일</label>
              <input
                type="date"
                className="b2b-input"
                value={data.production_date}
                onChange={(e) => setField("production_date", e.target.value)}
              />
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">발송예정일</label>
              <input
                type="date"
                className="b2b-input"
                value={data.ship_date}
                onChange={(e) => setField("ship_date", e.target.value)}
              />
            </div>
          </div>

          <div className="b2b-field" style={{ marginTop: 12 }}>
            <label className="b2b-field-label">메모</label>
            <textarea
              className="b2b-textarea"
              value={data.notes}
              onChange={(e) => setField("notes", e.target.value)}
              rows={2}
              placeholder="포장 요청·전달 사항·결제 메모 등"
            />
          </div>
        </section>

        {/* ───── 상태 ───── */}
        <section className="b2b-form-section">
          <div className="b2b-form-section-title">상태</div>
          <div className="b2b-field-row">
            <div className="b2b-field">
              <label className="b2b-field-label">발주 상태</label>
              <select
                className="b2b-select"
                value={data.status}
                onChange={(e) => setField("status", e.target.value as OrderInput["status"])}
              >
                {ORDER_STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">입금 상태</label>
              <select
                className="b2b-select"
                value={data.payment_status}
                onChange={(e) => setField("payment_status", e.target.value as OrderInput["payment_status"])}
              >
                {PAYMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="b2b-field" style={{ marginTop: 12 }}>
            <label className="b2b-field-label">세금계산서</label>
            <select
              className="b2b-select"
              value={data.tax_invoice_status}
              onChange={(e) => setField("tax_invoice_status", e.target.value as OrderInput["tax_invoice_status"])}
              style={{ maxWidth: 200 }}
            >
              {TAX_INVOICE_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </section>

        {/* ───── 송장 정보 ───── */}
        <section className="b2b-form-section">
          <div className="b2b-form-section-title">
            송장 정보
            <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 500, color: "var(--sm-text-light)", textTransform: "none", letterSpacing: 0 }}>
              업체 선택 시 주소록 정보로 자동 채움 — 다르게 보낼 때만 수정
            </span>
          </div>
          <div className="b2b-field-row">
            <div className="b2b-field">
              <label className="b2b-field-label">수령인 이름</label>
              <input
                type="text"
                className="b2b-input"
                value={data.shipment.recipient_name}
                onChange={(e) => setShipment({ recipient_name: e.target.value })}
                placeholder="홍길동"
              />
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">수령인 연락처</label>
              <input
                type="text"
                className="b2b-input"
                value={data.shipment.recipient_phone}
                onChange={(e) => setShipment({ recipient_phone: e.target.value })}
                placeholder="010-0000-0000"
              />
            </div>
          </div>
          <div className="b2b-field" style={{ marginTop: 12 }}>
            <label className="b2b-field-label">배송지 주소</label>
            <input
              type="text"
              className="b2b-input"
              value={data.shipment.address}
              onChange={(e) => setShipment({ address: e.target.value })}
              placeholder="(우편번호) 시/도 시/군/구 도로명 + 상세"
            />
          </div>
          <div className="b2b-field" style={{ marginTop: 12 }}>
            <label className="b2b-field-label">배송 메세지</label>
            <input
              type="text"
              className="b2b-input"
              value={data.shipment.delivery_memo}
              onChange={(e) => setShipment({ delivery_memo: e.target.value })}
              placeholder="문 앞 / 부재 시 경비실 등"
            />
          </div>
          <div className="b2b-field-row" style={{ marginTop: 12 }}>
            <div className="b2b-field">
              <label className="b2b-field-label">택배사 (선택)</label>
              <input
                type="text"
                className="b2b-input"
                value={data.shipment.courier}
                onChange={(e) => setShipment({ courier: e.target.value })}
                placeholder="CJ대한통운"
              />
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">운송장 번호 (선택)</label>
              <input
                type="text"
                className="b2b-input"
                value={data.shipment.tracking_no}
                onChange={(e) => setShipment({ tracking_no: e.target.value })}
              />
            </div>
          </div>
        </section>

        {/* ───── 발주 상품 ───── */}
        <section className="b2b-form-section">
          <div className="b2b-form-section-title">발주 상품</div>
          <div className="b2b-table-wrap">
            <table className="b2b-items-table">
              <thead>
                <tr>
                  <th style={{ width: 200 }}>제품 선택</th>
                  <th>품목명 <span style={{ color: "var(--sm-orange)" }}>*</span></th>
                  <th style={{ width: 130 }}>옵션</th>
                  <th className="num" style={{ width: 90 }}>수량 *</th>
                  <th className="num" style={{ width: 120 }}>단가</th>
                  <th style={{ width: 80 }}>과세</th>
                  <th className="num" style={{ width: 120 }}>금액</th>
                  <th style={{ width: 1 }}></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it, idx) => {
                  const qty = Number(it.qty) || 0;
                  const price = Number(it.unit_price) || 0;
                  return (
                    <tr key={idx}>
                      <td data-label="제품 선택">
                        <select
                          value={it.product_id ?? ""}
                          onChange={(e) => pickProduct(idx, e.target.value)}
                        >
                          <option value="">직접 입력</option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}{p.spec ? ` (${p.spec})` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td data-label="품목명">
                        <input
                          type="text"
                          value={it.product_name}
                          onChange={(e) => updateItem(idx, { product_name: e.target.value, product_id: null })}
                          placeholder="품목명"
                        />
                      </td>
                      <td data-label="옵션">
                        <input
                          type="text"
                          value={it.spec}
                          onChange={(e) => updateItem(idx, { spec: e.target.value })}
                          placeholder="100g / 옵션"
                        />
                      </td>
                      <td data-label="수량">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={it.qty}
                          onChange={(e) => updateItem(idx, { qty: e.target.value })}
                          min={0}
                          style={{ textAlign: "right" }}
                        />
                      </td>
                      <td data-label="단가">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={it.unit_price}
                          onChange={(e) => updateItem(idx, { unit_price: e.target.value })}
                          min={0}
                          style={{ textAlign: "right" }}
                        />
                      </td>
                      <td data-label="과세">
                        <select
                          value={it.tax_type}
                          onChange={(e) => updateItem(idx, { tax_type: e.target.value as typeof it.tax_type })}
                        >
                          {TAX_TYPES.map((t) => (
                            <option key={t} value={t}>{TAX_TYPE_LABEL[t]}</option>
                          ))}
                        </select>
                      </td>
                      <td data-label="금액" className="num b2b-money b2b-item-amount" style={{ padding: "12px 10px", color: "var(--sm-text-mid)" }}>
                        {formatMoney(qty * price)}
                      </td>
                      <td className="b2b-item-remove">
                        <button
                          type="button"
                          className="b2b-icon-btn is-danger"
                          onClick={() => removeItemRow(idx)}
                          title="상품 삭제"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="b2b-items-add-row">
            <button type="button" className="b2b-btn-secondary" onClick={addItemRow}>
              + 상품 추가
            </button>
          </div>
        </section>

        {/* ───── 합계 ───── */}
        <section className="b2b-form-section">
          <div className="b2b-totals">
            <div className="b2b-totals-row">
              과세 분 <strong className="b2b-money">{formatMoney(totals.taxable)}원</strong>
            </div>
            <div className="b2b-totals-row">
              면세 분 <strong className="b2b-money">{formatMoney(totals.exempt)}원</strong>
            </div>
            <div className="b2b-totals-row">
              부가세 <strong className="b2b-money">{formatMoney(totals.vat)}원</strong>
            </div>
            <div className="b2b-totals-row is-grand">
              합계 <strong className="b2b-money">{formatMoney(totals.total)}원</strong>
            </div>
          </div>
        </section>

        {/* ───── 푸터 ───── */}
        <div className="b2b-form-foot">
          {mode === "edit" ? (
            <button
              type="button"
              className="b2b-btn-danger"
              onClick={handleDelete}
              disabled={saving}
              style={{ border: "1px solid #f5c6c6" }}
            >
              삭제
            </button>
          ) : <span />}
          <div className="b2b-form-foot-right">
            <Link href="/b2b/orders" className="b2b-btn-secondary">취소</Link>
            <button
              type="button"
              className="b2b-btn-primary"
              onClick={handleSave}
              disabled={saving || !canSave}
            >
              {saving ? "저장 중..." : mode === "create" ? "등록" : "수정"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
