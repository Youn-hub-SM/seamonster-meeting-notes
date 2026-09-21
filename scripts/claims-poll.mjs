// 채널 클레임(취소·반품·교환) + 고객문의 폴러 — 중계 서버 크론(10분)이 실행.
//  네이버·쿠팡·카페24에서 새 클레임 요청과 새 고객문의를 모아 업무도우미 서버(/api/claims/report)로
//  보내면, 서버가 (channel, claim_key) 유니크로 중복을 거르고 새 건만 Teams 알림을 보낸다(migration 112).
//  조회 창은 상태 파일 없이 '넉넉한 고정 되돌아보기'(겹침 허용) — 중복은 서버가 걸러 알림은 1회.
//
//  실행: node bin/claims-poll.cjs [서버URL]   (esbuild CJS 번들로 배포 — bcryptjs 포함)
//  env(.env.local): NAVER_COMMERCE_CLIENT_ID/SECRET, COUPANG_ACCESS_KEY/SECRET_KEY/VENDOR_ID,
//                   CAFE24_MALL_ID/CLIENT_ID/CLIENT_SECRET (+ ../.cafe24-token.json)
//  전송 인증: Bearer NAVER_COMMERCE_CLIENT_SECRET (카탈로그 업로드 공용 시크릿)
//
//  API 근거(클레임 2026-09-12, 문의 2026-09-17 공식 문서 검증 완료):
//  - 네이버 클레임: GET /v1/pay-order/seller/product-orders/last-changed-statuses (필터 없이 수신 후
//    claimType/claimStatus 로 분류 — 공식 답변 #701) + POST /product-orders/query (상세)
//  - 네이버 고객문의: GET /v1/pay-user/inquiries — 주문 문의·네이버페이(고객센터 경유 포함) 통합.
//    '고객센터 문의' 전용 API 는 없다(문의 도메인 6개 엔드포인트 전수 확인). 기간이 일 단위뿐이라
//    2일 창 + inquiryNo dedup. 네이버톡톡은 커머스API 밖 — 대상 아님(대표 지시).
//  - 네이버 상품 Q&A: GET /v1/contents/qnas — [문의] API 그룹 권한 필요(미추가 시 403 → 건너뜀)
//  - 쿠팡 클레임: GET v6 returnRequests (반품=status RU·UC 각각) + GET v4 exchangeRequests (RECEIPT)
//  - 쿠팡 고객문의: GET v5 onlineInquiries (answeredType=NOANSWER, 일 단위 → 2일 창 + inquiryId dedup)
//  - 쿠팡 고객센터문의: GET v5 callCenterInquiries (partnerCounselingStatus NO_ANSWER=답변 필요,
//    TRANSFER=쿠팡 상담 완료 후 이관 — 판매자 확인 필요. 둘 다 조치 필요 건이라 수집)
//  - 카페24: GET /admin/orders?embed=items&date_type={claim}_request_date + order_status 클레임 코드
//    (scope mall.read_order 필요 — 재인증 후 동작. 카페24 게시판형 문의는 대상 아님 — 대표 지정 채널만)
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
let naverTokenCached = null; // 한 실행(크론 1회) 안에서 클레임·문의 폴링이 토큰을 공유
async function naverToken() {
  if (naverTokenCached) return naverTokenCached;
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
  naverTokenCached = json.access_token;
  return naverTokenCached;
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
// 카페24가 돌려주는 expires_at 에는 시간대 표시가 없다 — 값은 KST 인데 Node 는 이를 서버 로컬(UTC)로
//  읽어 9시간 뒤로 본다. 그러면 '아직 유효'로 착각해 갱신을 건너뛰고 죽은 토큰으로 401 을 계속 맞는다
//  (2026-09-21 실측: 하루 2시간만 동작, 9시간씩 정지). 시간대 표시가 없으면 KST 로 못박아 읽는다.
function cafe24ExpiresMs(v) {
  const s = String(v || "").trim();
  if (!s) return 0;
  const t = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}+09:00`);
  return Number.isFinite(t) ? t : 0;
}

async function cafe24Token(force = false) {
  const mallId = (env.CAFE24_MALL_ID || "").trim();
  const clientId = (env.CAFE24_CLIENT_ID || "").trim();
  const clientSecret = (env.CAFE24_CLIENT_SECRET || "").trim();
  const tokenFile = path.join(ROOT, ".cafe24-token.json");
  if (!mallId || !clientId || !clientSecret || !fs.existsSync(tokenFile)) throw new Error("카페24 자격증명/토큰 없음");
  const saved = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  // access_token 이 아직 유효하면 refresh 하지 않는다 — 토큰 파일 회전 경합(감사 확정)을 늘리지 않기 위해
  if (!force && saved.access_token && cafe24ExpiresMs(saved.expires_at) - Date.now() > 5 * 60_000) {
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

// 판매자 승인/처리 대기 = '신청' 상태(C00 취소신청·R00 반품신청·E00 교환신청)만 조회한다.
//  이 상태는 아직 claim_code 가 없다(접수·완료 후 부여) — claim_code 유무로 거르면 정작 알릴 건이 빠진다.
const CAFE24_GROUPS = [
  { typeKo: "취소", dateType: "cancel_request_date", reqStatus: "C00" },
  { typeKo: "반품", dateType: "return_request_date", reqStatus: "R00" },
  { typeKo: "교환", dateType: "exchange_request_date", reqStatus: "E00" },
];

async function pollCafe24() {
  let { token, mallId } = await cafe24Token();
  let retried = false; // 401 = 만료시각을 잘못 믿은 경우 — 강제 갱신 후 한 번만 다시
  const k = kstNow();
  const day = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const start = day(new Date(k.getTime() - 2 * 86400_000)); // 요청일 기준 최근 3일(겹침) — 서버 dedup
  const end = day(k);
  const claims = [];
  for (let gi = 0; gi < CAFE24_GROUPS.length; gi++) {
    const g = CAFE24_GROUPS[gi];
    const qs = new URLSearchParams({
      embed: "items", order_status: g.reqStatus, date_type: g.dateType,
      start_date: start, end_date: end, limit: "500",
    });
    const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/admin/orders?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: timeout(),
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && !retried) {
      retried = true;                       // 강제 갱신은 폴링 1회당 한 번만(토큰 파일 회전 경합 방지)
      ({ token } = await cafe24Token(true));
      gi--;                                 // 이 그룹을 건너뛰지 않고 같은 그룹부터 다시
      continue;
    }
    if (!res.ok) {
      const msg = j.error?.message || j.message || "";
      if (res.status === 403 || res.status === 422) {
        throw new Error(`카페24 주문조회 권한 없음 (HTTP ${res.status}) ${msg} — 앱에 mall.read_order 추가 후 재인증 필요`);
      }
      throw new Error(`카페24 주문조회(${g.typeKo}) 실패 (HTTP ${res.status}) ${msg}`.trim());
    }
    for (const o of j.orders ?? []) {
      const its = o.items ?? [];
      for (let idx = 0; idx < its.length; idx++) {
        const it = its[idx];
        const st = String(it.order_status ?? "");
        if (st !== g.reqStatus) continue; // 같은 주문의 정상·타상태 품목 제외 — 이 신청 상태 품목만
        const itemCode = it.order_item_code || it.product_no || String(idx);
        claims.push({
          claim_type: g.typeKo,
          claim_key: `${o.order_id}:${itemCode}:${st}`, // C00 은 claim_code 가 없어 상태로 식별
          order_id: String(o.order_id ?? ""),
          product_name: it.product_name ?? null,
          option_name: it.option_value ? String(it.option_value) : null,
          qty: it.claim_quantity != null ? Number(it.claim_quantity) : (it.quantity != null ? Number(it.quantity) : null),
          reason: it.claim_reason ? String(it.claim_reason) : null,
          status: st,
          requested_at: null,
          action_required: true, // 신청 상태만 조회하므로 전부 처리 필요
        });
      }
    }
    await sleep(600); // Leaky Bucket(40, 초당 2 회복) 여유
  }
  return report("카페24", claims);
}

// ── 문의 (2026-09-17 대표 요청: '고객문의' 등록 시에도 알림 — 네이버·쿠팡만, 톡톡 제외) ──────
//  클레임과 같은 파이프라인(서버 dedup + 전용 Teams 채널)을 탄다. claim_type 으로만 구분.
//  기간 파라미터가 일 단위뿐인 API 는 2일 창(자정 경계 누락 방지)으로 조회하고 서버가 중복을 거른다.
//  이미 답변된 문의는 처리할 게 없으므로 알림 제외(클레임의 '통보 제외' 원칙과 동일).

async function pollNaverInquiries() {
  const token = await naverToken();
  const k = kstNow();
  const day = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const claims = [];

  // (a) 고객문의 — 주문 문의·네이버페이(고객센터 경유 포함) 통합. 일 단위 기간 → 2일 창 + dedup
  for (let page = 1; page <= 5; page++) {
    const qs = new URLSearchParams({
      startSearchDate: day(new Date(k.getTime() - 86400_000)), endSearchDate: day(k),
      page: String(page), size: "200",
    });
    const res = await fetch(`${NAVER_BASE}/v1/pay-user/inquiries?${qs}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: timeout(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`네이버 고객문의 조회 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim());
    for (const q of j.content ?? []) {
      if (q.inquiryNo == null) continue;
      let text = [q.title, q.inquiryContent].filter(Boolean).join(" — ");
      if (q.category) text = `(${q.category})${text ? " " + text : ""}`;
      claims.push({
        claim_type: "고객문의",
        claim_key: `inq:${q.inquiryNo}`,
        order_id: q.orderId ? String(q.orderId) : "",
        product_name: q.productName ?? null,
        option_name: null,
        qty: null,
        reason: text || null,
        status: q.answered === true ? "답변완료" : "미답변",
        requested_at: q.inquiryRegistrationDateTime ? String(q.inquiryRegistrationDateTime) : null,
        action_required: q.answered !== true, // 이미 답변된 건은 조치 불필요
      });
    }
    if (j.last !== false) break; // last 가 명시적으로 false 일 때만 다음 페이지
    await sleep(400);
  }

  // (b) 상품 Q&A — [문의] API 그룹 권한 필요. 미추가면 403 → 안내만 남기고 고객문의는 계속 전송
  try {
    for (let page = 1; page <= 5; page++) {
      const qs = new URLSearchParams({
        fromDate: new Date(Date.now() - 2 * 86400_000).toISOString(),
        toDate: new Date().toISOString(),
        page: String(page), size: "100",
      });
      const res = await fetch(`${NAVER_BASE}/v1/contents/qnas?${qs}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: timeout(),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403) {
        console.error("네이버 상품 Q&A 건너뜀: [문의] API 그룹 권한 없음 — 커머스API센터 > 애플리케이션 수정에서 [문의] 그룹 추가 필요");
        break;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${j.code || ""} ${j.message || ""}`.trim());
      for (const q of j.contents ?? []) {
        if (q.questionId == null) continue; // 스키마상 전 필드 비필수 — null 방어
        claims.push({
          claim_type: "상품문의",
          claim_key: `qna:${q.questionId}`,
          order_id: "",
          product_name: q.productName ?? null,
          option_name: null,
          qty: null,
          reason: q.question ? String(q.question) : null,
          status: q.answered === true ? "답변완료" : "미답변",
          requested_at: q.createDate ? String(q.createDate) : null,
          action_required: q.answered !== true,
        });
      }
      if (j.last !== false) break;
      await sleep(400);
    }
  } catch (e) {
    console.error(`네이버 상품문의 조회 실패(고객문의는 계속): ${e?.message || e}`);
  }
  return report("스마트스토어", claims);
}

async function pollCoupangInquiries() {
  const vendorId = (env.COUPANG_VENDOR_ID || "").trim();
  if (!vendorId) throw new Error("쿠팡 vendorId 없음");
  const k = kstNow();
  const day = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const from = day(new Date(k.getTime() - 86400_000)); // 일 단위만 지원(최대 7일) → 2일 창 + dedup
  const to = day(k);
  const claims = [];

  // (a) 고객문의(상품·주문 온라인 문의) — NOANSWER = 판매자 답변 필요 건만
  {
    const base = `/v2/providers/openapi/apis/api/v5/vendors/${vendorId}/onlineInquiries`;
    for (let page = 1; page <= 10; page++) {
      const res = await coupangGet(`${base}?vendorId=${vendorId}&answeredType=NOANSWER&inquiryStartAt=${from}&inquiryEndAt=${to}&pageNum=${page}&pageSize=50`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`쿠팡 고객문의 조회 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim());
      const rows = j.data?.content ?? [];
      for (const r of rows) {
        if (r.inquiryId == null) continue;
        const orders = Array.isArray(r.orderIds) ? r.orderIds.filter((v) => v != null) : [];
        claims.push({
          claim_type: "고객문의",
          claim_key: `oinq:${r.inquiryId}`,
          order_id: orders.length ? String(orders[0]) : "",
          product_name: null, // 응답에 상품명 필드 없음(productId 류만) — 내용으로 식별
          option_name: null,
          qty: null,
          reason: r.content ? String(r.content) : null,
          status: "미답변",
          requested_at: r.inquiryAt ? String(r.inquiryAt) : null,
          action_required: true,
        });
      }
      const totalPages = Number(j.data?.pagination?.totalPages ?? 1);
      if (!rows.length || page >= totalPages) break;
      await sleep(400);
    }
  }

  // (b) 고객센터문의 — NO_ANSWER(답변 필요)·TRANSFER(쿠팡 상담 후 이관, 확인 필요) 각 1회.
  //  같은 문의가 상태를 옮겨도 claim_key 가 같아 알림은 1회. buyerPhone 등 개인정보는 싣지 않는다.
  {
    const base = `/v2/providers/openapi/apis/api/v5/vendors/${vendorId}/callCenterInquiries`;
    for (const [st, label] of [["NO_ANSWER", "답변요청"], ["TRANSFER", "확인요청(이관)"]]) {
      for (let page = 1; page <= 10; page++) {
        const res = await coupangGet(`${base}?vendorId=${vendorId}&partnerCounselingStatus=${st}&inquiryStartAt=${from}&inquiryEndAt=${to}&pageNum=${page}&pageSize=30`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`쿠팡 고객센터문의(${st}) 조회 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim());
        const rows = j.data?.content ?? [];
        for (const r of rows) {
          if (r.inquiryId == null) continue;
          let text = r.content ? String(r.content) : "";
          if (r.receiptCategory) text = `(${r.receiptCategory})${text ? " " + text : ""}`;
          claims.push({
            claim_type: "고객센터문의",
            claim_key: `cs:${r.inquiryId}`,
            order_id: r.orderId ? String(r.orderId) : "",
            product_name: r.itemName ?? null,
            option_name: null,
            qty: null,
            reason: text || null,
            status: label,
            requested_at: r.inquiryAt ? String(r.inquiryAt) : null,
            action_required: true,
          });
        }
        const totalPages = Number(j.data?.pagination?.totalPages ?? 1);
        if (!rows.length || page >= totalPages) break;
        await sleep(400);
      }
      await sleep(400);
    }
  }
  return report("쿠팡", claims);
}

async function main() {
  const jobs = [
    ["스마트스토어", pollNaver],
    ["쿠팡", pollCoupang],
    ["카페24", pollCafe24],
    ["스마트스토어 문의", pollNaverInquiries],
    ["쿠팡 문의", pollCoupangInquiries],
  ];
  let failed = 0;
  for (const [name, fn] of jobs) {
    try { await fn(); } catch (e) { failed++; console.error(`${name} 폴링 실패: ${e?.message || e}`); }
  }
  if (failed === jobs.length) process.exit(1); // 전 채널 실패만 크론 실패로
}

main().catch((e) => { console.error(`[중단] ${e?.message || e}`); process.exit(1); });
