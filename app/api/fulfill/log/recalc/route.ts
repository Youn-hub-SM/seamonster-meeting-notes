import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { adminOnly, isAdminReq } from "@/app/lib/admin-req";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { logFulfillRecalc } from "@/app/lib/b2b-activity";
import { normalizeHistory, normalizeBoxCats, ratesFor, DEFAULT_EFFECTIVE } from "@/app/lib/fulfill-rates";
import { recalcDay, recordSigText, type BoxCounts } from "@/app/lib/delivery-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 배송일지 — 운임 다시 계산(2026-11-24 대표: "11월 1일부터 택배비가 바뀌어 단가를 고쳤는데 반영이 안 됐다").
//  발주처리에서 기록한 기본운임·도착보장 운임은 기록할 때의 단가로 저장된다. 단가를 나중에 넣으면 그 사이 기록은 옛 단가로 남으므로,
//  기록에 남은 박스 종류별 개수 × '그 날짜의 단가'로 다시 계산해 바꾼다(app/lib/delivery-log.ts recalcDay).
//  바꾸는 것 = 자동 기록의 기본운임·도착보장 운임(base_fee_normal·base_fee_guar, 기록 이력의 같은 값)뿐. 박스 수·직접수정·추가운임·메모는 건드리지 않는다.
//  GET                       → 기본 기간(지금 적용 중인 단가의 적용 시작일 ~ 오늘)과 관리자 여부
//  POST { from, to }         → 미리보기: 날짜별 지금 운임 / 다시 계산한 운임, 계산할 수 없는 날짜(무게를 모르는 박스 종류)
//  POST { from, to, apply: true, expect } → 적용. expect = 미리보기가 준 값 — 그 뒤 기록이 바뀌었으면 거절한다.
//  관리자만. 적용은 매출·재고 원장을 건드리지 않는다(배송일지 운임만).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const sigOf = (bn: BoxCounts, bg: BoxCounts, fn: number, fg: number) => createHash("sha1").update(recordSigText(bn, bg, fn, fg)).digest("hex").slice(0, 16);

async function readRates() {
  const { data, error } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", "fulfill_rates").maybeSingle();
  if (error) throw new Error(`단가 설정을 읽지 못했습니다: ${error.message}`); // 기본 단가로 대신 계산하지 않는다(S4)
  return { history: normalizeHistory(data?.value ?? {}), cats: normalizeBoxCats((data?.value as { boxCats?: unknown })?.boxCats) };
}

export async function GET(req: NextRequest) {
  try {
    const { history } = await readRates();
    const today = kstToday();
    const active = ratesFor(history, today) as { effectiveFrom?: string };
    const from = active.effectiveFrom && active.effectiveFrom !== DEFAULT_EFFECTIVE && active.effectiveFrom <= today ? active.effectiveFrom : today;
    return NextResponse.json({ ok: true, from, to: today, admin: await isAdminReq(req) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "단가 설정을 읽지 못했습니다") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny;
  try {
    const b = (await req.json().catch(() => ({}))) as { from?: string; to?: string; apply?: boolean; expect?: string };
    const from = String(b.from || ""), to = String(b.to || "");
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return NextResponse.json({ ok: false, error: "기간을 확인하세요." }, { status: 400 });
    if ((Date.parse(to) - Date.parse(from)) / 86400e3 > MAX_DAYS) return NextResponse.json({ ok: false, error: `한 번에 ${MAX_DAYS}일까지 계산합니다.` }, { status: 400 });
    const sb = supabaseAdmin();
    const { history, cats } = await readRates();
    const { data, error } = await sb.from("delivery_log").select("log_date, boxes_normal, boxes_guar, base_fee_normal, base_fee_guar, record_entries").gte("log_date", from).lte("log_date", to).order("log_date", { ascending: true }).limit(MAX_DAYS + 5);
    if (error) return NextResponse.json({ ok: false, error: /record_entries/i.test(error.message) ? "기록 이력이 없습니다 — 078_delivery_log_record_entries.sql 적용이 필요합니다." : error.message }, { status: 500 });

    const days = ((data ?? []) as Record<string, unknown>[]).map((row) => {
      const date = String(row.log_date || "");
      return { date, ...recalcDay(row, ratesFor(history, date), cats, sigOf) };
    });
    const changed = days.filter((d) => d.changed);
    const skipped = days.filter((d) => d.unknown.length).map((d) => ({ date: d.date, unknown: d.unknown }));
    const sum = (f: (d: (typeof days)[number]) => number) => changed.reduce((a, d) => a + f(d), 0);
    const totals = { days: changed.length, cur: sum((d) => d.cur_normal + d.cur_guar), next: sum((d) => d.new_normal + d.new_guar) };
    const expect = createHash("sha1").update(changed.map((d) => `${d.date}:${d.cur_normal}:${d.cur_guar}:${d.new_normal}:${d.new_guar}`).join("|")).digest("hex").slice(0, 16);
    const view = changed.map((d) => ({ date: d.date, cur_normal: d.cur_normal, new_normal: d.new_normal, cur_guar: d.cur_guar, new_guar: d.new_guar }));

    if (!b.apply) return NextResponse.json({ ok: true, from, to, checked: days.length, rows: view, totals, skipped, expect });

    if (!changed.length) return NextResponse.json({ ok: false, error: "바꿀 날짜가 없습니다." }, { status: 400 });
    if (String(b.expect || "") !== expect) return NextResponse.json({ ok: false, error: "미리보기 뒤에 기록이나 단가가 바뀌었습니다 — [미리보기]를 다시 누르세요." }, { status: 409 });
    let applied = 0; const conflicts: string[] = [];
    for (const d of changed) {
      const upd: Record<string, unknown> = { base_fee_normal: d.new_normal, base_fee_guar: d.new_guar, updated_at: new Date().toISOString() };
      if (d.entries) upd.record_entries = d.entries;
      // 읽은 뒤 누가 그 날짜를 다시 기록했으면(운임이 달라졌으면) 덮지 않는다
      const r = await sb.from("delivery_log").update(upd).eq("log_date", d.date).eq("base_fee_normal", d.cur_normal).eq("base_fee_guar", d.cur_guar).select("log_date");
      if (r.error) return NextResponse.json({ ok: false, error: `${d.date} 저장 오류: ${r.error.message} — 그 앞 ${applied}일은 바꿨습니다. [미리보기]를 다시 눌러 남은 날짜를 확인하세요.` }, { status: 500 });
      if ((r.data ?? []).length) applied++; else conflicts.push(d.date);
    }
    const t = req.cookies.get("b2b_auth")?.value;
    await logFulfillRecalc({ from, to, days: applied, before: totals.cur, after: totals.next }, (await verifySession(t)) || resolveUserName(t) || null);
    return NextResponse.json({ ok: true, from, to, applied, conflicts, totals });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "운임을 다시 계산하지 못했습니다") }, { status: 500 });
  }
}
