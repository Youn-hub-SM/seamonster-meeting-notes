import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getCrmOptions } from "@/app/lib/crm-options";
import {
  CRM_CHANNEL_LABEL, CRM_CUSTOMER_LABEL, CRM_MSG_TYPE_LABEL, CRM_STATUS_LABEL,
  statusKey, type CrmMessage, type CrmOption,
} from "@/app/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/crm/export — CRM 메시지 전체를 엑셀로. UTM 캠페인을 한 시트에서 훑고 편집하는 용도.
//  라벨은 선택지(crm_options) → 내장 맵 → 원문 순으로 변환. 선택 컬럼(customer/msg_type/start/end)은
//  미적용 DB 폴백을 위해 select("*")로 있는 것만 받는다.
const HEADERS = ["스테이지", "순서", "메시지명", "고객", "발송채널", "유형", "발송시점", "상태", "UTM 캠페인", "링크", "태그", "진행시작", "진행종료", "메시지내용"] as const;

const labelOf = (list: CrmOption[], fallback: Record<string, string>) => (k: string) =>
  (k ? list.find((o) => o.key === k)?.label || fallback[k] || k : "");

export async function GET() {
  try {
    const [{ data, error }, opts] = await Promise.all([
      supabaseAdmin().from("crm_messages").select("*")
        .order("stage_num", { ascending: true }).order("sort_order", { ascending: true }).order("created_at", { ascending: true }),
      getCrmOptions(),
    ]);
    if (error) throw error;
    const rows = (data ?? []) as Partial<CrmMessage>[];
    const ch = labelOf(opts.channels, CRM_CHANNEL_LABEL);
    const cust = labelOf(opts.customers, CRM_CUSTOMER_LABEL);
    const type = labelOf(opts.msgTypes, CRM_MSG_TYPE_LABEL);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("CRM 메시지맵");
    ws.addRow([...HEADERS]);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };

    for (const m of rows) {
      ws.addRow([
        m.stage || "", m.stage_num ?? "", m.title || "",
        cust(m.customer || ""), ch(m.channel || ""), type(m.msg_type || ""),
        m.timing || "", CRM_STATUS_LABEL[statusKey(m.status || "")] || "",
        m.links?.utm_campaign || "", m.links?.url || "", m.tags || "",
        m.start_date || "", m.end_date || "", m.msg || "",
      ]);
    }
    ws.columns.forEach((c, i) => {
      const h = HEADERS[i];
      c.width = h === "메시지내용" ? 40 : h === "메시지명" || h === "UTM 캠페인" || h === "링크" ? 24 : h === "순서" ? 6 : 14;
    });

    const buf = await wb.xlsx.writeBuffer();
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="crm-message-map-${today}.xlsx"`,
      },
    });
  } catch (err) {
    console.error("[crm/export]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "추출 실패") }, { status: 500 });
  }
}
