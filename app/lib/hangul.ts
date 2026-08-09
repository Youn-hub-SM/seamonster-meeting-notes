// 한글 검색 보조 — 초성 검색("ㄴㅇ" → 농어)과 영문자판 검색("shddj" → 농어).
//
// 영문자판 검색이 필요한 이유: 웹 페이지는 OS 입력기(IME)를 한글로 바꿀 수 없다.
//  (CSS ime-mode 는 폐기됐고 html lang="ko" 는 이미 걸려 있지만 Windows 크롬엔 영향이 없다.)
//  그래서 "입력기를 한글로 만든다" 대신 "영문으로 쳐도 찾아준다" 로 푼다 —
//  한/영 키를 안 눌러도 검색이 되므로 사용자 입장에선 같은 결과다.

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

// 중성·종성을 '실제로 눌러야 하는 자모'로 편 표 — ㅘ 는 ㅗ+ㅏ 두 번, ㄳ 은 ㄱ+ㅅ 두 번 누른다.
//  이렇게 펴 두면 영문 입력을 음절로 조립(오토마타)하지 않고 자모 나열끼리 비교하면 된다.
const JUNG = [
  "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅗㅏ", "ㅗㅐ", "ㅗㅣ",
  "ㅛ", "ㅜ", "ㅜㅓ", "ㅜㅔ", "ㅜㅣ", "ㅠ", "ㅡ", "ㅡㅣ", "ㅣ",
];
const JONG = [
  "", "ㄱ", "ㄲ", "ㄱㅅ", "ㄴ", "ㄴㅈ", "ㄴㅎ", "ㄷ", "ㄹ", "ㄹㄱ", "ㄹㅁ", "ㄹㅂ", "ㄹㅅ",
  "ㄹㅌ", "ㄹㅍ", "ㄹㅎ", "ㅁ", "ㅂ", "ㅂㅅ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

// 두벌식 자판 — 영문 키 → 자모. 대문자는 시프트(ㅃㅉㄸㄲㅆㅒㅖ).
const KEY_TO_JAMO: Record<string, string> = {
  q: "ㅂ", w: "ㅈ", e: "ㄷ", r: "ㄱ", t: "ㅅ", y: "ㅛ", u: "ㅕ", i: "ㅑ", o: "ㅐ", p: "ㅔ",
  a: "ㅁ", s: "ㄴ", d: "ㅇ", f: "ㄹ", g: "ㅎ", h: "ㅗ", j: "ㅓ", k: "ㅏ", l: "ㅣ",
  z: "ㅋ", x: "ㅌ", c: "ㅊ", v: "ㅍ", b: "ㅠ", n: "ㅜ", m: "ㅡ",
  Q: "ㅃ", W: "ㅉ", E: "ㄸ", R: "ㄲ", T: "ㅆ", O: "ㅒ", P: "ㅖ",
};

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

// 문자열을 '자판을 누른 순서'의 자모 나열로 — "광어" → "ㄱㅗㅏㅇㅇㅓ".
//  한글이 아닌 글자는 소문자로 그대로 둔다(SKU·숫자가 섞인 이름도 같은 축에서 비교되게).
export function typingJamoOf(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) {
      const i = c - 0xac00;
      out += CHO[Math.floor(i / 588)] + JUNG[Math.floor((i % 588) / 28)] + JONG[i % 28];
    } else if (c >= 0x3131 && c <= 0x3163) {
      out += ch; // 이미 낱자로 적힌 자모(ㄱ, ㅏ …)
    } else {
      out += ch.toLowerCase();
    }
  }
  return out;
}

// 영문 자판 입력 → 자모 나열. 자판에 없는 글자가 하나라도 있으면 ""(변환 포기).
//  숫자·SKU 처럼 원래 영문인 검색어가 엉뚱한 자모로 바뀌어 오탐을 내지 않게 하기 위해서다.
export function latinToJamo(s: string): string {
  let out = "";
  for (const ch of s) {
    const j = KEY_TO_JAMO[ch];
    if (!j) return "";
    out += j;
  }
  return out;
}

// name 이 query(한 단어)에 매칭되는지 — 일반 부분일치 OR 초성 부분일치 OR 영문자판 입력.
export function matchKo(name: string, query: string): boolean {
  const raw = query.trim();
  if (!raw) return true;
  const q = raw.toLowerCase();
  if (name.toLowerCase().includes(q)) return true;
  if (chosungOf(name).includes(q)) return true;

  // 입력기가 영문인 채로 친 경우 — "rhkddj"(광어) 처럼. 한 글자는 자모 하나라 거의 다 걸려서 제외한다.
  if (raw.length >= 2) {
    const jamo = latinToJamo(raw);
    if (jamo && (typingJamoOf(name).includes(jamo) || chosungOf(name).includes(jamo))) return true;
  }
  return false;
}

// 여러 단어 검색 — 공백으로 나눈 각 단어가 모두 매칭(AND). "광어 100 1kg" → 이름·옵션·SKU 어디든.
//  대소문자는 matchKo 안에서 처리한다 — 여기서 미리 낮추면 시프트 자모(ㄲㅆ…)를 잃는다.
export function matchKoQuery(haystack: string, query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((t) => matchKo(haystack, t));
}
