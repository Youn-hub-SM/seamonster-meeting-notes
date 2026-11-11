// 에이전트 예약 설정 — 서버 전용(b2b_settings kv). 순수 계산(dueTargetKey·nextTargetLabel)은 registry.ts.
//  agent_schedule:<agent>      = {on, weekday, hour} JSON
//  agent_schedule_last:<agent> = 마지막으로 실행한 목표 시각 키(YYYY-MM-DDTHH) — 같은 목표를 두 번 실행하지 않는다
//  agent_tick_last             = 예약 신호(pg_cron, migration 165)가 마지막으로 온 시각 — 화면이 '신호가 안 온다'를 알린다
import { getKv, setKv } from "../b2b-settings";
import { DEFAULT_SCHEDULE, type AgentSchedule } from "./registry";

const key = (agent: string) => `agent_schedule:${agent}`;
const lastKey = (agent: string) => `agent_schedule_last:${agent}`;
const TICK_KEY = "agent_tick_last";

export function normalizeSchedule(v: unknown): AgentSchedule {
  const o = (v && typeof v === "object" ? v : {}) as Partial<AgentSchedule>;
  const weekday = Number(o.weekday), hour = Number(o.hour);
  return {
    on: o.on === true,
    weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : DEFAULT_SCHEDULE.weekday,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_SCHEDULE.hour,
  };
}
export async function getSchedule(agent: string): Promise<AgentSchedule> {
  const raw = await getKv(key(agent));
  if (!raw) return { ...DEFAULT_SCHEDULE };
  try { return normalizeSchedule(JSON.parse(raw)); } catch { return { ...DEFAULT_SCHEDULE }; }
}
export async function setSchedule(agent: string, s: AgentSchedule): Promise<void> { await setKv(key(agent), JSON.stringify(normalizeSchedule(s))); }

export const getLastTarget = (agent: string): Promise<string> => getKv(lastKey(agent));
export const setLastTarget = (agent: string, k: string): Promise<void> => setKv(lastKey(agent), k);
export const getLastTick = (): Promise<string> => getKv(TICK_KEY);
export const markTick = (): Promise<void> => setKv(TICK_KEY, new Date().toISOString());
