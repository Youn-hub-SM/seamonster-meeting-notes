// 카페24 공식몰 리뷰 수집 — 중계 서버(클라우드웨이즈) 크론, 하루 한 번이면 충분하다(광고 카피 에이전트가 주 1회 읽는다, migration 166).
//  실행: node scripts/cafe24-review-sync.mjs [서버URL] [--boards=4] [--days=14] [--list]
//   · --list      게시판 번호·이름만 출력하고 끝낸다(리뷰 게시판 번호를 모를 때 먼저 실행)
//   · --boards=   리뷰 게시판 번호(쉼표로 여럿). 기본 4(카페24 기본 '상품 사용후기')
//   · --days=     오늘부터 며칠 전까지 읽을지. 기본 14. 처음 한 번은 --days=365 로 지난 리뷰를 채운다
//   · 목록: GET /api/v2/admin/boards/{board_no}/articles — 작성일 창(start_date~end_date), 100건씩
//   · 상품명: GET /api/v2/admin/products?product_no=… (게시글에는 상품 번호만 있다)
//   · 업로드: POST {서버}/api/agents/tick/reviews (Bearer 업로드 공용 시크릿)
//  권한: 카페24 앱에 '게시판 읽기(mall.read_community)'가 있어야 하고, 토큰도 그 권한으로 받은 것이어야 한다.
//   403 이 나오면 scripts/cafe24-auth.mjs 의 scope 에 mall.read_community 를 넣어 다시 인증한다.
//  개인정보: 작성자 이름·아이디·이메일·IP·주문번호는 보내지 않는다. 답글(관리자 댓글)·비밀글·삭제글은 뺀다.
//  토큰: 상위 폴더의 .cafe24-token.json — 다른 크론과 같은 파일. 유효하면 그대로 쓰고 만료 임박일 때만 갱신한다(cafe24-subscription-sync 와 같은 규칙).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const SERVER = (args.find((a) => !a.startsWith("--")) || "https://meeting-notes-beryl.vercel.app").replace(/\/+$/, "");
const LIST_ONLY = args.includes("--list");
const BOARDS = String(opt("boards", "4")).split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const DAYS = Math.max(1, Math.min(1100, Number(opt("days", "14")) || 14));
const TOKEN_FILE = path.join(ROOT, ".cafe24-token.json");

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const mallId = (env.CAFE24_MALL_ID || "").trim();
const clientId = (env.CAFE24_CLIENT_ID || "").trim();
const clientSecret = (env.CAFE24_CLIENT_SECRET || "").trim();
const uploadSecret = (env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
if (!mallId || !clientId || !clientSecret || !uploadSecret || !fs.existsSync(TOKEN_FILE)) {
  console.error("[중단] .env.local(CAFE24_MALL_ID·CLIENT_ID·CLIENT_SECRET·NAVER_COMMERCE_CLIENT_SECRET) 또는 .cafe24-token.json 이 없습니다.");
  process.exit(1);
}
const API = `https://${mallId}.cafe24api.com/api/v2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const expMs = (s) => { s = String(s || ""); const t = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}+09:00`); return Number.isFinite(t) ? t : 0; };

