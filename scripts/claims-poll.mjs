// 채널 클레임(취소·반품·교환) 폴러 — 중계 서버 크론(10분)이 실행.
//  네이버·쿠팡·카페24에서 새 클레임 요청을 모아 업무도우미 서버(/api/claims/report)로 보내면,
//  서버가 (channel, claim_key) 유니크로 중복을 거르고 새 건만 Teams 알림을 보낸다(migration 112).
//  조회 창은 상태 파일 없이 '넉넉한 고정 되돌아보기'(겹침 허용) — 중복은 서버가 걸러 알림은 1회.
//
//  실행: node bin/claims-poll.cjs [서버URL]   (esbuild CJS 번들로 배포 — bcryptjs 포함)
//  env(.env.local): NAVER_COMMERCE_CLIENT_ID/SECRET, COUPANG_ACCESS_KEY/SECRET_KEY/VENDOR_ID,
//                   CAFE24_MALL_ID/CLIENT_ID/CLIENT_SECRET (+ ../.cafe24-token.json)
//  전송 인증: Bearer NAVER_COMMERCE_CLIENT_SECRET (카탈로그 업로드 공용 시크릿)
//
//  API 근거(2026-09-12 공식 문서 검증 완료):
//  - 네이버: GET /v1/pay-order/seller/product-orders/last-changed-statuses (필터 없이 수신 후
//    claimType/claimStatus 로 분류 — 공식 답변 #701) + POST /product-orders/query (상세)
//  - 쿠팡: GET v6 returnRequests (반품=status RU·UC 각각, 취소=cancelType=CANCEL 일단위+nextToken)
//          GET v4 exchangeRequests (7일 창, exchangeStatus RECEIPT = 신규)
//  - 카페24: GET /admin/orders?embed=items&date_type={claim}_request_date + order_status 클레임 코드
//    (scope mall.read_order 필요 — 재인증 후 동작)
import fs from "fs";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const IS_PKG = !!process.pkg;
function rootDir() {
  if (IS_PKG) return path.dirname(process.execPath);
  try {
    // eslint-disable-next-line no-undef
    if (typeof __dirname !== "undefined") return path.resolve(__dirname, "..");
  } catch { /* ESM */ }
  return process.cwd();
}
const ROOT = rootDir();
const SERVER = (process.argv[2] || "https://meeting-notes-beryl.vercel.app").replace(/\/+$/, "");
const NAVER_BASE = "https://api.commerce.naver.com/external";
const COUPANG_HOST = "https://api-gateway.coupang.com";

