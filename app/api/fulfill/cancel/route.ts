import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { logOrderCancel } from "@/app/lib/b2b-activity";
import { normalizeBoxCats } from "@/app/lib/fulfill-rates";
import { findOrders, listCancels, normalizeApply, applyCancel, revertCancel, markSteps, getCancel, CancelError, type BoxPlan, type StockPlan } from "@/app/lib/order-cancel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 취소·반품 처리(온라인 발주 › 취소·반품, 2026-11-20) — 소매 주문 줄을 수량 단위로 취소해 매출 원장에 반영한다(app/lib/order-cancel.ts, migration 175).
//  GET                       → 최근 취소·반품 기록 100건 + 배송일지 박스 종류
//  GET ?order=주문번호         → 그 주문의 매출 줄(채널별) — 남은 수량·금액, 이미 취소한 수량, 재고에 돌려놓을 품목
//  POST { action: "apply", requestKey, kind, channel, orderId, note, lines[{row_hash, qty, amount}], box?, stock? }
//                            → 매출 원장 반영(한 트랜잭션). 박스·재고는 계획만 기록 — 화면이 기존 저장 경로로 이어서 기록한다.
//  POST { action: "mark", id, box?, stock? }  → 박스·재고 단계의 결과 기록
//  POST { action: "revert", id }              → 매출 복구. 박스·재고는 화면이 기존 경로로 지운 뒤 mark 로 기록한다.
//  로그인한 내부 직원 누구나(공장 계정 제외). 누가 언제 무엇을 취소했는지는 화면의 기록과 매출 변경 기록에 남는다.

async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 화면이 보낸 단계 결과 다듬기 — 저장해 둔 계획(날짜·종류·수량·요청 키)은 바꾸지 못하고 결과(entry_id·txn_ids·done)만 받는다
function mergeBox(saved: BoxPlan | null, raw: unknown): BoxPlan | null {
  if (!saved || !raw || typeof raw !== "object") return saved;
  const x = raw as Record<string, unknown>;
  return { ...saved, done: x.done === true };
}
function mergeStock(saved: StockPlan[] | null, raw: unknown): StockPlan[] | null {
  if (!saved || !Array.isArray(raw)) return saved;
  const by = new Map((raw as Record<string, unknown>[]).map((x) => [String(x?.request_key || ""), x]));
  return saved.map((s) => {
    const x = by.get(s.request_key);
    if (!x) return s;
    const ids = Array.isArray(x.txn_ids) ? (x.txn_ids as unknown[]).map((v) => String(v).slice(0, 80)).slice(0, 50) : [];
    return { ...s, txn_ids: ids, done: x.done === true };
  });
}

export async function GET(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sb = supabaseAdmin();
    const order = req.nextUrl.searchParams.get("order");
    if (order != null) return NextResponse.json({ ok: true, orders: await findOrders(sb, order) });
    const [records, rates] = await Promise.all([
      listCancels(sb),
      sb.from("b2b_settings").select("value").eq("key", "fulfill_rates").maybeSingle(),
    ]);
    if (rates.error) throw new Error(`박스 종류를 읽지 못했습니다: ${rates.error.message}`);
    const boxCats = normalizeBoxCats((rates.data?.value as { boxCats?: unknown } | undefined)?.boxCats).map((c) => c.name);
    return NextResponse.json({ ok: true, records: records ?? [], ready: records !== null, boxCats });
  } catch (err) {
    if (err instanceof CancelError) return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    console.error("[fulfill/cancel]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소·반품 기록을 불러오지 못했습니다") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const name = await loginName(req);
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const sb = supabaseAdmin();

    if (b.action === "apply") {
      const input = normalizeApply(b, name);
      if (input.box && !DATE_RE.test(input.box.date)) return NextResponse.json({ ok: false, error: "배송일지 날짜를 고르세요." }, { status: 400 });
      const { record, replay } = await applyCancel(sb, input);
      if (!replay) await logOrderCancel("apply", { kind: record.kind, channel: record.channel, orderId: record.order_id, qty: record.cancel_qty, amount: record.cancel_amount, cancelId: record.id }, name);
      return NextResponse.json({ ok: true, record, replay });
    }
    const id = Math.floor(Number(b.id));
    if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ ok: false, error: "취소 기록을 찾지 못했습니다." }, { status: 400 });

    if (b.action === "mark") {
      const cur = await getCancel(sb, id);
      const record = await markSteps(sb, id, {
        ...(b.box !== undefined ? { box: mergeBox(cur.box, b.box) } : {}),
        ...(b.stock !== undefined ? { stock: mergeStock(cur.stock, b.stock) } : {}),
      });
      return NextResponse.json({ ok: true, record });
    }
    if (b.action === "revert") {
      const { record, missing, replay } = await revertCancel(sb, id, name);
      if (!replay) await logOrderCancel("revert", { kind: record.kind, channel: record.channel, orderId: record.order_id, qty: record.cancel_qty, amount: record.cancel_amount, cancelId: record.id }, name);
      return NextResponse.json({ ok: true, record, missing, replay });
    }
    return NextResponse.json({ ok: false, error: "알 수 없는 요청입니다." }, { status: 400 });
  } catch (err) {
    if (err instanceof CancelError) return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    console.error("[fulfill/cancel]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소·반품을 처리하지 못했습니다") }, { status: 500 });
  }
}
