import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import {
  ExportLineItem,
  OrderExportOption,
  ShipmentExportOption,
  ShipmentStatus,
} from "@/app/lib/b2b-orders";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────
// POST /api/b2b/orders/export-options
//   body: { order_ids: string[] }
//   선택한 발주들의 발송 일정 목록을 반환 → 프론트가 "어떤 발송을 뽑을지" 선택 모달에 사용.
// ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { order_ids?: string[] };
    const ids = (body.order_ids ?? []).filter(Boolean);
    if (ids.length === 0) {
      return NextResponse.json(
        { ok: false, error: "발주를 1개 이상 선택하세요." },
        { status: 400 }
      );
    }

    const sb = supabaseAdmin();
    const { data: orders, error } = await sb
      .from("orders")
      .select(
        "id, order_no, order_date, " +
          "companies:company_id(name), " +
          "order_items(product_name, option_label, spec, qty, sort_order), " +
          "shipments(id, seq, ship_date, status, shipment_items(product_name, spec, qty))"
      )
      .in("id", ids)
      .order("order_date", { ascending: true });
    if (error) throw error;

    type CompJoin = { name?: string };
    type OItem = { product_name: string; option_label: string | null; spec: string | null; qty: number; sort_order: number };
    type SItem = { product_name: string; spec: string | null; qty: number };
    type ShipJoin = { id: string; seq: number; ship_date: string | null; status: string; shipment_items: SItem[] };
    type Row = {
      id: string;
      order_no: string;
      companies: CompJoin | CompJoin[] | null;
      order_items: OItem[];
      shipments: ShipJoin[];
    };

    const options: OrderExportOption[] = (orders as unknown as Row[] | null ?? []).map((o) => {
      const company = Array.isArray(o.companies) ? o.companies[0] : o.companies;
      const fallbackItems: ExportLineItem[] = (o.order_items ?? [])
        .slice()
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((it) => ({
          product_name: it.product_name,
          spec: it.spec || it.option_label || null,
          qty: Number(it.qty) || 0,
        }));

      const shipments: ShipmentExportOption[] = (o.shipments ?? [])
        .slice()
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .map((s) => ({
          id: s.id,
          seq: s.seq,
          ship_date: s.ship_date,
          status: (s.status || "발송대기") as ShipmentStatus,
          items: (s.shipment_items ?? []).map((si) => ({
            product_name: si.product_name,
            spec: si.spec,
            qty: Number(si.qty) || 0,
          })),
        }));

      return {
        order_id: o.id,
        order_no: o.order_no,
        company_name: company?.name ?? "(미지정)",
        fallbackItems,
        shipments,
      };
    });

    return NextResponse.json({ ok: true, options });
  } catch (err) {
    console.error("[b2b/orders/export-options]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}
