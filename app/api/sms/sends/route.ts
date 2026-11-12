import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { getKv, setKv } from "@/app/lib/b2b-settings";
import {
  parseReceivers, smsBytes, msgTypeOf, inSendWindow, maskPhone, PENDING_167,
  SMS_MAX_RECEIVERS, LMS_BYTES, LMS_TITLE_BYTES, SEND_FROM_HOUR, SEND_UNTIL_HOUR, QUEUE_EXPIRE_MS, CLAIM_ORPHAN_MS, type SmsSend,
} from "@/app/lib/sms-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 고객 문자 발송 큐(migration 167 sms_sends). 미들웨어 예외 경로(중계 실행기의 Bearer 접근용)라 여기서 직접 인증한다.
//
//  화면(로그인 쿠키 — factory 역할 거부):
//    GET                              → 최근 발송 기록(받는 번호는 가려서) + 발송 서버의 마지막 신호 시각 + 알리고 잔여 건수
//    POST { receivers, message, title? } → 발송 요청('대기' 행). 08~21시(한국 시간)에만 받는다.
//  실행기(Bearer NAVER_COMMERCE_CLIENT_SECRET 또는 크론 키 — 중계 서버 scripts/aligo-sms-runner.mjs):
//    POST ?mode=claim   → '대기'를 원자적으로 '실행중' 선점 후 반환(받는 번호 원문 포함)
//    POST ?mode=report { id, ok, uncertain?, error?, msg_id?, success_cnt?, error_cnt?, test?, remain? } → 결과 기록
//
//  고객에게 나가는 문자라 '많아야 한 번':
//   · 대기 30분이 넘은 행은 보내지 않고 실패로 닫는다(늦게 엉뚱한 시각에 나가지 않게).
//   · 선점 뒤 10분 동안 보고가 없으면 '확인 필요' — 다시 선점하지 않는다(두 번 나가는 것보다 사람이 확인하는 쪽이 낫다).

const isMissing = (e: { message?: string } | null | undefined) => !!e && /sms_sends/i.test(e.message || "") && /does not exist|schema cache|could not find/i.test(e.message || "");
const MISSING = NextResponse.json({ ok: false, error: PENDING_167 }, { status: 503 });
const KV_RUNNER = "sms_runner_last"; // 발송 서버가 마지막으로 큐를 본 시각
const KV_REMAIN = "sms_remain";      // 알리고 잔여 건수 {sms, lms, at} — 실행기가 발송 뒤 알려 준다

function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET, process.env.DIGEST_CRON_KEY];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}
async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}

type Sb = ReturnType<typeof supabaseAdmin>;
// 멈춘 행 정리 — 오래 대기한 것은 실패로, 보고 없는 선점은 '확인 필요'로. 조회·선점 때마다 부른다(따로 도는 틱 없음).
async function settle(sb: Sb): Promise<void> {
  const now = Date.now();
  await sb.from("sms_sends").update({ status: "실패", error: "발송 서버가 30분 안에 가져가지 않아 보내지 않았습니다. 다시 보내세요.", executed_at: new Date(now).toISOString() })
    .eq("status", "대기").lt("created_at", new Date(now - QUEUE_EXPIRE_MS).toISOString());
  await sb.from("sms_sends").update({ status: "확인 필요", error: "발송 서버가 결과를 알리지 않았습니다. 알리고 전송 내역에서 발송 여부를 확인하세요." })
    .eq("status", "실행중").lt("claimed_at", new Date(now - CLAIM_ORPHAN_MS).toISOString());
}

type Row = Record<string, unknown>;
function toSend(r: Row): SmsSend {
  const receivers = Array.isArray(r.receivers) ? (r.receivers as string[]) : [];
  return {
    id: Number(r.id), message: String(r.message || ""), title: (r.title as string | null) ?? null, msg_type: r.msg_type === "LMS" ? "LMS" : "SMS",
    receiver_count: Number(r.receiver_count) || receivers.length,
    receiver_preview: receivers.slice(0, 3).map((d) => maskPhone(String(d))).join(", "),
    status: String(r.status || "대기") as SmsSend["status"], test: (r.test as boolean | null) ?? null,
    success_cnt: r.success_cnt == null ? null : Number(r.success_cnt), error_cnt: r.error_cnt == null ? null : Number(r.error_cnt),
    error: (r.error as string | null) ?? null, requested_by: (r.requested_by as string | null) ?? null,
    created_at: String(r.created_at), executed_at: (r.executed_at as string | null) ?? null,
  };
}

