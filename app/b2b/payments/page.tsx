"use client";

import { useEffect, useState } from "react";
import {
  Payment,
  PaymentInput,
  PAYMENT_COLORS,
  PaymentStatus,
  formatMoney,
} from "@/app/lib/b2b-orders";
import {
  BankDeposit,
  DEPOSIT_STATUS_COLORS,
  DepositCandidate,
  UnpaidOrderLite,
  formatTrdt,
} from "@/app/lib/b2b-deposit-types";
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

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">입금 확인</h1>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={reload} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      <DepositFeed onMatched={reload} />

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
            미수금 발주가 없습니다.
          </div>
        ) : (
          <div className="b2b-table-wrap">
            {/* is-responsive + pay-table: 모바일은 카드(업체·발주일·청구액·입금상태만) */}
            <table className="b2b-table is-responsive pay-table">
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
                    <td data-label="업체"><strong>{o.company_name}</strong></td>
                    <td data-label="발주일">{o.order_date}</td>
                    <td>{o.ship_date || "-"}</td>
                    <td className="num b2b-money" data-label="청구액">{formatMoney(o.total)}</td>
                    <td className="num b2b-money">{formatMoney(o.paid)}</td>
                    <td className="num b2b-money" style={{ color: o.remaining > 0 ? "var(--sm-danger)" : "inherit", fontWeight: 600 }}>
                      {formatMoney(o.remaining)}
                    </td>
                    <td data-label="입금상태">
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
          onChanged={reload}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// 은행 입금 피드 — 팝빌 계좌조회 수집분. 확인필요 원클릭 매칭 + 최근 처리 내역.
// ─────────────────────────────────────────────
type DepositsResponse = {
  ok: boolean;
  notReady?: boolean;
  error?: string;
  review: BankDeposit[];
  recent: BankDeposit[];
  suggestions: Record<string, DepositCandidate[]>;
  unpaid: UnpaidOrderLite[];
  lastSync: { at: string; fetched: number; inserted: number; autoMatched: number; needReview: number } | null;
  rules: string[];
};

function DepositFeed({ onMatched }: { onMatched: () => void }) {
  const [data, setData] = useState<DepositsResponse | null>(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/b2b/deposits", { cache: "no-store" });
      const j = (await res.json()) as DepositsResponse;
      if (!res.ok || !j.ok) throw new Error(j.error || "입금 내역 조회 실패");
      setData(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : "입금 내역 조회 오류");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSync() {
    setSyncing(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/deposits/sync", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "동기화 실패");
      await load();
      if (j.autoMatched > 0) onMatched();
    } catch (err) {
      setError(err instanceof Error ? err.message : "동기화 오류");
    }
    setSyncing(false);
  }

  async function act(
    depositId: string,
    action: "match" | "ignore" | "restore",
    opts?: { orderId?: string; label?: string; always?: boolean; remark?: string | null }
  ) {
    if (action === "match" && !confirm(`이 입금을 ${opts?.label} 발주에 매칭할까요?\n입금 기록이 추가되고 입금 상태가 바뀝니다.`)) return;
    if (
      opts?.always &&
      !confirm(`'${opts?.remark}' 입금자명을 항상 무시할까요?\n앞으로 같은 이름의 입금은 알림 없이 자동 무시됩니다. (매출 정산·이자 등)`)
    )
      return;
    setBusyId(depositId);
    setError("");
    try {
      const res = await fetch("/api/b2b/deposits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, deposit_id: depositId, order_id: opts?.orderId, always: opts?.always }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "처리 실패");
      await load();
      if (action === "match") {
        onMatched();
        pingActivityFeed();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "처리 오류");
    }
    setBusyId(null);
  }

  // 자동무시 규칙 삭제 (칩 ✕)
  async function removeRule(rule: string) {
    if (!data || !confirm(`'${rule}' 자동무시 규칙을 삭제할까요?`)) return;
    setError("");
    try {
      const res = await fetch("/api/b2b/deposits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rules", rules: data.rules.filter((r) => r !== rule) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "규칙 저장 실패");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "규칙 저장 오류");
    }
  }

  const lastSyncLabel = data?.lastSync?.at
    ? new Date(data.lastSync.at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "없음";

  return (
    <div className="b2b-card" style={{ marginBottom: 16 }}>
      <div className="b2b-card-head">
        <h2 className="b2b-card-title">
          은행 입금 (국민은행)
          {data && data.review.length > 0 && <span className="pay-dep-count">{data.review.length}건 확인필요</span>}
        </h2>
        <div className="b2b-page-actions">
          <span className="pay-dep-sync-at">마지막 동기화 {lastSyncLabel}</span>
          <button className="b2b-btn-secondary" onClick={handleSync} disabled={syncing}>
            {syncing ? "동기화 중..." : "지금 동기화"}
          </button>
        </div>
      </div>

      {error && <div className="b2b-error">{error}</div>}

      {data?.notReady ? (
        <div className="b2b-empty">
          마이그레이션 089_bank_deposits.sql 이 아직 적용되지 않았습니다 — Supabase SQL Editor 에서 적용하세요.
        </div>
      ) : !data ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : data.review.length === 0 && data.recent.length === 0 ? (
        <div className="b2b-empty">수집된 입금이 없습니다. [지금 동기화]로 국민은행 입금 내역을 가져옵니다.</div>
      ) : (
        <>
          {data.review.map((d) => (
            <div key={d.id} className="pay-dep-row is-review">
              <div className="pay-dep-main">
                <span className="b2b-money pay-dep-amount">{formatMoney(d.amount)}원</span>
                <span className="pay-dep-remark">{d.remark || "(입금자명 없음)"}</span>
                <span className="pay-dep-date">{formatTrdt(d.trdt)}</span>
              </div>
              <div className="pay-dep-actions">
                {(data.suggestions[d.id] ?? []).map((c) => (
                  <button
                    key={c.order.id}
                    className="pay-dep-suggest"
                    disabled={busyId === d.id}
                    onClick={() => act(d.id, "match", { orderId: c.order.id, label: `${c.order.order_no} (${c.order.company_name})` })}
                    title={`청구 ${formatMoney(c.order.total)} · 잔액 ${formatMoney(c.order.remaining)}`}
                  >
                    → {c.order.company_name} · 잔액 {formatMoney(c.order.remaining)}
                    {c.nameHit && c.amountHit ? " (이름·금액 일치)" : c.amountHit ? " (금액 일치)" : " (이름 일치)"}
                  </button>
                ))}
                <select
                  className="b2b-input pay-dep-select"
                  disabled={busyId === d.id}
                  value=""
                  onChange={(e) => {
                    const o = data.unpaid.find((u) => u.id === e.target.value);
                    if (o) act(d.id, "match", { orderId: o.id, label: `${o.order_no} (${o.company_name})` });
                  }}
                >
                  <option value="">직접 선택...</option>
                  {data.unpaid.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.company_name} · {o.order_no} · 잔액 {formatMoney(o.remaining)}
                    </option>
                  ))}
                </select>
                <button className="pay-dep-ignore" disabled={busyId === d.id} onClick={() => act(d.id, "ignore")}>
                  무시
                </button>
                {d.remark && (
                  <button
                    className="pay-dep-ignore"
                    disabled={busyId === d.id}
                    onClick={() => act(d.id, "ignore", { always: true, remark: d.remark })}
                    title="이 입금자명을 앞으로 알림 없이 자동 무시 (매출 정산·이자 등)"
                  >
                    항상 무시
                  </button>
                )}
              </div>
            </div>
          ))}

          {data.rules.length > 0 && (
            <div className="pay-dep-rules">
              <span className="pay-dep-rules-label">자동무시 규칙</span>
              {data.rules.map((r) => (
                <span key={r} className="pay-dep-rule-chip">
                  {r}
                  <button className="pay-dep-rule-del" onClick={() => removeRule(r)} title="규칙 삭제">
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {data.recent.length > 0 && (
            <>
              <button className="pay-dep-toggle" onClick={() => setShowRecent((v) => !v)}>
                최근 처리 {data.recent.length}건 {showRecent ? "접기" : "펼치기"}
              </button>
              {showRecent &&
                data.recent.map((d) => (
                  <div key={d.id} className="pay-dep-row">
                    <div className="pay-dep-main">
                      <span className="b2b-money pay-dep-amount">{formatMoney(d.amount)}원</span>
                      <span className="pay-dep-remark">{d.remark || "(입금자명 없음)"}</span>
                      <span className="pay-dep-date">{formatTrdt(d.trdt)}</span>
                    </div>
                    <div className="pay-dep-actions">
                      <span
                        className="b2b-status-pill"
                        style={{ background: DEPOSIT_STATUS_COLORS[d.status]?.bg, color: DEPOSIT_STATUS_COLORS[d.status]?.fg }}
                      >
                        {d.status}
                        {d.matched_by && d.status !== "무시" ? ` · ${d.matched_by}` : ""}
                      </span>
                      {d.status === "무시" && (
                        <button className="pay-dep-ignore" disabled={busyId === d.id} onClick={() => act(d.id, "restore")}>
                          되돌리기
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 입금 모달 — 입금 상태 변경(최상단, 큰 버튼) + 입금 추가(금액·입금일·메모) + 내역
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
  const [curStatus, setCurStatus] = useState<PaymentStatus>(order.payment_status);
  const [statusSaving, setStatusSaving] = useState(false);
  const [form, setForm] = useState<PaymentInput>({
    order_id: order.id,
    amount: order.remaining > 0 ? order.remaining : "",
    paid_at: todayIso(),
    method: "",
    reference: "",
    notes: "",
  });

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

  async function handleStatusChange(newStatus: PaymentStatus) {
    if (newStatus === curStatus) return;
    setStatusSaving(true);
    setError("");
    const prev = curStatus;
    setCurStatus(newStatus); // 낙관적
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
      // 미수금 목록에서 빠지는 상태면 모달 닫기(완료감)
      if (newStatus === "입금완료" || newStatus === "불필요") onClose();
    } catch (err) {
      setCurStatus(prev); // 롤백
      setError(err instanceof Error ? err.message : "상태 변경 오류");
    }
    setStatusSaving(false);
  }

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
        body: JSON.stringify({ ...form, method: "", reference: "" }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "입금 추가 실패");
      setForm({ order_id: order.id, amount: "", paid_at: todayIso(), method: "", reference: "", notes: "" });
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

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="b2b-modal-head">
          <div>
            <h2 className="b2b-modal-title">{order.company_name}</h2>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--sm-text-mid)" }}>
              {order.order_no} · {order.order_date}
              {" · 청구 "}
              <strong className="b2b-money">{formatMoney(order.total)}</strong>
              {" · 잔액 "}
              <strong className="b2b-money" style={{ color: remaining > 0 ? "var(--sm-danger)" : "var(--sm-success)" }}>
                {formatMoney(remaining)}
              </strong>
            </div>
          </div>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="b2b-modal-body">
          {error && <div className="b2b-error">{error}</div>}

          {/* ① 입금 상태 변경 — 가장 중요, 최상단 큰 버튼 */}
          <section className="pay-status-box">
            <div className="pay-status-label">입금 상태 변경</div>
            <button
              className={`pay-paid-btn${curStatus === "입금완료" ? " is-current" : ""}`}
              onClick={() => handleStatusChange("입금완료")}
              disabled={statusSaving || curStatus === "입금완료"}
            >
              {curStatus === "입금완료" ? "✓ 입금완료됨" : "✓ 입금완료로 변경"}
            </button>
            <div className="pay-status-others">
              {(["입금전", "일부입금", "불필요"] as PaymentStatus[]).map((s) => (
                <button
                  key={s}
                  className={`pay-status-btn${curStatus === s ? " is-active" : ""}`}
                  onClick={() => handleStatusChange(s)}
                  disabled={statusSaving || curStatus === s}
                >
                  {s}
                </button>
              ))}
            </div>
          </section>

          {/* ② 입금 추가 — 금액·입금일·메모만 */}
          <section className="pay-add-box">
            <div className="pay-status-label" style={{ marginBottom: 8 }}>
              입금 추가 <span style={{ fontWeight: 400, color: "var(--sm-text-light)" }}>(선택)</span>
            </div>
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
            <div className="b2b-field" style={{ marginTop: 10 }}>
              <label className="b2b-field-label">메모</label>
              <input
                type="text"
                className="b2b-input"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="예) 세금계산서 발행분 / 부분입금"
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="b2b-btn-primary"
                onClick={handleAdd}
                disabled={adding || !Number(form.amount) || Number(form.amount) <= 0}
                style={{ width: "100%" }}
              >
                {adding ? "추가 중..." : "+ 입금 추가"}
              </button>
            </div>
          </section>

          {/* ③ 입금 내역 */}
          <section style={{ marginTop: 16 }}>
            <div className="pay-status-label" style={{ marginBottom: 8 }}>입금 내역</div>
            {loading ? (
              <div className="b2b-loading">불러오는 중...</div>
            ) : payments.length === 0 ? (
              <div className="b2b-empty" style={{ padding: "20px 12px" }}>기록된 입금이 없습니다.</div>
            ) : (
              <div className="pay-history">
                {payments.map((p) => (
                  <div key={p.id} className="pay-history-row">
                    <div className="pay-history-main">
                      <span className="b2b-money" style={{ fontWeight: 700 }}>{formatMoney(p.amount)}</span>
                      <span className="pay-history-date">{p.paid_at}</span>
                    </div>
                    {p.notes && <div className="pay-history-note">{p.notes}</div>}
                    <button className="b2b-btn-danger pay-history-del" onClick={() => handleDelete(p.id)}>삭제</button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right" style={{ width: "100%" }}>
            <button className="b2b-btn-secondary" onClick={onClose} style={{ width: "100%" }}>닫기</button>
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
