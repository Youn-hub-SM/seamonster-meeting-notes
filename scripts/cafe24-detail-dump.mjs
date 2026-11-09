// 카페24 전체 상품의 상세설명을 읽어 JSON 으로 저장 — 읽기 전용(쓰기 없음). 중계 서버에서 실행.
//  용도: 상세설명 안 아코디언 블록(.smd-info) 현황 조사 → 상세페이지 전송 소스로 옮기기(2026-11-09).
//  실행: node bin/cafe24-detail-dump.mjs [출력경로]   (기본 logs/detail-dump.json)
//  env(.env.local): CAFE24_MALL_ID / CAFE24_CLIENT_ID / CAFE24_CLIENT_SECRET (+ .cafe24-token.json)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] || path.join(ROOT, "logs", "detail-dump.json");
const TOKEN_FILE = path.join(ROOT, ".cafe24-token.json");

const env = {};
const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
  const mallId = (env.CAFE24_MALL_ID || "").trim();
  const clientId = (env.CAFE24_CLIENT_ID || "").trim();
  const clientSecret = (env.CAFE24_CLIENT_SECRET || "").trim();
  if (!mallId || !clientId || !clientSecret || !fs.existsSync(TOKEN_FILE)) throw new Error("카페24 자격증명/토큰 없음");
  const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64") },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refresh_token }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) throw new Error(`카페24 토큰 실패 (HTTP ${res.status}) ${json.error || ""} ${json.error_description || ""}`.trim());
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(json, null, 2));
  return { token: json.access_token, mallId };
}

async function main() {
  const { token, mallId } = await getToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const out = [];
  for (let page = 0; page < 100; page++) {
    const url = `https://${mallId}.cafe24api.com/api/v2/admin/products?shop_no=1&fields=product_no,product_name,display,selling,description,mobile_description&limit=100&offset=${page * 100}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`상품 목록 실패 (HTTP ${res.status}) ${json.error?.message || ""}`.trim());
    const batch = json.products ?? [];
    for (const p of batch) out.push({ product_no: p.product_no, product_name: p.product_name, display: p.display, selling: p.selling, description: "", mobile_description: "" });
    if (batch.length < 100) break;
    await sleep(250);
  }
  // 목록 끝점은 description 을 내려주지 않는다 → 상품별 단건 조회(95개 × 250ms ≈ 30초)
  for (const row of out) {
    const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/admin/products/${row.product_no}?shop_no=1&fields=product_no,description,mobile_description`, { headers, signal: AbortSignal.timeout(30_000) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.product) { row.description = json.product.description ?? ""; row.mobile_description = json.product.mobile_description ?? ""; }
    else console.error(`  상품 ${row.product_no} 상세 조회 실패 (HTTP ${res.status})`);
    await sleep(250);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ dumped_at: new Date().toISOString(), count: out.length, products: out }, null, 0));
  console.log(`상품 ${out.length}개 저장 → ${OUT}`);
}

main().catch((e) => { console.error(`[중단] ${e?.message || e}`); process.exit(1); });