async function getToken(force = false) {
  const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  if (!force && saved.access_token && expMs(saved.expires_at) - Date.now() > 5 * 60_000) return saved.access_token;
  for (let attempt = 0; ; attempt++) {
    const cur = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); // 다른 크론이 막 회전시켰을 수 있어 매번 다시 읽는다
    const res = await fetch(`${API}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64") },
      signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cur.refresh_token }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.access_token) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(json, null, 2)); return json.access_token; }
    if (attempt >= 1) throw new Error(`카페24 토큰 갱신 실패 (HTTP ${res.status}) ${json.error || ""} ${json.error_description || ""}`.trim());
    await sleep(3000);
  }
}

let token = await getToken();
let forced = false;
// GET — 401 이면 한 번만 강제 갱신, 429·5xx·시간 초과·연결 오류는 지수 대기 후 재시도, 그 밖의 오류는 던진다
async function get(url) {
  for (let backoff = 1000; ; backoff *= 2) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (backoff <= 16000) { await sleep(backoff); continue; }
      throw e;
    }
    if (res.status === 401 && !forced) { forced = true; token = await getToken(true); backoff /= 2; continue; }
    if ((res.status === 429 || res.status >= 500) && backoff <= 16000) { await sleep(backoff); continue; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = res.status === 403 ? " — 게시판 읽기 권한(mall.read_community)이 없습니다. 카페24 앱 권한과 토큰의 scope 를 확인하세요." : "";
      throw new Error(`HTTP ${res.status} ${j.error?.message || j.message || ""}${hint}`.trim());
    }
    return j;
  }
}

if (LIST_ONLY) {
  const j = await get(`${API}/admin/boards`);
  for (const b of j.boards || []) console.log(`${String(b.board_no).padStart(4)}  ${b.board_name}${b.board_type ? `  (유형 ${b.board_type})` : ""}`);
  process.exit(0);
}
if (!BOARDS.length) { console.error("[중단] --boards 에 게시판 번호가 없습니다."); process.exit(1); }

const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const startD = new Date(Date.now() + 9 * 3600e3 - DAYS * 86400e3).toISOString().slice(0, 10);
// 고객이 쓰지 않은 글은 올리지 않는다 — app/lib/agents/review-clean.ts 와 같은 규칙(고치면 둘 다 고친다).
//  ① 리뷰 앱(알파리뷰)이 별점에 맞춰 자동으로 채운 문구 ② 스마트스토어 리뷰를 게시판으로 복사해 온 글(엑셀로 따로 받는다)
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const AUTO_TEMPLATES = new Set(["만족해요. 역시 생선은 씨몬스터! 감사합니다!", "수산물로 건강한 식단을 꾸리고 있어요! 감사합니다.", "나쁘지 않은 선택이었던 것 같아요", "무난한 상품이에요 감사합니다", "솔직히 조금 실망했어요. 다음 번엔 더 좋은 상품 부탁드려요", "운이 안 좋았던 건가.. 다음 번엔 더 좋은 상품으로 준비해주세요"]);
const IMPORTED = /\(\d{4}-\d{2}-\d{2} 스마트스토어에서 등록된 구매후기\)\s*$/;
function customerText(t) {
  if (!t || IMPORTED.test(t)) return null;
  const body = t.replace(/\s*alpha_review\s*$/, "").trim();
  return body && !AUTO_TEMPLATES.has(body.replace(EMOJI, "").replace(/\s+/g, " ").trim()) ? body : null;
}
const plain = (s) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

const reviews = [];
let skippedAuto = 0;
for (const board of BOARDS) {
  for (let offset = 0; offset <= 8000; offset += 100) {
    const j = await get(`${API}/admin/boards/${board}/articles?start_date=${startD}&end_date=${today}&limit=100&offset=${offset}`);
    const list = j.articles || [];
    for (const a of list) {
      if (Number(a.reply_depth) > 0 || a.parent_article_no && a.parent_article_no !== a.article_no) continue; // 답글
      if (a.deleted === "T" || a.secret === "T" || a.notice === "T") continue;
      const content = customerText(plain(a.content));
      if (!content) { skippedAuto++; continue; }
      reviews.push({
        board_no: board, article_no: Number(a.article_no), product_no: a.product_no ? Number(a.product_no) : null,
        rating: Number(a.rating) >= 1 ? Number(a.rating) : null, title: plain(a.title), content,
        has_photo: Array.isArray(a.attach_file_urls) ? a.attach_file_urls.length > 0 : /<img/i.test(String(a.content || "")),
        written_at: a.created_date || null,
      });
    }
    if (list.length < 100) break;
    await sleep(300);
  }
}

// 상품명 붙이기 — 상품 번호 100개씩
const names = new Map();
const ids = [...new Set(reviews.map((r) => r.product_no).filter(Boolean))];
for (let i = 0; i < ids.length; i += 100) {
  try {
    const j = await get(`${API}/admin/products?product_no=${ids.slice(i, i + 100).join(",")}&fields=product_no,product_name&limit=100`);
    for (const p of j.products || []) names.set(Number(p.product_no), plain(p.product_name));
  } catch (e) { console.error(`[${stamp()}] 상품명 조회 실패(리뷰는 그대로 올림): ${e.message}`); }
  await sleep(300);
}
for (const r of reviews) r.product_name = r.product_no ? names.get(r.product_no) || null : null;

if (!reviews.length) { console.log(`[${stamp()}] 리뷰 없음 (게시판 ${BOARDS.join(",")}, ${startD}~${today})`); process.exit(0); }
let saved = 0;
for (let i = 0; i < reviews.length; i += 500) {
  const res = await fetch(`${SERVER}/api/agents/tick/reviews`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${uploadSecret}` },
    body: JSON.stringify({ reviews: reviews.slice(i, i + 500) }), signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) { console.error(`[${stamp()}] 업로드 실패 (HTTP ${res.status}) ${j.error || ""}`); process.exit(1); }
  saved += j.saved || 0;
}
console.log(`[${stamp()}] 리뷰 ${saved}건 저장 · 자동 문구·복사본 ${skippedAuto}건 제외 (게시판 ${BOARDS.join(",")}, ${startD}~${today})`);
