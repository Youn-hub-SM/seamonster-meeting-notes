// 카페24 Admin API 최초 인증 — 인증 URL 생성 + authorization code 를 토큰으로 교환.
//  1) 인증 URL 출력:  node scripts/cafe24-auth.mjs
//     → 출력된 URL 을 브라우저(카페24 운영자 로그인 상태)에서 열고 [허용] →
//       이동된 주소창의 code=값 을 복사.
//  2) 토큰 교환:      node scripts/cafe24-auth.mjs <code>
//     → 상위 폴더에 .cafe24-token.json 생성(이후 cafe24-catalog-sync.mjs 가 사용·자동 회전).
//  자격증명(.env.local): CAFE24_MALL_ID / CAFE24_CLIENT_ID / CAFE24_CLIENT_SECRET / CAFE24_REDIRECT_URI
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FILE = path.join(ROOT, ".cafe24-token.json");

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const mallId = (env.CAFE24_MALL_ID || "").trim();
const clientId = (env.CAFE24_CLIENT_ID || "").trim();
const clientSecret = (env.CAFE24_CLIENT_SECRET || "").trim();
const redirectUri = (env.CAFE24_REDIRECT_URI || "https://meeting-notes-beryl.vercel.app/").trim();
if (!mallId || !clientId || !clientSecret) {
  console.error("[중단] .env.local 에 CAFE24_MALL_ID / CAFE24_CLIENT_ID / CAFE24_CLIENT_SECRET 이 필요합니다.");
  process.exit(1);
}

const code = (process.argv[2] || "").trim();
if (!code) {
  // 재고 수정(channel-commands)까지 쓰므로 read+write 둘 다 요청 — 앱 권한에도 '상품 수정'이 있어야 한다
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("mall.read_product,mall.write_product,mall.read_order")}&state=seamonster`;
  console.log("아래 URL 을 브라우저에서 열어 [허용] 후, 이동된 주소창의 code= 값을 복사해 다시 실행하세요:");
  console.log(url);
  process.exit(0);
}

const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/oauth/token`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
  },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
});
const json = await res.json().catch(() => ({}));
if (!res.ok || !json.access_token) {
  console.error(`[중단] 토큰 교환 실패 (HTTP ${res.status}) ${json.error || ""} ${json.error_description || ""}`.trim());
  console.error("       code 는 발급 후 수 분 내 1회만 유효합니다 — 다시 인증 URL 부터 진행하세요.");
  process.exit(1);
}
fs.writeFileSync(TOKEN_FILE, JSON.stringify(json, null, 2));
console.log(`토큰 발급 성공 — ${TOKEN_FILE} 저장됨 (mall: ${json.mall_id || mallId})`);
