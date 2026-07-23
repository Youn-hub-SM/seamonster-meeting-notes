import { cookies } from "next/headers";
import { supabaseAdmin } from "./supabase";
import { resolveUserName, verifySession } from "./b2b-auth";
import { getNotifyConfig, shouldNotify, getFlowBotConfig, isFlowBotConfigured, getAppBaseUrl, type FlowBotConfig } from "./b2b-settings";
import type { ProductFieldChange } from "./product-diff";

// B2B 활동 로그 — 상태 변경을 activity_log 테이블에 기록.
// 대시보드 우측 "최근 변경" 피드의 소스.
//
// 모든 기록은 fire-and-forget: 에러 나도 호출 측 작업(발주 저장 등)을 실패시키지 않음.
//
// recordActivity() 가 ① DB 기록(대시보드 피드) + ② 외부 웹훅(Zapier) 전송을 모두 담당.
// 외부 웹훅은 환경변수 ZAPIER_WEBHOOK_URL 설정 시에만 동작.

type ActivityInput = {
  event_type: string;
  summary: string;
  order_id?: string | null;
  order_no?: string | null;
  meta?: Record<string, unknown>;
  notify?: boolean;   // false면 DB 감사기록만 남기고 외부 웹훅(Zapier)은 보내지 않음. 매출 등 비-B2B 이벤트용.
  actor?: string | null; // 지정 시 currentActor() 대신 이 값을 작업자로 사용(라우트가 이미 해석한 이름).
};

// 요청 쿠키에서 현재 작업자 이름 (지인/예지/현석/관리자). 요청 컨텍스트 밖이면 null.
//  서명 세션 토큰(현행 로그인) 우선, 구식 비밀번호 쿠키는 하위 호환 폴백 —
//  verifySession 없이 resolveUserName 만 쓰면 현행 로그인 사용자가 전부 null(- 표시)이 된다.
export async function currentActor(): Promise<string | null> {
  try {
    const store = await cookies();
    const token = store.get("b2b_auth")?.value;
    return (await verifySession(token)) || resolveUserName(token);
  } catch {
    return null;
  }
}

async function recordActivity(input: ActivityInput): Promise<void> {
  const actor = input.actor !== undefined ? input.actor : await currentActor();

  // 1) DB 기록 (대시보드 피드의 소스) — 실패해도 호출 측 작업엔 영향 없음
  try {
    const sb = supabaseAdmin();
    const row = {
      event_type: input.event_type,
      summary: input.summary,
      order_id: input.order_id ?? null,
      order_no: input.order_no ?? null,
      meta: input.meta ?? null,
    };
    const { error } = await sb.from("activity_log").insert({ ...row, actor });
    // actor 컬럼이 아직 없으면(migration 009 미적용) 기존 형식으로 재시도
    if (error) {
      await sb.from("activity_log").insert(row);
    }
  } catch (err) {
    console.error("[b2b-activity] record failed", err);
  }

  // 2) Zapier(또는 호환 외부 웹훅) 전송 — ZAPIER_WEBHOOK_URL 미설정 시 스킵
  //    notify:false(매출 등 비-B2B 감사이벤트)는 외부 알림 없이 DB 기록만.
  if (input.notify !== false) await sendWebhook(input, actor);
}

// ── 도매 생산 요청: 변경기록(활동피드) + notify:true면 Flow 봇 발송 ──
//  둘 다 fire-and-forget(recordActivity 내부에서 실패 무시) — 호출 측 DB 작업에 영향 없음.
export async function logProductionRequestCreated(reqNo: string, label: string, actor?: string | null): Promise<void> {
  await recordActivity({
    event_type: "production_request.created",
    summary: `생산요청 등록 · ${reqNo || "(번호없음)"}${label ? ` · ${label}` : ""}`,
    meta: { req_no: reqNo },
    notify: true, // 작성 시 Flow 알림
    actor,        // 메시지에 '작업자: {actor}' 로 표시(B2B 작업과 동일)
  });
}
export async function logProductionRequestStatusChanged(reqNo: string, fromStatus: string, toStatus: string, actor?: string | null): Promise<void> {
  if (fromStatus === toStatus) return;
  // 생산 시작(진행중)·완료만 Flow 알림, 그 외(취소·다시열기)는 변경기록만.
  const notify = toStatus === "진행중" || toStatus === "완료";
  await recordActivity({
    event_type: "production_request.status_changed",
    summary: `생산요청 ${reqNo || "(번호없음)"} · ${fromStatus} → ${toStatus}`,
    meta: { req_no: reqNo, from: fromStatus, to: toStatus },
    notify,
    actor,
  });
}

