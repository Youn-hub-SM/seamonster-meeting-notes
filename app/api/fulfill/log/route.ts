import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { BOX_CATEGORIES } from "@/app/lib/order-fulfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MANUAL = ["extra_fee", "guar_extra_fee", "pado_fee", "pado_extra", "pado_cod", "dryice_full", "dryice_half", "memo"] as const;

// 알려진 박스종류만·0 이상 정수로 정제(임의 jsonb 저장 방지)
function sanitizeBoxes(o: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (o && typeof o === "object") for (const c of BOX_CATEGORIES) { const n = Math.max(0, Math.round(Number((o as Record<string, unknown>)[c]) || 0)); if (n) out[c] = n; }
  return out;
}
function mergeBoxes(a: unknown, b: Record<string, number>): Record<string, number> {
  const out = sanitizeBoxes(a);
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v;
  return out;
}

// GET ?from=&to= — 배송일지(기본 최근 60일)
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let from = (sp.get("from") || "").trim(), to = (sp.get("to") || "").trim();
    if (!DATE_RE.test(to)) { const d = new Date(Date.now() + 9 * 3600e3); to = d.toISOString().slice(0, 10); }
    if (!DATE_RE.test(from)) { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - 60); from = d.toISOString().slice(0, 10); }
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("delivery_log").select("*").gte("log_date", from).lte("log_date", to).order("log_date", { ascending: false });
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (055 적용 확인)` }, { status: 500 });
    return NextResponse.json({ ok: true, from, to, rows: data ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

// POST — record:true 면 발주처리 자동칸(택배량·기본운임) 기록, 아니면 수동칸 편집. 둘 다 날짜 단위 upsert(부분 컬럼).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const log_date = String(b.log_date || "");
    if (!DATE_RE.test(log_date)) return NextResponse.json({ ok: false, error: "날짜(YYYY-MM-DD)가 올바르지 않습니다." }, { status: 400 });
    const sb = supabaseAdmin();
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
      // 수동 편집: 제공된 칸만 부분 upsert(다른 칸 보존). 기본운임·택배량도 손으로 수정 가능.
      for (const k of MANUAL) {
        if (b[k] === undefined) continue;
        row[k] = k === "memo" ? (String(b[k] || "").trim() || null) : (k.startsWith("dryice") ? Number(b[k]) || 0 : Math.round(Number(b[k]) || 0));
      }
      if (b.base_fee_normal !== undefined) row.base_fee_normal = Math.round(Number(b.base_fee_normal) || 0);
      if (b.base_fee_guar !== undefined) row.base_fee_guar = Math.round(Number(b.base_fee_guar) || 0);
      if (b.boxes_normal !== undefined) row.boxes_normal = sanitizeBoxes(b.boxes_normal);
      if (b.boxes_guar !== undefined) row.boxes_guar = sanitizeBoxes(b.boxes_guar);
    }
    const { error } = await sb.from("delivery_log").upsert(row, { onConflict: "log_date" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
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
