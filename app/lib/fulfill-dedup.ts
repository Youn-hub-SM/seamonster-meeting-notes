import { getKv, setKv } from "./b2b-settings";

// 온라인 발주 '이미 처리된 주문' 중복 방지 설정 — b2b_settings KV(fulfill_dedup_config).
//  운영자가 온라인 발주 > 단가 설정에서 켜고/끄고, 판정 기준·조회 창을 조정할 수 있다.

export type DedupMatch = "order_and_items" | "order_only";
export type DedupConfig = {
  enabled: boolean;    // 중복 자동 제외 사용
  match: DedupMatch;   // 판정 기준: 주문번호+상품구성(기본) / 주문번호만
  windowDays: number;  // 며칠 이내 출고 완료분과 대조할지(기본 45)
};

export const DEDUP_DEFAULT: DedupConfig = { enabled: true, match: "order_and_items", windowDays: 45 };
const KEY = "fulfill_dedup_config";

export async function getDedupConfig(): Promise<DedupConfig> {
  const raw = await getKv(KEY);
  if (!raw) return { ...DEDUP_DEFAULT };
  try {
    const j = JSON.parse(raw) as Partial<DedupConfig>;
    return {
      enabled: j.enabled !== false,
      match: j.match === "order_only" ? "order_only" : "order_and_items",
      windowDays: Math.min(180, Math.max(1, Math.round(Number(j.windowDays) || DEDUP_DEFAULT.windowDays))),
    };
  } catch { return { ...DEDUP_DEFAULT }; }
}

export async function setDedupConfig(cfg: DedupConfig): Promise<DedupConfig> {
  const clean: DedupConfig = {
    enabled: cfg.enabled !== false,
    match: cfg.match === "order_only" ? "order_only" : "order_and_items",
    windowDays: Math.min(180, Math.max(1, Math.round(Number(cfg.windowDays) || DEDUP_DEFAULT.windowDays))),
  };
  await setKv(KEY, JSON.stringify(clean));
  return clean;
}
