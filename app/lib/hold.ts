// 운영 보류 — 베타(dev)에는 있지만 운영(main)에는 아직 내보내지 않는 화면(클라이언트·서버 공용).
//  dev → main 은 통째로 올라가므로, 운영 빌드에서만 가릴 화면을 여기 적는다.
//  값은 next.config.ts 가 빌드 때 정한다(VERCEL_ENV=production 이면 NEXT_PUBLIC_HOLD_AGENTS="1"). 베타·로컬에서는 항상 false.
//  주소 자체(화면·API)는 next.config.ts 의 리라이트가 404 로 막고, 여기 값으로는 메뉴·가이드·업데이트 내역·AI 설정 항목을 뺀다.
//  보류를 풀 때는 next.config.ts 의 HOLD_AGENTS 만 false 로 바꾼다.
//
//  2026-11-13 대표: "ai 에이전트만 보류하고 모두 배포해줘" — AI 에이전트(/agents: 도매 생산 요청서·광고 카피).
export const HOLD_AGENTS = process.env.NEXT_PUBLIC_HOLD_AGENTS === "1";

const HELD_PREFIXES = ["/agents"];
export function isHeldHref(href: string): boolean {
  return HOLD_AGENTS && HELD_PREFIXES.some((p) => href === p || href.startsWith(`${p}/`) || href.startsWith(`${p}?`));
}