// 외부 알림 전송. fire-and-forget.
//  설정(b2b_settings.zapier_notify)에 따라 이벤트·결과상태별로 발송을 거름.
//  라우팅: Flow 봇(flow_bot_id·flow_bot_api_key·flow_bot_receivers) 이 모두 설정돼 있으면
//         Flow 로 직접 발송(Zapier 완전 대체), 아니면 기존 Zapier(ZAPIER_WEBHOOK_URL) 로 폴백.
async function sendWebhook(input: ActivityInput, actor: string | null): Promise<void> {
  // 알림 설정 게이팅 — DB 기록(히스토리)은 영향 없음, 외부 발송만 거름
  const config = await getNotifyConfig();
  if (!shouldNotify(config, input.event_type, input.meta)) return;

  // 1순위: Flow 봇 알림(설정 시 Zapier 대체)
  if (await isFlowBotConfigured()) { await sendFlowBotNotify(input, actor); return; }

  // 폴백: 기존 Zapier Catch Hook
  const url = process.env.ZAPIER_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: input.event_type,
        summary: input.summary,
        actor,
        order_id: input.order_id ?? null,
        order_no: input.order_no ?? null,
        // meta 의 from/to/amount 등을 최상위로도 펼쳐 Zapier 필드 매핑 쉽게
        ...(input.meta ?? {}),
        occurred_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) console.warn("[b2b-activity] webhook responded", res.status);
  } catch (err) {
    console.error("[b2b-activity] webhook failed", err);
  }
}

// 알림 메시지에 넣을 주문 상세 링크(주문 이벤트만). app_base_url 미설정 시 링크 생략.
export async function b2bAlertLink(orderId: string | null | undefined): Promise<string | null> {
  if (!orderId) return null;
  const base = await getAppBaseUrl();
  return base ? `${base}/b2b/orders/${orderId}` : null;
}

// Flow 봇 알림 발송(flow.team Open API bulk). 본문(contents) = 요약 + (작업자) + 주문 상세 링크.
//  수신자·제목·봇키는 설정값. opts 로 테스트 발송 시 수신자/설정 오버라이드 가능.
//  성공 판정: HTTP 2xx 이고 response.success !== false.
export async function sendFlowBotNotify(
  input: ActivityInput,
  actor: string | null,
  opts?: { config?: FlowBotConfig; receivers?: string[] },
): Promise<{ ok: boolean; status: number; error?: string }> {
  const cfg = opts?.config ?? (await getFlowBotConfig());
  const receivers = (opts?.receivers ?? cfg.receivers).map((r) => r.trim()).filter(Boolean);
  if (!cfg.botId || !cfg.apiKey || !receivers.length) {
    return { ok: false, status: 0, error: "Flow 봇 설정(봇 ID·API 키·수신자)이 완료되지 않았습니다." };
  }

  const link = await b2bAlertLink(input.order_id);
  const lines = [input.summary];
  if (actor) lines.push(`— 작업자: ${actor}`);
  // 링크는 본문(contents)에 원문 URL로 넣지 않고, Flow 알림봇 body의 url(선택) 필드로 전달
  //  → 플로우가 본문과 별개의 '자세히 보기' 클릭 링크로 렌더한다(주소 원문 노출 방지).

  const endpoint = `https://api.flow.team/v1/bots/${encodeURIComponent(cfg.botId)}/notifications/bulk`;
  const payload: Record<string, unknown> = {
    receivers: receivers.map((r) => ({ receiverId: r })),
    title: cfg.title || "씨몬스터 B2B 알림",
    contents: lines.join("\n"),
  };
  if (link) payload.url = link; // format:url, max 2000 (문서 스펙)
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-flow-api-key": cfg.apiKey },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    const resp = (json as { response?: { success?: boolean; message?: string; error?: { message?: string; verbose?: string[] } } } | null)?.response;
    if (!res.ok || resp?.success === false) {
      const msg = resp?.error?.message || resp?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      const verbose = resp?.error?.verbose?.length ? ` (${resp.error.verbose.join(", ")})` : "";
      console.warn("[b2b-activity] flow bot notify failed", res.status, msg);
      return { ok: false, status: res.status, error: `${msg}${verbose}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    console.error("[b2b-activity] flow bot notify error", err);
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

// Flow 봇에 임의 텍스트 발송(아침 일정 다이제스트 등). 설정값 사용.
export async function sendFlowText(contents: string, opts?: { config?: FlowBotConfig; receivers?: string[]; title?: string }): Promise<{ ok: boolean; status: number; error?: string }> {
  const cfg = opts?.config ?? (await getFlowBotConfig());
  const receivers = (opts?.receivers ?? cfg.receivers).map((r) => r.trim()).filter(Boolean);
  if (!cfg.botId || !cfg.apiKey || !receivers.length) return { ok: false, status: 0, error: "Flow 봇 설정(봇 ID·API 키·수신자)이 완료되지 않았습니다." };
  const url = `https://api.flow.team/v1/bots/${encodeURIComponent(cfg.botId)}/notifications/bulk`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-flow-api-key": cfg.apiKey },
      body: JSON.stringify({ receivers: receivers.map((r) => ({ receiverId: r })), title: opts?.title || cfg.title || "씨몬스터 B2B 알림", contents }),
    });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    const resp = (json as { response?: { success?: boolean; message?: string; error?: { message?: string; verbose?: string[] } } } | null)?.response;
    if (!res.ok || resp?.success === false) {
      const msg = resp?.error?.message || resp?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: msg };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
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
    summary: `새 발주 · ${o.company_name} · ${o.order_no} · ${fmtMoney(o.total)}원`,
    order_id: o.id,
    order_no: o.order_no,
  });
}

