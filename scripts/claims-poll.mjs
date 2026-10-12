// 채널 클레임(취소·반품·교환) + 고객문의 폴러 — 중계 서버 크론(10분)이 실행.
//  네이버·쿠팡·카페24에서 새 클레임 요청과 새 고객문의를 모아 업무도우미 서버(/api/claims/report)로
//  보내면, 서버가 (channel, claim_key) 유니크로 중복을 거르고 새 건만 Teams 알림을 보낸다(migration 112).
//  조회 창은 상태 파일 없이 '넉넉한 고정 되돌아보기'(겹침 허용) — 중복은 서버가 걸러 알림은 1회.
//  + 문의 대장(2026-10-12, migration 137): 네이버 고객문의·상품문의 'KST 8일 전 0시~지금' 질문·답변을, 알림 POST 를
//    보낸 뒤 별도 POST(claims: [], inquiry_log)로 보낸다(주간 종합 리포트 '고객의 소리'용). 알림 요청의 본문·시점은
//    대장 추가 전과 같다. 알림 후보는 그대로 2일 창 — 대장과 섞지 않는다.
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

// 알림 전송 — 2026-10-12 이전과 같은 본문 { channel, claims }·같은 시점(문의 대장은 아래 reportInquiryLog 가 따로 보낸다)
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

// 문의 대장은 본문이 길 수 있어(질문·답변 각 4000자) 요청 1건이 ~1.5MB·500건을 넘지 않게 나눈다
//  (Vercel 요청 본문 상한 4.5MB).
function splitInquiryLog(log) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const e of log) {
    const b = Buffer.byteLength(JSON.stringify(e));
    if (cur.length && (bytes + b > 1_500_000 || cur.length >= 500)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(e);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

// 문의 대장(137) 전송 — 알림과 별도 POST(claims: [] — 알림 경로를 타지 않는다). 알림을 보낸 뒤에만 부른다.
//  한 덩어리가 실패해도 다음 덩어리는 보낸다(다음 폴링이 8일치를 다시 보내므로 빠진 건 그때 채워진다).
//  okKinds = 이번 실행에서 끝까지 받은 종류 — 서버가 종류별 '마지막 수집 성공' 시각으로 남긴다(리포트가 수집 멈춤과
//  문의 없음을 구별). 문의가 0건이어도 받은 종류가 있으면 빈 대장으로 한 번 보낸다.
async function reportInquiryLog(channel, log, okKinds) {
  if (!log.length && !okKinds.length) return;
  for (const chunk of (log.length ? splitInquiryLog(log) : [[]])) {
    try {
      const res = await fetch(`${SERVER}/api/claims/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${uploadSecret}` },
        signal: timeout(),
        body: JSON.stringify({ channel, claims: [], inquiry_log: chunk, inquiry_log_ok: okKinds }),
      });
      const j = await res.json().catch(() => ({}));
      const r = j.inquiry_log;
      if (!res.ok || !j.ok || r === undefined) {
        console.error(`${channel}: 문의 대장 전송 실패 (HTTP ${res.status}) ${j.error || (r === undefined ? "응답에 inquiry_log 없음(서버 구버전)" : "")}`.trim());
        continue;
      }
      const msg = typeof r === "string"
        ? (r === "skipped_137" ? "건너뜀(migration 137 미적용)" : r)
        : `저장 ${r.written}건 · 변경 없음 ${r.unchanged}건${r.dropped ? ` · 제외 ${r.dropped}건` : ""}`;
      console.log(`${channel}: 문의 대장 ${chunk.length}건 → ${msg}`);
    } catch (e) {
      console.error(`${channel}: 문의 대장 전송 실패: ${e?.message || e}`);
    }
  }
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
        naverQnaForbidden = true; // 문의 대장 수집도 상품 Q&A 는 건너뛴다(같은 안내 반복 방지)
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

  // 알림 먼저 — 본문·시점이 문의 대장 추가 전과 같다(대장 수집·저장이 알림을 늦추거나 끊지 않게).
  let alertErr = null;
  try { await report("스마트스토어", claims); } catch (e) { alertErr = e; }

  // 문의 대장(137) — 알림을 보낸 뒤 9일치를 따로 받아 별도 POST 로. 실패해도 알림에는 영향 없다.
  try {
    await sleep(NAVER_LOG_GAP_MS); // 알림용 조회 직후 몰리지 않게(레이트리밋)
    const { log, okKinds } = await collectNaverInquiryLog(token);
    await reportInquiryLog("스마트스토어", log, okKinds);
  } catch (e) {
    console.error(`네이버 문의 대장 수집 실패(알림과 무관): ${e?.message || e}`);
  }
  if (alertErr) throw alertErr; // 알림 전송 실패는 이전처럼 이 작업의 실패로 센다
}

