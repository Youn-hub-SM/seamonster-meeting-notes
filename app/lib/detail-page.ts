// 상세페이지 전송(160) — 소스 블록 마커·조립 규칙. 화면 미리보기와 API 검증이 쓴다.
//  실행기(scripts/detail-apply-runner.mjs)는 TS 를 못 읽어 같은 규칙을 JS 로 갖고 있다 — 한쪽을 고치면 다른 쪽도.

export const POSITIONS = ["replace", "prepend", "append"] as const;
export type Position = (typeof POSITIONS)[number];
export const POSITION_KO: Record<Position, string> = { replace: "전체 교체", prepend: "기존 맨 앞", append: "기존 맨 뒤" };

export const APPLY_STATUSES = ["대기", "실행중", "완료", "실패"] as const;
export type ApplyStatus = (typeof APPLY_STATUSES)[number];
/** 적용 상태 배지 색(디자인 시스템: 완료=초록, 실패=빨강, 나머지=회색) */
export const APPLY_STATUS_COLOR: Record<ApplyStatus, { bg: string; fg: string }> = {
  "대기": { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
  "실행중": { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
  "완료": { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  "실패": { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
};

export function markerOpen(sourceId: number): string { return `<!-- sm:src=${sourceId} -->`; }
export function markerClose(sourceId: number): string { return `<!-- /sm:src=${sourceId} -->`; }

/** 소스 HTML 을 마커로 감싼 블록 */
export function wrapBlock(sourceId: number, html: string): string {
  return `${markerOpen(sourceId)}\n${html.trim()}\n${markerClose(sourceId)}`;
}

function blockRegex(sourceId: number): RegExp {
  // 마커 사이 전부(줄바꿈 포함). 같은 소스 마커가 여럿이면 전부 지운다(중복 방지).
  return new RegExp(`<!--\\s*sm:src=${sourceId}\\s*-->[\\s\\S]*?<!--\\s*/sm:src=${sourceId}\\s*-->\\s*`, "g");
}

/** 현재 상세설명에 소스 블록을 넣은 결과. 이미 같은 소스 마커가 있으면 그 자리만 갱신. */
export function mergeDescription(current: string, sourceId: number, html: string, position: Position): string {
  const block = wrapBlock(sourceId, html);
  const cur = current ?? "";
  if (position === "replace") return block;
  const re = blockRegex(sourceId);
  if (re.test(cur)) {
    // 기존 자리 갱신 — 첫 마커 자리에 새 블록, 나머지 중복은 제거
    let first = true;
    return cur.replace(blockRegex(sourceId), () => { if (first) { first = false; return block + "\n"; } return ""; }).trimEnd();
  }
  if (position === "prepend") return `${block}\n${cur}`.trimEnd();
  return `${cur.trimEnd()}\n${block}`.trimStart();
}

/** 쉼표·공백·줄바꿈으로 적은 상품번호를 정수 목록으로(중복 제거·순서 유지) */
export function parseProductNos(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const tok of (text || "").split(/[\s,;]+/)) {
    const n = Number(tok.trim());
    if (!tok.trim() || !Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n); out.push(n);
  }
  return out;
}
