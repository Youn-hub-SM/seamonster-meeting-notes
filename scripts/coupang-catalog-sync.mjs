// 쿠팡 등록 카탈로그 동기화 — 중계 서버(클라우드웨이즈)/로컬에서 실행.
//  쿠팡 오픈API 도 발급 시 등록한 IP 에서만 호출이 허용된다 — 서버 IP(158.247.253.90)를 Wing 에 등록할 것.
//  실행: node scripts/coupang-catalog-sync.mjs [서버URL]
//  자격증명(.env.local — 스크립트 상위 폴더): COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY / COUPANG_VENDOR_ID
//  업로드 인증: NAVER_COMMERCE_CLIENT_SECRET (채널 공용 업로드 시크릿 — upload 라우트와 공유)
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = (process.argv[2] || "https://meeting-notes-beryl.vercel.app").replace(/\/+$/, "");
const HOST = "https://api-gateway.coupang.com";
const CHANNEL = "쿠팡";

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const accessKey = (env.COUPANG_ACCESS_KEY || "").trim();
const secretKey = (env.COUPANG_SECRET_KEY || "").trim();
const vendorId = (env.COUPANG_VENDOR_ID || "").trim();
const uploadSecret = (env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
if (!accessKey || !secretKey || !vendorId) {
  console.error("[중단] .env.local 에 COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY / COUPANG_VENDOR_ID 가 필요합니다.");
  process.exit(1);
}
if (!uploadSecret) {
  console.error("[중단] .env.local 에 NAVER_COMMERCE_CLIENT_SECRET(업로드 공용 시크릿)이 필요합니다.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 쿠팡 HMAC 서명 — signed-date(yyMMdd'T'HHmmss'Z', UTC) + method + path + query(물음표 제외)
function coupangHeaders(method, fullPath) {
  const [p, q = ""] = fullPath.split("?");
  const datetime = new Date().toISOString().slice(2, 19).replace(/[:-]/g, "") + "Z";
  const message = datetime + method + p + q;
  const signature = crypto.createHmac("sha256", secretKey).update(message).digest("hex");
  return {
    Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`,
    "Content-Type": "application/json;charset=UTF-8",
  };
}

// 429/5xx 재시도 래퍼
async function coupangGet(fullPath) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(HOST + fullPath, { headers: coupangHeaders("GET", fullPath), signal: AbortSignal.timeout(20_000) });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    return res;
  }
}

async function main() {
  // 1) 상품 목록 (nextToken 페이징)
  const base = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
  const products = [];
  let nextToken = "";
  let truncated = false;
  for (let page = 0; page < 200; page++) {
    const q = `?vendorId=${vendorId}&maxPerPage=100` + (nextToken ? `&nextToken=${nextToken}` : "");
    const res = await coupangGet(base + q);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.message || json.errorMessage || "";
      // 원문을 항상 남긴다 — 인증/IP 문제(401·403)일 때만 안내를 덧붙인다
      console.error(`[중단] 상품 목록 실패 (HTTP ${res.status}) ${json.code || ""} ${msg}`.trim());
      if (res.status === 401 || res.status === 403) {
        console.error("       401/403 이면 키 값과 Wing 오픈API '허용 IP' 에 이 서버 IP 가 등록됐는지 확인하세요.");
      }
      process.exit(1);
    }
    for (const p of json.data ?? []) products.push(p);
    nextToken = String(json.nextToken ?? "").trim();
    if (!nextToken) break;
    if (page === 199) truncated = true;
    await sleep(150);
  }
  console.log(`등록 상품 ${products.length}개${truncated ? " (페이지 캡 초과 — 절단됨)" : ""}`);
  if (products.length === 0) {
    console.error("[중단] 등록 상품이 0개로 반환됨 — 응답 형상 확인 필요. 업로드하지 않습니다.");
    process.exit(1);
  }

  // 2) 상품 상세 → 아이템(옵션) 행 전개. 필드명은 문서 버전에 따라 달라 후보를 방어적으로 읽는다.
  const items = [];
  let failed = 0;
  let firstError = null;
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const originNo = String(p.sellerProductId ?? "");
    try {
      const res = await coupangGet(`${base}/${p.sellerProductId}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`HTTP ${res.status} ${j.code || ""} ${j.message || ""}`.trim());
      }
      const json = await res.json();
      const d = json.data ?? {};
      const listingName = String(d.sellerProductName ?? p.sellerProductName ?? "");
      const status = String(d.statusName ?? p.statusName ?? "").trim() || null;
      const its = Array.isArray(d.items) ? d.items : [];
      for (let k = 0; k < its.length; k++) {
        const it = its[k];
        const itemId = it.vendorItemId ?? it.sellerProductItemId ?? it.itemId ?? k;
        items.push({
          item_key: `${originNo}:item:${itemId}`,
          origin_no: originNo,
          listing_name: listingName,
          item_kind: its.length > 1 ? "option" : "product",
          item_name: its.length > 1 ? String(it.itemName ?? "").trim() || null : null,
          sku_code: String(it.externalVendorSku ?? "").trim(),
          sale_status: status,
          stock_qty: it.maximumBuyCount != null ? Number(it.maximumBuyCount) : null,
        });
      }
      if (its.length === 0) {
        items.push({
          item_key: `${originNo}:product:0`, origin_no: originNo, listing_name: listingName,
          item_kind: "product", item_name: null, sku_code: "", sale_status: status, stock_qty: null,
        });
      }
    } catch (e) {
      failed++;
      if (!firstError) firstError = `${originNo}: ${e.message}`;
    }
    if ((i + 1) % 20 === 0) console.log(`상세 조회 ${i + 1}/${products.length}...`);
    await sleep(150);
  }
  console.log(`카탈로그 행 ${items.length}개 생성 (상세 실패 ${failed}건${firstError ? ` — 첫 실패: ${firstError}` : ""})`);
  if (items.length === 0) {
    console.error("[중단] 상세 조회가 전건 실패해 업로드할 행이 없습니다 — 크론이 성공으로 오인하지 않게 실패로 종료합니다.");
    process.exit(1);
  }

  // 3) 서버 업로드 — 500행 청크, 마지막 청크에 live_origins
  const liveOrigins = truncated ? undefined : products.map((p) => String(p.sellerProductId));
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
  console.log("쿠팡 동기화 완료");
}

main().catch((e) => { console.error(`[중단] 오류: ${e?.message || e}`); process.exit(1); });