// ── 문의 대장 (137, 2026-10-12 대표 요청: 주간 종합 리포트 '고객의 소리') ──────
//  답변 여부와 관계없이 'KST 8일 전 0시 ~ 지금' 문의의 질문·답변을 모은다(오늘 포함 KST 9일). 리포트(report-voice
//  POLL_BACK_DAYS=8)는 '첫 수집일 − 8일'부터 수집됐다고 보므로 그날 0시부터 받아야 그 판정이 맞다.
//  서버가 (channel, inquiry_key) 로 갱신하므로 나중에 달린 답변도 같은 행에 붙는다. 알림 후보(claims)에는 섞지 않는다 —
//  알림은 위 2일 창 그대로라 지난 문의가 늦게·중복으로 알림되지 않는다. 고객 이름·아이디·주문번호(customerId·
//  customerName·maskedWriterId·orderId)는 싣지 않는다.
const INQUIRY_LOG_BACK_DAYS = 8;   // 'KST 8일 전 0시'부터 — report-voice.ts POLL_BACK_DAYS 와 같은 값이어야 한다
const NAVER_LOG_GAP_MS = 800;      // 대장 조회 사이 간격(알림 조회 직후 몰림 방지 — 네이버 앱 단위 TPS 한도)
const LOG_TEXT_MAX = 4000; // 서버 상한과 같다 — 본문 크기 절약
let naverQnaForbidden = false; // 상품 Q&A 403(권한 없음) — 알림 조회에서 확인되면 대장 수집도 건너뜀

function httpError(msg, status) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

// 대장용 네이버 GET — 429·5xx 는 1.5초·3초·4.5초 쉬고 최대 3번 다시(coupangGet 과 같은 방식).
//  네트워크 오류·타임아웃은 다시 하지 않고 던진다(그 종류만 이번 실행에서 빠지고 다음 폴링이 채운다).
async function naverLogGet(token, url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: timeout() });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
    return res;
  }
}

// 고객문의 기간 조회(KST 일 단위, 양끝 포함) — 페이지 상한 5(1000건)
async function naverInquiryRange(token, startDay, endDay) {
  const items = [];
  for (let page = 1; page <= 5; page++) {
    const qs = new URLSearchParams({ startSearchDate: startDay, endSearchDate: endDay, page: String(page), size: "200" });
    const res = await naverLogGet(token, `${NAVER_BASE}/v1/pay-user/inquiries?${qs}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(`네이버 고객문의(대장 ${startDay}~${endDay}) 조회 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim(), res.status);
    items.push(...(j.content ?? []));
    if (j.last !== false) return items;
    await sleep(400);
  }
  console.error(`네이버 고객문의 대장 ${startDay}~${endDay}: 페이지 상한(1000건) 도달 — 나머지는 빠짐`);
  return items;
}

