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

// name 이 query 에 매칭되는지 — 일반 부분일치 OR 초성 부분일치.
export function matchKo(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (name.toLowerCase().includes(q)) return true;
  return chosungOf(name).includes(q);
}
