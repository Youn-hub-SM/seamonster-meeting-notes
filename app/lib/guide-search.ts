// 사용 가이드 검색 매처 — /guide 화면과 전역 검색(Ctrl+K, app/components/GlobalSearch.tsx)이 같이 쓴다.
//  항목의 메뉴명·설명·단계·주의·검색어를 한 줄로 합쳐 공용 한글 매처(초성·영문자판)로 비교한다.
//  두 화면의 결과가 같아야 하므로 매칭 규칙은 여기 한 곳에만 둔다.

import { GUIDE, type GuideEntry } from "./guide-data";
import { matchKoQuery } from "./hangul";

export function matchesGuideEntry(e: GuideEntry, q: string): boolean {
  const hay = [e.label, e.what, ...e.steps, ...(e.tips || []), ...(e.keywords || [])].join(" ");
  return matchKoQuery(hay, q);
}

export type GuideHit = { entry: GuideEntry; tool: string; category: string };

// 가이드 전체를 메뉴 순서대로 훑어 매칭 항목을 limit 개까지 돌려준다(전역 검색 '가이드' 묶음용).
export function searchGuide(q: string, limit = 6): GuideHit[] {
  const query = q.trim();
  if (!query) return [];
  const out: GuideHit[] = [];
  for (const cat of GUIDE) {
    for (const t of cat.tools) {
      for (const e of t.entries) {
        if (!matchesGuideEntry(e, query)) continue;
        out.push({ entry: e, tool: t.tool, category: cat.category });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
