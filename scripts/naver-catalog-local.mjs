// 네이버 등록 카탈로그 — 로컬 동기화 스크립트 (클로드 코드/터미널/직원 배포용 exe)
//
// 커머스API 는 애플리케이션에 등록된 IP 에서만 호출이 허용된다(GW.IP_NOT_ALLOWED).
// Vercel 은 고정 IP 가 없어 서버 동기화가 막히므로, 등록 IP 인 PC 에서 네이버를 호출해
// 서버 업로드 라우트(/api/naver/catalog/upload)로 밀어넣는다.
//
// 실행: 저장소 루트에서  node scripts/naver-catalog-local.mjs  [서버URL]
//  - 자격증명: 개발 모드 = .env.local / exe 모드 = 실행파일 옆 naver.env
//  - 서버URL 기본값은 운영(https://meeting-notes-beryl.vercel.app) — DB 가 하나라 베타에서도 보인다.
//  - 시크릿·토큰 값은 출력하지 않는다.
//  - 직원 배포 exe 빌드: esbuild 로 CJS 번들 후 @yao-pkg/pkg (top-level await 금지 → main() 구조 유지)
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

const IS_PKG = !!process.pkg; // 직원 배포용 exe 로 패키징된 경우(@yao-pkg/pkg)
const SERVER = (process.argv[2] || "https://meeting-notes-beryl.vercel.app").replace(/\/+$/, "");
const BASE = "https://api.commerce.naver.com/external";

function rootDir() {
  if (IS_PKG) return path.dirname(process.execPath);
  // 개발 모드: 이 파일(scripts/) 기준 저장소 루트. CJS 번들에선 __dirname, ESM 실행에선 cwd 폴백.
  try {
    // eslint-disable-next-line no-undef
    if (typeof __dirname !== "undefined") return path.resolve(__dirname, "..");
  } catch { /* ESM */ }
  return process.cwd();
}

