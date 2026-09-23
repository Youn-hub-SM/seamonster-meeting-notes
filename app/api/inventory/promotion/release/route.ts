import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { logInventoryPoolMoved, logProductionRequestStatusChanged } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inventory/promotion/release — 프로모션 풀 자동 합류(113).
//  시점 = **행사 시작(목표일) 하루 전 아침**(2026-09-23 대표 지시 — H-24 엔 행사 준비가 끝나 있어야 한다.
//  행사 판매는 소매에서 나가므로 시작 전에 재고가 소매에 가 있어야 한다. 종전: 목표일 지난 다음날).
//  중계 서버가 매일 아침(09:00 KST) 호출 — 운영(main)에서만 돈다. 그날 하는 일 두 가지:
//   ① 목표일이 내일(이하)인 열린 프로모션 요청서를 자동 완료로 닫는다 — 이동 화면 배정 목록에서 빠지고,
//      그 다음 입고분은 옮길 곳 없이 소매에 그대로 남는다(대표: "그 다음 입고건부터는 소매로 바로").
//   ② 잡는 요청서(비취소·목표일 모레 이후 또는 목표일 없음)가 더는 없는 품목의 풀 잔량을
//      전량 프로모션→소매로 이동(사람의 이동과 같은 원장 기록·취소 가능).
//  메모 문자열 '행사 종료 자동 합류'는 옛 이름이지만 멱등 가드·기존 원장과의 호환을 위해 그대로 둔다.
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
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10); // KST 내일 = 행사 하루 전 판정 기준

    // 1) 프로모션 풀 잔량 — 마감(2a)·겹침 경고·합류가 모두 쓴다. 풀이 비어도 마감은 해야 하므로
    //    빈 풀의 이른 반환은 마감 뒤로 미룬다.
    const pool = await sb.rpc("inventory_stock", { asof: null, chan: "프로모션" });
    if (pool.error) {
      if (/channel/i.test(pool.error.message)) return NextResponse.json({ ok: true, released: 0, closed: 0, note: "113 미적용 — 프로모션 풀 없음" });
      throw pool.error;
    }
    const rows = ((pool.data as { product_id: string; qty: number }[] | null) ?? [])
      .map((r) => ({ product_id: r.product_id, qty: Math.round((Number(r.qty) || 0) * 100) / 100 }))
      .filter((r) => r.qty > 0);
    const poolQty = new Map(rows.map((r) => [r.product_id, r.qty]));

    // 2) 보류 판정(2026-09-23 개정) — 잡는 힘 = '목표일이 모레 이후(또는 목표일 없음)인 비취소 프로모션 요청'.
    //    목표일이 내일(이하)인 요청은 아래 2a 가 닫는다 — 상태 구분이 더는 필요 없다
    //    (2a 마감이 실패한 열린 요청도 날짜 기준으로 합류 — 행사 하루 전엔 무조건 소매에 있어야 한다).
    //    목표일 없는 요청은 보수적으로 보류(행사 연기 시 목표일 수정을 잊어도 확보분이 사라지지 않게).
    //    조회 실패는 무조건 throw — 1단계(풀 RPC)가 성공한 환경은 113 적용이 확정이라 폴백이 옳은 경우가 없고,
    //    조용한 폴백은 '실패 → 보호 해제(전량 합류)' 방향 사고가 된다(검증 확정).
    //    잡는 조건(목표일 없음 또는 모레 이후)을 SQL 로 내려보내 과거 행사 품목행 누적을 배제하고,
    //    range 페이징으로 전량 읽는다 — 서버 Max Rows(기본 1000)가 .limit 보다 우선해 조용히 잘리면
    //    미래 행사 품목이 보류에서 빠져 조기 합류되는 '보호 해제' 방향 사고가 된다(리뷰 확정).
    const held = new Set<string>();
    {
      type Rel = { purpose?: string; status?: string; due_date?: string | null };
      for (let off = 0; off < 20000; off += 1000) {
        const { data: items, error: ie } = await sb.from("production_request_items")
          .select("product_id, production_requests!inner(purpose, status, due_date)")
          .eq("production_requests.purpose", "프로모션")
          .neq("production_requests.status", "취소")
          .or(`due_date.is.null,due_date.gt.${tomorrow}`, { referencedTable: "production_requests" })
          .order("id", { ascending: true })
          .range(off, off + 999);
        if (ie) throw ie;
        const rows2 = (items ?? []) as { product_id: string; production_requests?: Rel | Rel[] }[];
        for (const it of rows2) {
          const rel = it.production_requests;
          const h = Array.isArray(rel) ? rel[0] : rel;
          if (!h) continue;
          const dueLater = !h.due_date || String(h.due_date) > tomorrow; // SQL 필터와 동일 — 이중 확인
          if (dueLater) held.add(String(it.product_id));
        }
        if (rows2.length < 1000) break;
      }
    }
    // 2a) 행사 하루 전 요청서 자동 마감(2026-09-23 대표 지시) — 목표일이 내일(이하)인 열린 프로모션
    //    요청서를 완료로 닫는다. 이행률과 무관(문을 닫는 게 목적). 닫힌 요청서의 품목이 다른 미래
    //    요청서에 묶여 오늘 합류하지 못하면 마감 알림 본문에 경고를 남긴다(리뷰 확정 — 이번 주 행사가
    //    확보분 없이 치러질 수 있는데 조용히 넘기면 사람이 알 길이 없다).
    //    113 미적용(purpose 없음)이면 1단계 풀 RPC 가 어차피 빈손이라 여기 오류는 조용히 넘긴다.
    let closed = 0;
    try {
      const { data: dueReqs } = await sb.from("production_requests")
        .select("id, req_no, status")
        .eq("purpose", "프로모션").in("status", ["요청", "진행중"])
        .not("due_date", "is", null).lte("due_date", tomorrow).limit(200);
      for (const r of dueReqs ?? []) {
        const { data: flipped, error: ue } = await sb.from("production_requests")
          .update({ status: "완료", updated_at: new Date().toISOString() })
          .eq("id", r.id).in("status", ["요청", "진행중"]).select("id"); // 경합 시 한 번만 전환
        if (ue || !flipped?.length) continue;
        closed++;
        let detail: string | undefined;
        try {
          const { data: its } = await sb.from("production_request_items").select("product_id").eq("request_id", r.id).limit(500);
          const stuck = [...new Set((its ?? []).map((x) => String(x.product_id)))]
            .filter((pid) => held.has(pid) && (poolQty.get(pid) || 0) > 0);
          if (stuck.length) {
            const { data: ps } = await sb.from("products").select("id, name").in("id", stuck).limit(500);
            const nm = new Map((ps ?? []).map((pr) => [String(pr.id), String(pr.name || "품목")]));
            detail = [
              "주의 — 확보분이 소매로 합류하지 않은 품목(다음 행사 요청서가 잡고 있음):",
              ...stuck.map((pid) => `- ${nm.get(pid) || pid} ×${(poolQty.get(pid) || 0).toLocaleString()}`),
              "이번 행사에 쓰려면 '재고 옮기기'에서 프로모션 → 소매 로 직접 옮기세요.",
            ].join("\n");
          }
        } catch { /* 경고 없이 마감 */ }
        try { await logProductionRequestStatusChanged(String(r.req_no || ""), String(r.status), "완료", "행사 하루 전 자동 마감", detail); } catch { /* 알림 실패는 마감을 막지 않는다 */ }
      }
    } catch { /* 조회 실패 — 마감 없이 합류로 진행(다음 날 재시도) */ }

    if (!rows.length) return NextResponse.json({ ok: true, released: 0, closed });
    let release = rows.filter((r) => !held.has(r.product_id));
    if (!release.length) return NextResponse.json({ ok: true, released: 0, closed, held: held.size });

    // 2b) 멱등 가드 — 오늘 이미 자동 합류가 기록된 품목은 스킵(타임아웃 재시도·중복 호출 시 이중 이동 방지)
    {
      const { data: doneToday } = await sb.from("inventory_txns")
        .select("product_id").eq("partner", MARK).eq("memo", "행사 종료 자동 합류")
        .eq("txn_date", today).eq("channel", "프로모션").in("product_id", release.map((r) => r.product_id)).limit(2000);
      const doneSet = new Set((doneToday ?? []).map((r) => String(r.product_id)));
      release = release.filter((r) => !doneSet.has(r.product_id));
      if (!release.length) return NextResponse.json({ ok: true, released: 0, closed, held: held.size, note: "오늘 이미 합류됨" });
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
        await logInventoryPoolMoved("프로모션", "소매", title, done.length === 1 ? first?.sku ?? null : null, totalQty, "행사 하루 전 자동 합류", "자동", lines.join("\n"));
      } catch (e) { console.warn("[promotion/release] 알림 실패", e); }
    }

    return NextResponse.json({ ok: true, released: done.length, closed, failed: failed.length, held: held.size });
  } catch (err) {
    console.error("[promotion/release]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "자동 합류 실패") }, { status: 500 });
  }
}
