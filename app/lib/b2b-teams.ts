// 씨몬스터 B2B 알림 → Microsoft Teams 채널 발송 (서버 전용, 2026-08-20 도입).
//  Teams 'Workflows' 웹훅("웹후크 요청을 받으면 채널에 게시")으로 POST 한다 — 페이로드는 Adaptive Card.
//  b2b-activity.sendWebhook 이 기존 경로(헬퍼봇/Flow/Zapier)와 별개로 미러를 부르고,
//  아침 일정 브리핑(schedule-digest)도 Flow 발송과 병행해 호출한다.
//  실패·미설정은 조용히 무시 — 미러가 본 알림·기록을 막으면 안 된다.
//  (Swit 미러(b2b-swit)와 같은 자리·같은 규칙 — 도입 확정 시 Flow 를 끄고 Teams 만 남긴다.)

import { supabaseAdmin } from "./supabase";

const KV_KEY = "b2b_teams";

export type B2BTeamsConfig = { url: string; enabled: boolean };

export async function getB2BTeamsConfig(): Promise<B2BTeamsConfig> {
  try {
    const { data } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KV_KEY).maybeSingle();
    const v = (data?.value ?? {}) as Partial<B2BTeamsConfig>;
    return { url: typeof v.url === "string" ? v.url : "", enabled: !!v.enabled };
  } catch {
    return { url: "", enabled: false };
  }
}

export async function setB2BTeamsConfig(cfg: B2BTeamsConfig): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("b2b_settings")
    .upsert({ key: KV_KEY, value: cfg, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

// 텍스트 → Adaptive Card 페이로드.
//  Teams 렌더러가 TextBlock 안의 단일 \n 을 무시하는 일이 있어, 줄마다 TextBlock 을 만든다
//  (빈 줄은 다음 블록의 간격으로 표현). 링크는 마크다운 [자세히 보기](url) — 카드가 지원한다.
function toAdaptiveCard(text: string, opts?: { title?: string; link?: string | null }) {
  const body: Record<string, unknown>[] = [];
  if (opts?.title) {
    body.push({ type: "TextBlock", text: opts.title, weight: "Bolder", size: "Medium", wrap: true });
  }
  let gap = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) { gap = true; continue; }
    body.push({ type: "TextBlock", text: line, wrap: true, spacing: gap ? "Medium" : "None" });
    gap = false;
  }
  if (opts?.link) {
    body.push({ type: "TextBlock", text: `[자세히 보기](${opts.link})`, wrap: true, spacing: "Medium" });
  }
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
          msteams: { width: "Full" },
        },
      },
    ],
  };
}

// 저수준 발송 — Workflows 웹훅은 접수 시 200/202 를 반환한다.
export async function sendTeamsWebhook(
  url: string,
  text: string,
  opts?: { title?: string; link?: string | null },
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!url.trim()) return { ok: false, status: 0, error: "Teams 웹훅 URL이 비어 있습니다." };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toAdaptiveCard(text, opts)),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "발송 실패" };
  }
}

// 알림 미러 — Flow 와 같은 요약을 Teams 채널로. 각 게시가 채널의 새 스레드가 된다.
//  link 는 호출부(b2b-activity)가 b2bAlertLink 로 만들어 넘긴다 — 여기서 만들면 순환 import.
export async function mirrorB2BTeams(summary: string, actor: string | null, link?: string | null): Promise<void> {
  try {
    const cfg = await getB2BTeamsConfig();
    if (!cfg.enabled || !cfg.url) return;
    let text = summary;
    if (actor) text += `\n— 작업자: ${actor}`;
    await sendTeamsWebhook(cfg.url, text, { title: "씨몬스터 B2B", link });
  } catch {
    /* 미러 실패가 본 알림을 막지 않는다 */
  }
}

// 일정 브리핑 등 완성된 본문 발송 — 설정이 켜져 있을 때만. 실패는 조용히.
export async function sendTeamsTextSafe(text: string, opts?: { link?: string | null }): Promise<void> {
  try {
    const cfg = await getB2BTeamsConfig();
    if (!cfg.enabled || !cfg.url) return;
    // 브리핑은 첫 줄이 제목이라 별도 title 없이 본문 그대로 — 첫 줄을 굵게 올린다.
    const [first, ...rest] = text.split("\n");
    await sendTeamsWebhook(cfg.url, rest.join("\n"), { title: first, link: opts?.link });
  } catch {
    /* 병행 발송 실패가 Flow 발송·크론 응답을 막지 않는다 */
  }
}
