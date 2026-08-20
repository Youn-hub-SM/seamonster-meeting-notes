// [업무도우미 변경알림] — 상품마스터 변경 시 Flow 알림봇으로 '지정 수신자들'에게 발송.
//  기존 B2B 도매 알림봇(flow_bot_*)과 별개의 봇: 봇 ID 기본 BFLOW_300003566171.
//  API 는 B2B 봇과 동일한 notifications/bulk — POST /v1/bots/{botId}/notifications/bulk,
//  headers { x-flow-api-key }, body { receivers:[{receiverId}], title, contents }.
//  설정은 b2b_settings KV(master_notify_*), 편집은 '생산관리 설정' 페이지.
//  발송은 fire-and-forget — 실패해도 상품 저장을 막지 않는다(console 경고만).
//  Teams 미러(2026-08-20) — 같은 내용을 '업무도우미 변경알림' 채널로 병행 발송(생산·재고가
//  b2b-activity 에서 미러되는 것과 같은 규칙). Flow 수신자 미설정이어도 Teams 는 나간다 —
//  전환 완료 시 수신자만 비우면 Flow 는 멎고 Teams 만 남는 구조.

import { getKv, setKv, getAppBaseUrl } from "./b2b-settings";
import { currentActor } from "./b2b-activity";
import { mirrorB2BTeams } from "./b2b-teams";

export const MASTER_NOTIFY_EVENTS = [
  { key: "created", label: "상품 등록", group: "상품마스터" },
  { key: "updated", label: "상품 수정", group: "상품마스터" },
  { key: "deleted", label: "상품 삭제", group: "상품마스터" },
  { key: "bundle", label: "묶음 구성 변경", group: "상품마스터" },
  { key: "import", label: "엑셀 일괄 변경", group: "상품마스터" },
  // 생산·재고 알림(b2b-activity 의 helper 라우팅)도 이 체크리스트로 개별 제어 — 요청 라이프사이클 순서
  { key: "prod_request", label: "생산 요청 등록", group: "생산·재고" },
  { key: "prod_updated", label: "생산 요청 수정(품목·수량·마감일)", group: "생산·재고" },
  { key: "prod_started", label: "생산 시작(진행중 전환)", group: "생산·재고" },
  { key: "prod_receipt", label: "입고 기록(품목별)", group: "생산·재고" },
  { key: "prod_receipt_cancel", label: "입고 취소", group: "생산·재고" },
  { key: "prod_completed", label: "생산 완료", group: "생산·재고" },
  { key: "prod_cancelled", label: "생산 요청 취소", group: "생산·재고" },
  { key: "prod_deleted", label: "생산 요청 삭제", group: "생산·재고" },
  { key: "inv_move", label: "재고 이전(소매→도매)", group: "생산·재고" },
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
  events: { created: true, updated: true, deleted: true, bundle: true, import: true, prod_request: true, prod_updated: true, prod_started: true, prod_receipt: true, prod_receipt_cancel: true, prod_completed: true, prod_cancelled: true, prod_deleted: true, inv_move: true },
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
//  켜짐·이벤트 체크리스트는 Flow·Teams 공통 관문(꺼진 이벤트는 어디로도 안 감),
//  수신자 목록은 Flow 봇 전용 조건 — Teams 는 자체 설정(b2b_teams)으로만 추가 게이팅된다.
export async function notifyMasterChange(event: MasterNotifyEventKey, lines: string[]): Promise<void> {
  try {
    const cfg = await getMasterNotifyConfig();
    if (!cfg.enabled || !cfg.events[event]) return;
    const actor = await currentActor();
    // Teams 미러 — 작업자 꼬리표는 mirrorB2BTeams 가 붙인다. 링크는 상품마스터 화면.
    void getAppBaseUrl()
      .then((base) => mirrorB2BTeams(lines.join("\n"), actor, base ? `${base}/b2b/products` : null, { helper: true }))
      .catch(() => {});
    if (!cfg.receivers.trim()) return;
    const body = [...lines, actor ? `— 작업자: ${actor}` : ""].filter(Boolean).join("\n");
    await sendMasterBot(body);
  } catch (err) {
    console.warn("[master-notify] notify skipped:", err);
  }
}
