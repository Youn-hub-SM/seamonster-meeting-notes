import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { RESERVED_CHANNELS, toInvChannelParam } from "@/app/lib/inventory";
import { getUntracked } from "@/app/lib/stock-tracked";
import { getAllBundles, isBundleId } from "@/app/lib/product-bundles";
import { readStockMap } from "@/app/lib/inventory-template";
import { kstTodayIso } from "@/app/lib/production-schedule";
import { countDateError } from "../../count-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 131(request_key·source·source_ref) 미적용 — '컬럼 없음' 에러에 그 컬럼명이 보이면 빼고 다시 넣는다.
//  유니크 위반(23505, 제약명에 request_key)은 여기 걸리면 안 된다 — 키를 빼고 다시 넣으면 두 벌이 된다.
const missing131 = (e: { code?: string; message: string }) =>
  e.code !== "23505" && /request_key|source_ref|\bsource\b/i.test(e.message) && /column|schema cache/i.test(e.message);

// POST /api/inventory/adjust/import/apply { channel, count_date?, batch_key?, rows: [{product_id, target, memo?}] }
//  실사일 기준 현재고를 다시 읽어 델타(=target−current)를 재계산 후 '조정' 원장 일괄 기록(거래일 = 실사일). 델타 0은 건너뜀.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: { product_id?: string; target?: number | string; memo?: string | null }[]; channel?: string; count_date?: string; batch_key?: string };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return NextResponse.json({ ok: false, error: "반영할 행이 없습니다." }, { status: 400 });
    // 같은 품목이 두 번이면 줄마다 같은 현재고로 델타가 나와 조정이 겹쳐 기록된다 — 미리보기가 걸러 주지만 서버에서도 막는다.
    const ids = rows.map((r) => r?.product_id).filter(Boolean) as string[];
    if (new Set(ids).size !== ids.length) return NextResponse.json({ ok: false, error: "같은 품목이 두 번 이상 들어 있습니다 — 한 줄로 합쳐 다시 업로드하세요." }, { status: 400 });
    // 칸 명시 필수(S8) — 소매 폴백으로 받으면 칸을 안 고른 실사가 소매 재고를 덮어쓴다.
    const chan = toInvChannelParam(body.channel);
    if (!chan) return NextResponse.json({ ok: false, error: "실사할 칸을 고르세요." }, { status: 400 });
    const today = kstTodayIso();
    const countDate = String(body.count_date || "").trim() || today;
    const badDate = countDateError(countDate, today);
    if (badDate) return NextResponse.json({ ok: false, error: badDate }, { status: 400 });
    // 이 미리보기 한 번의 키 — 더블클릭·시간 초과 뒤 재요청이 같은 조정을 두 번 넣지 않게(S2, 131 의 request_key 유니크)
    const batchKey = typeof body.batch_key === "string" && /^[\w-]{8,64}$/.test(body.batch_key) ? body.batch_key : null;
    const cookie = req.cookies.get("b2b_auth")?.value;
    const actor = (await verifySession(cookie)) || resolveUserName(cookie);

    const sb = supabaseAdmin();
    // 이미 반영한 미리보기인지 먼저 본다(S2) — 응답이 끊긴 뒤 다시 누르면 델타를 새로 계산하는데, 첫 반영 때 델타 0 이라
    //  행이 없던 품목은 키가 없어 새로 들어가고, 그 사이 정상 기록된 입출고가 실사값으로 지워진다.
    //  131 미적용('컬럼 없음')일 때만 건너뛰고, 다른 조회 오류는 멈춘다(S4) — 못 읽었는데 새로 쓰면 두 번 반영된다.
    if (batchKey) {
      const seen = await sb.from("inventory_txns").select("id").eq("source", "adjust_import").eq("source_ref", batchKey).limit(1);
      if (seen.error && !missing131(seen.error)) throw seen.error;
      if (!seen.error && (seen.data ?? []).length)
        return NextResponse.json({ ok: true, applied: 0, invalid: 0, replay: true, note: "이미 반영된 실사입니다 — 조정 내역에서 확인하세요." });
    }
    // 델타는 '해당 채널'의 실사일(KST)까지 원장 기준으로 재계산 — 미리보기(import)와 같은 기준.
    //  asof=null 이면 발송예정일이 미래인 선점 출고까지 빠진 값이라, 실물을 적어도 선점분만큼 유령 재고가 생긴다.
    //  기록 거래일도 실사일이므로 실사일까지의 원장 합 = 실사수량, 실사일 뒤 움직임은 그 뒤에 그대로 남는다.
    //  페이지 끝까지 읽고, 일시 오류면 그대로 실패한다(4칸 합·0 으로 델타를 만들면 틀린 조정이 원장에 남는다).
    const [stock, untracked, bundles] = await Promise.all([
      readStockMap(sb, { asof: countDate, chan }),
      getUntracked(sb), // 재고 관리 사용 안함(121) — 미리보기에서 이미 빠지지만 방어
      getAllBundles(sb), // 세트는 자체 재고가 없다 — 미리보기에서 이미 오류로 빠지지만 방어(조회 오류는 던진다)
    ]);

    const insert: Record<string, unknown>[] = [];
    const targets = new Map<string, number>();
    let invalid = 0; // 실사수량이 숫자가 아닌 행 — 0 으로 쓰지 않고 건너뛴 뒤 응답에 알린다
    for (const r of rows) {
      if (!r || !r.product_id || r.target == null) continue;
      if (untracked.ids.has(r.product_id) || isBundleId(bundles, r.product_id)) continue;
      // 엄격 파싱 — Number("") 은 0 이라 빈 문자열이 '0 개' 조정으로 둔갑한다. 숫자거나 비어 있지 않은 숫자 문자열만 받는다.
      const raw = typeof r.target === "string" ? r.target.trim() : r.target;
      const target = raw === "" ? Number.NaN : Math.round(Number(raw) * 100) / 100;
      if (!Number.isFinite(target) || target < 0) { invalid++; continue; }
      const delta = Math.round((target - (stock.get(r.product_id) || 0)) * 100) / 100;
      if (delta === 0) continue;
      targets.set(r.product_id, target);
      insert.push({
        product_id: r.product_id, type: "조정", channel: chan, qty: delta, txn_date: countDate,
        memo: (r.memo ? String(r.memo).slice(0, 500) : `엑셀 실사(${chan} ${countDate})`), created_by: actor,
        source: "adjust_import", source_ref: batchKey,
        request_key: batchKey ? `adjust_import:${batchKey}:${chan}:${r.product_id}` : null,
      });
    }
    if (!insert.length) return NextResponse.json({ ok: true, applied: 0, invalid, note: "변경할 재고가 없습니다(현재고와 실사수량 동일)." });

    let ins = await sb.from("inventory_txns").insert(insert);
    if (ins.error && missing131(ins.error)) {
      for (const r of insert) { delete r.request_key; delete r.source; delete r.source_ref; }
      ins = await sb.from("inventory_txns").insert(insert);
    }
    // 같은 미리보기를 이미 반영함(동시 더블클릭 등) — 한 행이라도 키가 겹치면 묶음 전체가 거절되므로 두 벌이 생기지 않는다
    if (ins.error && ins.error.code === "23505" && /request_key/i.test(`${ins.error.message} ${ins.error.details ?? ""}`))
      return NextResponse.json({ ok: true, applied: 0, invalid, replay: true, note: "이미 반영된 실사입니다 — 조정 내역에서 확인하세요." });
    if (ins.error && RESERVED_CHANNELS.includes(chan) && /channel_chk|check constraint/i.test(ins.error.message))
      return NextResponse.json({ ok: false, error: `${chan} 칸이 아직 없습니다 — migration ${chan === "프로모션" ? "113" : "115"} 을 먼저 적용하세요.` }, { status: 500 });
    if (ins.error && /channel/i.test(ins.error.message)) { for (const r of insert) delete r.channel; ins = await sb.from("inventory_txns").insert(insert); }
    if (ins.error) throw ins.error;

    // 반영 직후 실사일 재고가 실사수량과 같은지 다시 본다(S12) — 다른 사람·탭의 실사가 같은 순간 들어오면
    //  둘 다 같은 현재고로 델타를 만들어 조정이 겹친다. 고치지 않고 품목을 알려 사람이 다시 확인하게 한다.
    let mismatch: { product_id: string; target: number; actual: number }[] = [];
    try {
      const after = await readStockMap(sb, { asof: countDate, chan });
      mismatch = [...targets].filter(([pid, t]) => Math.abs((after.get(pid) || 0) - t) > 0.001).map(([pid, t]) => ({ product_id: pid, target: t, actual: after.get(pid) || 0 }));
    } catch { /* 확인 조회 실패 — 반영은 끝났으므로 성공으로 돌려준다 */ }
    return NextResponse.json({ ok: true, applied: insert.length, invalid, mismatch });
  } catch (err) {
    console.error("[inventory/adjust/import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조정 반영 실패") }, { status: 500 });
  }
}
