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

// GET — 브리핑 설정(중단된 06:30 브리핑의 자동 생성 여부·팀즈 웹훅) + 종합 리포트 메일 수신자(2026-10-13: analyst_mail_to ·
//  비었을 때 받는 기본 수신자 SALES_MAIL_TO · SMTP env 유무). 관리자 전용이라 기본 수신자 주소도 돌려준다.
//  종합 리포트는 2026-10-13 대표 결정으로 수동 [보내기] = 메일만 — 자동 발송(analyst_auto)·메일 끄기(analyst_mail)·팀즈 웹훅 설정은 쓰지 않는다.
export async function GET(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 설정입니다." }, { status: 403 });
    // 2026-10-20: 옛 06:30 브리핑의 자동 생성·팀즈 웹훅(briefing_auto·briefing_webhook) 삭제 — 종합 리포트 메일 수신자만 남는다
    const mailTo = await getKv("analyst_mail_to");
    return NextResponse.json({ ok: true, mailTo, mailDefault: defaultRecipients(), smtpReady: smtpReady() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 조회 실패") }, { status: 500 });
  }
}

// PUT { auto?, webhook?, mailTo? } — mailTo = 쉼표 구분 이메일(빈 값 = 기본 수신자).
//  검사(웹훅 https·수신자 형식)를 모두 통과한 뒤에만 저장한다 — 하나라도 틀리면 아무것도 저장하지 않는다(화면 [설정 저장]은 칸들을 한 번에 보낸다).
export async function PUT(req: NextRequest) {
  try {
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "대표 전용 설정입니다." }, { status: 403 });
    const b = (await req.json()) as { mailTo?: string };
    let mailTo: string | undefined;
    if (b.mailTo !== undefined) {
      const list = splitMailList(String(b.mailTo ?? ""));
      const bad = list.filter((s) => !MAIL_ADDR_RE.test(s));
      if (bad.length) return NextResponse.json({ ok: false, error: `메일 수신자 형식이 올바르지 않습니다: ${bad.slice(0, 3).join(", ")}` }, { status: 400 });
      mailTo = list.join(", ");
    }
    if (mailTo !== undefined) await setKv("analyst_mail_to", mailTo);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 저장 실패") }, { status: 500 });
  }
}
