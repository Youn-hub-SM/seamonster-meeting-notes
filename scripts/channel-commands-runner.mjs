// 채널 재고 명령 실행기 — 중계 서버 크론(2분)이 실행. 큐가 비면 즉시 종료(부하 없음).
//  화면(SKU 리스팅 찾기)이 등록한 '수량 적용(0=품절)' 명령을 가져와 채널 쓰기 API 를 호출하고 결과를 보고한다.
//  네이버·쿠팡은 등록 IP(이 서버)에서만 쓰기가 허용된다. 자동 판정 없음 — 사람이 누른 명령만 실행.
//
//  실행: node bin/channel-commands-runner.cjs [서버URL]   (esbuild 번들로 배포 — bcryptjs 포함)
//  env(.env.local): NAVER_COMMERCE_CLIENT_ID/SECRET, COUPANG_ACCESS_KEY/SECRET_KEY/VENDOR_ID,
//                   CAFE24_MALL_ID/CLIENT_ID/CLIENT_SECRET (+ ../.cafe24-token.json)
//  보고 인증: Bearer NAVER_COMMERCE_CLIENT_SECRET (업로드 공용 시크릿)
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import bcrypt from "bcryptjs";

const execFileAsync = promisify(execFile);

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
const args = process.argv.slice(2);
const DAEMON = args.includes("--daemon"); // 상주 모드 — 10초 간격 폴링(체감 즉시 반영)
const SERVER = (args.find((a) => !a.startsWith("--")) || "https://meeting-notes-beryl.vercel.app").replace(/\/+$/, "");
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
if (!uploadSecret) {
  console.error("[중단] NAVER_COMMERCE_CLIENT_SECRET(보고 인증) 이 없습니다.");
  process.exit(1);
}
const timeout = () => AbortSignal.timeout(20_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce() {
  const STARTED = Date.now();
  // 동기화 명령(최대 3분)이 섞일 수 있어 예산을 넉넉히 — 겹쳐 떠도 claim 선점이 이중 실행을 막는다
  const TIME_BUDGET_MS = 200_000;
  // 1) 대기 명령을 원자적으로 선점(claim → '실행중') — 없으면 즉시 종료.
  //  선점 이후의 수량 변경은 새 명령으로만 생기므로, 이 스냅샷 값이 그대로 실행돼도 안전하다.
  const listRes = await fetch(`${SERVER}/api/channel-commands?mode=claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${uploadSecret}` },
    signal: timeout(),
  });
  const listJson = await listRes.json().catch(() => ({}));
  if (!listRes.ok || !listJson.ok) {
    // 원샷 모드는 main().catch 에서 exit 1, 데몬 모드는 루프가 이어받아 다음 회차에 재시도
    throw new Error(`명령 선점 실패 (HTTP ${listRes.status}) ${listJson.error || ""}`.trim());
  }
  const commands = listJson.commands ?? [];
  if (commands.length === 0) return; // 조용히 종료 — 크론 로그를 더럽히지 않는다
  console.log(`선점 명령 ${commands.length}건 (${new Date().toISOString()})`);

  // 채널별 토큰은 필요할 때 1회만
  let naverToken = null;
  let cafe24Token = null;

  async function getNaverToken() {
    if (naverToken) return naverToken;
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
    naverToken = json.access_token;
    return naverToken;
  }

  async function getCafe24Token() {
    if (cafe24Token) return cafe24Token;
    const mallId = (env.CAFE24_MALL_ID || "").trim();
    const clientId = (env.CAFE24_CLIENT_ID || "").trim();
    const clientSecret = (env.CAFE24_CLIENT_SECRET || "").trim();
    const tokenFile = path.join(ROOT, ".cafe24-token.json");
    if (!mallId || !clientId || !clientSecret || !fs.existsSync(tokenFile)) throw new Error("카페24 자격증명/토큰 없음");
    // 카탈로그 크론과의 refresh 회전 경합 대비 — 실패 시 파일 재독 1회 재시도
    for (let attempt = 0; ; attempt++) {
      const saved = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
      const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        },
        signal: timeout(),
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refresh_token }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.access_token) {
        fs.writeFileSync(tokenFile, JSON.stringify(json, null, 2));
        cafe24Token = { token: json.access_token, mallId };
        return cafe24Token;
      }
      if (attempt >= 1) throw new Error(`카페24 토큰 실패 (HTTP ${res.status}) ${json.error || ""} ${json.error_description || ""}`.trim());
      await sleep(3000);
    }
  }

  function coupangHeaders(method, fullPath) {
    const accessKey = (env.COUPANG_ACCESS_KEY || "").trim();
    const secretKey = (env.COUPANG_SECRET_KEY || "").trim();
    if (!accessKey || !secretKey) throw new Error("쿠팡 자격증명 없음");
    const [p, q = ""] = fullPath.split("?");
    const datetime = new Date().toISOString().slice(2, 19).replace(/[:-]/g, "") + "Z";
    const message = datetime + method + p + q;
    const signature = crypto.createHmac("sha256", secretKey).update(message).digest("hex");
    return {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`,
      "Content-Type": "application/json;charset=UTF-8",
    };
  }

  // 카탈로그 동기화 — 서버에 배치된 채널별 동기화 스크립트를 그대로 실행(화면 버튼용)
  const SYNC_SCRIPT = {
    "스마트스토어": "naver-sync.cjs",
    "쿠팡": "coupang-catalog-sync.mjs",
    "카페24": "cafe24-catalog-sync.mjs",
  };
  async function runCatalogSync(channel) {
    const script = SYNC_SCRIPT[channel];
    if (!script) return `동기화 스크립트 없음: ${channel}`;
    const file = path.join(ROOT, "bin", script);
    if (!fs.existsSync(file)) return `서버에 스크립트가 없습니다: bin/${script}`;
    try {
      const { stdout } = await execFileAsync("/usr/bin/node", [file, SERVER], { timeout: 180_000, cwd: ROOT });
      const tail = String(stdout || "").trim().split("\n").pop() || "";
      return /완료/.test(tail) ? null : `동기화가 정상 종료 메시지 없이 끝남: ${tail.slice(0, 200)}`;
    } catch (e) {
      const out = `${e.stdout || ""}\n${e.stderr || ""}`.trim().split("\n").filter(Boolean).pop() || e.message;
      return `동기화 실패: ${String(out).slice(0, 300)}`;
    }
  }

  // 채널별 실행 — 성공 시 null, 실패 시 에러 메시지 반환
  async function execute(cmd) {
    if (cmd.command === "sync_catalog") return runCatalogSync(cmd.channel);
    const seg = String(cmd.item_key).split(":"); // origin:kind:id
    const kind = seg[1] || "";
    const itemId = seg.slice(2).join(":");

    if (cmd.channel === "스마트스토어") {
      // 추가상품은 재고만 바꾸는 API 가 없다(원상품 '전체 수정'뿐 — 누락 필드가 삭제되는 위험한 방식이라 미지원)
      if (kind === "supplement") {
        return "네이버 추가상품은 API 재고 수정을 지원하지 않습니다 (스마트스토어센터 > 상품 수정에서 직접 변경)";
      }
      const token = await getNaverToken();
      if (kind === "product") {
        // 옵션 없는 단일 상품 — 멀티 상품 변경(부분 수정) API 로 재고(STOCK) 영역만 변경.
        //  실측 확정: HTTP 200 + {"data":true}, 다른 필드는 보존. 0 이면 네이버가 품절 처리.
        const res = await fetch(`${NAVER_BASE}/v1/products/origin-products/multi-update`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          signal: timeout(),
          body: JSON.stringify({ multiProductUpdateRequestVos: [{ originProductNo: Number(cmd.origin_no), multiUpdateTypes: ["STOCK"], stockQuantity: cmd.qty }] }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j.data === true) return null;
        const detail = j.message || (j.data != null ? JSON.stringify(j.data).slice(0, 200) : "");
        return `네이버 응답 HTTP ${res.status} ${j.code || ""} ${detail}`.trim();
      }
      if (kind !== "option") return `네이버에서 지원하지 않는 항목 유형입니다: ${kind || "(없음)"}`;
      // 스펙 문언상 body 에 없는 필드(price·usable)는 0/기본값으로 대입될 수 있어,
      //  현재 옵션가·사용여부를 조회해 그대로 되돌려 보낸다(재고만 변경). 조회 실패 시 기존 방식 폴백.
      const combo = { id: Number(itemId), stockQuantity: cmd.qty };
      try {
        const dRes = await fetch(`${NAVER_BASE}/v2/products/origin-products/${cmd.origin_no}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: timeout(),
        });
        if (dRes.ok) {
          const dj = await dRes.json().catch(() => ({}));
          const cur = (dj.originProduct?.detailAttribute?.optionInfo?.optionCombinations ?? [])
            .find((c) => String(c.id) === String(itemId));
          if (cur) {
            if (cur.price != null) combo.price = Number(cur.price);
            if (cur.usable != null) combo.usable = !!cur.usable;
          }
        }
      } catch { /* 조회 실패 — 재고만 담은 기존 body 로 진행 */ }
      // optionInfo 는 배열이 아니라 객체(내부에 optionCombinations 배열) — 실측 400 역직렬화 오류로 확정
      const res = await fetch(`${NAVER_BASE}/v1/products/origin-products/${cmd.origin_no}/option-stock`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        signal: timeout(),
        body: JSON.stringify({ optionInfo: { optionCombinations: [combo] } }),
      });
      if (res.ok) return null;
      const j = await res.json().catch(() => ({}));
      return `네이버 응답 HTTP ${res.status} ${j.code || ""} ${j.message || ""}`.trim();
    }

    if (cmd.channel === "쿠팡") {
      if (kind !== "vi") {
        return "쿠팡 옵션ID(vendorItemId)가 아직 저장되지 않았습니다 — 다음 카탈로그 동기화(새벽) 후 다시 시도하세요";
      }
      const fullPath = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${itemId}/quantities/${cmd.qty}`;
      const res = await fetch(COUPANG_HOST + fullPath, { method: "PUT", headers: coupangHeaders("PUT", fullPath), signal: timeout() });
      const j = await res.json().catch(() => ({}));
      if (res.ok && (j.code === "SUCCESS" || j.code === 200 || j.code == null)) return null;
      return `쿠팡 응답 HTTP ${res.status} ${j.code || ""} ${j.message || ""}`.trim();
    }

    if (cmd.channel === "카페24") {
      if (kind !== "variant") {
        return "카페24 품목코드가 없는 상품입니다 — 다음 카탈로그 동기화(새벽) 후 다시 시도하세요";
      }
      const { token, mallId } = await getCafe24Token();
      const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/admin/products/${cmd.origin_no}/variants/${itemId}/inventories`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        signal: timeout(),
        body: JSON.stringify({ shop_no: 1, request: { quantity: cmd.qty } }),
      });
      if (res.ok) return null;
      const j = await res.json().catch(() => ({}));
      const msg = j.error?.message || j.message || "";
      if (res.status === 403 || res.status === 422) {
        return `카페24 응답 HTTP ${res.status} ${msg} — 앱 권한에 '상품 수정(mall.write_product)'이 있는지 확인하세요`;
      }
      return `카페24 응답 HTTP ${res.status} ${msg}`.trim();
    }

    return `알 수 없는 채널: ${cmd.channel}`;
  }

  for (const cmd of commands) {
    if (Date.now() - STARTED > TIME_BUDGET_MS) {
      console.log(`시간 예산 초과 — 남은 명령은 10분 뒤 재선점됩니다`);
      break;
    }
    let error = null;
    try {
      error = await execute(cmd);
    } catch (e) {
      error = e?.message || String(e);
    }
    await fetch(`${SERVER}/api/channel-commands?mode=report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${uploadSecret}` },
      signal: timeout(),
      body: JSON.stringify({ id: cmd.id, ok: !error, qty: cmd.qty, error }),
    }).catch(() => {});
    console.log(`#${cmd.id} ${cmd.channel} ${cmd.item_key} → ${cmd.qty}개: ${error ? `실패 (${error})` : "완료"}`);
    await sleep(300);
  }
}

async function main() {
  if (!DAEMON) return runOnce();
  // 상주 모드 — 10초 폴링. 회차 단위로 실행(토큰 캐시도 회차 지역이라 만료 걱정 없음).
  //  오류가 나도 데몬은 계속 돈다(개별 명령 실패는 report 로 이미 기록됨).
  console.log(`데몬 시작 (10초 폴링, ${new Date().toISOString()})`);
  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      console.error(`[데몬] 회차 오류: ${e?.message || e}`);
    }
    await sleep(10_000);
  }
}

main().catch((e) => { console.error(`[중단] 오류: ${e?.message || e}`); process.exit(1); });
