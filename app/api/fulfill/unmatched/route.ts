import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { signedQty } from "@/app/lib/inventory";
import { getAllBundles, expandBundleQty } from "@/app/lib/product-bundles";
import { getUntracked, dropUntracked } from "@/app/lib/stock-tracked";
import { fetchSkuProducts, insertTxnsWithFallback, kstToday, missingColumn, stockFixesAfter, type StockFixHit } from "@/app/lib/fulfill-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ④ 출고 때 상품마스터에 없어(또는 중복) 재고가 빠지지 않은 코드(fulfill_dispatch.unmatched, 135) — S9.
//  GET  → 미처리 목록(최근 60일) + 코드별 '지금은 등록됨' 여부.
//  POST { id, action: "record", ackCount? } → 지금 등록된 코드 수량을 그 배치 출고일(실물이 나간 날, S6)로 소매 출고 기록.
//                                  아직 미등록인 코드는 목록에 남는다. 출고일 뒤 그 품목에 소매 실사 조정이 있으면 409 countAfter 로
//                                  멈춘다(실사가 이미 빠진 수량을 반영했을 수 있다 — S8 guard). 사람이 확인하면 ackCount 로 다시.
//  POST { id, action: "done" }   → 확인 완료(기록 없이 닫기 — 그 사이 실사로 이미 맞춘 경우).
//  기록 행은 source='fulfill_unmatched'·source_ref=출고 이력 id(131) — 배치를 [입고 및 출고]에서 취소하면 함께 지워진다(135 RPC).
//  그 연결이 없으면 취소 뒤 다시 출고할 때 이중 차감되므로, 131 미적용이면 기록하지 않는다.
type Code = { sku: string; qty: number; kind?: string };
const codesOf = (v: unknown): Code[] =>
  Array.isArray(v) ? (v as Code[]).filter((c) => c && typeof c.sku === "string" && Number(c.qty) > 0).map((c) => ({ sku: c.sku, qty: Number(c.qty), kind: c.kind })) : [];

async function skuMap(sb: ReturnType<typeof supabaseAdmin>) {
  const prods = await fetchSkuProducts<{ id: string; sku: string }>(sb, "id, sku");
  const m = new Map<string, string[]>();
  for (const p of prods) { const k = String(p.sku || "").trim().toUpperCase(); if (!k) continue; m.set(k, [...(m.get(k) || []), p.id]); }
  return m;
}

