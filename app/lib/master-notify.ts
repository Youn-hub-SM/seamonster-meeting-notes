// [업무도우미 변경알림] — 상품마스터 변경 시 Teams '업무도우미 변경알림' 채널로 발송.
//  설정은 b2b_settings KV(master_notify_config: 켜기 + 이벤트 체크리스트), 편집은 '생산관리 설정' 페이지.
//  체크리스트는 b2b-activity 의 헬퍼(생산·재고) 이벤트 게이팅과 공유된다.
//  발송은 fire-and-forget — 실패해도 상품 저장을 막지 않는다(console 경고만).
//  (2026-08-23 대청소: Flow 알림봇 발송 제거 — 봇ID·수신자·API키 필드는 저장값 호환을 위해 타입에만 남김)

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

// 상품마스터 변경 알림(이벤트 게이팅 + 작업자 꼬리표). 실패는 삼키고 경고만 — 저장 흐름을 막지 않는다.
//  켜짐·이벤트 체크리스트가 관문이고, 발송은 Teams '업무도우미 변경알림' 채널 단독(2026-08-23 Flow 제거).
export async function notifyMasterChange(event: MasterNotifyEventKey, lines: string[]): Promise<void> {
  try {
    const cfg = await getMasterNotifyConfig();
    if (!cfg.enabled || !cfg.events[event]) return;
    const actor = await currentActor();
    // Teams 발송 — 작업자 꼬리표는 mirrorB2BTeams 가 붙인다. 링크는 상품마스터 화면.
    const base = await getAppBaseUrl();
    await mirrorB2BTeams(lines.join("\n"), actor, base ? `${base}/b2b/products` : null, { helper: true });
  } catch (err) {
    console.warn("[master-notify] notify skipped:", err);
  }
}
