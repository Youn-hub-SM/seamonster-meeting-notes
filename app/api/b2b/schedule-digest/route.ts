import { NextRequest, NextResponse } from "next/server";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { buildB2BDigest, getDigestConfig, getDigestLastSent, setDigestLastSent, kstHour, kstDateStr } from "@/app/lib/b2b-digest";
import { getKv, setKv } from "@/app/lib/b2b-settings";
import { sendFlowText } from "@/app/lib/b2b-activity";

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

// GET — 크론이 호출(Authorization: Bearer CRON_SECRET 또는 ?key=).
//  주 발송은 Supabase pg_cron(migration 091)이 06:00·16:00 KST 정각에 호출한다 —
//  Vercel Hobby 크론은 공식적으로 ±59분 정밀도라 정시가 안 된다. vercel.json 의 크론 2개는
//  예비로 남긴다: 슬롯별 dedup 때문에 pg_cron 이 이미 보냈으면 조용히 건너뛰고,
//  pg_cron 이 실패한 날에만 (늦게라도) 보낸다.
//  Vercel Hobby는 크론 1개당 '하루 1회'로 제한되지만 크론 자체는 2개까지 둘 수 있고,
//  여러 크론이 같은 경로를 공유하는 것도 공식 지원된다(vercel.json 참고). 그래서 같은 경로를
//  아침 06:00 · 오후 16:00 KST 두 번 호출해 하루 두 번 보낸다 — Pro 결제 없이.
//  둘을 가르는 건 호출 시각(KST 12시 기준)이다. 크론 표현식 헤더(x-vercel-cron-schedule)를 쓰지 않는 이유는
//  vercel.json 의 시각을 바꿀 때마다 이 파일도 같이 고쳐야 해서다. 수동 테스트는 ?slot=am|pm 로 덮어쓴다.
//  dedup 은 슬롯마다 따로 — 아침을 보냈다고 오후가 막히면 안 된다.
//  시간별 트리거(Vercel Pro 또는 외부 스케줄러)를 쓸 땐 ?gate=hour 로 설정 시각(cfg.hour)에만 발송.
//  활성(enabled)·하루 1회 dedup은 두 경우 모두 적용. 관리자 수동은 미리보기/?send=1.
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const slotParam = sp.get("slot");
  const slot: "am" | "pm" = slotParam === "pm" || slotParam === "am" ? slotParam : kstHour() >= 12 ? "pm" : "am";
  const lastSent = () => (slot === "pm" ? getKv("digest_last_sent_pm") : getDigestLastSent());
  const markSent = (d: string) => (slot === "pm" ? setKv("digest_last_sent_pm", d) : setDigestLastSent(d));
  // 오후 발송은 '남은 일'을 다시 짚는 성격이라 제목으로 구분한다(내용 계산은 아침과 동일).
  const cfgFor = (c: Awaited<ReturnType<typeof getDigestConfig>>) =>
    slot === "pm" ? { ...c, title: `${c.title} (오후 확인)` } : c;
  const secret = process.env.CRON_SECRET || "";
  // pg_cron(정시 발송, migration 091) 전용 보조 키 — CRON_SECRET 은 Vercel 에 '민감' 변수로
  //  저장돼 값을 다시 꺼낼 수 없어서, 기존 크론을 안 건드리고 별도 키를 하나 더 인정한다.
  const extraKey = process.env.DIGEST_CRON_KEY || "";
  const authz = req.headers.get("authorization") || "";
  const matches = (k: string) => !!k && (authz === `Bearer ${k}` || sp.get("key") === k);
  const isCron = matches(secret) || matches(extraKey);
  const name = await userOf(req);
  const isAdmin = name === "관리자" || name === "현석";
  if (!isCron && !isAdmin) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });

  const cfg = await getDigestConfig();

  // 크론: 활성·(선택적 시각 게이트)·중복 검사 후 발송
  if (isCron && sp.get("send") !== "1") {
    if (!cfg.enabled) return NextResponse.json({ ok: true, skipped: "disabled" });
    if (sp.get("gate") === "hour" && kstHour() !== cfg.hour) return NextResponse.json({ ok: true, skipped: `hour ${kstHour()}!=${cfg.hour}` });
    const today = kstDateStr();
    if ((await lastSent()) === today) return NextResponse.json({ ok: true, slot, skipped: "already-sent" });
    const digest = await buildB2BDigest(cfgFor(cfg));
    const { text, url } = splitTrailingLink(digest.text);
    const r = await sendFlowText(text, { url });
    if (r.ok) await markSent(today);
    return NextResponse.json({ ok: r.ok, slot, sent: r.ok, error: r.error, counts: digest.counts });
  }

  // 관리자 수동(또는 강제 send) — ?slot=pm 으로 오후본을 그대로 미리 볼 수 있다
  const digest = await buildB2BDigest(cfgFor(cfg));
  if (sp.get("send") === "1") {
    const { text, url } = splitTrailingLink(digest.text);
    const r = await sendFlowText(text, { url });
    return NextResponse.json({ ok: r.ok, slot, sent: r.ok, error: r.error, counts: digest.counts });
  }
  return NextResponse.json({ ok: true, slot, preview: digest.text, counts: digest.counts });
}