export async function logOrderStatusChanged(orderId: string, fromStatus: string, toStatus: string): Promise<void> {
  if (fromStatus === toStatus) return;
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  const emoji =
    toStatus === "발송완료" ? "" :
    toStatus === "취소" ? "" : "";
  await recordActivity({
    event_type: "order.status_changed",
    summary: `${emoji} ${o.order_no} (${o.company_name}) · ${fromStatus} → ${toStatus}`,
    order_id: o.id,
    order_no: o.order_no,
    meta: { from: fromStatus, to: toStatus },
  });
}

export async function logOrderProductionStatusChanged(orderId: string, fromStatus: string, toStatus: string): Promise<void> {
  if (fromStatus === toStatus) return;
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  const emoji = toStatus === "생산완료" ? "" : toStatus === "생산중" ? "" : "";
  await recordActivity({
    event_type: "order.production_status_changed",
    summary: `${emoji} 생산 ${o.order_no} (${o.company_name}) · ${fromStatus} → ${toStatus}`,
    order_id: o.id,
    order_no: o.order_no,
    meta: { from: fromStatus, to: toStatus },
  });
}

export async function logOrderPaymentStatusChanged(orderId: string, fromStatus: string, toStatus: string): Promise<void> {
  if (fromStatus === toStatus) return;
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  const emoji = toStatus === "입금완료" ? "" : toStatus === "일부입금" ? "" : "";
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
  const emoji = toStatus === "발행완료" ? "" : toStatus === "불필요" ? "" : "";
  await recordActivity({
    event_type: "order.tax_invoice_changed",
    summary: `${emoji} 세금계산서 ${o.order_no} (${o.company_name}) · ${fromStatus} → ${toStatus}`,
    order_id: o.id,
    order_no: o.order_no,
    meta: { from: fromStatus, to: toStatus },
  });
}

// 발송 차수(하위 발주) 상태 변경
export async function logShipmentStatusChanged(orderId: string, seq: number, fromStatus: string, toStatus: string): Promise<void> {
  if (fromStatus === toStatus) return;
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  const emoji =
    toStatus === "발송완료" ? "" :
    toStatus === "취소" ? "" : "";
  await recordActivity({
    event_type: "shipment.status_changed",
    summary: `${emoji} ${o.order_no} (${o.company_name}) · ${seq}차 발송 · ${fromStatus} → ${toStatus}`,
    order_id: o.id,
    order_no: o.order_no,
    meta: { seq, from: fromStatus, to: toStatus },
  });
}

// 발주 삭제 — order 가 이미 삭제됐으므로 스냅샷을 직접 받음 (order_id 는 null)
export async function logOrderDeleted(orderNo: string, companyName: string, total: number): Promise<void> {
  await recordActivity({
    event_type: "order.deleted",
    summary: `발주 삭제 · ${companyName} · ${orderNo} · ${fmtMoney(total)}원`,
    order_id: null,
    order_no: orderNo,
  });
}

