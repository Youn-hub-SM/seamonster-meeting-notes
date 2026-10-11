import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { loadRequests } from "@/app/lib/wholesale-production-db";
import { isFactoryPurpose } from "@/app/lib/wholesale-production";
import { logProductionRequestUpdated } from "@/app/lib/b2b-activity";
import { allocateReceiptsToRequest, deferNotify, getRequestFullness, linkedQtyByTxn, recheckRequestCompletion } from "@/app/lib/production-allocate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

// 입고 ↔ 제조사 요청서 연결 고치기(2026-10-11 원장 점검 S11·S9) — 실물 입고 원장은 건드리지 않고 연결(production_receipts)만 바꾼다.
//  · GET  — 이 요청서 품목의 '연결 안 된' 소매 입고 후보(요청일·생산시작일 30일 전부터). '연결 안 함'으로 저장된 조기 납품,
//           연결 실패 줄, 대기 → 입고처리된 입고를 여기서 붙인다. 수요일 초안 전 주간 점검 절차의 화면.
//  · POST { inv_txn_ids } — 고른 입고를 이 요청서에 연결. 원장 건별 기연결을 모든 요청서에 걸쳐 보고 남은 양만 붙인다(정확히 한 번).
//  · DELETE ?rid= — 연결만 해제(원장은 그대로 = 재고 그대로). 해제로 100% 아래가 되면 자동 완료였던 요청서는 다시 열린다.
//  원장을 지우고 다시 기록하던 옛 방법(재고가 그 사이 줄고, 재기록 누락·날짜 틀림 위험)을 대신한다.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARK = "채널이동";
const r2 = (n: number) => Math.round(n * 100) / 100;

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

type Txn = {
  id: string; product_id: string; qty: unknown; type: string; txn_date: string; partner?: string | null; memo?: string | null;
  order_no?: string | null; status?: string | null; channel?: string | null; shipment_id?: string | null; reason?: string | null; source?: string | null;
};
// 연결할 수 있는 입고 — 소매 칸 완료 입고, 이동·B2B 선점·고객 반품 아님(데이터 칸으로 판정)
function linkable(t: Txn): string | null {
  if (t.type !== "입고") return "입고가 아닙니다";
  if ((t.status ?? "완료") !== "완료") return "대기 중인 입고입니다 — 입고처리 후 연결하세요";
  if ((t.channel ?? "소매") !== "소매") return "소매 칸 입고가 아닙니다";
  if (t.partner === MARK || t.source === "move" || t.source === "promo_close") return "재고 이동 기록입니다";
  if (t.shipment_id) return "B2B 발송 기록입니다";
  if (t.reason === "고객 반품" || t.source === "customer_return") return "고객 반품 입고입니다";
  if (!(r2(Number(t.qty) || 0) > 0)) return "수량이 없습니다";
  return null;
}

