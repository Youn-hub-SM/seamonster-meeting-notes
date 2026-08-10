import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { parseKbDepositSms } from "@/app/lib/b2b-deposit-types";
import { runAutoMatch, isMissingDepositsTable } from "@/app/lib/b2b-deposits";
import type { BankDeposit } from "@/app/lib/b2b-deposits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/b2b/deposits/webhook — 입금 알림 문자/푸시 수집 (무료 경로, 팝빌 대체).
//  폰의 자동화 앱(MacroDroid 등)이 국민은행 입금 알림을 받으면 이 주소로 전달한다.
//  body: { text: "<알림 원문>" }  또는 파싱을 폰에서 한 경우 { amount, name, at? }
//  인증: ?key= 또는 X-Webhook-Key 헤더 = DEPOSIT_WEBHOOK_SECRET (없으면 CRON_SECRET 겸용).
//  ?dry=1 : 저장 없이 파싱 결과만 반환 (연동 테스트용).
//  미들웨어 공개 예외 경로 — 여기서 직접 검증한다.

// KST 기준 trdate/trdt 문자열. 문자에 찍힌 MM/DD HH:mm 이 있으면 그걸 쓰고 연도는 수신 시점으로
// 보정한다(12월 말 문자를 1월에 받는 경계만 -1년).
function kstStamp(p?: { month: number | null; day: number | null; hour: number | null; minute: number | null }) {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  let y = now.getUTCFullYear();
  const m = p?.month ?? now.getUTCMonth() + 1;
  const d = p?.day ?? now.getUTCDate();
  const hh = p?.hour ?? now.getUTCHours();
  const mi = p?.minute ?? now.getUTCMinutes();
  if (p?.month && p.month > now.getUTCMonth() + 1 + 1) y -= 1; // 미래 월 = 작년 문자
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    trdate: `${y}${pad(m)}${pad(d)}`,
    trdt: `${y}${pad(m)}${pad(d)}${pad(hh)}${pad(mi)}00`,
  };
}

export async function POST(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const secret = process.env.DEPOSIT_WEBHOOK_SECRET || process.env.CRON_SECRET || "";
    const key = sp.get("key") || req.headers.get("x-webhook-key") || "";
    if (!secret || key !== secret) {
      return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      text?: string;
      amount?: number | string;
      name?: string;
      at?: string;
    };

    // 원문 파싱 또는 구조화 입력 — 구조화 값이 있으면 우선
    const parsed = body.text ? parseKbDepositSms(body.text) : null;
    const amount = Number(body.amount ?? parsed?.amount ?? 0);
    const name = (body.name ?? parsed?.name ?? null) || null;
    if (!amount || amount <= 0) {
      // 입금 문자가 아님(출금·인증 등) — 폰 매크로가 걸러도 되고 여기서 걸러도 된다
      return NextResponse.json({ ok: true, skipped: "입금 문자가 아니거나 금액을 찾지 못했습니다.", parsed });
    }

    const stamp = kstStamp(parsed ?? undefined);
    if (sp.get("dry") === "1") {
      return NextResponse.json({ ok: true, dry: true, amount, name, ...stamp, parsed });
    }

    // 중복 방지: 원문(잔액 포함이라 거래마다 다름) 해시. 구조화 입력은 금액+이름+분 단위 시각.
    const dedupSrc = body.text ?? `${amount}|${name ?? ""}|${stamp.trdt}`;
    const tid = "sms-" + createHash("sha256").update(dedupSrc).digest("hex").slice(0, 40);

    const sb = supabaseAdmin();
    const { data: inserted, error } = await sb
      .from("bank_deposits")
      .insert({
        tid,
        trdate: stamp.trdate,
        trdt: stamp.trdt,
        amount,
        balance: null,
        remark: name,
        raw: { source: "sms", text: body.text ?? null },
      })
      .select()
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json({ ok: true, dup: true }); // 같은 알림 재전송 — 정상 무시
      }
      throw error;
    }

    const dep = inserted as BankDeposit;
    const { autoMatched, needReview } = await runAutoMatch(new Set([dep.id]));
    return NextResponse.json({ ok: true, deposit_id: dep.id, amount, name, autoMatched, needReview });
  } catch (err) {
    if (isMissingDepositsTable(err)) {
      return NextResponse.json(
        { ok: false, notReady: true, error: "bank_deposits 테이블이 없습니다 — 마이그레이션 089_bank_deposits.sql 을 적용하세요." },
        { status: 503 }
      );
    }
    console.error("[b2b/deposits/webhook]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}
