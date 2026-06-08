import { supabaseAdmin } from "./supabase";

// B2B 활동 로그 — 상태 변경을 activity_log 테이블에 기록.
// 대시보드 우측 "최근 변경" 피드의 소스.
//
// 모든 기록은 fire-and-forget: 에러 나도 호출 측 작업(발주 저장 등)을 실패시키지 않음.
//
// ※ 나중에 Teams/Flow 등 외부 푸시를 붙일 거면 recordActivity() 안에서
//   activity_log insert 직후에 전송 한 줄만 추가하면 됨 — 트리거 지점은 그대로 재사용.

type ActivityInput = {
  event_type: string;
  summary: string;
  order_id?: string | null;
  order_no?: string | null;
  meta?: Record<string, unknown>;
};

async function recordActivity(input: ActivityInput): Promise<void> {
  try {
    const sb = supabaseAdmin();
    await sb.from("activity_log").insert({
      event_type: input.event_type,
      summary: input.summary,
      order_id: input.order_id ?? null,
      order_no: input.order_no ?? null,
      meta: input.meta ?? null,
    });
  } catch (err) {
    console.error("[b2b-activity] record failed", err);
  }
}

type OrderSummary = {
  id: string;
  order_no: string;
  company_name: string;
  total: number;
};

async function loadOrderSummary(orderId: string): Promise<OrderSummary | null> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("orders")
      .select("id, order_no, total, company:company_id(name)")
      .eq("id", orderId)
      .single();
    if (error || !data) return null;
    type Row = {
      id: string;
      order_no: string;
      total: number;
      company: { name?: string } | { name?: string }[] | null;
    };
    const r = data as unknown as Row;
    const company = Array.isArray(r.company) ? r.company[0] : r.company;
    return {
      id: r.id,
      order_no: r.order_no,
      company_name: company?.name ?? "(미지정)",
      total: Number(r.total) || 0,
    };
  } catch (err) {
    console.error("[b2b-activity] loadOrderSummary failed", err);
    return null;
  }
}

function fmtMoney(n: number): string {
  return n.toLocaleString();
}

// ─────────────────────────────────────────────
// 공개 기록 함수
// ─────────────────────────────────────────────

export async function logOrderCreated(orderId: string): Promise<void> {
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  await recordActivity({
    event_type: "order.created",
    summary: `📦 새 발주 · ${o.company_name} · ${o.order_no} · ${fmtMoney(o.total)}원`,
    order_id: o.id,
    order_no: o.order_no,
  });
}

export async function logOrderStatusChanged(orderId: string, fromStatus: string, toStatus: string): Promise<void> {
  if (fromStatus === toStatus) return;
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  const emoji =
    toStatus === "생산요청/생산중" ? "🏭" :
    toStatus === "생산완료/발송대기" ? "✅" :
    toStatus === "발송완료" ? "🚚" :
    toStatus === "취소" ? "❌" : "🔄";
  await recordActivity({
    event_type: "order.status_changed",
    summary: `${emoji} ${o.order_no} (${o.company_name}) · ${fromStatus} → ${toStatus}`,
    order_id: o.id,
    order_no: o.order_no,
    meta: { from: fromStatus, to: toStatus },
  });
}

export async function logOrderPaymentStatusChanged(orderId: string, fromStatus: string, toStatus: string): Promise<void> {
  if (fromStatus === toStatus) return;
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  const emoji = toStatus === "입금완료" ? "💰" : toStatus === "부분입금" ? "💵" : "⏳";
  await recordActivity({
    event_type: "order.payment_status_changed",
    summary: `${emoji} 입금상태 ${o.order_no} (${o.company_name}) · ${fromStatus} → ${toStatus}`,
    order_id: o.id,
    order_no: o.order_no,
    meta: { from: fromStatus, to: toStatus },
  });
}

export async function logOrderTaxInvoiceChanged(orderId: string, fromStatus: string, toStatus: string): Promise<void> {
  if (fromStatus === toStatus) return;
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  const emoji = toStatus === "발행완료" ? "🧾" : toStatus === "발행대기" ? "📝" : toStatus === "면제" ? "➖" : "📄";
  await recordActivity({
    event_type: "order.tax_invoice_changed",
    summary: `${emoji} 세금계산서 ${o.order_no} (${o.company_name}) · ${fromStatus} → ${toStatus}`,
    order_id: o.id,
    order_no: o.order_no,
    meta: { from: fromStatus, to: toStatus },
  });
}

export async function logPaymentAdded(orderId: string, amount: number, method: string | null): Promise<void> {
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  await recordActivity({
    event_type: "payment.added",
    summary: `💵 입금기록 · ${o.order_no} (${o.company_name}) · ${fmtMoney(amount)}원${method ? ` (${method})` : ""}`,
    order_id: o.id,
    order_no: o.order_no,
    meta: { amount, method },
  });
}
