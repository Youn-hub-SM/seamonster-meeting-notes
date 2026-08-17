// 인스타 자동 DM — 규칙 판정·치환·링크 파싱(순수 함수). 서버 의존 없음(웹훅·화면·테스트 공용).
//  계정 저장(KV) 등 서버 전용은 ig-dm.ts.

export type IgRuleLite = { active: boolean; start_at: string | null; end_at: string | null; keyword: string };

/** 지금 이 규칙이 켜져 있는가 — 활성이고, 시작 전이 아니고, 종료 후가 아니다. */
export function isRuleLive(r: Pick<IgRuleLite, "active" | "start_at" | "end_at">, nowMs: number): boolean {
  if (!r.active) return false;
  if (r.start_at && nowMs < Date.parse(r.start_at)) return false;
  if (r.end_at && nowMs > Date.parse(r.end_at)) return false;
  return true;
}

/** 키워드 매칭 — 쉼표 구분 중 하나라도 포함(대소문자 무시). 키워드가 비면 모든 댓글. */
export function matchesKeyword(keyword: string, commentText: string): boolean {
  const kws = (keyword || "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (kws.length === 0) return true;
  const text = (commentText || "").toLowerCase();
  return kws.some((k) => text.includes(k));
}

/** DM 본문 치환 — {닉네임} 을 댓글 작성자 사용자명으로. */
export function renderDm(message: string, username: string): string {
  return (message || "").replaceAll("{닉네임}", username || "").trim();
}

/** 링크에서 브랜드링크 코드 추출 — link.seamonster.kr/<code> 또는 아무 호스트/q/<code>. 클릭 집계용. */
export function shortLinkCode(link: string): string {
  const s = (link || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    const segs = u.pathname.split("/").filter(Boolean);
    if (u.hostname === "link.seamonster.kr" && segs.length === 1) return decodeURIComponent(segs[0]);
    if (segs.length === 2 && segs[0] === "q") return decodeURIComponent(segs[1]);
    return "";
  } catch { return ""; }
}
