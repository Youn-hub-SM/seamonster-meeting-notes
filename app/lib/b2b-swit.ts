// 씨몬스터 B2B 알림 → Swit 미러 발송 (서버 전용, Swit 도입 검토용 2026-08-07).
//  Flow 는 봇 API(봇ID+API키) 방식이라 웹훅 URL 재사용이 불가 — Swit 수신 웹훅을 따로 받는다.
//  b2b-activity.sendWebhook 이 기존 경로(헬퍼봇/Flow/Zapier)와 별개로 이 미러를 부른다.
//  실패·미설정은 조용히 무시 — 미러가 본 알림·기록을 막으면 안 된다.

import { supabaseAdmin } from "./supabase";
import { sendSwit } from "./factory-notify";

const KV_KEY = "b2b_swit";

export type B2BSwitConfig = { url: string; enabled: boolean };

export async function getB2BSwitConfig(): Promise<B2BSwitConfig> {
  try {
    const { data } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KV_KEY).maybeSingle();
    const v = (data?.value ?? {}) as Partial<B2BSwitConfig>;
    return { url: typeof v.url === "string" ? v.url : "", enabled: !!v.enabled };
  } catch {
    return { url: "", enabled: false };
  }
}

export async function setB2BSwitConfig(cfg: B2BSwitConfig): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("b2b_settings")
    .upsert({ key: KV_KEY, value: cfg, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

// 알림 미러 — Flow 와 같은 요약을 Swit 채널로.
//  link 는 호출부(b2b-activity)가 b2bAlertLink 로 만들어 넘긴다 — 여기서 만들면 순환 import.
//  Flow 는 링크를 별도 '자세히 보기' 필드로 보내지만 Swit 수신 웹훅엔 그런 필드가 없어
//  본문 마지막 줄에 URL 을 그대로 붙인다(Swit 이 자동 링크로 렌더).
export async function mirrorB2BSwit(summary: string, actor: string | null, link?: string | null): Promise<void> {
  try {
    const cfg = await getB2BSwitConfig();
    if (!cfg.enabled || !cfg.url) return;
    let text = `[씨몬스터 B2B] ${summary}`;
    if (actor) text += `\n— 작업자: ${actor}`;
    if (link) text += `\n${link}`;
    await sendSwit(cfg.url, text);
  } catch {
    /* 미러 실패가 본 알림을 막지 않는다 */
  }
}
