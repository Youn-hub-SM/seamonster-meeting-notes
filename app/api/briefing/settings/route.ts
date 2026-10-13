import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
import { getKv, setKv } from "@/app/lib/b2b-settings";
import { defaultRecipients } from "@/app/lib/sales-mailer";
import { MAIL_ADDR_RE, splitMailList, smtpReady } from "@/app/lib/report-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAdminReq(req: NextRequest): Promise<boolean> {
  const t = req.cookies.get("b2b_auth")?.value;
  const name = (await verifySession(t)) || resolveUserName(t) || null;
  return isAdminName(name || "");
}

// GET — 브리핑 설정(자동 생성 여부, 팀즈 웹훅 URL) + 종합 리포트 메일(2026-10-13: 켜기 analyst_mail ≠ off · 수신자 analyst_mail_to ·
//  비었을 때 받는 기본 수신자 SALES_MAIL_TO · SMTP env 유무). 관리자 전용이라 기본 수신자 주소도 돌려준다.
export async function GET(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 설정입니다." }, { status: 403 });
    const [auto, webhook, analystAuto, mail, mailTo] = await Promise.all([getKv("briefing_auto"), getKv("briefing_webhook"), getKv("analyst_auto"), getKv("analyst_mail"), getKv("analyst_mail_to")]);
    return NextResponse.json({
      ok: true, auto: auto !== "off", webhook, analystAuto: analystAuto !== "off",
      mail: mail !== "off", mailTo, mailDefault: defaultRecipients(), smtpReady: smtpReady(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 조회 실패") }, { status: 500 });
  }
}

// PUT { auto?, webhook?, analystAuto?, mail?, mailTo? } — mailTo = 쉼표 구분 이메일(빈 값 = 기본 수신자).
//  검사(웹훅 https·수신자 형식)를 모두 통과한 뒤에만 저장한다 — 하나라도 틀리면 아무것도 저장하지 않는다(화면 [설정 저장]은 칸들을 한 번에 보낸다).
export async function PUT(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 설정입니다." }, { status: 403 });
    const b = (await req.json()) as { auto?: boolean; webhook?: string; analystAuto?: boolean; mail?: boolean; mailTo?: string };
    const webhook = b.webhook !== undefined ? String(b.webhook).trim() : undefined;
    if (webhook && !/^https:\/\//.test(webhook)) return NextResponse.json({ ok: false, error: "웹훅 URL은 https:// 로 시작해야 합니다." }, { status: 400 });
    let mailTo: string | undefined;
    if (b.mailTo !== undefined) {
      const list = splitMailList(String(b.mailTo ?? ""));
      const bad = list.filter((s) => !MAIL_ADDR_RE.test(s));
      if (bad.length) return NextResponse.json({ ok: false, error: `메일 수신자 형식이 올바르지 않습니다: ${bad.slice(0, 3).join(", ")}` }, { status: 400 });
      mailTo = list.join(", ");
    }
    if (b.auto !== undefined) await setKv("briefing_auto", b.auto ? "on" : "off");
    if (b.analystAuto !== undefined) await setKv("analyst_auto", b.analystAuto ? "on" : "off");
    if (b.mail !== undefined) await setKv("analyst_mail", b.mail ? "on" : "off");
    if (mailTo !== undefined) await setKv("analyst_mail_to", mailTo);
    if (webhook !== undefined) await setKv("briefing_webhook", webhook);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 저장 실패") }, { status: 500 });
  }
}
