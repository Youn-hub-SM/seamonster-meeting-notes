// 씨몬스터 B2B 알림 → Microsoft Teams 채널 발송 (서버 전용, 2026-08-20 도입).
//  Teams 'Workflows' 웹훅("웹후크 요청을 받으면 채널에 게시")으로 POST 한다 — 페이로드는 Adaptive Card.
//  b2b-activity.sendWebhook 이 기존 경로(헬퍼봇/Flow/Zapier)와 별개로 미러를 부르고,
//  아침 일정 브리핑(schedule-digest)도 Flow 발송과 병행해 호출한다.
//  실패·미설정은 조용히 무시 — 미러가 본 알림·기록을 막으면 안 된다.
//  (Swit 미러(b2b-swit)와 같은 자리·같은 규칙 — 도입 확정 시 Flow 를 끄고 Teams 만 남긴다.)

import { supabaseAdmin } from "./supabase";

const KV_KEY = "b2b_teams";

// url = 'B2B 알림' 채널(발주 알림·일정 브리핑), helperUrl = '업무도우미 변경알림' 채널(생산·재고).
//  Flow 의 봇 2종(기본 봇 / 업무도우미 변경알림 봇) 구조를 채널 2개로 그대로 매핑한다.
//  helperUrl 이 비어 있으면 helper 알림도 url 로 보낸다(Flow 의 '헬퍼봇 미구성 시 기본 봇 폴백'과 동일).
export type B2BTeamsConfig = { url: string; helperUrl: string; enabled: boolean };

export async function getB2BTeamsConfig(): Promise<B2BTeamsConfig> {
  try {
    const { data } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KV_KEY).maybeSingle();
    const v = (data?.value ?? {}) as Partial<B2BTeamsConfig>;
    return {
      url: typeof v.url === "string" ? v.url : "",
      helperUrl: typeof v.helperUrl === "string" ? v.helperUrl : "",
      enabled: !!v.enabled,
    };
  } catch {
    return { url: "", helperUrl: "", enabled: false };
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
  // text 필드: '메시지 게시(텍스트)' 플로우용 전문 — Teams 가 HTML 로 렌더하므로
  //  본문은 이스케이프하고, 링크는 <a> 로 감싸 클릭되게 하며, 제목은 <b> 로 굵힌다.
  //  (평문 URL 은 HTML 게시에서 자동 링크가 안 돼 '글자로만' 보였다 — 대표 보고)
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plainParts: string[] = [];
  if (opts?.title) plainParts.push(`<b>${esc(opts.title)}</b>`);
  plainParts.push(esc(text));
  if (opts?.link) plainParts.push(`<a href="${opts.link}">자세히 보기</a>`);
  return {
    type: "message",
    // 기본 템플릿(카드 게시)은 attachments 만 읽어 이 필드를 무시한다.
    // 플로우를 '채널에 메시지 게시'(텍스트)로 바꾸면 body 의 text 를 본문으로 매핑해 쓸 수 있다 —
    // 일반 메시지는 모바일 목록·알림 미리보기에 본문이 그대로 보인다.
    text: plainParts.join("\n\n"),
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
export async function mirrorB2BTeams(
  summary: string,
  actor: string | null,
  link?: string | null,
  opts?: { helper?: boolean },
): Promise<void> {
  try {
    const cfg = await getB2BTeamsConfig();
    if (!cfg.enabled) return;
    // 생산·재고(업무도우미 변경알림)는 전용 채널로, 없으면 B2B 채널로 폴백
    const target = opts?.helper ? (cfg.helperUrl || cfg.url) : cfg.url;
    if (!target) return;
    let text = summary;
    if (actor) text += `\n— 작업자: ${actor}`;
    await sendTeamsWebhook(target, text, { title: opts?.helper ? "업무도우미 변경알림" : "씨몬스터 B2B", link });
  } catch {
    /* 미러 실패가 본 알림을 막지 않는다 */
  }
}

// 일정 브리핑 등 완성된 본문 발송 — 설정이 켜져 있을 때만. 던지지 않고 결과를 돌려준다
//  (다이제스트 크론이 이 결과로 발송 성공을 판정한다 — Flow 제거 후 Teams 가 유일한 경로).
export async function sendTeamsTextSafe(text: string, opts?: { link?: string | null }): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = await getB2BTeamsConfig();
    if (!cfg.enabled || !cfg.url) return { ok: false, error: "Teams 알림이 꺼져 있거나 URL이 없습니다(B2B 설정)." };
    // 브리핑은 첫 줄이 제목이라 별도 title 없이 본문 그대로 — 첫 줄을 굵게 올린다.
    const [first, ...rest] = text.split("\n");
    const r = await sendTeamsWebhook(cfg.url, rest.join("\n"), { title: first, link: opts?.link });
    return r.ok ? { ok: true } : { ok: false, error: r.error || `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "발송 실패" };
  }
}
