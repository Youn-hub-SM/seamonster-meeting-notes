// 한글 초성 검색 — "ㄴㅇ" 같은 초성만 입력해도 "농어"가 매칭되도록.

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

// 문자열의 초성 문자열(한글 음절은 초성으로, 그 외는 그대로 소문자).
export function chosungOf(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) out += CHO[Math.floor((c - 0xac00) / 588)];
    else out += ch.toLowerCase();
  }
  return out;
}

// name 이 query(한 단어)에 매칭되는지 — 일반 부분일치 OR 초성 부분일치.
export function matchKo(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (name.toLowerCase().includes(q)) return true;
  return chosungOf(name).includes(q);
}

// 여러 단어 검색 — 공백으로 나눈 각 단어가 모두 매칭(AND). "광어 100 1kg" → 이름·옵션·SKU 어디든.
export function matchKoQuery(haystack: string, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((t) => matchKo(haystack, t));
}
