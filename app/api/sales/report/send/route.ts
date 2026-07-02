import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { sendSalesMail, defaultRecipients } from "@/app/lib/sales-mailer";
import { logSalesReportSent } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 리포트 실제 발송 + sales_reports 기록. body: {report_type, base_date, subject, text, html?, stats?, recipients?}
export async function POST(req: NextRequest) {
  let body: {
    report_type?: string; base_date?: string; subject?: string; text?: string;
    html?: string; stats?: unknown; recipients?: string[];
    period_start?: string; period_end?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const { report_type, base_date, subject, text, html, stats } = body;
  if (report_type !== "daily" && report_type !== "weekly")
    return NextResponse.json({ ok: false, error: "report_type은 daily 또는 weekly 여야 합니다." }, { status: 400 });
  if (!base_date || !subject || !text)
    return NextResponse.json({ ok: false, error: "base_date, subject, text는 필수입니다." }, { status: 400 });

  const to = (body.recipients?.length ? body.recipients : defaultRecipients())
    .map((s) => s.trim()).filter(Boolean);
  if (!to.length)
    return NextResponse.json({ ok: false, error: "수신자가 없습니다. SALES_MAIL_TO 환경변수를 설정하거나 수신자를 입력하세요." }, { status: 400 });

  // 기간: 일일=기준일 당일, 주간=클라이언트가 넘긴 주(월~일). 감사·추세용 컬럼.
  const period_start = report_type === "daily" ? base_date : body.period_start ?? null;
  const period_end = report_type === "daily" ? base_date : body.period_end ?? null;

  const sb = supabaseAdmin();
  try {
    const messageId = await sendSalesMail({ subject, text, html, to });
    await sb.from("sales_reports").insert({
      report_type, base_date, period_start, period_end, subject, html: html ?? null,
      stats: (stats as object) ?? null, status: "sent", recipients: to,
    });
    await logSalesReportSent(report_type, base_date, to.length);
    return NextResponse.json({ ok: true, sent_to: to, message_id: messageId });
  } catch (e) {
    const msg = (e as Error).message || "발송 실패";
    await sb.from("sales_reports").insert({
      report_type, base_date, period_start, period_end, subject, html: html ?? null,
      status: "failed", recipients: to, error: msg,
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