// 업체(주소록) 등록·수정·삭제
export async function logCompanyChange(action: "created" | "updated" | "deleted", name: string): Promise<void> {
  const verb = action === "created" ? "등록" : action === "updated" ? "수정" : "삭제";
  const emoji = action === "deleted" ? "" : "";
  await recordActivity({
    event_type: `company.${action}`,
    summary: `${emoji} 업체 ${verb} · ${name}`,
  });
}

// 상품 마스터(제품/품목) 등록·수정·삭제 — 변경 기록(/b2b/products/history)의 소스.
//  opts.changes: 필드별 diff(수정 시), opts.source: 변경 경로(수동수정·엑셀업로드·품목업로드(생산) 등).
export async function logProductChange(
  action: "created" | "updated" | "deleted",
  name: string,
  sku?: string | null,
  opts?: { source?: string; changes?: ProductFieldChange[]; productId?: string | null }
): Promise<void> {
  const verb = action === "created" ? "등록" : action === "updated" ? "수정" : "삭제";
  const emoji = action === "deleted" ? "" : action === "created" ? "" : "";
  const skuPart = sku ? ` (${sku})` : "";
  const changes = opts?.changes ?? [];
  const suffix = action === "updated" && changes.length ? ` · ${changes.length}개 항목` : "";
  await recordActivity({
    event_type: `product.${action}`,
    summary: `${emoji} 상품 마스터 ${verb} · ${name}${skuPart}${suffix}`,
    meta: { source: opts?.source ?? null, changes, product_id: opts?.productId ?? null, name, sku: sku ?? null },
  });
}

export async function logPaymentAdded(orderId: string, amount: number, method: string | null): Promise<void> {
  const o = await loadOrderSummary(orderId);
  if (!o) return;
  await recordActivity({
    event_type: "payment.added",
    summary: `입금기록 · ${o.order_no} (${o.company_name}) · ${fmtMoney(amount)}원${method ? ` (${method})` : ""}`,
    order_id: o.id,
    order_no: o.order_no,
    meta: { amount, method },
  });
}

// ── 매출(sales) ── 비-B2B. 전부 notify:false → 외부 웹훅(Zapier) 미발송, DB 감사기록만.
export async function logSalesUpload(filename: string, inserted: number, skipped: number): Promise<void> {
  await recordActivity({
    event_type: "sales.upload",
    summary: `매출 업로드 · ${filename} · 신규 ${inserted.toLocaleString()}건${skipped ? ` (중복 ${skipped.toLocaleString()} 제외)` : ""}`,
    meta: { filename, inserted, skipped },
    notify: false,
  });
}
export async function logSalesUploadRevert(filename: string, batchId: string, deleted: number): Promise<void> {
  await recordActivity({
    event_type: "sales.upload_revert",
    summary: `↩️ 매출 업로드 되돌리기 · ${filename || batchId} · ${deleted.toLocaleString()}건 삭제`,
    meta: { filename, batchId, deleted },
    notify: false,
  });
}
export async function logSalesReportSent(reportType: "daily" | "weekly", baseDate: string, recipients: number): Promise<void> {
  await recordActivity({
    event_type: "sales.report_sent",
    summary: `${reportType === "weekly" ? "주간" : "일일"} 매출 리포트 발송 · ${baseDate} · 수신 ${recipients}명`,
    meta: { reportType, baseDate, recipients },
    notify: false,
  });
}
export async function logSalesConfigChanged(channels: number): Promise<void> {
  await recordActivity({
    event_type: "sales.config_changed",
    summary: `채널 이익 설정 저장 · ${channels}개 채널`,
    meta: { channels },
    notify: false,
  });
}
// 전화번호 조회 감사 — 번호는 뒤4자리만 기록(내부 오남용 억제). 외부 알림 없이 DB에만 남김.
export async function logPhoneLookup(phoneDigits: string): Promise<void> {
  const masked = phoneDigits ? `***${phoneDigits.slice(-4)}` : "(빈값)";
  await recordActivity({
    event_type: "sales.phone_lookup",
    summary: `주문 검색(전화 조회) · ${masked}`,
    meta: { masked },
    notify: false,
  });
}
