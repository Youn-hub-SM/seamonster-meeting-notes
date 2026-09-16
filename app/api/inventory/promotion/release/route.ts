import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logInventoryPoolMoved } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inventory/promotion/release — 행사 종료 자동 합류(113, 대표 확정: "행사일이 지나면 자동으로 소매로").
//  중계 서버가 매일 아침(09:00 KST) 호출. 프로모션 풀에 재고가 남아 있는 품목 중,
//  '목표일(마감일)이 오늘 이후인 프로모션 요청서'(취소 제외 — 완료돼도 행사 전이면 보류)에
//  더는 포함되지 않는 품목을 전량 프로모션→소매로 이동(사람의 이동과 같은 원장 기록·취소 가능).
//  미들웨어 예외 경로 — Bearer(카탈로그 업로드 공용 시크릿 또는 CRON_SECRET)로 인증.
const MARK = "채널이동";

function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

export async function POST(req: NextRequest) {
  try {
    if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sb = supabaseAdmin();
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

    // 1) 프로모션 풀 잔량
    const pool = await sb.rpc("inventory_stock", { asof: null, chan: "프로모션" });
    if (pool.error) {
      if (/channel/i.test(pool.error.message)) return NextResponse.json({ ok: true, released: 0, note: "113 미적용 — 프로모션 풀 없음" });
      throw pool.error;
    }
    const rows = ((pool.data as { product_id: string; qty: number }[] | null) ?? [])
      .map((r) => ({ product_id: r.product_id, qty: Math.round((Number(r.qty) || 0) * 100) / 100 }))
      .filter((r) => r.qty > 0);
    if (!rows.length) return NextResponse.json({ ok: true, released: 0 });

    // 2) 보류 판정 — '열린(요청·진행중) 프로모션 요청'이 잡은 품목은 목표일과 무관하게 보류
    //    (행사 연기 시 목표일 수정을 잊어도 확보분이 사라지지 않게 — 화면 안내 "열린 요청이 없으면 합류"와 일치).
    //    '완료' 요청은 목표일이 오늘 이후일 때만 보류(행사 전 100% 확보 상태 보호), 목표일 지난 완료는 합류.
    //    조회 실패는 무조건 throw — 1단계(풀 RPC)가 성공한 환경은 113 적용이 확정이라 폴백이 옳은 경우가 없고,
    //    조용한 폴백은 '실패 → 보호 해제(전량 합류)' 방향 사고가 된다(검증 확정).
    const held = new Set<string>();
    {
      const { data: items, error: ie } = await sb.from("production_request_items")
        .select("product_id, production_requests!inner(purpose, status, due_date)")
        .eq("production_requests.purpose", "프로모션")
        .neq("production_requests.status", "취소")
        .limit(5000);
      if (ie) throw ie;
      type Rel = { purpose?: string; status?: string; due_date?: string | null };
      for (const it of items ?? []) {
        const rel = (it as { production_requests?: Rel | Rel[] }).production_requests;
        const h = Array.isArray(rel) ? rel[0] : rel;
        if (!h) continue;
        const open = h.status === "요청" || h.status === "진행중";
        const dueFuture = !h.due_date || String(h.due_date) >= today; // 목표일 없음 = 보수적으로 보류
        if (open || dueFuture) held.add(String(it.product_id));
      }
    }
    let release = rows.filter((r) => !held.has(r.product_id));
    if (!release.length) return NextResponse.json({ ok: true, released: 0, held: held.size });

    // 2b) 멱등 가드 — 오늘 이미 자동 합류가 기록된 품목은 스킵(타임아웃 재시도·중복 호출 시 이중 이동 방지)
    {
      const { data: doneToday } = await sb.from("inventory_txns")
        .select("product_id").eq("partner", MARK).eq("memo", "행사 종료 자동 합류")
        .eq("txn_date", today).eq("channel", "프로모션").in("product_id", release.map((r) => r.product_id)).limit(2000);
      const doneSet = new Set((doneToday ?? []).map((r) => String(r.product_id)));
      release = release.filter((r) => !doneSet.has(r.product_id));
      if (!release.length) return NextResponse.json({ ok: true, released: 0, held: held.size, note: "오늘 이미 합류됨" });
    }

    // 3) 품목별 프로모션→소매 이동(각자 group — 내역·취소 규칙은 사람 이동과 동일)
    const { data: prods } = await sb.from("products").select("id, name, sku").in("id", release.map((r) => r.product_id));
    const nameById = new Map((prods ?? []).map((p) => [p.id as string, { name: String(p.name || "품목"), sku: (p.sku as string) ?? null }]));
    const done: { product_id: string; qty: number }[] = [];
    const failed: string[] = [];
    for (const r of release) {
      const base = { product_id: r.product_id, partner: MARK, memo: "행사 종료 자동 합류", group_id: randomUUID(), txn_date: today, status: "완료", created_by: "자동" };
      const { error } = await sb.from("inventory_txns").insert([
        { ...base, type: "출고", qty: -r.qty, channel: "프로모션", unit_amount: null },
        { ...base, type: "입고", qty: r.qty, channel: "소매", unit_amount: null },
      ]);
      if (error) { console.warn("[promotion/release] 이동 기록 실패:", error.message); failed.push(nameById.get(r.product_id)?.name || r.product_id); continue; }
      done.push(r);
    }
    // 전건 실패는 5xx — ok:true 로 조용히 넘어가면 크론 실패 감지에 안 걸려 풀이 계속 묶인다(검증 확정).
    //  성공분은 다음 호출에서 풀 잔량 0 이라 재시도 멱등.
    if (!done.length && failed.length) {
      return NextResponse.json({ ok: false, error: `자동 합류 전건 실패(${failed.length}건)`, failed: failed.length }, { status: 500 });
    }

    // 4) Teams 알림 — 합류 1회 = 게시물 1건
    if (done.length) {
      try {
        const lines = done.map((r) => `- ${nameById.get(r.product_id)?.name || "품목"} ×${r.qty.toLocaleString()}`);
        if (failed.length) lines.push(`(실패 ${failed.length}건: ${failed.join(", ")} — 내일 재시도)`);
        const totalQty = done.reduce((s, r) => s + r.qty, 0);
        const first = nameById.get(done[0].product_id);
        const title = done.length === 1 ? (first?.name || "품목") : `${first?.name || "품목"} 외 ${done.length - 1}종`;
        await logInventoryPoolMoved("프로모션", "소매", title, done.length === 1 ? first?.sku ?? null : null, totalQty, "행사 종료 자동 합류", "자동", lines.join("\n"));
      } catch (e) { console.warn("[promotion/release] 알림 실패", e); }
    }

    return NextResponse.json({ ok: true, released: done.length, failed: failed.length, held: held.size });
  } catch (err) {
    console.error("[promotion/release]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "자동 합류 실패") }, { status: 500 });
  }
}
