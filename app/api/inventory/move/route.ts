import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logInventoryMovedToWholesale } from "@/app/lib/b2b-activity";
import { validateManualAllocations, applyManualAllocations, recheckRequestCompletion, getRequestFullness, type ManualAlloc } from "@/app/lib/production-allocate";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHANNELS = ["도매", "소매"] as const;
const MARK = "채널이동"; // partner 필드에 마커로 넣어 이동 내역을 구분·조회

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// GET ?limit= — 최근 옮긴 내역(그룹 단위)
export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 50));
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("inventory_txns")
      .select("id, product_id, type, qty, channel, txn_date, memo, group_id, created_at, created_by, products:product_id(name, sku)")
      .eq("partner", MARK)
      .order("created_at", { ascending: false })
      .limit(limit * 2); // 이동 1건 = 출고+입고 2행
    if (error) throw error;

    // group_id 로 짝지어 이동 1건으로 합침
    type Leg = { id: string; product_id: string; type: string; qty: number; channel: string; txn_date: string; memo: string | null; group_id: string | null; created_at: string; created_by: string | null; products: { name?: string; sku?: string | null } | { name?: string; sku?: string | null }[] | null };
    const byGroup = new Map<string, Leg[]>();
    for (const r of (data as unknown as Leg[]) ?? []) {
      const k = r.group_id || r.id;
      byGroup.set(k, [...(byGroup.get(k) || []), r]);
    }
    const moves = [...byGroup.entries()].map(([group_id, legs]) => {
      const out = legs.find((l) => l.type === "출고");
      const inn = legs.find((l) => l.type === "입고");
      const p = (inn || out)?.products;
      const prod = Array.isArray(p) ? p[0] : p;
      return {
        group_id,
        in_id: inn?.id || null, // 배정 요약 조회용(응답 전 제거)
        product_name: prod?.name || "(품목?)",
        sku: prod?.sku || null,
        qty: Math.abs(Number((inn || out)?.qty) || 0),
        from: out?.channel || "?",
        to: inn?.channel || "?",
        txn_date: (inn || out)?.txn_date || "",
        memo: (inn || out)?.memo || null,
        created_at: (inn || out)?.created_at || "",
        created_by: (inn || out)?.created_by || null,
        complete: !!(out && inn),
        alloc_qty: 0,
        alloc_reqs: [] as string[],
      };
    }).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);

    // 배정 요약 — 이동의 도매 입고편에 연결된 요청서 배정(수량 합 + 요청번호). 실패해도 목록은 낸다.
    try {
      const inIds = moves.map((m) => m.in_id).filter((v): v is string => !!v);
      if (inIds.length) {
        const { data: rcs } = await sb.from("production_receipts")
          .select("inv_txn_id, qty, request_id").in("inv_txn_id", inIds).limit(5000);
        const reqIds = [...new Set((rcs ?? []).map((r) => r.request_id as string).filter(Boolean))];
        const noById = new Map<string, string>();
        if (reqIds.length) {
          const { data: heads } = await sb.from("production_requests").select("id, req_no").in("id", reqIds);
          for (const h of heads ?? []) noById.set(h.id as string, (h.req_no as string) || "");
        }
        const byTxn = new Map<string, { qty: number; reqs: Set<string> }>();
        for (const r of rcs ?? []) {
          const k = r.inv_txn_id as string;
          const cur = byTxn.get(k) || { qty: 0, reqs: new Set<string>() };
          cur.qty += Number(r.qty) || 0;
          const no = noById.get(r.request_id as string);
          if (no) cur.reqs.add(no);
          byTxn.set(k, cur);
        }
        for (const m of moves) {
          const s = m.in_id ? byTxn.get(m.in_id) : undefined;
          if (s) { m.alloc_qty = Math.round(s.qty * 100) / 100; m.alloc_reqs = [...s.reqs]; }
        }
      }
    } catch { /* 요약 없이 진행 */ }

    return NextResponse.json({ ok: true, moves: moves.map(({ in_id: _drop, ...m }) => m) });
  } catch (err) {
    console.error("[inventory/move GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { product_id, from, to, qty, txn_date?, memo? } — 한 품목을 from채널 재고 → to채널 재고로 이동.
//  출고(from, −) + 입고(to, +) 두 행을 같은 group_id 로 묶어 한 번에 기록(원자적, 취소 시 함께 삭제).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const product_id = String(b.product_id || "");
    const from = String(b.from || "");
    const to = String(b.to || "");
    const qty = Math.round((Number(b.qty) || 0) * 100) / 100;
    if (!product_id) return NextResponse.json({ ok: false, error: "품목을 선택하세요." }, { status: 400 });
    if (!CHANNELS.includes(from as never) || !CHANNELS.includes(to as never)) return NextResponse.json({ ok: false, error: "채널이 올바르지 않습니다." }, { status: 400 });
    if (from === to) return NextResponse.json({ ok: false, error: "옮길 채널이 서로 달라야 합니다." }, { status: 400 });
    if (qty <= 0) return NextResponse.json({ ok: false, error: "옮길 수량을 입력하세요." }, { status: 400 });

    const txn_date = DATE_RE.test(String(b.txn_date || "")) ? String(b.txn_date) : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const memo = String(b.memo || "").trim() || null;
    const group_id = crypto.randomUUID();
    const created_by = await actor(req);
    const base = { product_id, partner: MARK, memo, group_id, txn_date, status: "완료", created_by };

    const sb = supabaseAdmin();

    // 요청서 수동 배정(2026-09-14) — 소매→도매에서만. 합계는 이동 수량 이하(잔여=기타).
    //  이동(원장) 기록 전에 검증해 잘못된 배정이면 이동 자체를 거부한다.
    const rawAllocs = Array.isArray(b.allocations) ? (b.allocations as Record<string, unknown>[]) : [];
    const allocations: ManualAlloc[] = rawAllocs
      .map((a) => ({ item_id: String(a.item_id || ""), qty: Math.round((Number(a.qty) || 0) * 100) / 100 }))
      .filter((a) => a.item_id && a.qty > 0);
    if (allocations.length) {
      if (!(from === "소매" && to === "도매"))
        return NextResponse.json({ ok: false, error: "요청서 배정은 소매 → 도매 이동에서만 가능합니다." }, { status: 400 });
      const allocSum = Math.round(allocations.reduce((s, a) => s + a.qty, 0) * 100) / 100;
      if (allocSum > qty + 0.001)
        return NextResponse.json({ ok: false, error: `배정 합계(${allocSum})가 이동 수량(${qty})보다 많습니다.` }, { status: 400 });
      const v = await validateManualAllocations(sb, product_id, allocations);
      if (!v.ok) return NextResponse.json({ ok: false, error: v.error || "배정 검증 실패" }, { status: 400 });
    }
    const { data, error } = await sb.from("inventory_txns").insert([
      { ...base, type: "출고", qty: -qty, channel: from, unit_amount: null },
      { ...base, type: "입고", qty: qty, channel: to, unit_amount: null },
    ]).select("id, type, qty, txn_date");
    if (error) {
      if (/channel/i.test(error.message)) return NextResponse.json({ ok: false, error: "채널 컬럼이 없습니다 — migration 036 을 먼저 적용하세요." }, { status: 500 });
      throw error;
    }

    // 소매→도매 이전 = '도매 납품' 요청의 이행 — 담당자가 지정한 요청서에만 배정(2026-09-14 대표 확정,
    //  종전 FIFO 자동 매칭 폐지 — 배정 안 하면 기타 100%). 100% 도달 요청은 자동 완료.
    //  이전 취소는 이 화면의 '취소'(group 삭제) → cascade(083)로 배정도 함께 원복.
    //  배정·알림 실패는 이동을 되돌리지 않고 경고로 응답(이동이 원장 — 이미 기록됨).
    const warnings: string[] = [];
    if (from === "소매" && to === "도매") {
      if (allocations.length) {
        try {
          const inLeg = (data ?? []).find((t) => t.type === "입고" && Number(t.qty) > 0);
          if (inLeg) {
            const r = await applyManualAllocations(sb, {
              inv_txn_id: inLeg.id as string, product_id, receipt_date: txn_date,
              allocations, actor: created_by,
            });
            warnings.push(...r.warnings);
            if (r.requestIds.length) await recheckRequestCompletion(sb, r.requestIds, "요청서 배정");
          }
        } catch (e) {
          console.warn("[inventory/move] 요청서 배정 실패", e);
          warnings.push("요청서 배정 기록에 실패했습니다 — 이동은 저장됐으니 취소 후 다시 시도하세요.");
        }
      }
      try {
        const { data: prod } = await sb.from("products").select("name, sku").eq("id", product_id).maybeSingle();
        await logInventoryMovedToWholesale(prod?.name || "품목", (prod?.sku as string) ?? null, qty, memo, created_by);
      } catch (e) { console.warn("[inventory/move] 이전 알림 실패", e); }
    }

    return NextResponse.json({ ok: true, group_id, count: data?.length ?? 0, warnings });
  } catch (err) {
    console.error("[inventory/move POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "이동 실패") }, { status: 500 });
  }
}

// DELETE ?group_id= — 이동 취소(양쪽 채널 원복). 마커가 채널이동인 행만 삭제.
//  배정된 요청서는 cascade(083)로 증거가 함께 지워진다 — 그 취소로 100% 아래로 내려간
//  자동 완료 요청은 다시 '진행중'으로 재개해 종합에 재등장시킨다.
export async function DELETE(req: NextRequest) {
  try {
    const group_id = req.nextUrl.searchParams.get("group_id");
    if (!group_id) return NextResponse.json({ ok: false, error: "group_id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();

    // cascade 로 사라지기 전에 영향 요청 수집 — 조회가 실패하면 취소 자체를 중단(fail-closed).
    //  여기서 삭제만 진행되면 '이행률은 내려갔는데 상태는 완료'로 굳고 재판정할 트리거가 없다(검증 확정).
    let affected: string[] = [];
    {
      const { data: txns, error: te } = await sb.from("inventory_txns").select("id").eq("group_id", group_id).eq("partner", MARK);
      if (te) return NextResponse.json({ ok: false, error: "취소 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
      const ids = (txns ?? []).map((t) => t.id as string);
      if (ids.length) {
        const { data: rcs, error: re } = await sb.from("production_receipts").select("request_id").in("inv_txn_id", ids).limit(2000);
        if (re) return NextResponse.json({ ok: false, error: "취소 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
        affected = [...new Set((rcs ?? []).map((r) => r.request_id as string).filter(Boolean))];
      }
    }

    // 재개 대상 = '삭제 전에 이행 100%였던' 요청만 — 사람이 미달인 채 수동 완료한 요청은 건드리지 않는다.
    //  (getRequestFullness 가 도매 납품 아닌 요청·판정 불가 건은 null 로 걸러준다)
    const reopenIds: string[] = [];
    for (const rid of affected) {
      const f = await getRequestFullness(sb, rid);
      if (f?.full) reopenIds.push(rid);
    }

    const { error } = await sb.from("inventory_txns").delete().eq("group_id", group_id).eq("partner", MARK);
    if (error) throw error;

    if (reopenIds.length) {
      try { await recheckRequestCompletion(sb, reopenIds, "이동 취소", "reopen"); }
      catch (e) { console.warn("[inventory/move] 취소 후 재판정 실패", e); }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/move DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
