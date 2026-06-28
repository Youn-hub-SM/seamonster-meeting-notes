"use client";

import { useEffect, useState } from "react";
import {
  Payment,
  PaymentInput,
  PAYMENT_STATUSES,
  PAYMENT_COLORS,
  PaymentStatus,
  formatMoney,
} from "@/app/lib/b2b-orders";
import { pingActivityFeed } from "../ActivityFeed";

type UnpaidOrder = {
  id: string;
  order_no: string;
  order_date: string;
  ship_date: string | null;
  status: string;
  payment_status: PaymentStatus;
  total: number;
  paid: number;
  remaining: number;
  company_name: string;
};

type UnpaidResponse = {
  orders: UnpaidOrder[];
  summary: {
    order_count: number;
    total_amount: number;
    total_paid: number;
    total_remaining: number;
  };
};

export default function PaymentsPage() {
  const [data, setData] = useState<UnpaidResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modalOrder, setModalOrder] = useState<UnpaidOrder | null>(null);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/payments/unpaid", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      setData(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }

  useEffect(() => {
    reload();
  }, []);

  // 모달이 데이터를 변경하면 (입금 추가/삭제, 상태 변경) 외부 리스트도 새로고침
  function onModalChanged() {
    reload();
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">입금 확인</h1>
          <p className="b2b-page-subtitle">
            입금전·일부입금 발주를 한 화면에서 — 발주를 클릭해 입금 내역을 기록하세요.
          </p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={reload} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {data && (
        <div className="b2b-dash-grid" style={{ marginBottom: 16 }}>
          <div className="b2b-stat-card">
            <div className="b2b-stat-card-label">미수금 발주</div>
            <div className="b2b-stat-card-value">{data.summary.order_count}건</div>
          </div>
          <div className="b2b-stat-card">
            <div className="b2b-stat-card-label">총 청구액</div>
            <div className="b2b-stat-card-value b2b-money">{formatMoney(data.summary.total_amount)}</div>
          </div>
          <div className="b2b-stat-card">
            <div className="b2b-stat-card-label">입금 합계</div>
            <div className="b2b-stat-card-value b2b-money">{formatMoney(data.summary.total_paid)}</div>
          </div>
          <div className="b2b-stat-card" style={{ borderColor: "var(--sm-danger-border)" }}>
            <div className="b2b-stat-card-label" style={{ color: "var(--sm-danger)" }}>미수금</div>
            <div className="b2b-stat-card-value b2b-money" style={{ color: "var(--sm-danger)" }}>
              {formatMoney(data.summary.total_remaining)}
            </div>
          </div>
        </div>
      )}

      <div className="b2b-card">
        <div className="b2b-card-head">
          <h2 className="b2b-card-title">입금전·일부입금 발주</h2>
        </div>

        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : !data || data.orders.length === 0 ? (
          <div className="b2b-empty">
            <div className="b2b-empty-icon">💰</div>
            미수금 발주가 없습니다.
          </div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead>
                <tr>
                  <th>발주번호</th>
                  <th>업체</th>
                  <th>발주일</th>
                  <th>발송일</th>
                  <th className="num">청구액</th>
                  <th className="num">입금</th>
                  <th className="num">잔액</th>
                  <th>입금 상태</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} onClick={() => setModalOrder(o)}>
                    <td><strong>{o.order_no}</strong></td>
                    <td>{o.company_name}</td>
                    <td>{o.order_date}</td>
                    <td>{o.ship_date || "-"}</td>
                    <td className="num b2b-money">{formatMoney(o.total)}</td>
                    <td className="num b2b-money">{formatMoney(o.paid)}</td>
                    <td className="num b2b-money" style={{ color: o.remaining > 0 ? "var(--sm-danger)" : "inherit", fontWeight: 600 }}>
                      {formatMoney(o.remaining)}
                    </td>
                    <td>
                      <span
                        className="b2b-status-pill"
                        style={{
                          background: PAYMENT_COLORS[o.payment_status]?.bg,
                          color: PAYMENT_COLORS[o.payment_status]?.fg,
                        }}
                      >
                        {o.payment_status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOrder && (
        <PaymentModal
          order={modalOrder}
          onClose={() => setModalOrder(null)}
          onChanged={onModalChanged}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// 입금 내역 모달
// ─────────────────────────────────────────────
function PaymentModal({
  order,
  onClose,
  onChanged,
}: {
  order: UnpaidOrder;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<PaymentInput>({
    order_id: order.id,
    amount: order.remaining > 0 ? order.remaining : "",
    paid_at: todayIso(),
    method: "",
    reference: "",
    notes: "",
  });
  const [statusSaving, setStatusSaving] = useState(false);

  async function loadPayments() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/b2b/payments?order_id=${order.id}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "조회 실패");
      setPayments(j.payments || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }

  useEffect(() => {
    loadPayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);

  const paidSum = payments.reduce((s, p) => s + Number(p.amount), 0);
  const remaining = order.total - paidSum;

  async function handleAdd() {
    if (!Number(form.amount) || Number(form.amount) <= 0) {
      setError("금액은 0보다 커야 합니다.");
      return;
    }
    setAdding(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "입금 추가 실패");
      setForm({
        order_id: order.id,
        amount: "",
        paid_at: todayIso(),
        method: form.method,
        reference: "",
        notes: "",
      });
      await loadPayments();
      onChanged();
      pingActivityFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "추가 중 오류");
    }
    setAdding(false);
  }

  async function handleDelete(id: string) {
    if (!confirm("이 입금 내역을 삭제할까요?")) return;
    try {
      const res = await fetch(`/api/b2b/payments?id=${id}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "삭제 실패");
      await loadPayments();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 중 오류");
    }
  }

  async function handleStatusChange(newStatus: PaymentStatus) {
    setStatusSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/b2b/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_status: newStatus }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "상태 변경 실패");
      onChanged();
      pingActivityFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "상태 변경 오류");
    }
    setStatusSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="b2b-modal-head">
          <div>
            <h2 className="b2b-modal-title">{order.order_no} · {order.company_name}</h2>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--sm-text-mid)" }}>
              청구액 <strong className="b2b-money">{formatMoney(order.total)}</strong>
              {" · "}
              입금 <strong className="b2b-money">{formatMoney(paidSum)}</strong>
              {" · "}
              잔액 <strong className="b2b-money" style={{ color: remaining > 0 ? "var(--sm-danger)" : "var(--sm-success)" }}>
                {formatMoney(remaining)}
              </strong>
            </div>
          </div>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="b2b-modal-body">
          {error && <div className="b2b-error">{error}</div>}

          <section>
            <div className="b2b-form-section-title" style={{ marginBottom: 8 }}>입금 내역</div>
            {loading ? (
              <div className="b2b-loading">불러오는 중...</div>
            ) : payments.length === 0 ? (
              <div style={{ padding: 12, fontSize: 12, color: "var(--sm-text-light)", textAlign: "center", background: "var(--sm-bg)", borderRadius: 8 }}>
                기록된 입금이 없습니다.
              </div>
            ) : (
              <table className="b2b-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>입금일</th>
                    <th className="num">금액</th>
                    <th>방법</th>
                    <th>메모</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} style={{ cursor: "default" }}>
                      <td>{p.paid_at}</td>
                      <td className="num b2b-money">{formatMoney(p.amount)}</td>
                      <td>{p.method || "-"}</td>
                      <td>
                        {p.reference || "-"}
                        {p.notes && <div style={{ fontSize: 10, color: "var(--sm-text-light)" }}>{p.notes}</div>}
                      </td>
                      <td className="actions">
                        <button className="b2b-btn-danger" onClick={() => handleDelete(p.id)} style={{ fontSize: 11, padding: "4px 8px" }}>
                          삭제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section style={{ background: "var(--sm-bg)", padding: 14, borderRadius: 8 }}>
            <div className="b2b-form-section-title" style={{ marginBottom: 8 }}>입금 추가</div>
            <div className="b2b-field-row">
              <div className="b2b-field">
                <label className="b2b-field-label">금액 (원)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  className="b2b-input b2b-money"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  min={0}
                />
              </div>
              <div className="b2b-field">
                <label className="b2b-field-label">입금일</label>
                <input
                  type="date"
                  className="b2b-input"
                  value={form.paid_at}
                  onChange={(e) => setForm({ ...form, paid_at: e.target.value })}
                />
              </div>
            </div>
            <div className="b2b-field-row" style={{ marginTop: 10 }}>
              <div className="b2b-field">
                <label className="b2b-field-label">방법</label>
                <input
                  type="text"
                  className="b2b-input"
                  value={form.method}
                  onChange={(e) => setForm({ ...form, method: e.target.value })}
                  placeholder="계좌이체 / 카드 / 현금"
                />
              </div>
              <div className="b2b-field">
                <label className="b2b-field-label">송금명의·전표번호</label>
                <input
                  type="text"
                  className="b2b-input"
                  value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })}
                />
              </div>
            </div>
            <div className="b2b-field" style={{ marginTop: 10 }}>
              <label className="b2b-field-label">메모</label>
              <input
                type="text"
                className="b2b-input"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
            <div style={{ marginTop: 12, textAlign: "right" }}>
              <button
                type="button"
                className="b2b-btn-primary"
                onClick={handleAdd}
                disabled={adding || !Number(form.amount) || Number(form.amount) <= 0}
              >
                {adding ? "추가 중..." : "+ 입금 추가"}
              </button>
            </div>
          </section>
        </div>

        <div className="b2b-modal-foot">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>입금 상태</span>
            <select
              className="b2b-select"
              value={order.payment_status}
              onChange={(e) => handleStatusChange(e.target.value as PaymentStatus)}
              disabled={statusSaving}
              style={{ width: "auto" }}
            >
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose}>닫기</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