// exe 모드는 실행파일 옆의 naver.env, 개발 모드는 저장소 루트의 .env.local 을 읽는다.
function readEnvFile() {
  const p = IS_PKG ? path.join(rootDir(), "naver.env") : path.join(rootDir(), ".env.local");
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// exe 더블클릭 시 콘솔 창이 바로 닫히지 않게 — 끝나면 Enter 대기
async function finish(code) {
  if (IS_PKG) {
    console.log("");
    console.log("Enter 키를 누르면 창이 닫힙니다.");
    await new Promise((r) => { process.stdin.resume(); process.stdin.once("data", r); });
  }
  process.exit(code);
}

const timeout = () => AbortSignal.timeout(20_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const env = readEnvFile();
  const id = (env.NAVER_COMMERCE_CLIENT_ID || "").trim();
  const secret = (env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
  if (!id || !secret) {
    console.error(IS_PKG
      ? "[중단] 실행파일과 같은 폴더의 naver.env 파일에 자격증명이 필요합니다."
      : "[중단] .env.local 에 NAVER_COMMERCE_CLIENT_ID / NAVER_COMMERCE_CLIENT_SECRET 을 추가하세요.");
    return finish(1);
  }

  // 1) 토큰
  const ts = Date.now();
  const sign = Buffer.from(bcrypt.hashSync(`${id}_${ts}`, secret), "utf8").toString("base64");
  const tokenRes = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: timeout(),
    body: new URLSearchParams({ client_id: id, timestamp: String(ts), grant_type: "client_credentials", client_secret_sign: sign, type: "SELF" }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    if (/IP_NOT_ALLOWED/i.test(String(tokenJson.code || "") + String(tokenJson.message || ""))) {
      console.error("[중단] 이 PC 의 인터넷 IP 가 네이버 커머스API센터에 등록돼 있지 않습니다.");
      // 등록해야 할 현재 공인 IP 를 바로 보여준다 — 유동 IP 회선에서 IP 가 바뀌면 이 메시지로 갱신
      const myIp = await fetch("https://api.ipify.org", { signal: timeout() }).then((r) => r.text()).catch(() => "확인 실패");
      console.error(`       현재 이 PC 의 공인 IP: ${myIp}`);
      console.error("       커머스API센터 > 애플리케이션 > API 호출 IP 에 위 IP 를 추가한 뒤 다시 실행하세요.");
    } else {
      console.error(`[중단] 토큰 발급 실패 (HTTP ${tokenRes.status}) ${tokenJson.code || ""} ${tokenJson.message || ""}`);
    }
    return finish(1);
  }
  const token = tokenJson.access_token;
  console.log("토큰 발급 성공");

  // 2) 등록 상품 전체 목록
  const products = [];
  let truncated = false;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${BASE}/v1/products/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      signal: timeout(),
      body: JSON.stringify({ page, size: 100 }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      console.error(`[중단] 상품 목록 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`);
      return finish(1);
    }
    const json = await res.json();
    for (const c of json.contents ?? []) {
      const cp = (c.channelProducts ?? [])[0] || {};
      products.push({
        originProductNo: c.originProductNo,
        name: String(cp.name ?? ""),
        statusType: cp.statusType != null ? String(cp.statusType) : undefined,
        sellerManagementCode: cp.sellerManagementCode != null ? String(cp.sellerManagementCode) : "",
        stockQuantity: cp.stockQuantity != null ? Number(cp.stockQuantity) : undefined,
      });
    }
    if (!json.totalPages || page >= json.totalPages) break;
    if (page === 50 && json.totalPages > 50) truncated = true;
  }
  console.log(`등록 원상품 ${products.length}개${truncated ? " (50페이지 초과 — 절단됨)" : ""}`);
  if (products.length === 0) {
    console.error("[중단] 등록 상품이 0개로 반환됨 — 응답 형상 확인 필요. 업로드하지 않습니다.");
    return finish(1);
  }

  // 3) 원상품 상세 → 카탈로그 행 전개 (서버 lib 와 같은 규칙)
  const skuOf = (r) => String(r.sellerManagerCode ?? r.sellerManagementCode ?? "").trim();

  // 상세 조회 — 429(레이트리밋)는 지수 백오프로 최대 4회 재시도
  async function fetchDetail(originProductNo) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}/v2/products/origin-products/${originProductNo}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: timeout(),
      });
      if (res.status === 429 && attempt < 4) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return res;
    }
  }

  const items = [];
  let failed = 0;
  let firstError = null;
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const originNo = String(p.originProductNo);
    try {
      const res = await fetchDetail(p.originProductNo);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`HTTP ${res.status} ${j.code || ""} ${j.message || ""}`.trim());
      }
      const json = await res.json();
      const op = json.originProduct ?? {};
      const detail = op.detailAttribute ?? {};
      const listingName = p.name || String(op.name ?? "");
      const combos = detail.optionInfo?.optionCombinations ?? [];
      for (const c of combos) {
        const optName = [c.optionName1, c.optionName2, c.optionName3, c.optionName4]
          .filter((v) => v != null && String(v).trim() !== "").map(String).join(" / ");
        items.push({
          item_key: `${originNo}:option:${c.id}`, origin_no: originNo, listing_name: listingName,
          item_kind: "option", item_name: optName || null, sku_code: skuOf(c),
          sale_status: c.usable === false ? "UNUSABLE" : p.statusType || null,
          stock_qty: c.stockQuantity != null ? Number(c.stockQuantity) : null,
        });
      }
      const supps = detail.supplementProductInfo?.supplementProducts ?? [];
      for (const s of supps) {
        items.push({
          item_key: `${originNo}:supplement:${s.id}`, origin_no: originNo, listing_name: listingName,
          item_kind: "supplement",
          item_name: [s.groupName, s.name].filter((v) => v != null && String(v).trim() !== "").map(String).join(" - ") || null,
          sku_code: skuOf(s),
          sale_status: s.usable === false ? "UNUSABLE" : p.statusType || null,
          stock_qty: s.stockQuantity != null ? Number(s.stockQuantity) : null,
        });
      }
      if (combos.length === 0) {
        items.push({
          item_key: `${originNo}:product:0`, origin_no: originNo, listing_name: listingName,
          item_kind: "product", item_name: null, sku_code: (p.sellerManagementCode || skuOf(op)).trim(),
          sale_status: p.statusType || null, stock_qty: p.stockQuantity ?? null,
        });
      }
    } catch (e) {
      failed++;
      if (!firstError) firstError = `${originNo}: ${e.message}`;
    }
    if ((i + 1) % 20 === 0) console.log(`상세 조회 ${i + 1}/${products.length}...`);
    await sleep(400); // 커머스API 레이트리밋 여유(429 방지)
  }
  console.log(`카탈로그 행 ${items.length}개 생성 (상세 실패 ${failed}건${firstError ? ` — 첫 실패: ${firstError}` : ""})`);

  // 4) 서버 업로드 — 500행 청크, 마지막 청크에 live_origins(절단 시 생략 → 서버가 stale 삭제 건너뜀)
  const liveOrigins = truncated ? undefined : products.map((p) => String(p.originProductNo));
  for (let i = 0; i < items.length; i += 500) {
    const isLast = i + 500 >= items.length;
    const res = await fetch(`${SERVER}/api/naver/catalog/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ items: items.slice(i, i + 500), ...(isLast && liveOrigins ? { live_origins: liveOrigins } : {}) }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      console.error(`[중단] 업로드 실패 (HTTP ${res.status}) ${j.error || ""}`);
      return finish(1);
    }
    console.log(`업로드 ${Math.min(i + 500, items.length)}/${items.length}${j.removed_origins ? ` (내려간 상품 ${j.removed_origins}개 정리)` : ""}`);
  }
  console.log("동기화 완료 — 화면(SKU 리스팅 찾기)에서 확인하세요.");
  return finish(0);
}

main().catch(async (e) => {
  console.error(`[중단] 오류: ${e?.message || e}`);
  await finish(1);
});
