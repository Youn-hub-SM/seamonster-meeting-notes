import { getKv, setKv } from "./b2b-settings";

// 주간 생산 요청서 AI 초안 — 자동 작성 켜기/끄기 · 작성 시각(2026-10-21 대표: 작성 시각과 작성 여부를 설정에서).
//  요일은 수요일 고정(production-schedule DRAFT_WEEKDAY — 권장 수량의 목표 일수가 이 요일 주기로 계산된다).
//  실행: Supabase pg_cron 이 수요일(KST)에 5분마다 초안 API 를 노크(migration 147, body {tick:true})하고,
//  API 가 이 설정을 보고 '작성 시각 ~ +15분' 창 안에서만 만든다. 중계 서버 crontab(수 13:50)은 예비로 남는다 —
//  꺼져 있거나 작성 시각 전이면 아무것도 하지 않는다.
export type DraftSchedule = { enabled: boolean; time: string }; // time = KST HH:MM(5분 단위)
export const DRAFT_SCHEDULE_DEFAULT: DraftSchedule = { enabled: true, time: "13:50" };
export const DRAFT_TICK_WINDOW_MIN = 15; // 작성 시각부터 이 시간 안의 틱만 만든다(실패하면 다음 틱이 다시 시도)

const KEY = "production_draft_schedule";
const DONE_KEY = "production_draft_done"; // 값 = 끝난 작성일(YYYY-MM-DD) — 초안 생성·권장 0·이미 있음. 같은 날 다시 알리지 않게
const LAST_KEY = "production_draft_last_run"; // 값 = "YYYY-MM-DD HH:MM · 결과" — 설정 화면 표시용

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export function normTime(t: string): string | null {
  const m = TIME_RE.exec(String(t || "").trim());
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${String(Math.floor(Number(m[2]) / 5) * 5).padStart(2, "0")}`; // 5분 틱 — 그 사이 시각은 울리지 않는다
}

export async function getDraftSchedule(): Promise<DraftSchedule> {
  try {
    const raw = await getKv(KEY);
    if (!raw) return { ...DRAFT_SCHEDULE_DEFAULT };
    const v = JSON.parse(raw) as Partial<DraftSchedule>;
    return { enabled: v.enabled !== false, time: normTime(String(v.time || "")) || DRAFT_SCHEDULE_DEFAULT.time };
  } catch { return { ...DRAFT_SCHEDULE_DEFAULT }; }
}

export async function saveDraftSchedule(p: Partial<DraftSchedule>): Promise<DraftSchedule> {
  const cur = await getDraftSchedule();
  const time = p.time === undefined ? cur.time : normTime(p.time);
  if (!time) throw new Error("작성 시각은 HH:MM 형식이어야 합니다.");
  const next: DraftSchedule = { enabled: p.enabled === undefined ? cur.enabled : !!p.enabled, time };
  await setKv(KEY, JSON.stringify(next));
  return next;
}

export const getDraftDone = () => getKv(DONE_KEY);
export const setDraftDone = (d: string) => setKv(DONE_KEY, d);
export const getDraftLastRun = () => getKv(LAST_KEY);
export async function setDraftLastRun(text: string): Promise<void> { try { await setKv(LAST_KEY, text); } catch { /* 표시용 */ } }
