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

// ── 영문 자판 입력 → 한글 조립(입력창에 한글로 보여 주기, 2026-10-22 파도소리 요청) ──────────────
//  검색은 영문 그대로도 되지만 칸에 "shddj" 가 보이고 새 품목 이름에도 그대로 들어가서, 입력기를 못 바꾸는 대신
//  칸의 글자를 한글로 바꿔 준다. 규칙:
//   - 공백으로 나눈 단어마다 따로. 자판에 없는 글자(숫자·기호·대문자 D 등)가 섞인 단어는 그대로(SKU·규격 "150/200").
//   - 첫 자모가 모음이면 그대로("pd" → ㅔㅇ 은 한글이 아니다 — SKU 를 치는 중).
//   - 이미 한글인 글자는 자모로 풀어 같이 조립한다("농어" + t → "농엇").
//   - 자음만 이어지면 초성 나열로 둔다("sd" → "ㄴㅇ" — 초성 검색).
//  입력기 조합 중(isComposing)에는 부르지 말 것 — 조합 중 값을 바꾸면 입력기가 깨진다(호출부 책임).
const JUNG_CH = ["ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ"];
const JONG_CH = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const JUNG_PAIR: Record<string, string> = { "ㅗㅏ": "ㅘ", "ㅗㅐ": "ㅙ", "ㅗㅣ": "ㅚ", "ㅜㅓ": "ㅝ", "ㅜㅔ": "ㅞ", "ㅜㅣ": "ㅟ", "ㅡㅣ": "ㅢ" };
const JONG_PAIR: Record<string, string> = { "ㄱㅅ": "ㄳ", "ㄴㅈ": "ㄵ", "ㄴㅎ": "ㄶ", "ㄹㄱ": "ㄺ", "ㄹㅁ": "ㄻ", "ㄹㅂ": "ㄼ", "ㄹㅅ": "ㄽ", "ㄹㅌ": "ㄾ", "ㄹㅍ": "ㄿ", "ㄹㅎ": "ㅀ", "ㅂㅅ": "ㅄ" };
const JONG_SPLIT: Record<string, [string, string]> = Object.fromEntries(Object.entries(JONG_PAIR).map(([k, v]) => [v, [k[0], k[1]]]));
const isVowel = (j: string) => JUNG_CH.includes(j);

// 한 단어의 자모 나열(낱자) — 변환할 수 없는 글자가 있으면 null
function wordToJamo(word: string): string[] | null {
  const out: string[] = [];
  let latin = false;
  for (const ch of word) {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) {
      const i = c - 0xac00;
      out.push(CHO[Math.floor(i / 588)], ...JUNG[Math.floor((i % 588) / 28)], ...JONG[i % 28]);
    } else if (c >= 0x3131 && c <= 0x3163) {
      out.push(ch);
    } else if (KEY_TO_JAMO[ch] || KEY_TO_JAMO[ch.toLowerCase()]) {
      // 시프트 자모(ㅃㅉㄸㄲㅆㅒㅖ)가 아닌 대문자는 소문자 키로 본다(캡스락·시프트 실수)
      out.push(KEY_TO_JAMO[ch] || KEY_TO_JAMO[ch.toLowerCase()]); latin = true;
    } else return null;
  }
  return latin ? out : null; // 영문이 하나도 없으면 바꿀 것도 없다
}

// 두벌식 오토마타 — 자모 나열을 음절로
function assemble(jamo: string[]): string {
  let out = "", cho = "", jung = "", jong = "";
  const flush = () => {
    if (cho && jung) out += String.fromCharCode(0xac00 + CHO.indexOf(cho) * 588 + JUNG_CH.indexOf(jung) * 28 + JONG_CH.indexOf(jong));
    else out += cho + jung + jong;
    cho = jung = jong = "";
  };
  for (const j of jamo) {
    if (isVowel(j)) {
      if (!jung) { jung = j; continue; }                                  // (초성 있든 없든) 첫 모음
      if (!jong) {
        const pair = JUNG_PAIR[jung + j];
        if (pair) { jung = pair; continue; }                               // ㅗ+ㅏ → ㅘ
        flush(); jung = j; continue;                                       // 가+ㅏ → 가ㅏ
      }
      // 받침이 있는데 모음이 오면 받침(또는 겹받침의 뒷자)이 다음 음절 초성으로
      const split = JONG_SPLIT[jong];
      const carry = split ? split[1] : jong;
      jong = split ? split[0] : "";
      flush(); cho = carry; jung = j;
    } else {
      if (!cho) { cho = j; continue; }
      if (!jung) { flush(); cho = j; continue; }                           // 자음 연속 = 초성 나열
      if (!jong) {
        if (JONG_CH.includes(j)) { jong = j; continue; }
        flush(); cho = j; continue;                                        // ㄸ·ㅃ·ㅉ 는 받침이 안 된다
      }
      const pair = JONG_PAIR[jong + j];
      if (pair) { jong = pair; continue; }
      flush(); cho = j;
    }
  }
  flush();
  return out;
}

// 입력창 값 → 영문 자판으로 친 단어만 한글로. 바꿀 게 없으면 원문 그대로(같은 문자열).
export function autoHangul(value: string): string {
  return value.split(/(\s+)/).map((tok) => {
    if (!tok || /^\s+$/.test(tok)) return tok;
    const jamo = wordToJamo(tok);
    if (!jamo || isVowel(jamo[0])) return tok;
    return assemble(jamo);
  }).join("");
}

// 여러 단어 검색 — 공백으로 나눈 각 단어가 모두 매칭(AND). "광어 100 1kg" → 이름·옵션·SKU 어디든.
//  대소문자는 matchKo 안에서 처리한다 — 여기서 미리 낮추면 시프트 자모(ㄲㅆ…)를 잃는다.
export function matchKoQuery(haystack: string, query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((t) => matchKo(haystack, t));
}

// 입력 이벤트용 — 입력기 조합 중이면 값을 건드리지 않는다(한글 IME 로 치는 중에 값을 바꾸면 조합이 깨진다).
//  <input value={v} onChange={(e) => setV(hangulInputValue(e))} />
export function hangulInputValue(e: { target: { value: string }; nativeEvent: Event }): string {
  const raw = e.target.value;
  return (e.nativeEvent as { isComposing?: boolean }).isComposing ? raw : autoHangul(raw);
}
