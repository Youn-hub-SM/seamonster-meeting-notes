// 파도소리 화면 공용 헬퍼(클라이언트 안전 — DB 코드 없음).

export const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
export const daysAgo = (n: number) => new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
export const n0 = (v: unknown) => Number(v) || 0;
