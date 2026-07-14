import { randomUUID } from "node:crypto";
import { getKv, setKv } from "./b2b-settings";

// 메타 소재 라이브러리 — 잘 나온 소재를 아카이빙해 재사용. b2b_settings 에 JSON 배열로 보관(테이블/RLS 불필요).
//  · 업로드 대신 '광고 라이브러리 URL'(adLibraryUrl)로 이미지·영상을 확인 → 스토리지 부담 없음.
//  · 소재 기획 규칙: 모든 소재는 후킹(hook)+스토리(story)+제안(offer) 3요소를 반드시 포함.

export type CreativeFormat = "영상" | "이미지";
export type SavedCreative = {
  id: string;
  name: string;               // 소재 이름/컨셉
  format: CreativeFormat;      // 영상 | 이미지
  hook: string;               // ① 후킹 (첫 1~3초·첫 문장, 시선 잡기)
  story: string;              // ② 스토리 (문제→공감→해결 전개)
  offer: string;              // ③ 제안 (혜택·CTA·구매 유도)
  adLibraryUrl: string;       // 메타 광고 라이브러리 링크(이미지/영상 확인)
  note?: string;              // 메모
  roas?: number;              // 저장 당시 참고 지표
  spend?: number;
  purchases?: number;
  sourceAdId?: string;        // 원본 메타 광고 id(있으면)
  createdAt: string;
};

const KEY = "meta_saved_creatives";

export async function getSavedCreatives(): Promise<SavedCreative[]> {
  const raw = await getKv(KEY);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? (v as SavedCreative[]) : []; } catch { return []; }
}

async function writeList(list: SavedCreative[]): Promise<void> {
  await setKv(KEY, JSON.stringify(list.slice(0, 200))); // 최신 우선, 최대 200개
}

export async function addSavedCreative(c: Omit<SavedCreative, "id" | "createdAt">): Promise<SavedCreative> {
  const list = await getSavedCreatives();
  const rec: SavedCreative = { ...c, id: randomUUID(), createdAt: new Date().toISOString() };
  await writeList([rec, ...list]);
  return rec;
}

export async function deleteSavedCreative(id: string): Promise<void> {
  const list = await getSavedCreatives();
  await writeList(list.filter((x) => x.id !== id));
}
