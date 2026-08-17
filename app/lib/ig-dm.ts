// 인스타 자동 DM — 계정 저장(b2b_settings KV)·규칙 판정·클릭 링크 파싱. (서버 전용: KV 접근)
import { getKv, setKv } from "./b2b-settings";

// ── 계정(3개 운영) ── 토큰은 env 가 아니라 KV: 계정이 여럿이고 60일마다 갱신되는 값이라 화면에서 관리.
export type IgAccount = {
  igUserId: string;    // 웹훅 entry.id 와 매칭
  username: string;
  token: string;       // Instagram Login 장기 토큰(60일, 갱신 가능)
  updatedAt: string;   // 토큰 저장/갱신 시각 — 오래되면 계정 목록 조회 때 기회적으로 갱신
};

const KEY = "ig_accounts";

export async function getIgAccounts(): Promise<IgAccount[]> {
  const raw = await getKv(KEY);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? (v as IgAccount[]) : []; } catch { return []; }
}

export async function saveIgAccounts(list: IgAccount[]): Promise<void> {
  await setKv(KEY, JSON.stringify(list.slice(0, 10)));
}

export async function upsertIgAccount(acc: IgAccount): Promise<IgAccount[]> {
  const list = await getIgAccounts();
  const next = [...list.filter((a) => a.igUserId !== acc.igUserId), acc];
  await saveIgAccounts(next);
  return next;
}

export async function removeIgAccount(igUserId: string): Promise<IgAccount[]> {
  const next = (await getIgAccounts()).filter((a) => a.igUserId !== igUserId);
  await saveIgAccounts(next);
  return next;
}

// 규칙 판정·치환·링크 파싱(순수 함수)은 ig-rules.ts — 서버 의존 없이 웹훅·테스트가 같은 로직을 쓴다.
