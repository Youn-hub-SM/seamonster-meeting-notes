// 공용 표기 헬퍼 — 금액·수량이 화면마다 다른 반올림/축약으로 나오지 않게 한 곳에 둔다.
// (won() 이 화면마다 재정의돼 일부는 반올림이 없어, 같은 금액이 화면에 따라
//  "1,234.5" 와 "1,235" 로 갈릴 수 있었다.)
// 억/만 축약 moneyCompact 도 여기 한 곳(charts.tsx 가 그대로 다시 내보내 축 라벨과 같은 표기).

/** 정수 반올림 + 천단위 콤마. null/undefined 는 "-" */
export const won = (n: number | null | undefined): string =>
  n == null ? "-" : Math.round(Number(n) || 0).toLocaleString();

/** 금액 축약(억/만) — 차트 축 라벨·팀즈 카드 제목 헤드라인 공용. 2026-10-13 charts.tsx("use client")에서 옮김:
 *  서버(팀즈 발송)에서도 불러야 하는데 "use client" 모듈의 함수는 서버 번들에서 호출할 수 없다. charts.tsx 는 이걸 다시 내보내므로 화면 import 는 그대로. */
export function moneyCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(a % 1e8 === 0 ? 0 : 1)}억`;
  if (a >= 1e4) return `${Math.round(n / 1e4).toLocaleString()}만`;
  return n.toLocaleString();
}

/** 표 날짜 축약 "MM-DD" — 표 셀 표기가 화면마다 갈리지 않게 한 곳에(2026-08-28). YYYY-MM-DD 입력 전제.
 *  예외: 여러 해가 섞이는 이력 화면(주문검색 등)은 연도 포함 원문 표기 유지. */
export const dateShort = (d: string | null | undefined): string => (d ? String(d).slice(5) : "-");

// ─────────────────────────────────────────────────────────────
// 표기 규율(2026-10-17 디자인 3차, 대표 확정) — 수산물 도구의 아이덴티티는 색이 아니라 '숫자·단위·날짜·품목명을 한 가지로 쓰는 것'.
//  표 안: 숫자만(천단위 쉼표), 단위는 열 이름이 말한다('합계(원)', '수량'). 문장·배지·카드: 'N개'·'N원'.
//  날짜: YYYY-MM-DD 하나. 기간은 'MM-DD ~ MM-DD'. 상대 표기('D-3')는 발주 긴급도에만.
// ─────────────────────────────────────────────────────────────

/** 수량(표 안) — 정수 천단위 쉼표, 단위 없음. 소수(kg 등)는 최대 1자리. null 은 "-" */
export const qty = (n: number | null | undefined): string => {
  if (n == null || Number.isNaN(Number(n))) return "-";
  const v = Number(n);
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
};

/** 수량(문장 안) — "12개". 단위는 바꿀 수 있다('12종', '3건'). */
export const qtyText = (n: number | null | undefined, unit = "개"): string => (n == null ? "-" : `${qty(n)}${unit}`);

/** 금액(문장·배지·카드 안) — "1,234원". 표 셀은 won() + 열 이름 '(원)'. */
export const wonText = (n: number | null | undefined): string => (n == null ? "-" : `${won(n)}원`);

/** 날짜 'YYYY-MM-DD' — ISO 문자열·Date·'YYYY-MM-DD' 어느 것을 넣어도 같은 꼴. 시각은 버린다(KST 기준). */
export const dateFull = (d: string | Date | null | undefined): string => {
  if (!d) return "-";
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const t = typeof d === "string" ? Date.parse(d) : d.getTime();
  if (Number.isNaN(t)) return String(d);
  const k = new Date(t + 9 * 3600 * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())}`;
};

/** 날짜+시각 'YYYY-MM-DD HH:mm' (KST). 기록·이력 표의 시각 칸. */
export const dateTime = (d: string | Date | null | undefined): string => {
  if (!d) return "-";
  const t = typeof d === "string" ? Date.parse(d) : d.getTime();
  if (Number.isNaN(t)) return String(d);
  const k = new Date(t + 9 * 3600 * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};

/** 기간 'MM-DD ~ MM-DD' (같은 해) / 'YYYY-MM-DD ~ YYYY-MM-DD' (해가 다르면). 한쪽이 없으면 '~' 로 연다. */
export const dateRange = (a: string | null | undefined, b: string | null | undefined): string => {
  const fa = a ? dateFull(a) : "", fb = b ? dateFull(b) : "";
  const sameYear = fa && fb && fa.slice(0, 4) === fb.slice(0, 4);
  const sa = sameYear ? fa.slice(5) : fa, sb = sameYear ? fb.slice(5) : fb;
  return `${sa || ""} ~ ${sb || ""}`.trim();
};

/** 품목 한 줄(문자열) — '상품명 · 규격 ×수량'. 규격·수량은 있을 때만. 툴팁·option·로그처럼 JSX 를 못 쓰는 자리용.
 *  화면에는 app/components/ItemLabel 을 쓴다(규격은 회색, 수량은 중간 회색). */
export const itemText = (it: { name: string; spec?: string | null; qty?: number | null }): string =>
  `${it.name}${it.spec ? ` · ${it.spec}` : ""}${it.qty != null ? ` ×${qty(it.qty)}` : ""}`;
