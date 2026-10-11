// 1,000행 상한(PostgREST Max Rows) 없이 끝까지 읽기 — 매출·B2B 집계 공용.
//  잘린 조회를 '전부'로 보고 합계·미수금·대조를 내지 않는다(원장 기준 S4). 페이지 하나라도 실패하면 throw.
//  q 는 같은 정렬(끝에 고유키 포함)로 lo~hi 구간을 돌려주는 조회여야 페이지 경계에서 행이 겹치거나 빠지지 않는다.

export const PAGE_SIZE = 1000;

type PageResult = { data: unknown[] | null; error: { message?: string } | null };

export async function fetchAllPages<T>(
  q: (lo: number, hi: number) => PromiseLike<PageResult>,
  opts: { cap?: number; label?: string } = {},
): Promise<T[]> {
  const cap = opts.cap ?? 50000;
  const out: T[] = [];
  for (let lo = 0; ; lo += PAGE_SIZE) {
    const { data, error } = await q(lo, lo + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (out.length >= cap) {
      throw new Error(`${opts.label ? `${opts.label} ` : ""}조회가 ${cap.toLocaleString()}행을 넘습니다 — 기간을 줄여 다시 조회하세요.`);
    }
  }
  return out;
}

// .in(키 목록) 조회를 100개씩 나눠 끝까지 — 큰 .in() 은 요청 URL 길이 초과로 게이트웨이 400 이 난다.
export async function fetchInChunks<T>(
  keys: string[],
  q: (chunk: string[], lo: number, hi: number) => PromiseLike<PageResult>,
  chunkSize = 100,
): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const part = uniq.slice(i, i + chunkSize);
    out.push(...(await fetchAllPages<T>((lo, hi) => q(part, lo, hi))));
  }
  return out;
}
