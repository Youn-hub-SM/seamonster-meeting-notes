import { NextRequest, NextResponse, after } from "next/server";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { runDueScheduledReports } from "@/app/lib/report-schedule";
import { buildB2BDigest, getDigestConfig, kstDateStr, type B2BDigest } from "@/app/lib/b2b-digest";
import { getAppBaseUrl, setKv } from "@/app/lib/b2b-settings";
import { sendTeamsTextSafe } from "@/app/lib/b2b-teams";
import { supabaseAdmin } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 2026-10-19: 아침 틱에 AI 비서 정기 리포트 발송(after) 몫 포함

const COOKIE = "b2b_auth";
async function userOf(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get(COOKIE)?.value;
  return (await verifySession(t)) || resolveUserName(t) || null;
}

// 본문 맨 끝의 '→ https://…' 원문 링크 줄을 떼어 Flow body 의 url 필드로 보낸다 —
//  변동 알림과 같은 '자세히 보기' 클릭 링크로 렌더되고, 본문에는 주소 원문이 노출되지 않는다.
//  (미리보기(preview) 응답에는 원문 그대로 남겨 어디로 가는 링크인지 보이게 둔다)
function splitTrailingLink(text: string): { text: string; url?: string } {
  const m = text.match(/\n\n→ (https?:\/\/\S+)\s*$/);
  if (!m || m.index === undefined) return { text };
  return { text: text.slice(0, m.index), url: m[1] };
}

const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : (e as { message?: string } | null)?.message || String(e);

// 발송 기록(b2b_settings) 엄격 읽기 — getKv 는 오류를 빈 값으로 삼켜 '아직 안 보냄'으로 읽히고,
//  그러면 재시도 창 안의 다음 틱이 같은 알림을 또 보낸다. 읽기에 실패하면 throw → 이번 호출은 건너뛰고 다음 틱이 다시 본다.
async function readMarkers(keys: string[]): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin().from("b2b_settings").select("key, value").in("key", keys);
  if (error) throw error;
  const out = new Map<string, string>();
  for (const row of (data ?? []) as { key: string; value: { v?: string } | string | null }[]) {
    const s = typeof row.value === "string" ? row.value : row.value?.v;
    if (s && String(s).trim()) out.set(row.key, String(s).trim());
  }
  return out;
}

// 틱(gate=times) 재시도 창(분) — 정각 칸 + 5분·10분 뒤 틱. 정각 시도가 실패(조회 오류·Teams 오류)해도 다시 보낸다.
//  짧게 두는 이유: Teams 발송은 됐는데 발송 기록이 실패하면 창 안에서 한 번 더 나갈 수 있다.
const RETRY_WINDOW = 15;

