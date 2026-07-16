// [업무도우미 변경알림] — 상품마스터 변경 시 Flow '채팅방'에 메시지 발송.
//  기존 B2B 알림봇(notifications/bulk, b2b-activity)과 별개 채널: Chats API 로 특정 채팅방에 직접 발송.
//  API: POST https://api.flow.team/v1/chats/{roomId}/messages
//       headers { x-flow-api-key }, body { registerId, contents }
//  설정은 b2b_settings KV(master_notify_*), 편집은 설정 페이지의 '[업무도우미 변경알림]' 섹션.
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
  roomId: string;      // 수신 채팅방 ID(숫자)
  registerId: string;  // 작성자 ID
  title: string;       // 메시지 머리말
  events: Record<MasterNotifyEventKey, boolean>;
};

const DEFAULTS: MasterNotifyConfig = {
  enabled: false,
  roomId: "3403419", // 업무도우미 변경알림 채팅방
  registerId: "seamonster.kr2@gmail.com",
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
      roomId: String(j.roomId || ""),
      registerId: String(j.registerId || DEFAULTS.registerId),
      title: String(j.title || DEFAULTS.title),
      events: { ...DEFAULTS.events, ...(j.events || {}) },
    };
  } catch { return { ...DEFAULTS, events: { ...DEFAULTS.events } }; }
}
export async function setMasterNotifyConfig(cfg: MasterNotifyConfig): Promise<void> {
  await setKv("master_notify_config", JSON.stringify(cfg));
}

// API 키 — 전용 키(master_notify_api_key)가 없으면 기존 Flow 키(flow_api_key, VOC 연동과 동일)로 폴백.
export async function getMasterNotifyApiKey(): Promise<string> {
  return (await getKv("master_notify_api_key")) || (await getKv("flow_api_key"));
}
export const setMasterNotifyApiKey = (s: string) => setKv("master_notify_api_key", s);

// 채팅방 메시지 발송(저수준). roomId·contents 필수.
export async function sendMasterChat(contents: string, opts?: { roomId?: string; registerId?: string }): Promise<{ ok: boolean; status: number; error?: string }> {
  const cfg = await getMasterNotifyConfig();
  const apiKey = await getMasterNotifyApiKey();
  const roomId = String(opts?.roomId ?? cfg.roomId).trim();
  const registerId = String(opts?.registerId ?? cfg.registerId).trim();
  if (!apiKey) return { ok: false, status: 0, error: "Flow API 키가 없습니다(설정에서 입력)." };
  if (!/^\d{1,15}$/.test(roomId)) return { ok: false, status: 0, error: "채팅방 ID 는 숫자(최대 15자)여야 합니다." };
  if (!registerId) return { ok: false, status: 0, error: "작성자 ID 가 없습니다." };
  try {
    const res = await fetch(`https://api.flow.team/v1/chats/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-flow-api-key": apiKey },
      body: JSON.stringify({ registerId, contents: contents.slice(0, 10000) }),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      console.warn("[master-notify] flow chat send failed", res.status, text.slice(0, 200));
      return { ok: false, status: res.status, error: text.slice(0, 200) || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    console.error("[master-notify] flow chat send error", err);
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

// 상품마스터 변경 알림(이벤트 게이팅 + 작업자 꼬리표). 실패는 삼키고 경고만 — 저장 흐름을 막지 않는다.
export async function notifyMasterChange(event: MasterNotifyEventKey, lines: string[]): Promise<void> {
  try {
    const cfg = await getMasterNotifyConfig();
    if (!cfg.enabled || !cfg.events[event] || !cfg.roomId) return;
    const actor = await currentActor();
    const body = [cfg.title, ...lines, actor ? `작업자: ${actor}` : ""].filter(Boolean).join("\n");
    await sendMasterChat(body);
  } catch (err) {
    console.warn("[master-notify] notify skipped:", err);
  }
}
