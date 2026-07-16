import { getKv, setKv } from "./b2b-settings";

// 메타 캠페인 증액 이력 — '주 1회 증액' 규칙을 화면 문구가 아니라 실제로 강제하기 위한 기록.
//  플레이북은 "주 1회 +N%"라고 안내하는데 버튼에 아무 제한이 없으면, 규칙을 모르는 사람이
//  하루에 여러 번 눌러 예산이 배로 뛸 수 있다. 되돌릴 수 없는 지출이라 서버에서 막는다.
//  b2b_settings 에 JSON 으로 보관(캠페인 수십 개 규모라 별도 테이블 불필요). [meta-creatives 와 동일한 방식]

export type ScaleEntry = { at: string; from: number; to: number };
export type ScaleLog = Record<string, ScaleEntry>; // campaignId → 마지막 증액 기록

const KEY = "meta_scale_log";
const MAX_ENTRIES = 200;

/** 증액 후 이 기간이 지나야 다시 증액할 수 있다(= '주 1회'). */
export const SCALE_COOLDOWN_DAYS = 7;

export async function getScaleLog(): Promise<ScaleLog> {
  const raw = await getKv(KEY);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as ScaleLog) : {};
  } catch { return {}; }
}

export async function recordScale(campaignId: string, from: number, to: number): Promise<ScaleLog> {
  const log = await getScaleLog();
  log[campaignId] = { at: new Date().toISOString(), from, to };
  // 오래된 기록부터 잘라냄(쿨다운 판정에는 마지막 것만 쓰므로 손실 없음)
  const trimmed: ScaleLog = Object.fromEntries(
    Object.entries(log)
      .sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, MAX_ENTRIES)
  );
  await setKv(KEY, JSON.stringify(trimmed));
  return trimmed;
}

/** 마지막 증액 이후 지난 일수(소수). 이력이 없으면 null(= 증액한 적 없음). */
export function daysSinceScale(entry: ScaleEntry | undefined, now = Date.now()): number | null {
  if (!entry?.at) return null;
  const t = Date.parse(entry.at);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 86_400_000;
}

/** 쿨다운이 남아 있으면 사유 문자열, 증액 가능하면 null. 서버·화면이 같은 규칙을 쓰도록 여기 한 곳에 둔다. */
export function scaleBlockedReason(entry: ScaleEntry | undefined, now = Date.now()): string | null {
  const days = daysSinceScale(entry, now);
  if (days === null || days >= SCALE_COOLDOWN_DAYS) return null;
  const left = Math.ceil(SCALE_COOLDOWN_DAYS - days);
  return `${Math.floor(days)}일 전에 증액했습니다 — ${left}일 뒤에 다시 증액할 수 있습니다 (주 1회 규칙)`;
}
