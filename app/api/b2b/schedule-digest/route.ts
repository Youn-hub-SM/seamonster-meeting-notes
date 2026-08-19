import { NextRequest, NextResponse } from "next/server";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { buildB2BDigest, getDigestConfig, getDigestLastSent, kstDateStr } from "@/app/lib/b2b-digest";
import { getKv, setKv } from "@/app/lib/b2b-settings";
import { sendFlowText } from "@/app/lib/b2b-activity";
import { sendTeamsTextSafe } from "@/app/lib/b2b-teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

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

// GET — 크론이 호출(Authorization: Bearer CRON_SECRET/DIGEST_CRON_KEY 또는 ?key=).
//  발송 시각은 설정(digest_config.times, KST HH:MM 5분 단위 목록)이 정한다 — 설정에서 바꾸면
//  SQL 을 다시 만질 필요 없이 즉시 반영된다.
//  · 주 발송: Supabase pg_cron 틱(migration 092)이 5분마다 ?gate=times 로 호출 → 현재 5분 칸이
//    목록에 있으면 그 시각으로 발송(정각, 수 초 이내).
//  · 예비: vercel.json 크론 2개(06시대·16시대, Hobby 는 ±59분) — 최근 75분 안에 지나간 미발송
//    시각이 있으면 대신 보낸다. 틱이 이미 보냈으면 dedup(시각별·하루 1회)이 걸러 조용히 건너뛴다.
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

  const cfg = await getDigestConfig();
  const times = (cfg.times?.length ? [...cfg.times] : ["06:00", "16:00"]).sort();
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const kstNow = new Date(Date.now() + 9 * 3600_000);
  const nowMin = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
  const today = kstDateStr();
  const keyFor = (t: string) => `digest_sent_${t.replace(":", "")}`; // 값 = 마지막 발송일
  const sentToday = async (t: string): Promise<boolean> => {
    if ((await getKv(keyFor(t))) === today) return true;
    // 구 버전 키 호환 — 전환 당일 이중 발송 방지(아침=digest_last_sent, 오후=digest_last_sent_pm)
    if (t === times[0] && (await getDigestLastSent()) === today) return true;
    if (toMin(t) >= 720 && (await getKv("digest_last_sent_pm")) === today) return true;
    return false;
  };
  const titled = (t: string) =>
    t === times[0] ? cfg : { ...cfg, title: `${cfg.title} (${toMin(t) >= 720 ? "오후" : "중간"} 확인)` };

  // 크론: 활성 확인 → 대상 시각 결정 → 시각별 dedup → 발송
  if (isCron && sp.get("send") !== "1") {
    if (!cfg.enabled) return NextResponse.json({ ok: true, skipped: "disabled" });

    let target: string | null = null;
    if (sp.get("gate") === "times") {
      // pg_cron 틱 — 지금이 정확히 그 5분 칸일 때만
      const tick = Math.floor(nowMin / 5) * 5;
      target = times.find((t) => toMin(t) === tick) ?? null;
      if (!target) return NextResponse.json({ ok: true, skipped: `no-time-at-${tick}` });
    } else {
      // 예비(Vercel, ±59분) — 최근 75분 안에 지나간 시각 중 가장 늦은 미발송 건.
      //  창을 제한하는 이유: 배포 직후 등에 한나절 전 시각까지 소급 발송하면 뜬금없는 알림이 된다.
      for (const t of [...times].reverse()) {
        if (toMin(t) <= nowMin && nowMin - toMin(t) <= 75 && !(await sentToday(t))) { target = t; break; }
      }
      if (!target) return NextResponse.json({ ok: true, skipped: "nothing-due" });
    }

    if (await sentToday(target)) return NextResponse.json({ ok: true, time: target, skipped: "already-sent" });
    const digest = await buildB2BDigest(titled(target));
    const { text, url } = splitTrailingLink(digest.text);
    const r = await sendFlowText(text, { url });
    await sendTeamsTextSafe(text, { link: url }); // Teams 병행 — 미설정·실패는 조용히(성공 판정은 Flow 기준 유지)
    if (r.ok) await setKv(keyFor(target), today);
    return NextResponse.json({ ok: r.ok, time: target, sent: r.ok, error: r.error, counts: digest.counts });
  }

  // 관리자 수동(또는 강제 send) — dedup 없이 즉시. 미리보기는 기본 제목.
  const digest = await buildB2BDigest(cfg);
  if (sp.get("send") === "1") {
    const { text, url } = splitTrailingLink(digest.text);
    const r = await sendFlowText(text, { url });
    await sendTeamsTextSafe(text, { link: url });
    return NextResponse.json({ ok: r.ok, sent: r.ok, error: r.error, counts: digest.counts });
  }
  return NextResponse.json({ ok: true, preview: digest.text, counts: digest.counts, times });
}
