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

// 전체 교체는 기존 상세설명을 하나도 남기지 않는다(2026-11-13 대표 결정). 옛 아코디언 블록(.smd-info)을 남기던 규칙은 없앴다 —
//  아코디언도 sm-acc 소스로 넣으므로 남겨 두면 옛 내용이 계속 따라다닌다. 조립 규칙을 바꾸면 scripts/detail-apply-runner.mjs 도 함께 고친다.

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

/** 상세설명에서 소스 블록들을 전부 걷어낸다(조합 재전송·순서 재정렬용) */
export function removeBlocks(current: string, sourceIds: number[]): string {
  let out = current ?? "";
  for (const id of sourceIds) out = out.replace(blockRegex(id), "");
  return out.trim();
}

export type SetMember = { source_id: number; version: number; html: string };

/** 조합(161): 구성 블록을 전부 걷어낸 뒤 조합 순서대로 묶어서 position 에 넣는다 */
export function mergeSet(current: string, members: SetMember[], position: Position): string {
  const blocks = members.map((m) => wrapBlock(m.source_id, m.html)).join("\n");
  if (position === "replace") return blocks;
  const rest = removeBlocks(current, members.map((m) => m.source_id));
  if (!rest) return blocks;
  return position === "prepend" ? `${blocks}\n${rest}` : `${rest}\n${blocks}`;
}

/** 적용 기록 한 행(완료된 것) — 지금 상품에 어떤 소스가 들어 있는지 계산하는 데 필요한 칸만 */
export type PresenceRow = {
  id: number; product_no: number; position: string; command?: string | null;
  source_id?: number | null; source_version?: number | null; members?: SetMember[] | null;
};
export type Presence<R extends PresenceRow> = {
  /** 지금 들어 있는 소스 id → 그 소스를 마지막으로 넣은 행과 그때 버전 */
  sources: Map<number, { via: R; version: number }>;
  /** 이 상품에 마지막으로 완료된 행 */
  last: R;
};

/**
 * 상품별 '지금 들어 있는 소스' — 완료 행을 오래된 순으로 따라간다.
 *  전체 교체 행은 그 전 블록을 전부 지우고(소스 하나 또는 조합 구성만 남음), 맨 앞/맨 뒤 행은 더한다.
 *  같은 소스를 다시 쏘면 버전만 갱신. (화면 밖에서 편집기로 지운 것은 알 수 없다)
 */
export function computePresence<R extends PresenceRow>(completedRows: R[]): Map<number, Presence<R>> {
  const rows = [...completedRows].sort((a, b) => a.id - b.id);
  const out = new Map<number, Presence<R>>();
  for (const r of rows) {
    const ids: { id: number; version: number }[] = r.command === "set" && Array.isArray(r.members)
      ? r.members.map((m) => ({ id: Number(m.source_id), version: Number(m.version) }))
      : (r.source_id ? [{ id: r.source_id, version: r.source_version ?? 0 }] : []);
    if (ids.length === 0) continue;
    let p = out.get(r.product_no);
    if (!p) { p = { sources: new Map(), last: r }; out.set(r.product_no, p); }
    if (r.position === "replace") p.sources.clear();
    for (const m of ids) p.sources.set(m.id, { via: r, version: m.version });
    p.last = r;
  }
  return out;
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

/** 소스 이름의 소분류 — 제목 안 첫 대괄호 [ ] 의 글자. 없으면 ""(분류 없음). 예: "[이유식] 보관방법" → "이유식" */
export function sourceCategory(name: string): string {
  const m = /\[([^\]]+)\]/.exec(name || "");
  return m ? m[1].trim() : "";
}
/** 소분류 대괄호를 뺀 표시 이름. 대괄호만 있고 나머지가 비면 원래 이름 그대로 */
export function sourceLabel(name: string): string {
  const rest = (name || "").replace(/\[[^\]]+\]\s*/, "").trim();
  return rest || (name || "").trim();
}