// GET — 크론이 호출(Authorization: Bearer CRON_SECRET/DIGEST_CRON_KEY 또는 ?key=).
//  발송 시각은 설정(digest_config.times, KST HH:MM 5분 단위 목록)이 정한다 — 설정에서 바꾸면
//  SQL 을 다시 만질 필요 없이 즉시 반영된다.
//  · 주 발송: Supabase pg_cron 틱(migration 092)이 5분마다 ?gate=times 로 호출 → 최근 15분 안에 지난
//    시각 중 가장 늦은 것이 아직 안 나갔으면 그 시각으로 발송(정각 칸에서 실패하면 다음 두 틱이 다시 시도).
//  · 예비: vercel.json 크론 2개(06시대·16시대, Hobby 는 ±59분) — 최근 75분 안에 지난 시각 중 가장 늦은 것이
//    미발송이면 대신 보낸다. 그 밖의 시각(예: 08:30)은 틱 재시도 창만 있다.
//  · dedup: 시각별·하루 1회(digest_sent_HHMM). Teams 발송이 성공했을 때만 기록한다.
//  · 알림 내용의 조회가 일부 실패하면 그 섹션만 '확인 못 함'으로 표시해 보낸다(b2b-digest.ts).
//    본 조회가 모두 실패하면 기록하지 않고 다음 시도로 넘기며, 마지막 시도에서도 실패하면 짧은 실패 알림을 한 번 보낸다.
//  제목: 하루 첫 시각은 설정 제목 그대로, 이후 시각은 '(중간/오후 확인)' 을 붙인다.
//  관리자 수동은 미리보기 / ?send=1(즉시 발송, dedup 무시).
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const secret = process.env.CRON_SECRET || "";
  // pg_cron(정시 발송) 전용 보조 키 — CRON_SECRET 은 Vercel 에 '민감' 변수로
  //  저장돼 값을 다시 꺼낼 수 없어서, 기존 크론을 안 건드리고 별도 키를 하나 더 인정한다.
  const extraKey = process.env.DIGEST_CRON_KEY || "";
  const authz = req.headers.get("authorization") || "";
  const matches = (k: string) => !!k && (authz === `Bearer ${k}` || sp.get("key") === k);
  const isCron = matches(secret) || matches(extraKey);
  const name = await userOf(req);
  const isAdmin = name === "관리자" || name === "현석";
  if (!isCron && !isAdmin) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });

  // AI 비서 정기 리포트(2026-10-19) — 크론 아침 틱(KST 12시 전)에만, 응답을 보낸 뒤 after 로. 일정 알림과는 독립(실패해도 서로 영향 없음).
  //  크론은 Hobby 한도(2개)가 꽉 차 있어 새 크론을 늘리지 않고 이 틱에 얹는다. dedup 은 저장 리포트의 schedule.lastSentOn.
  if (isCron && (new Date(Date.now() + 9 * 3600_000)).getUTCHours() < 12) {
    after(async () => { try { await runDueScheduledReports(); } catch (e) { console.error("[schedule-digest] 정기 리포트 발송 실패", errMsg(e)); } });
  }

  const cfg = await getDigestConfig();
  const times = (cfg.times?.length ? [...cfg.times] : ["06:00", "16:00"]).sort();
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const kstNow = new Date(Date.now() + 9 * 3600_000);
  const nowMin = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
  const today = kstDateStr();
  const keyFor = (t: string) => `digest_sent_${t.replace(":", "")}`; // 값 = 마지막 발송일
  const failKeyFor = (t: string) => `digest_fail_${t.replace(":", "")}`; // 값 = 실패 알림을 보낸 날
  // 구 버전 키 호환 — 전환 당일 이중 발송 방지(아침=digest_last_sent, 오후=digest_last_sent_pm)
  const markerKeys = (t: string) => [keyFor(t), ...(t === times[0] ? ["digest_last_sent"] : []), ...(toMin(t) >= 720 ? ["digest_last_sent_pm"] : [])];
  const titled = (t: string) =>
    t === times[0] ? cfg : { ...cfg, title: `${cfg.title} (${toMin(t) >= 720 ? "오후" : "중간"} 확인)` };

  // 크론: 활성 확인 → 대상 시각 결정 → 시각별 dedup → 발송
  if (isCron && sp.get("send") !== "1") {
    if (!cfg.enabled) return NextResponse.json({ ok: true, skipped: "disabled" });

    const gate = sp.get("gate") === "times";
    const tick = Math.floor(nowMin / 5) * 5;
    // 대상 = 창 안에서 지난 시각 중 가장 늦은 것. 그게 이미 나갔으면 더 이른 시각을 소급하지 않는다(새 알림이 이미 최신).
    //  예비 창을 75분으로 제한하는 이유: 배포 직후 등에 한나절 전 시각까지 소급 발송하면 뜬금없는 알림이 된다.
    const ref = gate ? tick : nowMin;
    const due = [...times].reverse().find((t) => toMin(t) <= ref && (gate ? ref - toMin(t) < RETRY_WINDOW : ref - toMin(t) <= 75)) ?? null;
    if (!due) return NextResponse.json({ ok: true, skipped: gate ? `no-time-at-${tick}` : "nothing-due" });

    let marks: Map<string, string>;
    try { marks = await readMarkers(markerKeys(due)); }
    catch (e) {
      console.error("[schedule-digest] 발송 기록 조회 실패 — 이번 시도는 건너뜀", due, e);
      return NextResponse.json({ ok: false, time: due, error: `발송 기록을 읽지 못해 건너뜁니다: ${errMsg(e)}` }, { status: 503 });
    }
    if (markerKeys(due).some((k) => marks.get(k) === today)) return NextResponse.json({ ok: true, time: due, skipped: "already-sent" });
    const target = due;

    let digest: B2BDigest;
    try { digest = await buildB2BDigest(titled(target)); }
    catch (e) {
      console.error("[schedule-digest] 알림 내용 조회 실패", target, e);
      // 마지막 시도(틱 창의 끝 칸, 또는 예비 크론)에서도 실패하면 '불러오지 못했다'는 짧은 알림을 시각별 하루 1회 보낸다 —
      //  조용히 빠지지 않게. 발송 완료로는 기록하지 않는다(뒤이은 예비 크론이 정상 알림을 보낼 수 있게).
      const lastTry = !gate || tick - toMin(target) >= RETRY_WINDOW - 5;
      let failNotice = false;
      if (lastTry) {
        try {
          const fk = failKeyFor(target);
          if ((await readMarkers([fk])).get(fk) !== today) {
            const base = await getAppBaseUrl();
            const r = await sendTeamsTextSafe(
              `${titled(target).title} — ${today.slice(5)}\n\n할 일 목록을 불러오지 못했습니다(조회 실패). 업무도우미 B2B › 발주에서 직접 확인하세요`,
              { link: base ? `${base}/b2b/orders` : undefined },
            );
            if (r.ok) { failNotice = true; await setKv(fk, today); }
          }
        } catch (e2) { console.error("[schedule-digest] 실패 알림 발송 실패", target, e2); }
      }
      return NextResponse.json({ ok: false, time: target, error: errMsg(e), failNotice }, { status: 500 });
    }

    const { text, url } = splitTrailingLink(digest.text);
    const r = await sendTeamsTextSafe(text, { link: url }); // Teams 단독 발송(2026-08-23 Flow 제거) — 성공 시에만 발송 완료 처리
    let markError: string | undefined;
    if (r.ok) {
      // 기록이 안 남으면 재시도 창 안의 다음 틱이 같은 알림을 다시 보낸다 — 한 번 더 시도하고, 그래도 안 되면 남긴다
      try { await setKv(keyFor(target), today); }
      catch {
        try { await setKv(keyFor(target), today); }
        catch (e) { markError = errMsg(e); console.error("[schedule-digest] 발송 기록 실패 — 다음 틱에 다시 나갈 수 있음", target, e); }
      }
      // 설정 화면 '마지막 자동 발송' 표시용(날짜 시각) — 중복 방지 표시(digest_sent_*·digest_last_sent)와 따로 둔다. 실패해도 발송엔 영향 없음
      try { await setKv("digest_last_auto", `${today} ${target}`); } catch { /* 표시용 */ }
    }
    return NextResponse.json({ ok: r.ok, time: target, sent: r.ok, error: r.error, markError, counts: digest.counts, failed: digest.failed });
  }

  // 관리자 수동(또는 강제 send) — dedup 없이 즉시. 미리보기는 기본 제목.
  let digest: B2BDigest;
  try { digest = await buildB2BDigest(cfg); }
  catch (e) {
    console.error("[schedule-digest] 알림 내용 조회 실패(수동)", e);
    return NextResponse.json({ ok: false, error: `알림 내용을 불러오지 못했습니다: ${errMsg(e)}` }, { status: 500 });
  }
  if (sp.get("send") === "1") {
    const { text, url } = splitTrailingLink(digest.text);
    const r = await sendTeamsTextSafe(text, { link: url });
    return NextResponse.json({ ok: r.ok, sent: r.ok, error: r.error, counts: digest.counts, failed: digest.failed });
  }
  return NextResponse.json({ ok: true, preview: digest.text, counts: digest.counts, failed: digest.failed, times });
}
