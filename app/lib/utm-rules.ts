// UTM 규칙 — 단일 소스(클라이언트 안전, 서버 의존 없음). 2026-11-06 대표 확정(docs/utm-crm-builder-plan.md).
//  /utm 화면(광고·SNS 모드 공통 경고 + CRM 모드 검사)과 CRM 메시지 엑셀 가져오기 검사가 같은 함수를 쓴다.
//
//  CRM 메시지 링크 규칙:
//   utm_source   = kakao 고정
//   utm_medium   = 메시지종류-경로 4종(CRM_MEDIA)
//   utm_campaign = 메시지 하나에 하나. 영문 소문자 kebab-case, 날짜·버전 접미 금지
//   utm_content  = 버튼 슬러그. 추적 링크가 둘 이상이면 모두 필수
//   utm_term     = A/B 변형만 a·b
//   주소         = https. 우리 GA 밖(인스타·네이버·카카오 등)은 UTM 을 붙이지 않는다.

export const CRM_SOURCE = "kakao";

// 광고·SNS 모드 기본값(설정을 못 읽어도 화면이 돌아가게 클라이언트에도 둔다). 저장본은 utm_settings.
export type UrlPreset = { label: string; value: string };
export type SourceMediumMap = Record<string, string[]>;
export const DEFAULT_URL_PRESETS: UrlPreset[] = [
  { label: "씨몬스터 공식몰", value: "https://seamonster.kr" },
  { label: "씨몬스터 블로그", value: "https://blog.seamonster.kr" },
  { label: "네이버 스마트스토어", value: "https://smartstore.naver.com/seamonster" },
];
export const DEFAULT_SOURCE_MEDIUM_MAP: SourceMediumMap = {
  naver: ["cpc", "blog", "display", "shopping", "brand_search"],
  google: ["cpc", "display", "shopping", "discovery", "pmax"],
  kakao: ["cpc", "display", "bizboard", "kakao_moment"],
  instagram: ["social", "story", "reels", "collab"],
  facebook: ["social", "cpc", "display", "cpa"],
  youtube: ["video", "shorts", "display", "cpc"],
  tiktok: ["social", "video", "cpc", "spark_ads"],
  daum: ["cpc", "display", "blog"],
};

export type CrmMedium = { value: string; label: string; kind: "alimtalk" | "brandmessage"; path: "cafe24" | "naver" };
export const CRM_MEDIA: CrmMedium[] = [
  { value: "alimtalk-cafe24", label: "알림톡 · 공식몰", kind: "alimtalk", path: "cafe24" },
  { value: "brandmessage-cafe24", label: "브랜드메시지 · 공식몰", kind: "brandmessage", path: "cafe24" },
  { value: "alimtalk-naver", label: "알림톡 · 네이버", kind: "alimtalk", path: "naver" },
  { value: "brandmessage-naver", label: "브랜드메시지 · 네이버", kind: "brandmessage", path: "naver" },
];
export const CRM_MEDIUM_VALUES = CRM_MEDIA.map((m) => m.value);

// 우리 GA 가 잡는 도메인 — 이 밖으로 가는 링크엔 UTM 을 붙이지 않는다(대표 결정 5).
export const TRACKED_HOST_SUFFIXES = ["seamonster.kr", "seamonster.co.kr"];

// 슬러그 규칙: 영문 소문자·숫자, 단어 사이 하이픈 하나
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// 날짜·버전 접미 — 2610, _2610, -2026, -v2, _v3 (추이가 끊기는 원인이라 금지)
const DATE_SUFFIX_RE = /(^|[-_])(20\d{2}(0[1-9]|1[0-2])?|\d{2}(0[1-9]|1[0-2])|v\d+)$/i;

// 한글 버튼명 → 영문 슬러그 사전 기본값(공지 2026-11-06 의 슬러그). utm_settings.content_slugs 로 직원이 키운다.
export const DEFAULT_CONTENT_SLUGS: Record<string, string> = {
  "쿠폰": "coupon", "할인쿠폰": "coupon", "레시피": "recipe", "간편 레시피": "recipe", "다양한 레시피": "recipe",
  "영양": "nutrient", "영양정보": "nutrient", "영양 성분": "nutrient", "가이드": "guide", "가이드북": "guide",
  "설문": "survey", "인터뷰": "survey", "로드맵": "roadmap", "소스": "sauce", "조리법": "easycook", "간편 조리법": "easycook",
  "식단": "diet", "다이어트": "diet", "식단 노하우": "diet-interview", "이유식": "babyfish", "체험단": "trial",
  "비린내": "smell-tips", "세트": "set", "추천 이유": "why", "좋은 이유": "why", "홈": "home", "정기배송": "subscription",
  "제출": "submit", "100g": "portion-100g", "흰살": "white-vs-red", "장바구니": "cart", "재입고": "restock",
  "등급": "grade", "리뷰": "review", "상품권": "voucher", "구매하기": "buy", "더 알아보기": "more", "상담": "consult",
};