export async function GET(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sb = supabaseAdmin();
    await settle(sb);
    const [{ data, error }, runnerLast, remainRaw] = await Promise.all([
      sb.from("sms_sends").select("*").order("created_at", { ascending: false }).limit(50),
      getKv(KV_RUNNER), getKv(KV_REMAIN),
    ]);
    if (error) { if (isMissing(error)) return NextResponse.json({ ok: true, sends: [], pending: PENDING_167 }); throw error; }
    let remain: { sms?: number; lms?: number; at?: string } | null = null;
    try { remain = remainRaw ? JSON.parse(remainRaw) : null; } catch { remain = null; }
    return NextResponse.json({ ok: true, sends: ((data ?? []) as Row[]).map(toSend), runnerLast: runnerLast || null, remain, open: inSendWindow(Date.now()) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "발송 기록을 불러오지 못했습니다") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const sb = supabaseAdmin();

    if (sp.get("mode") === "claim") {
      if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
      await setKv(KV_RUNNER, new Date().toISOString()).catch(() => {});
      await settle(sb);
      if (!inSendWindow(Date.now())) return NextResponse.json({ ok: true, sends: [] });
      const { data, error } = await sb.from("sms_sends").update({ status: "실행중", claimed_at: new Date().toISOString() })
        .eq("status", "대기").select("id, receivers, message, title, msg_type");
      if (error) { if (isMissing(error)) return MISSING; throw error; }
      const rows = ((data ?? []) as { id: number }[]).sort((a, b) => a.id - b.id);
      return NextResponse.json({ ok: true, sends: rows });
    }

    if (sp.get("mode") === "report") {
      if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
      const b = (await req.json().catch(() => ({}))) as { id?: number; ok?: boolean; uncertain?: boolean; error?: string; msg_id?: string | number; success_cnt?: number; error_cnt?: number; test?: boolean; remain?: { sms?: number; lms?: number } };
      if (!b.id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
      const patch: Record<string, unknown> = {
        status: b.ok ? "완료" : b.uncertain ? "확인 필요" : "실패", // uncertain = 알리고에 요청은 갔는데 답을 못 받음(나갔을 수 있다)
        error: b.ok ? null : String(b.error || "알 수 없는 오류").slice(0, 500),
        executed_at: new Date().toISOString(),
        test: b.test === true,
      };
      if (b.msg_id != null) patch.aligo_msg_id = String(b.msg_id).slice(0, 40);
      if (Number.isFinite(Number(b.success_cnt))) patch.success_cnt = Number(b.success_cnt);
      if (Number.isFinite(Number(b.error_cnt))) patch.error_cnt = Number(b.error_cnt);
      // 늦게 온 보고('확인 필요'로 넘어간 뒤)도 받는다 — 실제 결과가 추측보다 낫다
      const { error } = await sb.from("sms_sends").update(patch).eq("id", b.id).in("status", ["실행중", "확인 필요"]);
      if (error) throw error;
      if (b.remain && (Number.isFinite(Number(b.remain.sms)) || Number.isFinite(Number(b.remain.lms))))
        await setKv(KV_REMAIN, JSON.stringify({ sms: Number(b.remain.sms) || 0, lms: Number(b.remain.lms) || 0, at: new Date().toISOString() })).catch(() => {});
      return NextResponse.json({ ok: true });
    }

    const name = await loginName(req);
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const b = (await req.json().catch(() => ({}))) as { receivers?: string; message?: string; title?: string };
    const message = String(b.message || "").replace(/\r\n/g, "\n").trim();
    const { valid, invalid } = parseReceivers(String(b.receivers || ""));
    if (invalid.length) return NextResponse.json({ ok: false, error: `휴대폰 번호가 아닌 것이 있습니다: ${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? ` 외 ${invalid.length - 5}개` : ""}` }, { status: 400 });
    if (!valid.length) return NextResponse.json({ ok: false, error: "받는 번호를 입력하세요." }, { status: 400 });
    if (valid.length > SMS_MAX_RECEIVERS) return NextResponse.json({ ok: false, error: `한 번에 ${SMS_MAX_RECEIVERS.toLocaleString("ko-KR")}명까지 보낼 수 있습니다. 나눠서 보내세요.` }, { status: 400 });
    if (!message) return NextResponse.json({ ok: false, error: "내용을 입력하세요." }, { status: 400 });
    const bytes = smsBytes(message);
    if (bytes > LMS_BYTES) return NextResponse.json({ ok: false, error: `내용은 ${LMS_BYTES.toLocaleString("ko-KR")}바이트 이하(지금 ${bytes.toLocaleString("ko-KR")}바이트)` }, { status: 400 });
    const msg_type = msgTypeOf(message);
    const title = msg_type === "LMS" ? String(b.title || "").trim() : "";
    if (title && smsBytes(title) > LMS_TITLE_BYTES) return NextResponse.json({ ok: false, error: `제목은 ${LMS_TITLE_BYTES}바이트 이하` }, { status: 400 });
    if (!inSendWindow(Date.now())) return NextResponse.json({ ok: false, error: `문자는 ${SEND_FROM_HOUR}시부터 ${SEND_UNTIL_HOUR}시 전까지만 보낼 수 있습니다.` }, { status: 400 });

    const { data, error } = await sb.from("sms_sends").insert({ message, title: title || null, msg_type, receivers: valid, receiver_count: valid.length, requested_by: name }).select("*").single();
    if (error) { if (isMissing(error)) return MISSING; throw error; }
    return NextResponse.json({ ok: true, send: toSend(data as Row) });
  } catch (err) {
    console.error("[sms/sends]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "문자를 보내지 못했습니다") }, { status: 500 });
  }
}