export async function GET() {
  try {
    const sb = supabaseAdmin();
    const since = new Date(Date.now() + 9 * 3600e3 - 60 * 86400e3).toISOString().slice(0, 10);
    const { data, error } = await sb.from("fulfill_dispatch").select("id, dispatch_date, order_no, unmatched")
      .not("unmatched", "is", null).is("unmatched_done_at", null).gte("dispatch_date", since)
      .order("dispatch_date", { ascending: false }).range(0, 199);
    if (error) {
      if (missingColumn(error, /unmatched/i)) return NextResponse.json({ ok: true, rows: [], applied: false });
      throw error;
    }
    const list = (data ?? []) as { id: string; dispatch_date: string; order_no: string | null; unmatched: unknown }[];
    const bySku = list.length ? await skuMap(sb) : new Map<string, string[]>();
    const rows = list.map((r) => ({
      id: r.id, dispatch_date: r.dispatch_date, order_no: r.order_no,
      codes: codesOf(r.unmatched).map((c) => ({ ...c, registered: (bySku.get(c.sku.trim().toUpperCase())?.length ?? 0) === 1 })),
    })).filter((r) => r.codes.length);
    return NextResponse.json({ ok: true, applied: true, rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { id?: string; action?: string; ackCount?: boolean };
    const id = String(b.id || "");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const nowIso = new Date().toISOString();

    if (b.action === "done") {
      const { data, error } = await sb.from("fulfill_dispatch").update({ unmatched_done_at: nowIso }).eq("id", id).is("unmatched_done_at", null).select("id");
      if (error) throw error;
      if (!data?.length) return NextResponse.json({ ok: false, error: "이미 처리된 항목입니다 — 새로고침하세요." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }
    if (b.action !== "record") return NextResponse.json({ ok: false, error: "알 수 없는 동작입니다." }, { status: 400 });

    const { data: row, error: re } = await sb.from("fulfill_dispatch").select("id, dispatch_date, order_no, unmatched, unmatched_done_at, created_at").eq("id", id).maybeSingle();
    if (re) throw re;
    if (!row) return NextResponse.json({ ok: false, error: "출고 기록을 찾지 못했습니다." }, { status: 404 });
    if (row.unmatched_done_at) return NextResponse.json({ ok: false, error: "이미 처리된 항목입니다 — 새로고침하세요." }, { status: 409 });
    const codes = codesOf(row.unmatched);

    const [bySku, bundles, untracked] = await Promise.all([skuMap(sb), getAllBundles(sb), getUntracked(sb)]);
    const perProduct = new Map<string, number>();
    const remaining: Code[] = [];
    for (const c of codes) {
      const m = bySku.get(c.sku.trim().toUpperCase());
      if (!m || m.length !== 1) { remaining.push(c); continue; }
      expandBundleQty(bundles, m[0], c.qty, perProduct); // 공용 전개 규칙(S5)
    }
    if (remaining.length === codes.length) return NextResponse.json({ ok: false, error: "아직 상품마스터에 등록된 코드가 없습니다." }, { status: 400 });
    dropUntracked(perProduct, untracked);
    const txnDate = String(row.dispatch_date || kstToday()).slice(0, 10);
    const pids = [...perProduct].filter(([, q]) => q > 0).map(([pid]) => pid);

    if (pids.length) {
      // 131(source·source_ref) — 배치 취소 때 이 기록을 함께 지울 연결 칸. 없으면 기록하지 않는다.
      const probe = await sb.from("inventory_txns").select("source_ref").limit(1);
      if (probe.error) {
        if (missingColumn(probe.error, /source_ref/i)) return NextResponse.json({ ok: false, error: "migration 131 적용 후 [재고 차감 기록]을 쓸 수 있습니다 — 출고 배치를 취소할 때 이 기록도 함께 되돌리는 연결 칸이 필요합니다." }, { status: 409 });
        throw probe.error;
      }
      // 출고일 뒤 실사(소매 조정) — 실사가 이미 빠진 수량을 반영했으면 소급 차감은 이중 차감이다(S8). 조회 실패면 멈춘다(S4).
      //  출고일 이후 날짜의 조정, 또는 출고 기록 뒤에 입력된 조정(날짜를 앞당겨 넣은 실사)을 본다. 품목당 하나만 있으면 된다.
      //  공용 stockFixesAfter(fulfill-db) — 중단된 출고 이어서 차감(dispatch)과 같은 규칙, 페이지 끝까지 읽는다.
      if (!b.ackCount) {
        const sinceIso = new Date(String(row.created_at || nowIso)).toISOString();
        let found: StockFixHit[];
        try { found = await stockFixesAfter(sb, pids, txnDate, sinceIso); }
        catch (e) { return NextResponse.json({ ok: false, error: `실사 기록을 확인하지 못했습니다 — 재고는 차감하지 않았습니다. 다시 시도하세요. (${extractErrorMsg(e, "조회 실패")})` }, { status: 500 }); }
        if (found.length) {
          const list = found.map((h) => ({ name: h.name, date: h.date }));
          const shown = list.slice(0, 5).map((h) => `${h.name}(${h.date})`).join(", ") + (list.length > 5 ? ` 외 ${list.length - 5}개` : "");
          return NextResponse.json({ ok: false, countAfter: true, products: list,
            error: `출고일(${txnDate}) 뒤 실사 조정이 있는 품목: ${shown}. 실사에 이미 반영됐으면 [확인 완료]를 누르세요.` }, { status: 409 });
        }
      }
    }

    // 선점 — 동시에 두 번 눌러도 한 번만 기록(S2)
    const { data: claim, error: cle } = await sb.from("fulfill_dispatch").update({ unmatched_done_at: nowIso }).eq("id", id).is("unmatched_done_at", null).select("id");
    if (cle) throw cle;
    if (!claim?.length) return NextResponse.json({ ok: false, error: "이미 처리된 항목입니다 — 새로고침하세요." }, { status: 409 });

    const groupId = crypto.randomUUID();
    const memo = `온라인발주 미반영분 출고 (${txnDate}${row.order_no ? ` ${row.order_no}` : ""})`;
    const rows: Record<string, unknown>[] = pids.map((pid) => ({
      product_id: pid, type: "출고", qty: signedQty("출고", perProduct.get(pid) || 0), channel: "소매", status: "완료", group_id: groupId, order_no: row.order_no || null,
      partner: "온라인몰", memo, txn_date: txnDate, source: "fulfill_unmatched", source_ref: id, // 한 번만 = 위 선점(코드가 나눠 등록되면 여러 번 기록하므로 request_key 는 쓰지 않는다)
    }));
    const { error: insErr } = await insertTxnsWithFallback(sb, rows);
    if (insErr) {
      await sb.from("fulfill_dispatch").update({ unmatched_done_at: null }).eq("id", id); // 선점 되돌림
      return NextResponse.json({ ok: false, error: `재고 기록에 실패했습니다 — 다시 시도하세요. (${insErr.message})` }, { status: 500 });
    }
    if (rows.length) {
      // 그 사이 배치가 취소됐으면(출고 이력 행 삭제) 이 기록은 되돌릴 연결이 없는 출고로 남는다 — 바로 지운다(S3)
      const { data: still, error: se } = await sb.from("fulfill_dispatch").select("id").eq("id", id).maybeSingle();
      if (!se && !still) {
        await sb.from("inventory_txns").delete().eq("group_id", groupId);
        return NextResponse.json({ ok: false, error: "이 출고 배치가 방금 취소됐습니다 — 기록하지 않았습니다. 새로고침하세요." }, { status: 409 });
      }
    }
    if (remaining.length) {
      // 아직 미등록인 코드만 남겨 다시 연다 — 실패하면 그 코드가 목록에서 조용히 빠지므로 알린다(S9)
      const { error: ue } = await sb.from("fulfill_dispatch").update({ unmatched: remaining, unmatched_done_at: null }).eq("id", id);
      if (ue) return NextResponse.json({ ok: false, error: `등록된 코드는 재고에서 뺐지만 아직 미등록인 코드를 목록에 다시 남기지 못했습니다 — 적어 두세요: ${remaining.map((c) => `${c.sku} ${c.qty}개`).join(", ")}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, recorded: rows.length, qty: [...perProduct.values()].reduce((s, q) => s + q, 0), remaining });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "처리 실패") }, { status: 500 });
  }
}