// 외부 도메인인가(= UTM 안 붙임). 주소가 비었거나 변수(#{URL}·[DOMAIN_PC])면 추적 불가로 본다.
export function isTrackedUrl(url: string): boolean {
  const m = String(url || "").trim().match(/^https?:\/\/([^/?#]+)/i);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return TRACKED_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

// 한글·공백 섞인 글 → 슬러그. 사전(긴 키 우선 부분 일치) → 남은 영문·숫자만 kebab. 한글이 남으면 "" (직원이 영문으로 적어야 한다).
export function slugify(text: string, dict: Record<string, string> = DEFAULT_CONTENT_SLUGS): string {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
  const lower = raw.toLowerCase();
  for (const k of keys) {
    if (lower === k.toLowerCase()) return dict[k];
  }
  for (const k of keys) {
    if (k && lower.includes(k.toLowerCase())) return dict[k];
  }
  if (/[가-힣]/.test(lower)) return ""; // 사전에 없는 한글 — 직원이 영문으로 적는다(엉뚱한 로마자 변환보다 빈칸이 낫다)
  return lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
}

// 영문 값을 규칙에 맞게 고친 값(소문자·하이픈·접미 제거). 바꿀 게 없으면 그대로.
export function fixSlug(v: string): string {
  const s = String(v || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return s.replace(DATE_SUFFIX_RE, "").replace(/-+$/g, "");
}

export type UtmParams = { source?: string; medium?: string; campaign?: string; content?: string; term?: string };

// 주소 + UTM. 기존 utm_* 는 덮어쓰고 다른 쿼리(returnUrl·product_no)는 보존. 추적 도메인이면 https 로.
//  경로의 한글은 그대로 둔다(기존 빌더와 같은 동작 — URL 객체로 다시 조립하면 퍼센트 인코딩돼 보기 어렵다).
export function buildUtmUrl(base: string, p: UtmParams, opts: { forceHttps?: boolean } = {}): string {
  let b = String(base || "").trim();
  if (!b) return "";
  if (opts.forceHttps !== false && /^http:\/\//i.test(b) && isTrackedUrl(b)) b = b.replace(/^http:\/\//i, "https://");
  const hashAt = b.indexOf("#");
  const hash = hashAt >= 0 ? b.slice(hashAt) : "";
  if (hashAt >= 0) b = b.slice(0, hashAt);
  const qAt = b.indexOf("?");
  const path = qAt >= 0 ? b.slice(0, qAt) : b;
  const kept = qAt >= 0 ? b.slice(qAt + 1).split("&").filter((kv) => kv && !/^utm_(source|medium|campaign|content|term)=/i.test(kv)) : [];
  const add: string[] = [];
  const put = (k: string, v?: string) => { const s = String(v ?? "").trim(); if (s) add.push(`${k}=${encodeURIComponent(s)}`); };
  put("utm_source", p.source); put("utm_medium", p.medium); put("utm_campaign", p.campaign); put("utm_content", p.content); put("utm_term", p.term);
  const q = [...kept, ...add];
  return path + (q.length ? "?" + q.join("&") : "") + hash;
}

export function parseUtm(url: string): UtmParams & { hasUtm: boolean } {
  const q = String(url || "").split("#")[0].split("?")[1] || "";
  const out: UtmParams & { hasUtm: boolean } = { hasUtm: false };
  for (const kv of q.split("&")) {
    const [k, v = ""] = kv.split("=");
    const key = k.toLowerCase();
    if (!key.startsWith("utm_")) continue;
    out.hasUtm = true;
    const val = (() => { try { return decodeURIComponent(v); } catch { return v; } })();
    if (key === "utm_source") out.source = val; else if (key === "utm_medium") out.medium = val; else if (key === "utm_campaign") out.campaign = val; else if (key === "utm_content") out.content = val; else if (key === "utm_term") out.term = val;
  }
  return out;
}

// ── 광고·SNS 공통 최소 규칙(결정 2: 경고만) ──
export type UtmIssue = { field: string; msg: string; fix?: string };

export function checkCommon(p: { baseUrl?: string; source?: string; medium?: string; campaign?: string; content?: string; term?: string }): UtmIssue[] {
  const issues: UtmIssue[] = [];
  const b = String(p.baseUrl || "").trim();
  if (b && /^http:\/\//i.test(b) && isTrackedUrl(b)) issues.push({ field: "baseUrl", msg: "https 로 시작해야 합니다", fix: b.replace(/^http:\/\//i, "https://") });
  for (const f of ["source", "medium", "campaign", "content", "term"] as const) {
    const v = String(p[f] || "").trim();
    if (!v) continue;
    if (v !== v.toLowerCase()) issues.push({ field: f, msg: "소문자만 씁니다", fix: fixSlug(v) });
    else if (/\s/.test(v)) issues.push({ field: f, msg: "공백 대신 하이픈(-)", fix: fixSlug(v) });
  }
  return issues;
}

// ── CRM 메시지 규칙 검사 ──
export type CrmButton = { label: string; url: string; content: string };
export type CrmCheckInput = { source: string; medium: string; campaign: string; buttons: CrmButton[]; term: string };

export function checkCrmUtm(i: CrmCheckInput): UtmIssue[] {
  const issues: UtmIssue[] = [];
  const src = String(i.source || "").trim();
  if (src !== CRM_SOURCE) issues.push({ field: "source", msg: `utm_source 는 ${CRM_SOURCE} 고정`, fix: CRM_SOURCE });
  const med = String(i.medium || "").trim();
  if (!med) issues.push({ field: "medium", msg: "발송 수단을 고르세요" });
  else if (!CRM_MEDIUM_VALUES.includes(med)) issues.push({ field: "medium", msg: `매체는 ${CRM_MEDIUM_VALUES.join(" / ")} 중 하나` });
  const camp = String(i.campaign || "").trim();
  if (!camp) issues.push({ field: "campaign", msg: "캠페인을 입력하세요" });
  else if (/[가-힣]/.test(camp)) issues.push({ field: "campaign", msg: "영문 소문자 kebab-case 로 적습니다", fix: slugify(camp) || undefined });
  else if (!SLUG_RE.test(camp)) issues.push({ field: "campaign", msg: "영문 소문자·숫자·하이픈(-)만", fix: fixSlug(camp) });
  else if (DATE_SUFFIX_RE.test(camp)) issues.push({ field: "campaign", msg: "날짜·버전 접미 없이(추이가 끊깁니다)", fix: fixSlug(camp) });
  const term = String(i.term || "").trim();
  if (term && !["a", "b"].includes(term)) issues.push({ field: "term", msg: "A/B 변형은 a 또는 b 만", fix: term.toLowerCase().startsWith("a") ? "a" : term.toLowerCase().startsWith("b") ? "b" : "" });
  const tracked = i.buttons.filter((b) => isTrackedUrl(b.url));
  if (tracked.length === 0 && i.buttons.some((b) => String(b.url || "").trim())) issues.push({ field: "buttons", msg: "추적 가능한 링크가 없습니다(우리 도메인 밖에는 UTM 을 붙이지 않습니다)" });
  i.buttons.forEach((b, idx) => {
    const url = String(b.url || "").trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) { issues.push({ field: `button.${idx}.url`, msg: "https:// 로 시작하는 주소" }); return; }
    if (!isTrackedUrl(url)) return;
    if (/^http:\/\//i.test(url)) issues.push({ field: `button.${idx}.url`, msg: "https 로", fix: url.replace(/^http:\/\//i, "https://") });
    const c = String(b.content || "").trim();
    if (tracked.length >= 2 && !c) issues.push({ field: `button.${idx}.content`, msg: "버튼이 둘 이상이면 content 필수", fix: slugify(b.label) || undefined });
    else if (c && /[가-힣]/.test(c)) issues.push({ field: `button.${idx}.content`, msg: "영문 슬러그로", fix: slugify(c) || undefined });
    else if (c && !SLUG_RE.test(c)) issues.push({ field: `button.${idx}.content`, msg: "영문 소문자·숫자·하이픈(-)만", fix: fixSlug(c) });
  });
  const contents = tracked.map((b) => String(b.content || "").trim()).filter(Boolean);
  if (new Set(contents).size !== contents.length) issues.push({ field: "buttons", msg: "버튼 content 가 겹칩니다(버튼마다 다르게)" });
  return issues;
}

// 엑셀 가져오기용 — 한 줄의 링크 URL 칸(줄바꿈 여러 개)·캠페인·매체를 그대로 검사.
export function checkCrmRow(row: { urls: string[]; campaign: string; medium: string }): UtmIssue[] {
  const buttons: CrmButton[] = row.urls.map((u, i) => { const p = parseUtm(u); return { label: `링크${i + 1}`, url: u, content: p.content || "" }; });
  const issues = checkCrmUtm({ source: CRM_SOURCE, medium: row.medium, campaign: row.campaign, buttons, term: "" });
  row.urls.forEach((u, idx) => {
    if (!isTrackedUrl(u)) return;
    const p = parseUtm(u);
    if (p.source && p.source !== CRM_SOURCE) issues.push({ field: `button.${idx}.url`, msg: `링크의 utm_source 가 ${p.source} (kakao 여야 함)` });
    if (p.medium && row.medium && p.medium !== row.medium) issues.push({ field: `button.${idx}.url`, msg: `링크의 utm_medium ${p.medium} 이 매체 칸 ${row.medium} 과 다름` });
    if (p.campaign && row.campaign && p.campaign !== row.campaign) issues.push({ field: `button.${idx}.url`, msg: `링크의 utm_campaign ${p.campaign} 이 캠페인 칸 ${row.campaign} 과 다름` });
    if (p.term && !["a", "b"].includes(p.term)) issues.push({ field: `button.${idx}.url`, msg: `utm_term ${p.term} 은 a/b 만` });
  });
  return issues;
}
