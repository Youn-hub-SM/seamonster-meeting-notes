import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { isKnownDepositName, parseKbDepositSms } from "@/app/lib/b2b-deposit-types";
import { isMissingDepositsTable, loadCompanyNames, loadDepositAliases, runAutoMatch } from "@/app/lib/b2b-deposits";
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

// 구조화 입력의 at(거래시각) 파싱 — 지연 재전송이 '수신 시점' 기준으로 다른 거래가 되는 것을 막는다(감사 후속).
//  타임존 표기가 없으면 폰이 보낸 KST 문자열 그대로로 해석하고, ISO(Z/+오프셋)면 절대시각→KST 변환.
function stampFromAt(at?: string): { trdate: string; trdt: string } | null {
  if (!at || typeof at !== "string") return null;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(at.trim());
  const m = at.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (m && !hasTz) {
    const pad = (n: string | number) => String(n).padStart(2, "0");
    return { trdate: `${m[1]}${pad(m[2])}${pad(m[3])}`, trdt: `${m[1]}${pad(m[2])}${pad(m[3])}${pad(m[4])}${pad(m[5])}00` };
  }
  const t = Date.parse(at);
  if (isNaN(t)) return null;
  const k = new Date(t + 9 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    trdate: `${k.getUTCFullYear()}${pad(k.getUTCMonth() + 1)}${pad(k.getUTCDate())}`,
    trdt: `${k.getUTCFullYear()}${pad(k.getUTCMonth() + 1)}${pad(k.getUTCDate())}${pad(k.getUTCHours())}${pad(k.getUTCMinutes())}00`,
  };
}

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
    let amount = Number(body.amount ?? parsed?.amount ?? 0);
    // 폰 매크로가 금액을 따로 보냈는데 그 값이 원문의 '잔액'과 같고 원문 파싱 금액과 다르면 — 매크로가 잔액을 집은 것(2026-10-16). 원문 파싱을 믿는다.
    if (body.text && parsed && body.amount != null && Number(body.amount) !== parsed.amount) {
      const balRe = new RegExp(`(잔액|잔고)\\s*:?\\s*${Number(body.amount).toLocaleString("ko-KR")}(?!\\d)`);
      if (balRe.test(body.text)) {
        console.log(`[deposits webhook] 구조화 amount 가 원문의 잔액과 같음 — 원문 파싱값으로 교체: ${Number(body.amount).toLocaleString()} → ${parsed.amount.toLocaleString()}`);
        amount = parsed.amount;
      }
    }
    const name = (body.name ?? parsed?.name ?? null) || null;
    if (!amount || amount <= 0) {
      // 입금 문자가 아님(출금·인증 등) — 폰 매크로가 걸러도 되고 여기서 걸러도 된다.
      //  '입금'이 든 글인데 금액을 못 찾은 것은 파서 구멍일 수 있으니 기록을 남긴다(2026-10-13 — 긴 법인명 건이 여기서 소리 없이 빠졌다).
      if (body.text && /입금/.test(body.text)) console.log(`[deposits webhook] 입금 글인데 금액을 못 찾음 — 저장 안 함: ${body.text.replace(/\s+/g, " ").slice(0, 80)}`);
      return NextResponse.json({ ok: true, skipped: "입금 문자가 아니거나 금액을 찾지 못했습니다.", parsed });
    }

    // 허용 목록 — 등록된 이름(업체명·별칭·일반 등록)의 입금만 저장한다.
    //  급여·매출 정산·사적 입금까지 내부 도구에 쌓이지 않게 수집 단계에서 버린다(대표 결정 2026-08-10).
    //  미등록 거래처의 입금은 화면에 안 뜨므로, 그런 건은 발주 모달의 '입금 추가'로 직접 기록.
    const known = isKnownDepositName(name, (await loadCompanyNames()).map((c) => c.name), await loadDepositAliases());

    const stamp = stampFromAt(body.at) ?? kstStamp(parsed ?? undefined);
    if (sp.get("dry") === "1") {
      return NextResponse.json({ ok: true, dry: true, amount, name, known, ...stamp, parsed });
    }
    // 이름이 아예 없으면(파싱 실패) 버리지 않고 저장 — 은행 문자 양식이 바뀌어도 입금이 소리 없이
    //  유실되지 않고 '확인필요'로 남는다(감사 확정 결함 보정). '등록된 이름과 다른 이름'은
    //  대표 결정(2026-08-10: 급여·사적 입금 미수집)대로 버린다.
    //  2026-10-13 에 "금액이 미수금과 같으면 미등록 이름도 저장" 예외를 넣었다가 2026-10-16 폐지 — 쿠팡 정산처럼 무관한 입금이
    //  우연히 어떤 발주 잔액과 같아 '확인필요'로 올라왔다. 법인 전환으로 이름이 바뀐 건(플라잉닥터→주식회사플라잉닥터)은
    //  depositNameMatch 의 법인 접두어 제거·앞부분 비교가 잡으므로 예외가 더 필요 없다. 버린 건은 콘솔에 한 줄(이름 앞 두 글자).
    if (!known && name) {
      console.log(`[deposits webhook] 미등록 입금자명 — 저장 안 함: ${name.slice(0, 2)}* · ${amount.toLocaleString()}원 · ${stamp.trdt}`);
      return NextResponse.json({ ok: true, skipped: "미등록 입금자명 — 저장하지 않음" });
    }

    // 중복 방지: 원문 해시. 원문에 거래 시각이 찍혀 있으면(SMS — 잔액도 있어 거래마다 다름) 원문만으로 충분하지만,
    //  앱 푸시처럼 '주식회사플라잉닥터 입금 1,272,200' 뿐인 글은 같은 거래처가 같은 금액을 다시 보내면 글자가 똑같아
    //  진짜 새 입금이 '재전송'으로 버려진다(2026-10-13) — 시각이 없는 원문은 수신 시각(분)을 붙여 구분한다.
    //  구조화 입력은 금액+이름+거래시각(분 단위 정규화 — stamp 가 이미 at 우선이므로 at 원문의 포맷·초 지터에 흔들리지 않는다).
    const dedupSrc = body.text ? (parsed?.month ? body.text : `${body.text}|${stamp.trdt}`) : `${amount}|${name ?? ""}|${stamp.trdt}`;
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
        console.log(`[deposits webhook] 같은 알림 재전송 — 무시: ${(name ?? "").slice(0, 2)}* · ${amount.toLocaleString()}원 · ${stamp.trdt}`);
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
