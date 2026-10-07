// 카페24 정기배송 신청 수집 — 중계 서버(클라우드웨이즈) 크론, 매일 05:30 KST(2026-10-07 대표 결정, migration 127).
//  실행: node scripts/cafe24-subscription-sync.mjs [서버URL] [--all-payments]
//   · 신청 목록: GET /api/v2/admin/subscription/shipments — 신청일 기준 1개월 창으로 전 기간(시작 2025-01-01) 조회
//   · 회차별 결제: GET /subscription/shipments/{id}/payments — 이용중·일시정지 신청과 최근 45일 안에 신청·해지된 신청만
//     (--all-payments 면 전부 — 처음 한 번)
//   · 업로드: POST {서버}/api/subscription/sync (Bearer 업로드 공용 시크릿)
//  개인정보: 연락처·주소·이메일은 보내지 않는다. 회원 아이디·신청자/수령자 이름은 서버가 받는 즉시 암호화 값으로 바꿔 저장(원문 저장 안 함),
//   주소는 첫 낱말(시·도)만 보낸다.
//  토큰: 상위 폴더의 .cafe24-token.json — 다른 크론(claims-poll 등)과 같은 파일. 유효한 access_token 은 그대로 쓰고
//   만료 임박일 때만 갱신·저장한다(refresh_token 회전 경합을 늘리지 않게 — claims-poll 과 같은 규칙).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const SERVER = (args.find((a) => !a.startsWith("--")) || "https://meeting-notes-beryl.vercel.app").replace(/\/+$/, "");
const ALL_PAYMENTS = args.includes("--all-payments");
const START = "2025-01-01"; // 정기배송 첫 신청(2025-08) 이전부터 — 빈 달은 호출 1번
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
// GET — 401 이면 한 번만 강제 갱신, 429·5xx·시간 초과·연결 오류는 지수 대기(1→2→4→8→16초) 후 재시도, 그 밖의 오류는 던진다
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
    if (!res.ok) throw new Error(`HTTP ${res.status} ${j.error?.message || j.message || ""}`.trim());
    return j;
  }
}

// 1) 신청 목록 — 신청일 기준 1개월 창(최대 기간 제한이 문서에 없어 안전하게 나눔), 창마다 100건씩 offset 5000 까지
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const subs = [];
let complete = true;
const errors = [];
for (let [y, m] = START.split("-").map(Number); ; m++) {
  if (m > 12) { m = 1; y++; }
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  if (start > today) break;
  const endD = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const end = endD > today ? today : endD;
  try {
    for (let offset = 0; ; offset += 100) {
      if (offset > 5000) { complete = false; errors.push(`${start} 창이 5,100건을 넘음 — 창을 줄여야 함`); break; }
      const qs = new URLSearchParams({ date_type: "created_date", start_date: start, end_date: end, limit: "100", offset: String(offset) });
      const j = await get(`${API}/admin/subscription/shipments?${qs}`);
      const arr = Array.isArray(j.shipments) ? j.shipments : j.shipments ? [j.shipments] : [];
      for (const s of arr) {
        subs.push({
          subscription_id: s.subscription_id, created_date: s.created_date, subscription_state: s.subscription_state,
          member_id: s.member_id || null, buyer_name: s.buyer_name || null, receiver_name: s.receiver_name || null,
          region: String(s.receiver_address1 || "").trim().split(/\s+/)[0] || null, // 시·도만
          items: (s.items || []).map((it) => ({
            subscription_item_id: it.subscription_item_id, product_no: it.product_no, product_code: it.product_code, variant_code: it.variant_code,
            product_name: it.product_name, option_value: it.option_value, quantity: it.quantity,
            subscription_cycle: it.subscription_cycle, subscription_cycle_count: it.subscription_cycle_count,
            subscription_shipments_sequence: it.subscription_shipments_sequence, subscription_state: it.subscription_state,
            expected_pay_date: it.expected_pay_date, expected_delivery_date: it.expected_delivery_date, terminated_date: it.terminated_date,
            max_delivery_limit: it.max_delivery_limit,
          })),
        });
      }
      if (arr.length < 100) break;
      await sleep(500);
    }
  } catch (e) { complete = false; errors.push(`${start}: ${e.message}`); }
  await sleep(500);
}
if (!subs.length) {
  console.error(`[${stamp()}] [중단] 받은 신청이 없습니다 ${errors.join(" / ")}`);
  process.exit(1);
}

// 2) 회차별 결제 — 상태가 바뀔 수 있는 신청만(해지 45일 지난 신청은 더 안 바뀐다)
const cut = new Date(Date.now() + 9 * 3600e3 - 45 * 86400e3).toISOString().slice(0, 10);
const payTargets = subs.filter((s) => ALL_PAYMENTS
  || String(s.created_date || "").slice(0, 10) >= cut
  || s.items.some((it) => ["U", "B", "Q"].includes(it.subscription_state) || String(it.terminated_date || "").slice(0, 10) >= cut));
const payments = [];
let payErr = 0;
for (const s of payTargets) {
  try {
    for (let offset = 0; offset <= 5000; offset += 100) {
      const j = await get(`${API}/admin/subscription/shipments/${encodeURIComponent(s.subscription_id)}/payments?limit=100&offset=${offset}`);
      const arr = j.payments || [];
      for (const p of arr) payments.push({ subscription_id: s.subscription_id, order_id: p.order_id, status: p.status, payment_date: p.payment_date });
      if (arr.length < 100) break;
    }
  } catch { payErr++; }
  await sleep(500); // 유량(초당 2회 감소)에 맞춤
}

// 3) 업로드
const res = await fetch(`${SERVER}/api/subscription/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${uploadSecret}` },
  signal: AbortSignal.timeout(90_000),
  body: JSON.stringify({ complete, subs, payments }),
});
const out = await res.json().catch(() => ({}));
const line = `[${stamp()}] 신청 ${subs.length} · 결제 ${payments.length}(대상 ${payTargets.length}${payErr ? `, 실패 ${payErr}` : ""}) · ${complete ? "전체" : "일부"}${errors.length ? ` · 오류: ${errors.join(" / ")}` : ""}`;
if (!res.ok || !out.ok) {
  console.error(`${line} → 업로드 실패 HTTP ${res.status} ${out.error || ""}`);
  process.exit(1);
}
console.log(`${line} → 저장 신청 ${out.subs} · 품목 ${out.items} · 결제 ${out.payments}${out.removed ? ` · 삭제 ${out.removed}` : ""}${out.snapshot ? ` · 스냅샷 ${out.snapshot}` : ""}`);
// 일부 기간 조회 실패 — 받은 것은 저장했지만 그 기간 신청은 이전 상태로 남는다. 크론 로그에서 실패로 보이게 종료 코드 2
if (!complete) process.exit(2);
