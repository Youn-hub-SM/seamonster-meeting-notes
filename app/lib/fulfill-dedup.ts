import { supabaseAdmin } from "./supabase";
import { setKv } from "./b2b-settings";

// 온라인 발주 '이미 처리된 주문' 중복 방지 설정 — b2b_settings KV(fulfill_dedup_config).
//  운영자가 온라인 발주 > 단가 설정에서 켜고/끄고, 판정 기준·조회 창을 조정할 수 있다.

export type DedupMatch = "order_and_items" | "order_only";
export type DedupConfig = {
  enabled: boolean;    // 중복 자동 제외 사용
  match: DedupMatch;   // 판정 기준: 주문번호+상품구성(기본) / 주문번호만
  windowDays: number;  // 며칠 이내 출고 완료분과 대조할지(기본 45)
};

export const DEDUP_DEFAULT: DedupConfig = { enabled: true, match: "order_and_items", windowDays: 45 };
// 대조 기간 최소 — 누적 다운로드 파일 범위와 ④ 출고 주문일 허용(14일)보다 넉넉하게. 짧으면 이미 출고한 주문이 다시 실린다.
export const DEDUP_MIN_DAYS = 30;
export const DEDUP_MAX_DAYS = 180;
const KEY = "fulfill_dedup_config";

const clampDays = (v: unknown) => Math.min(DEDUP_MAX_DAYS, Math.max(DEDUP_MIN_DAYS, Math.round(Number(v) || DEDUP_DEFAULT.windowDays)));

// 조회 오류는 던진다 — 기본값으로 대신하면 '주문번호만' 기준이 조용히 '주문번호+구성'으로 바뀌어 덜 거른다(S4).
export async function getDedupConfig(): Promise<DedupConfig> {
  const { data, error } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KEY).maybeSingle();
  if (error) throw new Error(`중복 방지 설정을 읽지 못했습니다(${error.message})`);
  const v = data?.value as { v?: string } | string | null | undefined;
  const raw = typeof v === "string" ? v : v?.v;
  if (!raw || !String(raw).trim()) return { ...DEDUP_DEFAULT };
  try {
    const j = JSON.parse(String(raw)) as Partial<DedupConfig>;
    return {
      enabled: j.enabled !== false,
      match: j.match === "order_only" ? "order_only" : "order_and_items",
      windowDays: clampDays(j.windowDays),
    };
  } catch { return { ...DEDUP_DEFAULT }; }
}

export async function setDedupConfig(cfg: DedupConfig): Promise<DedupConfig> {
  const clean: DedupConfig = {
    enabled: cfg.enabled !== false,
    match: cfg.match === "order_only" ? "order_only" : "order_and_items",
    windowDays: clampDays(cfg.windowDays),
  };
  await setKv(KEY, JSON.stringify(clean));
  return clean;
}
