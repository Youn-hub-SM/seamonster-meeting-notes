import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { VOC_CATEGORIES, VOC_STATUSES, VOC_BUYER_TYPES, VOC_COMP_TYPES, VOC_FAULTS, suggestFault } from "@/app/lib/voc";
import type { VocImportRow } from "@/app/lib/voc-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const inSet = (v: unknown, set: readonly string[], dflt: string) => (typeof v === "string" && set.includes(v) ? v : dflt);
const dateOrNull = (v: unknown) => (typeof v === "string" && DATE_RE.test(v) ? v : null);

// POST /api/voc/import/apply { rows: VocImportRow[] } — 미리보기에서 확인한 행을 일괄 등록(재검증 후).
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: VocImportRow[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return NextResponse.json({ ok: false, error: "등록할 행이 없습니다." }, { status: 400 });
    const cookie = req.cookies.get("b2b_auth")?.value;
    const actor = (await verifySession(cookie)) || resolveUserName(cookie);

    const insert = rows
      .filter((r) => r && DATE_RE.test(String(r.received_at)) && String(r.content || "").trim())
      .map((r) => {
        const category = inSet(r.category, VOC_CATEGORIES, "배송");
        return {
          received_at: r.received_at,
          customer: r.customer ? String(r.customer).slice(0, 5000) : null,
          buyer_type: typeof r.buyer_type === "string" && (VOC_BUYER_TYPES as readonly string[]).includes(r.buyer_type) ? r.buyer_type : null,
          purchase_place: r.purchase_place ? String(r.purchase_place).slice(0, 500) : null,
          product: r.product ? String(r.product).slice(0, 500) : null,
          purchase_date: dateOrNull(r.purchase_date),
          production_date: dateOrNull(r.production_date),
          category,
          comp_type: inSet(r.comp_type, VOC_COMP_TYPES, "없음"),
          comp_qty: Math.max(1, Math.round(Number(r.comp_qty) || 1)),
          loss_amount: Math.max(0, Math.round(Number(r.loss_amount) || 0)),
          fault: inSet(r.fault, VOC_FAULTS, suggestFault(category)),
          status: inSet(r.status, VOC_STATUSES, "접수"),
          content: String(r.content).slice(0, 5000),
          cause: r.cause ? String(r.cause).slice(0, 5000) : null,
          resolution: r.resolution ? String(r.resolution).slice(0, 5000) : null,
          improvement: r.improvement ? String(r.improvement).slice(0, 5000) : null,
          customer_note: r.customer_note ? String(r.customer_note).slice(0, 5000) : null,
          created_by: actor,
        };
      });
    if (!insert.length) return NextResponse.json({ ok: false, error: "유효한 행이 없습니다." }, { status: 400 });

    const { error } = await supabaseAdmin().from("voc").insert(insert);
    if (error) throw error;
    return NextResponse.json({ ok: true, applied: insert.length });
  } catch (err) {
    console.error("[voc/import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "등록 실패") }, { status: 500 });
  }
}
