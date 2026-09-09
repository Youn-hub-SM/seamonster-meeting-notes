// 카페24(공식몰) 등록 카탈로그 동기화 — 중계 서버(클라우드웨이즈)/로컬에서 실행.
//  카페24 Admin API 는 IP 제한이 없지만 실행처를 중계 서버로 통일한다.
//  실행: node scripts/cafe24-catalog-sync.mjs [서버URL]
//  자격증명(.env.local): CAFE24_MALL_ID / CAFE24_CLIENT_ID / CAFE24_CLIENT_SECRET
//  토큰: 상위 폴더의 .cafe24-token.json (최초 발급은 scripts/cafe24-auth.mjs 로) —
//  refresh_token 은 사용할 때마다 새로 발급되므로 매 실행 후 파일을 갱신 저장한다(2주 미사용 시 만료 —
//  매일 크론이 돌면 자동 연장된다).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = (process.argv[2] || "https://meeting-notes-beryl.vercel.app").replace(/\/+$/, "");
const TOKEN_FILE = path.join(ROOT, ".cafe24-token.json");
const CHANNEL = "카페24";

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const mallId = (env.CAFE24_MALL_ID || "").trim();
const clientId = (env.CAFE24_CLIENT_ID || "").trim();
const clientSecret = (env.CAFE24_CLIENT_SECRET || "").trim();
const uploadSecret = (env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
if (!mallId || !clientId || !clientSecret) {
  console.error("[중단] .env.local 에 CAFE24_MALL_ID / CAFE24_CLIENT_ID / CAFE24_CLIENT_SECRET 이 필요합니다.");
  process.exit(1);
}
if (!uploadSecret) {
  console.error("[중단] .env.local 에 NAVER_COMMERCE_CLIENT_SECRET(업로드 공용 시크릿)이 필요합니다.");
  process.exit(1);
}
if (!fs.existsSync(TOKEN_FILE)) {
  console.error(`[중단] ${TOKEN_FILE} 이 없습니다 — 최초 1회 scripts/cafe24-auth.mjs 로 토큰을 발급하세요.`);
  process.exit(1);
}

const API = `https://${mallId}.cafe24api.com/api/v2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// refresh_token 으로 access_token 발급 + 회전된 refresh_token 저장
async function getAccessToken() {
  const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refresh_token }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    console.error(`[중단] 카페24 토큰 갱신 실패 (HTTP ${res.status}) ${json.error || ""} ${json.error_description || json.message || ""}`.trim());
    console.error("       refresh_token 이 만료됐다면 scripts/cafe24-auth.mjs 로 재발급하세요.");
    process.exit(1);
  }
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(json, null, 2));
  return json.access_token;
}

async function main() {
  const token = await getAccessToken();
  console.log("카페24 토큰 갱신 성공");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // 1) 상품 전체 (variants 포함, offset 페이징)
  const products = [];
  let truncated = false;
  for (let page = 0; page < 100; page++) {
    const res = await fetch(`${API}/admin/products?embed=variants&limit=100&offset=${page * 100}`, {
      headers, signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[중단] 상품 목록 실패 (HTTP ${res.status}) ${json.error?.message || json.message || ""}`.trim());
      process.exit(1);
    }
    const batch = json.products ?? [];
    products.push(...batch);
    if (batch.length < 100) break;
    if (page === 99) truncated = true;
    await sleep(250); // Admin API 레이트리밋 여유
  }
  console.log(`등록 상품 ${products.length}개${truncated ? " (페이지 캡 초과 — 절단됨)" : ""}`);
  if (products.length === 0) {
    console.error("[중단] 등록 상품이 0개로 반환됨 — 응답 형상 확인 필요. 업로드하지 않습니다.");
    process.exit(1);
  }

  // 2) 행 전개 — 진열/판매 플래그를 한글 상태로(화면에 그대로 표시됨)
  const statusOf = (display, selling) =>
    selling === "F" ? "판매안함" : display === "F" ? "진열안함" : "판매중";
  const items = [];
  for (const p of products) {
    const originNo = String(p.product_no);
    const listingName = String(p.product_name ?? "");
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const hasOptions = variants.length > 1 || (variants.length === 1 && (variants[0].options ?? []).length > 0);
    if (variants.length === 0 || !hasOptions) {
      // 옵션 없는 상품도 기본 품목(variant)이 있으면 그 코드를 키에 보존 — 재고 수정 API 가 품목코드를 요구한다
      const v0 = variants[0];
      items.push({
        item_key: v0?.variant_code ? `${originNo}:variant:${v0.variant_code}` : `${originNo}:product:0`,
        origin_no: originNo, listing_name: listingName,
        item_kind: "product", item_name: null,
        sku_code: String(v0?.custom_variant_code ?? p.custom_product_code ?? "").trim(),
        sale_status: statusOf(p.display, p.selling),
        stock_qty: v0?.quantity != null ? Number(v0.quantity) : null,
      });
      continue;
    }
    for (let k = 0; k < variants.length; k++) {
      const v = variants[k];
      const optName = (v.options ?? []).map((o) => String(o.value ?? "").trim()).filter(Boolean).join(" / ");
      items.push({
        item_key: `${originNo}:variant:${v.variant_code ?? k}`,
        origin_no: originNo,
        listing_name: listingName,
        item_kind: "option",
        item_name: optName || null,
        sku_code: String(v.custom_variant_code ?? p.custom_product_code ?? "").trim(),
        sale_status: v.selling === "F" ? "판매안함" : v.display === "F" ? "진열안함" : statusOf(p.display, p.selling),
        stock_qty: v.quantity != null ? Number(v.quantity) : null,
      });
    }
  }
  console.log(`카탈로그 행 ${items.length}개 생성`);

  // 3) 서버 업로드 — 500행 청크, 마지막 청크에 live_origins
  const liveOrigins = truncated ? undefined : products.map((p) => String(p.product_no));
  for (let i = 0; i < items.length; i += 500) {
    const isLast = i + 500 >= items.length;
    const res = await fetch(`${SERVER}/api/naver/catalog/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${uploadSecret}` },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ channel: CHANNEL, items: items.slice(i, i + 500), ...(isLast && liveOrigins ? { live_origins: liveOrigins } : {}) }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      console.error(`[중단] 업로드 실패 (HTTP ${res.status}) ${j.error || ""}`);
      process.exit(1);
    }
    console.log(`업로드 ${Math.min(i + 500, items.length)}/${items.length}${j.removed_origins ? ` (내려간 상품 ${j.removed_origins}개 정리)` : ""}`);
  }
  console.log("카페24 동기화 완료");
}

main().catch((e) => { console.error(`[중단] 오류: ${e?.message || e}`); process.exit(1); });
