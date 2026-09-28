import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { RESERVED_CHANNELS, toInvChannel } from "@/app/lib/inventory";
import { getUntracked } from "@/app/lib/stock-tracked";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inventory/adjust/import/apply { rows: [{product_id, target, memo?}] }
//  현재고를 다시 확인해 델타(=target−current)를 재계산 후 '조정' 원장 일괄 기록. 델타 0은 건너뜀.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: { product_id?: string; target?: number | string; memo?: string | null }[]; channel?: string };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return NextResponse.json({ ok: false, error: "반영할 행이 없습니다." }, { status: 400 });
    // 같은 품목이 두 번이면 줄마다 같은 현재고로 델타가 나와 조정이 겹쳐 기록된다 — 미리보기가 걸러 주지만 서버에서도 막는다.
    const ids = rows.map((r) => r?.product_id).filter(Boolean) as string[];
    if (new Set(ids).size !== ids.length) return NextResponse.json({ ok: false, error: "같은 품목이 두 번 이상 들어 있습니다 — 한 줄로 합쳐 다시 업로드하세요." }, { status: 400 });
    const chan = toInvChannel(body.channel); // 실사 대상 채널(036·113·115, 기본 소매) — 조정은 네 칸 모두 허용
    const cookie = req.cookies.get("b2b_auth")?.value;
    const actor = (await verifySession(cookie)) || resolveUserName(cookie);

    const sb = supabaseAdmin();
    // 델타는 '해당 채널'의 오늘(KST)까지 원장 기준으로 재계산 — 미리보기(import)와 같은 기준.
    //  asof=null 이면 발송예정일이 미래인 선점 출고까지 빠진 값이라, 실물을 적어도 선점분만큼 유령 재고가 생긴다.
    //  기록 거래일도 오늘이므로 오늘까지의 원장 합 = 실사수량, 미래 선점은 그 뒤에 그대로 빠진다.
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    let tr = await sb.rpc("inventory_stock", { asof: today, chan });
    // 폴백은 (asof, chan) 시그니처가 없을 때(036 미적용, PGRST202)만. 일시 오류에 4칸 합으로 델타를 만들면 틀린 조정이 원장에 남는다 → 그대로 실패.
    if (tr.error?.code === "PGRST202") tr = await sb.rpc("inventory_stock", { asof: today });
    if (tr.error) throw tr.error;
    const stock = new Map<string, number>();
    for (const t of (tr.data as { product_id: string; qty: number }[] | null) ?? []) stock.set(t.product_id, Number(t.qty) || 0);
    const untracked = await getUntracked(sb); // 재고 관리 사용 안함(121) — 미리보기에서 이미 빠지지만 방어

    const insert: Record<string, unknown>[] = [];
    let invalid = 0; // 실사수량이 숫자가 아닌 행 — 0 으로 쓰지 않고 건너뛴 뒤 응답에 알린다
    for (const r of rows) {
      if (!r || !r.product_id || r.target == null) continue;
      if (untracked.ids.has(r.product_id)) continue;
      // 엄격 파싱 — Number("") 은 0 이라 빈 문자열이 '0 개' 조정으로 둔갑한다. 숫자거나 비어 있지 않은 숫자 문자열만 받는다.
      const raw = typeof r.target === "string" ? r.target.trim() : r.target;
      const target = raw === "" ? Number.NaN : Math.round(Number(raw) * 100) / 100;
      if (!Number.isFinite(target) || target < 0) { invalid++; continue; }
      const delta = target - (stock.get(r.product_id) || 0);
      if (delta === 0) continue;
      insert.push({ product_id: r.product_id, type: "조정", channel: chan, qty: delta, txn_date: today, memo: (r.memo ? String(r.memo).slice(0, 500) : `엑셀 실사 조정(${chan})`), created_by: actor });
    }
    if (!insert.length) return NextResponse.json({ ok: true, applied: 0, invalid, note: "변경할 재고가 없습니다(현재고와 실사수량 동일)." });

    let ins = await sb.from("inventory_txns").insert(insert);
    if (ins.error && RESERVED_CHANNELS.includes(chan) && /channel_chk|check constraint/i.test(ins.error.message))
      return NextResponse.json({ ok: false, error: `${chan} 칸이 아직 없습니다 — migration ${chan === "프로모션" ? "113" : "115"} 을 먼저 적용하세요.` }, { status: 500 });
    if (ins.error && /channel/i.test(ins.error.message)) { for (const r of insert) delete r.channel; ins = await sb.from("inventory_txns").insert(insert); }
    if (ins.error) throw ins.error;
    return NextResponse.json({ ok: true, applied: insert.length, invalid });
  } catch (err) {
    console.error("[inventory/adjust/import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조정 반영 실패") }, { status: 500 });
  }
}
