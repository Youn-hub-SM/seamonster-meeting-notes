// [업무도우미 변경알림] — 상품마스터 변경 시 Flow 알림봇으로 '지정 수신자들'에게 발송.
//  기존 B2B 도매 알림봇(flow_bot_*)과 별개의 봇: 봇 ID 기본 BFLOW_300003566171.
//  API 는 B2B 봇과 동일한 notifications/bulk — POST /v1/bots/{botId}/notifications/bulk,
//  headers { x-flow-api-key }, body { receivers:[{receiverId}], title, contents }.
//  설정은 b2b_settings KV(master_notify_*), 편집은 '생산관리 설정' 페이지.
//  발송은 fire-and-forget — 실패해도 상품 저장을 막지 않는다(console 경고만).

import { getKv, setKv } from "./b2b-settings";
import { currentActor } from "./b2b-activity";

export const MASTER_NOTIFY_EVENTS = [
  { key: "created", label: "상품 등록" },
  { key: "updated", label: "상품 수정" },
  { key: "deleted", label: "상품 삭제" },
  { key: "bundle", label: "묶음 구성 변경" },
  { key: "import", label: "엑셀 일괄 변경" },
] as const;
export type MasterNotifyEventKey = (typeof MASTER_NOTIFY_EVENTS)[number]["key"];

export type MasterNotifyConfig = {
  enabled: boolean;
  botId: string;       // Flow 봇 프로퍼티 (BFLOW_...)
  receivers: string;   // 수신자 ID 목록(쉼표 구분) — 당사자들에게 개별 발송
  title: string;       // 알림 제목
  events: Record<MasterNotifyEventKey, boolean>;
};

const DEFAULTS: MasterNotifyConfig = {
  enabled: false,
  botId: "BFLOW_300003566171",
  receivers: "",
  title: "[업무도우미 변경알림]",
  events: { created: true, updated: true, deleted: true, bundle: true, import: true },
};

export async function getMasterNotifyConfig(): Promise<MasterNotifyConfig> {
  const raw = await getKv("master_notify_config");
  if (!raw) return { ...DEFAULTS, events: { ...DEFAULTS.events } };
  try {
    const j = JSON.parse(raw) as Partial<MasterNotifyConfig>;
    return {
      enabled: j.enabled === true,
      botId: String(j.botId || DEFAULTS.botId),
      receivers: String(j.receivers || ""),
      title: String(j.title || DEFAULTS.title),
      events: { ...DEFAULTS.events, ...(j.events || {}) },
    };
  } catch { return { ...DEFAULTS, events: { ...DEFAULTS.events } }; }
}
export async function setMasterNotifyConfig(cfg: MasterNotifyConfig): Promise<void> {
  await setKv("master_notify_config", JSON.stringify(cfg));
}

// API 키 — 이 봇 전용 키(master_notify_api_key). 없으면 B2B 알림봇 키(flow_bot_api_key)로 폴백(같은 워크스페이스 키일 때).
export async function getMasterNotifyApiKey(): Promise<string> {
  return (await getKv("master_notify_api_key")) || (await getKv("flow_bot_api_key"));
}
export const setMasterNotifyApiKey = (s: string) => setKv("master_notify_api_key", s);

// 알림봇 발송(저수준) — B2B 봇(sendFlowBotNotify)과 동일한 bulk 페이로드·성공 판정.
export async function sendMasterBot(contents: string, opts?: { receivers?: string[]; title?: string }): Promise<{ ok: boolean; status: number; error?: string }> {
  const cfg = await getMasterNotifyConfig();
  const apiKey = await getMasterNotifyApiKey();
  const receivers = (opts?.receivers ?? cfg.receivers.split(",")).map((r) => r.trim()).filter(Boolean);
  if (!cfg.botId || !apiKey || !receivers.length) {
    return { ok: false, status: 0, error: "변경알림 설정(봇 ID·API 키·수신자)이 완료되지 않았습니다." };
  }
  try {
    const res = await fetch(`https://api.flow.team/v1/bots/${encodeURIComponent(cfg.botId)}/notifications/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-flow-api-key": apiKey },
      body: JSON.stringify({
        receivers: receivers.map((r) => ({ receiverId: r })),
        title: opts?.title || cfg.title || "[업무도우미 변경알림]",
        contents: contents.slice(0, 10000),
      }),
    });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    const resp = (json as { response?: { success?: boolean; message?: string; error?: { message?: string; verbose?: string[] } } } | null)?.response;
    if (!res.ok || resp?.success === false) {
      const msg = resp?.error?.message || resp?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      const verbose = resp?.error?.verbose?.length ? ` (${resp.error.verbose.join(", ")})` : "";
      console.warn("[master-notify] flow bot send failed", res.status, msg);
      return { ok: false, status: res.status, error: `${msg}${verbose}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    console.error("[master-notify] flow bot send error", err);
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

// 상품마스터 변경 알림(이벤트 게이팅 + 작업자 꼬리표). 실패는 삼키고 경고만 — 저장 흐름을 막지 않는다.
export async function notifyMasterChange(event: MasterNotifyEventKey, lines: string[]): Promise<void> {
  try {
    const cfg = await getMasterNotifyConfig();
    if (!cfg.enabled || !cfg.events[event] || !cfg.receivers.trim()) return;
    const actor = await currentActor();
    const body = [...lines, actor ? `— 작업자: ${actor}` : ""].filter(Boolean).join("\n");
    await sendMasterBot(body);
  } catch (err) {
    console.warn("[master-notify] notify skipped:", err);
  }
}
