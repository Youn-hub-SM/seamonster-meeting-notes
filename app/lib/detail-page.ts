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

/**
 * 보존 블록 — 공식몰 스킨이 아코디언·구매박스 요약으로 읽는 숨김 텍스트 블록(<div class="smd-info"> 또는 .wf-acc).
 *  전체 교체는 상세설명을 전부 지우므로 이 블록만 떼어 새 내용 맨 앞에 되돌려 놓는다(스킨 JS 는 첫 번째 .smd-info 만 읽는다 →
 *  상품 자체 아코디언이 계속 우선). 새 내용에 이미 이 블록이 있으면 소스가 아코디언을 바꾸려는 뜻이므로 보존하지 않는다.
 *  찾는 기준은 class 이름뿐이다 — 편집기에서 class 가 지워진 블록은 보존 대상이 아니다.
 */
const PRESERVE_OPEN = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:smd-info|wf-acc)\b[^"']*["'][^>]*>/i;
const DIV_TAG = /<\/?div\b[^>]*>/gi;
export function extractPreserved(html: string): { block: string; rest: string } | null {
  const src = html ?? "";
  const m = PRESERVE_OPEN.exec(src);
  if (!m) return null;
  // 여는 div 부터 짝이 맞는 닫는 </div> 까지(중첩 div 세기)
  let depth = 0;
  DIV_TAG.lastIndex = m.index;
  let t: RegExpExecArray | null;
  while ((t = DIV_TAG.exec(src))) {
    if (t[0].startsWith("</")) { depth--; if (depth === 0) { const end = t.index + t[0].length; return { block: src.slice(m.index, end), rest: (src.slice(0, m.index) + src.slice(end)).trim() }; } }
    else if (!/\/\s*>$/.test(t[0])) depth++;
  }
  return null; // 닫는 태그를 못 찾음 — 보존하지 않는다
}
export const hasPreserved = (html: string): boolean => PRESERVE_OPEN.test(html ?? "");
/** 전체 교체 결과 앞에 보존 블록을 되돌려 놓는다 */
function withPreserved(current: string, replacement: string, newHtml: string): string {
  if (hasPreserved(newHtml)) return replacement;
  const p = extractPreserved(current);
  return p ? `${p.block}\n${replacement}` : replacement;
}

/** 현재 상세설명에 소스 블록을 넣은 결과. 이미 같은 소스 마커가 있으면 그 자리만 갱신. */
export function mergeDescription(current: string, sourceId: number, html: string, position: Position): string {
  const block = wrapBlock(sourceId, html);
  const cur = current ?? "";
  if (position === "replace") return withPreserved(cur, block, html);
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
  if (position === "replace") return withPreserved(current ?? "", blocks, members.map((m) => m.html).join("\n"));
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