// 상품 Q&A 기간 조회(ISO) — 페이지 상한 5(500건). 403 은 권한 없음 → 빈 목록
async function naverQnaRange(token, fromMs, toMs) {
  const items = [];
  for (let page = 1; page <= 5; page++) {
    const qs = new URLSearchParams({
      fromDate: new Date(fromMs).toISOString(), toDate: new Date(toMs).toISOString(),
      page: String(page), size: "100",
    });
    const res = await naverLogGet(token, `${NAVER_BASE}/v1/contents/qnas?${qs}`);
    const j = await res.json().catch(() => ({}));
    if (res.status === 403) { naverQnaForbidden = true; return items; }
    if (!res.ok) throw httpError(`네이버 상품문의(대장) 조회 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim(), res.status);
    items.push(...(j.contents ?? []));
    if (j.last !== false) return items;
    await sleep(400);
  }
  console.error("네이버 상품문의 대장: 페이지 상한(500건) 도달 — 나머지는 빠짐");
  return items;
}

// 한 번에 받고, 거절(400)되면 두 조각으로 나눠 다시 — 조각은 받는 대로 add 에 넘겨, 뒤 조각이 실패해도 앞 조각은 남긴다.
//  끝까지 다 받았으면 true(한 조각이라도 빠지면 false — 그 종류의 '수집 성공' 시각을 남기지 않는다)
async function fetchRangeOrSplit(label, whole, parts, add) {
  try {
    add(await whole());
    return true;
  } catch (e) {
    if (e?.status !== 400) throw e;
  }
  let all = true;
  for (let i = 0; i < parts.length; i++) {
    await sleep(NAVER_LOG_GAP_MS);
    try { add(await parts[i]()); }
    catch (e) { all = false; console.error(`${label} 대장 ${i + 1}/${parts.length} 조각 수집 실패(받은 조각은 저장): ${e?.message || e}`); }
  }
  return all;
}

const clipText = (v) => (v == null || v === "" ? null : String(v).slice(0, LOG_TEXT_MAX));
const strOrNull = (v) => (v == null || v === "" ? null : String(v));

async function collectNaverInquiryLog(token) {
  const k = kstNow();
  const day = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const daysAgo = (n) => day(new Date(k.getTime() - n * 86400_000));
  const byKey = new Map(); // 기간을 나눠 받을 때 겹친 건 하나로
  const okKinds = [];      // 끝까지 받은 종류(서버가 종류별 마지막 수집 성공 시각으로 남긴다)

  // (a) 고객문의 — KST 8일 전 ~ 오늘(9일, 양끝 포함). 조회 기간 상한을 확인하지 못해, 한 번에 거절(400)되면 5일·4일로 나눠 받는다
  try {
    const B = INQUIRY_LOG_BACK_DAYS;
    const full = await fetchRangeOrSplit("네이버 고객문의",
      () => naverInquiryRange(token, daysAgo(B), daysAgo(0)),
      [() => naverInquiryRange(token, daysAgo(B), daysAgo(4)), () => naverInquiryRange(token, daysAgo(3), daysAgo(0))],
      (rows) => {
        for (const q of rows) {
          if (q?.inquiryNo == null) continue;
          byKey.set(`inq:${q.inquiryNo}`, {
            kind: "고객문의",
            inquiry_key: `inq:${q.inquiryNo}`,
            product_name: strOrNull(q.productName),
            category: strOrNull(q.category),
            title: strOrNull(q.title),
            question: clipText(q.inquiryContent),
            answer: clipText(q.answerContent),
            answered: q.answered === true,
            asked_at: strOrNull(q.inquiryRegistrationDateTime),
            answered_at: strOrNull(q.answerRegistrationDateTime), // 서버는 이미 있던 더 이른 값을 지킨다(답변 수정 대비)
          });
        }
      });
    if (full) okKinds.push("고객문의");
  } catch (e) {
    console.error(`네이버 고객문의 대장 수집 실패(알림·상품문의는 계속): ${e?.message || e}`);
  }

  // (b) 상품 Q&A — KST 8일 전 0시 ~ 지금(ISO). 400 이면 둘로 나눠 다시. 권한 없음(403)은 알림 쪽과 같이 건너뜀
  if (!naverQnaForbidden) {
    try {
      await sleep(NAVER_LOG_GAP_MS);
      const now = Date.now();
      const from = Date.parse(`${daysAgo(INQUIRY_LOG_BACK_DAYS)}T00:00:00+09:00`);
      const mid = Date.parse(`${daysAgo(3)}T00:00:00+09:00`);
      const full = await fetchRangeOrSplit("네이버 상품문의",
        () => naverQnaRange(token, from, now),
        [() => naverQnaRange(token, from, mid), () => naverQnaRange(token, mid, now)],
        (rows) => {
          for (const q of rows) {
            if (q?.questionId == null) continue;
            // 답변이 여러 개면 작성 순서대로 이어 붙인다. 답변 시각 = 첫 답변(리포트의 '답변까지 걸린 시간' — 보충 답변이 늦게
            //  달려도 응답 속도가 나빠 보이지 않게)
            const answers = (Array.isArray(q.answers) ? q.answers : [])
              .filter((a) => a && a.answer != null && String(a.answer).trim());
            const ms = (a) => Date.parse(String(a.createDate ?? ""));
            if (answers.every((a) => Number.isFinite(ms(a)))) answers.sort((x, y) => ms(x) - ms(y));
            const dated = answers.filter((a) => Number.isFinite(ms(a)));
            const first = dated.length ? dated.reduce((x, y) => (ms(y) < ms(x) ? y : x)) : answers[0];
            byKey.set(`qna:${q.questionId}`, {
              kind: "상품문의",
              inquiry_key: `qna:${q.questionId}`,
              product_name: strOrNull(q.productName),
              category: null,
              title: null,
              question: clipText(q.question),
              answer: answers.length ? clipText(answers.map((a) => String(a.answer).trim()).join("\n\n")) : clipText(q.answer),
              answered: q.answered === true,
              asked_at: strOrNull(q.createDate),
              answered_at: first ? strOrNull(first.createDate) : null,
            });
          }
        });
      if (full && !naverQnaForbidden) okKinds.push("상품문의"); // 403 이면 빈 목록이라 성공으로 치지 않는다
    } catch (e) {
      console.error(`네이버 상품문의 대장 수집 실패(알림·고객문의는 계속): ${e?.message || e}`);
    }
  }
  return { log: [...byKey.values()], okKinds };
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
