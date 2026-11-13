import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { isSolapiConfigured, SolapiRejected } from "@/app/lib/solapi";
import { FORM_SMS_TABLE, AUTO_CAP, TICK_MINUTES, FormSmsError, getRule, getLast, getTickAt, saveRule, loadPending, syncTally, runFormSms, sendTest, maskPhone, isMissingFormSms } from "@/app/lib/form-sms";
import { getTallyApiKey, listTallyForms } from "@/app/lib/voc-tally";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 신청자 문자 — 탈리 폼 신청자에게 매일 정한 시각 또는 즉시 문자(app/lib/form-sms.ts).
//  GET                            → 설정 + 대기 중인 신청(번호 가림) + 최근 발송 기록 + 마지막 실행·예약 신호 시각 + 폼 선택지(탈리 API)
//                                    켜져 있으면 먼저 탈리에서 새 신청을 가져온다 — 대기 목록이 지금 기준이 되게
//  POST { action: "save", rule }  → 설정 저장(켜는 순간부터 들어온 신청이 대상)
//  POST { action: "test", to, from, text } → 적어 넣은 번호로 시험 발송(기록 표에는 남기지 않는다)
//  POST { action: "send" }        → 대기 중인 신청자에게 지금 보내기
//  로그인한 내부 직원(공장 계정 제외). 자동 발송은 /api/form-sms/tick(5분마다 오는 예약 신호).
async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}

export async function GET(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sb = supabaseAdmin();
    const [rule, last, tickAt] = await Promise.all([getRule(), getLast(), getTickAt()]);
    // 폼 선택지 — 탈리 API 키로 보이는 폼 전부(관리자 › 설정 › 연결 › Tally 의 키). 신청은 같은 키로 가져온다.
    const apiKey = await getTallyApiKey();
    let forms: { id: string; name: string }[] = [], tallyError = "";
    if (apiKey) {
      try { forms = await listTallyForms(apiKey); } catch (e) { tallyError = e instanceof Error ? e.message : "탈리 폼 목록을 불러오지 못했습니다"; }
      if (rule.on && !tallyError) { try { await syncTally(sb, rule); } catch (e) { tallyError = `탈리에서 신청을 가져오지 못했습니다 — ${e instanceof Error ? e.message : "오류"}`; } }
    }

    let applied = true, pending: { id: string; at: string; phone: string | null }[] = [], log: unknown[] = [];
    try {
      const [p, l] = await Promise.all([
        loadPending(sb, rule),
        sb.from(FORM_SMS_TABLE).select("id, phone_mask, status, reason, sent_by, created_at, sent_at").order("created_at", { ascending: false }).limit(200),
      ]);
      if (l.error) throw l.error;
      pending = p.map((x) => ({ id: x.id, at: x.at, phone: x.phone ? maskPhone(x.phone) : null }));
      log = l.data ?? [];
    } catch (e) {
      if (!isMissingFormSms(e as { message?: string })) throw e;
      applied = false; // migration 167 미적용
    }
    return NextResponse.json({ ok: true, rule, last, tickAt, forms, hasTallyKey: !!apiKey, tallyError, applied, configured: isSolapiConfigured(), pending, log, autoCap: AUTO_CAP, tickMinutes: TICK_MINUTES });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "신청자 문자 설정을 불러오지 못했습니다") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const name = await loginName(req);
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const b = (await req.json().catch(() => ({}))) as { action?: string; rule?: unknown; to?: unknown; from?: unknown; text?: unknown };
    if (b.action === "save") return NextResponse.json({ ok: true, rule: await saveRule(b.rule, name) });
    if (b.action === "test") {
      if (!isSolapiConfigured()) return NextResponse.json({ ok: false, error: "솔라피 키가 설정되지 않았습니다." }, { status: 400 });
      await sendTest({ to: b.to, from: b.from, text: b.text });
      return NextResponse.json({ ok: true });
    }
    if (b.action === "send") {
      const r = await runFormSms(supabaseAdmin(), name, false);
      return NextResponse.json({ ...r, ok: r.ok, error: r.error }, { status: r.ok ? 200 : 502 });
    }
    return NextResponse.json({ ok: false, error: "알 수 없는 요청입니다." }, { status: 400 });
  } catch (err) {
    if (err instanceof FormSmsError) return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    if (err instanceof SolapiRejected) return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
    if (isMissingFormSms(err as { message?: string })) return NextResponse.json({ ok: false, error: "migration 167 이 적용되지 않았습니다." }, { status: 500 });
    console.error("[form-sms]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "신청자 문자 처리에 실패했습니다") }, { status: 500 });
  }
}
