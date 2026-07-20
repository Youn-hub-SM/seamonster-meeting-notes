import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeHistory } from "@/app/lib/fulfill-rates";
import { BOX_CATEGORIES } from "@/app/lib/order-fulfill";
import { cleanBoxes, cleanEntries, mergeDeliveryRow, type ManualEntry } from "@/app/lib/delivery-log";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MANUAL = ["extra_fee", "guar_extra_fee", "pado_fee", "pado_extra", "pado_cod", "dryice_full", "dryice_half", "memo"] as const;

const sanitizeBoxes = (o: unknown) => cleanBoxes(o);
function mergeBoxes(a: unknown, b: Record<string, number>): Record<string, number> {
  const out = sanitizeBoxes(a);
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v;
  return out;
}

// GET ?from=&to= — 배송일지(기본 최근 60일). 행은 자동+직접수정 '병합'으로 반환:
//  boxes_*/base_fee_* = 최종값(통계·기존 소비처 호환), *_auto/*_manual/manual_updated_at = 화면 구분 표시용.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let from = (sp.get("from") || "").trim(), to = (sp.get("to") || "").trim();
    if (!DATE_RE.test(to)) { const d = new Date(Date.now() + 9 * 3600e3); to = d.toISOString().slice(0, 10); }
    if (!DATE_RE.test(from)) { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - 60); from = d.toISOString().slice(0, 10); }
    const sb = supabaseAdmin();
    const [{ data, error }, { data: rateRow }] = await Promise.all([
      sb.from("delivery_log").select("*").gte("log_date", from).lte("log_date", to).order("log_date", { ascending: false }),
      sb.from("b2b_settings").select("value").eq("key", "fulfill_rates").maybeSingle(),
    ]);
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (055 적용 확인)` }, { status: 500 });
    const history = normalizeHistory(rateRow?.value ?? {});
    const rows = (data ?? []).map((r) => mergeDeliveryRow(r as Record<string, unknown>, history));
    return NextResponse.json({ ok: true, from, to, rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

// POST — record:true 면 발주처리 자동칸(택배량·기본운임) 기록, add_entry/del_entry 면 직접수정 내역, 아니면 수동칸 편집.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const log_date = String(b.log_date || "");
    if (!DATE_RE.test(log_date)) return NextResponse.json({ ok: false, error: "날짜(YYYY-MM-DD)가 올바르지 않습니다." }, { status: 400 });
    const sb = supabaseAdmin();

    // ── 직접수정 내역 추가/삭제 — 사유(내용)까지 히스토리로 남긴다 ──
    if (b.add_entry || b.del_entry) {
      const { data: ex, error: exErr } = await sb.from("delivery_log").select("manual_entries").eq("log_date", log_date).maybeSingle();
      if (exErr) {
        if (/manual_entries/i.test(exErr.message)) return NextResponse.json({ ok: false, error: "직접수정 내역에는 076_delivery_log_manual_entries.sql 적용이 필요합니다." }, { status: 500 });
        return NextResponse.json({ ok: false, error: exErr.message }, { status: 500 });
      }
      let entries = cleanEntries(ex?.manual_entries);
      let added: ManualEntry | null = null;
      if (b.add_entry) {
        const a = b.add_entry as Record<string, unknown>;
        const side = a.side === "g" ? "g" as const : "n" as const;
        const category = String(a.category || "");
        const qty = Math.round(Number(a.qty) || 0);
        const note = String(a.note || "").trim();
        if (!(BOX_CATEGORIES as readonly string[]).includes(category)) return NextResponse.json({ ok: false, error: "박스종류가 올바르지 않습니다." }, { status: 400 });
        if (qty === 0) return NextResponse.json({ ok: false, error: "수량(±)을 입력하세요." }, { status: 400 });
        if (!note) return NextResponse.json({ ok: false, error: "내용(사유)을 입력하세요." }, { status: 400 });
        const token = req.cookies.get("b2b_auth")?.value;
        const by = (await verifySession(token)) || resolveUserName(token);
        added = { id: randomUUID(), side, category, qty, note: note.slice(0, 200), at: new Date().toISOString(), by };
        entries = [...entries, added];
      } else {
        const id = String((b.del_entry as Record<string, unknown>)?.id || "");
        if (!id) return NextResponse.json({ ok: false, error: "삭제할 내역 id 가 없습니다." }, { status: 400 });
        entries = entries.filter((e) => e.id !== id);
      }
      const { error: upErr } = await sb.from("delivery_log").upsert(
        { log_date, manual_entries: entries, manual_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "log_date" }
      );
      if (upErr) {
        if (/manual/i.test(upErr.message)) return NextResponse.json({ ok: false, error: "직접수정 내역에는 076_delivery_log_manual_entries.sql 적용이 필요합니다." }, { status: 500 });
        return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });
      }
      return NextResponse.json({ ok: true, entry: added, entries });
    }

    const row: Record<string, unknown> = { log_date, updated_at: new Date().toISOString() };

    if (b.record) {
      // 자동칸 기록. mode='add'면 그날 기존 값에 누적(하루 여러 배치), 아니면 덮어쓰기.
      const bxN = sanitizeBoxes(b.boxes_normal), bxG = sanitizeBoxes(b.boxes_guar);
      const bfN = Math.round(Number(b.base_fee_normal) || 0), bfG = Math.round(Number(b.base_fee_guar) || 0);
      const gxf = Math.round(Number(b.guar_extra_fee) || 0); // 도착보장 추가운임(143×건수) 자동
      if (b.mode === "add") {
        const { data: ex } = await sb.from("delivery_log").select("boxes_normal,boxes_guar,base_fee_normal,base_fee_guar,guar_extra_fee").eq("log_date", log_date).maybeSingle();
        row.boxes_normal = mergeBoxes(ex?.boxes_normal, bxN);
        row.boxes_guar = mergeBoxes(ex?.boxes_guar, bxG);
        row.base_fee_normal = (Number(ex?.base_fee_normal) || 0) + bfN;
        row.base_fee_guar = (Number(ex?.base_fee_guar) || 0) + bfG;
        row.guar_extra_fee = (Number(ex?.guar_extra_fee) || 0) + gxf;
      } else {
        row.boxes_normal = bxN; row.boxes_guar = bxG;
        row.base_fee_normal = bfN; row.base_fee_guar = bfG; row.guar_extra_fee = gxf;
      }
    } else {
      // 수동 편집: 제공된 칸만 부분 upsert(다른 칸 보존).
      //  택배량 자동칸(boxes_*/base_fee_*)은 발주처리 기록 전용 — 직접수정은 보정(±) 컬럼에만 기록.
      for (const k of MANUAL) {
        if (b[k] === undefined) continue;
        row[k] = k === "memo" ? (String(b[k] || "").trim() || null) : (k.startsWith("dryice") ? Number(b[k]) || 0 : Math.round(Number(b[k]) || 0));
      }
      if (b.boxes_normal_manual !== undefined || b.boxes_guar_manual !== undefined) {
        if (b.boxes_normal_manual !== undefined) row.boxes_normal_manual = cleanBoxes(b.boxes_normal_manual, true);
        if (b.boxes_guar_manual !== undefined) row.boxes_guar_manual = cleanBoxes(b.boxes_guar_manual, true);
        row.manual_updated_at = new Date().toISOString(); // 직접수정 최종 시각(초 단위 표시용)
      }
    }
    const { error } = await sb.from("delivery_log").upsert(row, { onConflict: "log_date" });
    if (error) {
      if (/manual/i.test(error.message)) return NextResponse.json({ ok: false, error: "직접수정 저장에는 075_delivery_log_manual.sql 적용이 필요합니다." }, { status: 500 });
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}

// DELETE ?log_date= — 그 날짜 행 삭제
export async function DELETE(req: NextRequest) {
  try {
    const log_date = req.nextUrl.searchParams.get("log_date") || "";
    if (!DATE_RE.test(log_date)) return NextResponse.json({ ok: false, error: "날짜가 올바르지 않습니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("delivery_log").delete().eq("log_date", log_date);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "삭제 실패") }, { status: 500 });
  }
}