const env = {};
const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
const uploadSecret = (env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
if (!uploadSecret) { console.error("[중단] NAVER_COMMERCE_CLIENT_SECRET 없음"); process.exit(1); }

const timeout = () => AbortSignal.timeout(20_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const kstNow = () => new Date(Date.now() + 9 * 3600_000);

async function report(channel, claims) {
  if (!claims.length) { console.log(`${channel}: 새 후보 0건`); return; }
  const res = await fetch(`${SERVER}/api/claims/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${uploadSecret}` },
    signal: timeout(),
    body: JSON.stringify({ channel, claims }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) console.error(`${channel}: 전송 실패 (HTTP ${res.status}) ${j.error || ""}`);
  else console.log(`${channel}: 후보 ${claims.length}건 → 신규 ${j.inserted}건${j.inserted ? " (Teams 발송)" : ""}`);
}

// ── 네이버 ──────────────────────────────────────────────
async function naverToken() {
  const id = (env.NAVER_COMMERCE_CLIENT_ID || "").trim();
  const secret = (env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
  if (!id || !secret) throw new Error("네이버 자격증명 없음");
  const ts = Date.now();
  const sign = Buffer.from(bcrypt.hashSync(`${id}_${ts}`, secret), "utf8").toString("base64");
  const res = await fetch(`${NAVER_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: timeout(),
    body: new URLSearchParams({ client_id: id, timestamp: String(ts), grant_type: "client_credentials", client_secret_sign: sign, type: "SELF" }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) throw new Error(`네이버 토큰 실패 (HTTP ${res.status}) ${json.code || ""} ${json.message || ""}`.trim());
  return json.access_token;
}

const NAVER_TYPE_KO = { CANCEL: "취소", RETURN: "반품", EXCHANGE: "교환" };
// *_REQUEST = 판매자 승인/처리 대기. 자동 환불되는 취소(요청 단계 없는 CANCEL_DONE)는 조치가 필요
//  없는 '통보'라 대표 요청으로 알림 제외 — 아예 수집하지 않는다.
const NAVER_REQ_STATUS = new Set(["CANCEL_REQUEST", "RETURN_REQUEST", "EXCHANGE_REQUEST"]);

async function pollNaver() {
  const token = await naverToken();
  // 최근 40분 창(10분 주기 + 넉넉한 겹침) — 중복은 서버 유니크가 거른다
  const from = new Date(Date.now() - 40 * 60_000).toISOString();
  const changed = [];
  let lastChangedFrom = from;
  let moreSequence = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ lastChangedFrom });
    if (moreSequence) qs.set("moreSequence", moreSequence);
    const res = await fetch(`${NAVER_BASE}/v1/pay-order/seller/product-orders/last-changed-statuses?${qs}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: timeout(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`네이버 변경조회 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim());
    const items = j.data?.lastChangeStatuses ?? [];
    changed.push(...items);
    const more = j.data?.more;
    if (!more?.moreFrom) break;
    lastChangedFrom = more.moreFrom;
    moreSequence = more.moreSequence ?? null;
    await sleep(400);
  }
  // 판매자 처리가 필요한 클레임 요청(*_REQUEST)만 — 자동 처리 통보는 제외
  const reqs = changed.filter((c) => NAVER_TYPE_KO[c.claimType] && NAVER_REQ_STATUS.has(String(c.claimStatus)));
  if (reqs.length === 0) return report("스마트스토어", []);

  // 상세(상품명·수량·사유) — productOrderIds 다건 조회
  const detailById = new Map();
  const ids = [...new Set(reqs.map((c) => String(c.productOrderId)))];
  for (let i = 0; i < ids.length; i += 100) {
    await sleep(400);
    const res = await fetch(`${NAVER_BASE}/v1/pay-order/seller/product-orders/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      signal: timeout(),
      body: JSON.stringify({ productOrderIds: ids.slice(i, i + 100), quantityClaimCompatibility: true }),
    });
    const j = await res.json().catch(() => ({}));
    for (const d of j.data ?? []) {
      const po = d.productOrder ?? {};
      if (po.productOrderId) detailById.set(String(po.productOrderId), d);
    }
  }
  const claims = reqs.map((c) => {
    const d = detailById.get(String(c.productOrderId)) ?? {};
    const po = d.productOrder ?? {};
    const cl = d.cancel ?? d.return ?? d.exchange ?? {};
    const reason = cl.cancelDetailedReason || cl.returnDetailedReason || cl.exchangeDetailedReason
      || cl.cancelReason || cl.returnReason || cl.exchangeReason || null;
    return {
      claim_type: NAVER_TYPE_KO[c.claimType],
      claim_key: `${c.productOrderId}:${c.claimType}:${c.claimStatus}`,
      order_id: String(c.orderId ?? d.order?.orderId ?? ""),
      product_name: po.productName ?? null,
      option_name: null,
      qty: po.quantity != null ? Number(po.quantity) : null,
      reason: reason ? String(reason) : null,
      status: String(c.claimStatus ?? ""),
      requested_at: String(c.lastChangedDate ?? ""),
      action_required: true, // *_REQUEST 만 남았으므로 전부 처리 필요
    };
  });
  return report("스마트스토어", claims);
}

// ── 쿠팡 ──────────────────────────────────────────────
function coupangHeaders(method, fullPath) {
  const accessKey = (env.COUPANG_ACCESS_KEY || "").trim();
  const secretKey = (env.COUPANG_SECRET_KEY || "").trim();
  if (!accessKey || !secretKey) throw new Error("쿠팡 자격증명 없음");
  const [p, q = ""] = fullPath.split("?");
  const datetime = new Date().toISOString().slice(2, 19).replace(/[:-]/g, "") + "Z";
  const signature = crypto.createHmac("sha256", secretKey).update(datetime + method + p + q).digest("hex");
  return { Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}` };
}
async function coupangGet(fullPath) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(COUPANG_HOST + fullPath, { headers: coupangHeaders("GET", fullPath), signal: timeout() });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
    return res;
  }
}
const COUPANG_NEW_RECEIPT = new Set(["RELEASE_STOP_UNCHECKED", "RETURNS_UNCHECKED"]); // 출고중지요청·반품접수(신규)

async function pollCoupang() {
  const vendorId = (env.COUPANG_VENDOR_ID || "").trim();
  if (!vendorId) throw new Error("쿠팡 vendorId 없음");
  const base = `/v2/providers/openapi/apis/api/v6/vendors/${vendorId}/returnRequests`;
  const k = kstNow();
  const minuteStamp = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const from40 = minuteStamp(new Date(k.getTime() - 40 * 60_000));
  const toNow = minuteStamp(k);
  const claims = [];

  const pushReturnRows = (rows, typeKo, actionRequired) => {
    for (const r of rows) {
      const items = Array.isArray(r.returnItems) ? r.returnItems : [];
      const first = items[0] ?? {};
      claims.push({
        claim_type: typeKo,
        claim_key: `receipt:${r.receiptId}`,
        order_id: String(r.orderId ?? ""),
        product_name: first.vendorItemName ?? first.sellerProductName ?? null,
        option_name: items.length > 1 ? `외 ${items.length - 1}개 품목` : null,
        qty: r.cancelCountSum != null ? Number(r.cancelCountSum) : (first.cancelCount != null ? Number(first.cancelCount) : null),
        reason: r.cancelReason || r.reasonCodeText || null,
        status: String(r.receiptStatus ?? ""),
        requested_at: String(r.createdAt ?? ""),
        action_required: actionRequired,
      });
    }
  };

  // (a) 반품·출고중지 — timeFrame(분단위)은 status 필수: RU(출고중지요청)·UC(반품접수) 각 1회
  for (const status of ["RU", "UC"]) {
    const res = await coupangGet(`${base}?searchType=timeFrame&createdAtFrom=${from40}&createdAtTo=${toNow}&status=${status}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`쿠팡 반품조회(${status}) 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim());
    pushReturnRows(j.data ?? [], "반품", true); // RU=출고중지요청, UC=반품접수 — 판매자 확인/처리 필요
    await sleep(400);
  }

  // (결제완료 단계 주문취소(cancelType=CANCEL)는 쿠팡이 자동 환불 처리 — 판매자 조치 불필요라 폴링 안 함)

  // (c) 교환 — v4, 초단위 스탬프, 최근 24시간 창
  {
    const exBase = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/exchangeRequests`;
    const secStamp = (d) => `${minuteStamp(d)}:${pad(d.getUTCSeconds())}`;
    const from24h = secStamp(new Date(k.getTime() - 24 * 3600_000));
    let nextToken = "";
    for (let page = 0; page < 10; page++) {
      const q = `${exBase}?createdAtFrom=${from24h}&createdAtTo=${secStamp(k)}&maxPerPage=50` + (nextToken ? `&nextToken=${nextToken}` : "");
      const res = await coupangGet(q);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`쿠팡 교환조회 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim());
      for (const r of j.data ?? []) {
        const items = Array.isArray(r.exchangeItemDtoV1s) ? r.exchangeItemDtoV1s : [];
        const first = items[0] ?? {};
        claims.push({
          claim_type: "교환",
          claim_key: `exchange:${r.exchangeId}`,
          order_id: String(r.orderId ?? ""),
          product_name: first.targetItemName ?? null,
          option_name: items.length > 1 ? `외 ${items.length - 1}개 품목` : null,
          qty: first.quantity != null ? Number(first.quantity) : null,
          reason: r.reasonEtcDetail || r.reasonCodeText || r.reasonCode || null,
          status: String(r.exchangeStatus ?? ""),
          requested_at: String(r.createdAt ?? ""),
          action_required: String(r.exchangeStatus ?? "") === "RECEIPT", // 접수 = 판매자 처리 필요
        });
      }
      nextToken = String(j.nextToken ?? "").trim();
      if (!nextToken) break;
      await sleep(400);
    }
  }
  return report("쿠팡", claims);
}

// ── 카페24 ──────────────────────────────────────────────
async function cafe24Token() {
  const mallId = (env.CAFE24_MALL_ID || "").trim();
  const clientId = (env.CAFE24_CLIENT_ID || "").trim();
  const clientSecret = (env.CAFE24_CLIENT_SECRET || "").trim();
  const tokenFile = path.join(ROOT, ".cafe24-token.json");
  if (!mallId || !clientId || !clientSecret || !fs.existsSync(tokenFile)) throw new Error("카페24 자격증명/토큰 없음");
  const saved = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  // access_token 이 아직 유효하면 refresh 하지 않는다 — 토큰 파일 회전 경합(감사 확정)을 늘리지 않기 위해
  if (saved.access_token && saved.expires_at && new Date(saved.expires_at).getTime() - Date.now() > 5 * 60_000) {
    return { token: saved.access_token, mallId };
  }
  for (let attempt = 0; ; attempt++) {
    const cur = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      signal: timeout(),
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cur.refresh_token }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.access_token) {
      fs.writeFileSync(tokenFile, JSON.stringify(json, null, 2));
      return { token: json.access_token, mallId };
    }
    if (attempt >= 1) throw new Error(`카페24 토큰 실패 (HTTP ${res.status}) ${json.error || ""} ${json.error_description || ""}`.trim());
    await sleep(3000);
  }
}

const CAFE24_GROUPS = [
  { typeKo: "취소", dateType: "cancel_request_date", statuses: "C00,C10,C34,C35,C36,C40,C41,C42,C43,C47,C49" },
  { typeKo: "반품", dateType: "return_request_date", statuses: "R00,R10,R12,R13,R20,R30,R31,R34,R36,R40,R41,R42,R43" },
  { typeKo: "교환", dateType: "exchange_request_date", statuses: "E00,E10,E12,E13,E20,E30,E31,E32,E33,E34,E35,E36,E40" },
];

async function pollCafe24() {
  const { token, mallId } = await cafe24Token();
  const k = kstNow();
  const day = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const start = day(new Date(k.getTime() - 2 * 86400_000)); // 요청일 기준 최근 3일(겹침) — 서버 dedup
  const end = day(k);
  const claims = [];
  for (const g of CAFE24_GROUPS) {
    const qs = new URLSearchParams({
      embed: "items", order_status: g.statuses, date_type: g.dateType,
      start_date: start, end_date: end, limit: "500",
    });
    const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/admin/orders?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: timeout(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = j.error?.message || j.message || "";
      if (res.status === 403 || res.status === 422) {
        throw new Error(`카페24 주문조회 권한 없음 (HTTP ${res.status}) ${msg} — 앱에 mall.read_order 추가 후 재인증 필요`);
      }
      throw new Error(`카페24 주문조회(${g.typeKo}) 실패 (HTTP ${res.status}) ${msg}`.trim());
    }
    for (const o of j.orders ?? []) {
      for (const it of o.items ?? []) {
        if (!it.claim_code) continue;
        const st = String(it.order_status ?? "");
        // 이 그룹의 클레임 계열(C/R/E)이 아닌 품목(같은 주문의 정상 품목)은 제외
        if (!st.startsWith(g.statuses.slice(0, 1))) continue;
        claims.push({
          claim_type: g.typeKo,
          claim_key: `${o.order_id}:${it.order_item_code}:${it.claim_code}`,
          order_id: String(o.order_id ?? ""),
          product_name: it.product_name ?? null,
          option_name: it.option_value ? String(it.option_value) : null,
          qty: it.claim_quantity != null ? Number(it.claim_quantity) : (it.quantity != null ? Number(it.quantity) : null),
          reason: it.claim_reason ? String(it.claim_reason) : null,
          status: st,
          requested_at: null,
          // 신청(C00/R00/E00) = 판매자 접수/승인 대기. 그 외(입금전취소·진행 단계)는 통보
          action_required: st === "C00" || st === "R00" || st === "E00",
        });
      }
    }
    await sleep(600); // Leaky Bucket(40, 초당 2 회복) 여유
  }
  return report("카페24", claims);
}

async function main() {
  const jobs = [
    ["스마트스토어", pollNaver],
    ["쿠팡", pollCoupang],
    ["카페24", pollCafe24],
  ];
  let failed = 0;
  for (const [name, fn] of jobs) {
    try { await fn(); } catch (e) { failed++; console.error(`${name} 폴링 실패: ${e?.message || e}`); }
  }
  if (failed === jobs.length) process.exit(1); // 전 채널 실패만 크론 실패로
}

main().catch((e) => { console.error(`[중단] ${e?.message || e}`); process.exit(1); });