async function loadHead(sb: ReturnType<typeof supabaseAdmin>, id: string) {
  let r = await sb.from("production_requests").select("id, req_no, status, purpose, request_date, prod_start").eq("id", id).maybeSingle();
  if (r.error && /prod_start/i.test(r.error.message)) r = await sb.from("production_requests").select("id, req_no, status, purpose, request_date").eq("id", id).maybeSingle();
  if (r.error && /purpose/i.test(r.error.message)) r = await sb.from("production_requests").select("id, req_no, status, request_date").eq("id", id).maybeSingle();
  if (r.error) throw r.error;
  return r.data as { id: string; req_no: string | null; status: string; purpose?: string | null; request_date: string; prod_start?: string | null } | null;
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const head = await loadHead(sb, id);
    if (!head) return NextResponse.json({ ok: false, error: "요청서를 찾을 수 없습니다." }, { status: 404 });
    if (!isFactoryPurpose(head.purpose)) return NextResponse.json({ ok: false, error: "제조사 요청서만 입고를 연결합니다." }, { status: 400 });

    const { data: its, error: ie } = await sb.from("production_request_items").select("product_id").eq("request_id", id).limit(2000);
    if (ie) throw ie;
    const pids = [...new Set((its ?? []).map((x) => String(x.product_id)))];
    if (!pids.length) return NextResponse.json({ ok: true, candidates: [] });
    const startIso = [head.request_date, head.prod_start].filter((d): d is string => !!d).sort()[0] || head.request_date;
    const from = new Date(Date.parse(`${startIso}T00:00:00Z`) - 30 * 864e5).toISOString().slice(0, 10);

    // 후보 원장 — 품목 100개씩, range 페이징 전량. 조회 오류는 그대로 실패(빈 후보로 보이면 '연결할 것 없음'으로 오독한다)
    const rows: Txn[] = [];
    for (let i = 0; i < pids.length; i += 100) {
      for (let off = 0; ; off += 1000) {
        const { data, error } = await sb.from("inventory_txns").select("*") // * = 선택 칸(035·099·131) 미적용에도 안전
          .eq("type", "입고").in("product_id", pids.slice(i, i + 100)).gte("txn_date", from).gt("qty", 0)
          .order("id", { ascending: true }).range(off, off + 999);
        if (error) throw error;
        rows.push(...((data ?? []) as Txn[]));
        if ((data ?? []).length < 1000) break;
      }
    }
    const ok = rows.filter((t) => !linkable(t));
    const linked = await linkedQtyByTxn(sb, ok.map((t) => t.id));
    if (!linked) return NextResponse.json({ ok: false, error: "기존 연결을 확인하지 못했습니다 — 잠시 뒤 다시 시도하세요." }, { status: 503 });
    const { data: ps } = await sb.from("products").select("id, name, sku, spec").in("id", pids);
    const pinfo = new Map((ps ?? []).map((p) => [String(p.id), p as { name?: string; sku?: string | null; spec?: string | null }]));
    const candidates = ok
      .map((t) => {
        const qty = r2(Number(t.qty) || 0);
        const left = r2(qty - (linked.get(t.id)?.qty || 0));
        const p = pinfo.get(t.product_id);
        return {
          id: t.id, product_id: t.product_id, name: p?.spec ? `${p.name} ${p.spec}` : (p?.name ?? "(삭제된 품목)"), sku: p?.sku ?? null,
          qty, left, txn_date: t.txn_date, partner: t.partner ?? null, memo: t.memo ?? null, order_no: t.order_no ?? null,
        };
      })
      .filter((c) => c.left > 0)
      .sort((a, b) => b.txn_date.localeCompare(a.txn_date) || a.name.localeCompare(b.name, "ko"));
    return NextResponse.json({ ok: true, candidates, from });
  } catch (err) {
    console.error("[production/requests link GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "연결 후보 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const b = (await req.json()) as { inv_txn_ids?: unknown };
    const ids = [...new Set((Array.isArray(b.inv_txn_ids) ? b.inv_txn_ids : []).map(String).filter((x) => UUID_RE.test(x)))];
    if (!ids.length) return NextResponse.json({ ok: false, error: "연결할 입고를 고르세요." }, { status: 400 });
    if (ids.length > 300) return NextResponse.json({ ok: false, error: "한 번에 300건까지 연결할 수 있습니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const rows: Txn[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("inventory_txns").select("*").in("id", ids.slice(i, i + 100));
      if (error) throw error;
      rows.push(...((data ?? []) as Txn[]));
    }
    if (rows.length !== ids.length) return NextResponse.json({ ok: false, error: "고른 입고 중 일부가 그사이 취소됐습니다 — 새로고침 후 다시 고르세요." }, { status: 409 });
    const bad = rows.map((t) => ({ t, why: linkable(t) })).filter((x) => x.why);
    if (bad.length) return NextResponse.json({ ok: false, error: `연결할 수 없는 기록이 있습니다: ${bad.slice(0, 3).map((x) => `${x.t.txn_date} ${x.why}`).join(", ")}` }, { status: 400 });

    const link = await allocateReceiptsToRequest(sb, id,
      rows.map((t) => ({ inv_txn_id: t.id, product_id: t.product_id, qty: Number(t.qty), receipt_date: t.txn_date || undefined })),
      await actor(req));
    if (!link.ok) return NextResponse.json({ ok: false, error: link.reason || "연결하지 못했습니다.", link }, { status: 400 });
    const [row] = await loadRequests(sb, { id });
    return NextResponse.json({ ok: true, link, request: row });
  } catch (err) {
    console.error("[production/requests link POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "입고 연결 실패") }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const rid = req.nextUrl.searchParams.get("rid") || "";
    if (!UUID_RE.test(rid)) return NextResponse.json({ ok: false, error: "연결 id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const head = await loadHead(sb, id);
    if (!head) return NextResponse.json({ ok: false, error: "요청서를 찾을 수 없습니다." }, { status: 404 });
    if (!isFactoryPurpose(head.purpose))
      return NextResponse.json({ ok: false, error: "제조사 요청서의 입고 연결만 해제합니다 — 이동 배정은 [재고 이동] 최근 내역에서 취소하세요." }, { status: 400 });
    const { data: rc, error: re } = await sb.from("production_receipts")
      .select("id, request_id, qty, inv_txn_id, production_request_items(products(name))").eq("id", rid).maybeSingle();
    if (re) throw re;
    if (!rc || String(rc.request_id) !== id) return NextResponse.json({ ok: false, error: "연결 기록을 찾을 수 없습니다 — 새로고침하세요." }, { status: 404 });
    if (!rc.inv_txn_id) return NextResponse.json({ ok: false, error: "원장과 연결된 기록이 아닙니다 — 입고 이력의 [취소]를 쓰세요." }, { status: 400 });

    // 해제 전 100% 완료였던 요청서만 해제 뒤 다시 연다(사람이 미달인 채 마감한 요청서는 그대로). 판독 실패면 해제하지 않는다.
    const fullBefore = await getRequestFullness(sb, id);
    if (!fullBefore) return NextResponse.json({ ok: false, error: "해제 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 503 });
    const { data: del, error: de } = await sb.from("production_receipts").delete().eq("id", rid).eq("request_id", id).select("id");
    if (de) throw de;
    if (!(del ?? []).length) return NextResponse.json({ ok: false, error: "이미 해제됐습니다 — 새로고침하세요." }, { status: 409 });
    if (fullBefore.full && fullBefore.status === "완료") { try { await recheckRequestCompletion(sb, [id], "입고 연결 해제", "reopen"); } catch { /* 재개 실패는 해제를 막지 않는다 */ } }

    type RcRel = { production_request_items?: { products?: { name?: string } | { name?: string }[] | null } | { products?: { name?: string } | { name?: string }[] | null }[] | null };
    const rel = (rc as RcRel).production_request_items;
    const item0 = Array.isArray(rel) ? rel[0] : rel;
    const pr = item0?.products;
    const itemName = (Array.isArray(pr) ? pr[0]?.name : pr?.name) || "품목";
    const who = await actor(req);
    const qty = Number(rc.qty) || 0;
    deferNotify(() => logProductionRequestUpdated(head.req_no || "", who, `입고 연결 해제 · ${itemName} ×${qty.toLocaleString()} — 재고 원장은 그대로`));
    const [row] = await loadRequests(sb, { id });
    return NextResponse.json({ ok: true, request: row });
  } catch (err) {
    console.error("[production/requests link DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "연결 해제 실패") }, { status: 500 });
  }
}
