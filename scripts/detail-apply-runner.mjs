// 상세페이지 전송 실행기(160) — 중계 서버(클라우드웨이즈)/로컬에서 실행. 큐가 비면 즉시 종료(부하 없음).
//  /detail 화면이 넣은 전송 요청(detail_applies 대기)을 가져와 카페24 상품 수정 API 로 상세설명을 바꾸고 결과를 보고한다.
//  카페24 Admin API 는 IP 제한이 없지만 refresh_token 이 쓸 때마다 회전하므로 토큰 보유처를 중계 서버 하나로 통일한다(기존 방침).
//
//  실행: node scripts/detail-apply-runner.mjs [서버URL]        (채널 재고 실행기와 같은 크론에 한 줄 추가하거나 수동 1회)
//  env(.env.local): CAFE24_MALL_ID / CAFE24_CLIENT_ID / CAFE24_CLIENT_SECRET (+ 상위 폴더 .cafe24-token.json)
//                   CAFE24_SHOP_URL(선택, 기본 https://seamonster.kr — 반영 뒤 마커 확인용 공개 주소)
//  보고 인증: Bearer NAVER_COMMERCE_CLIENT_SECRET (업로드 공용 시크릿)
//
//  조립 규칙은 app/lib/detail-page.ts 와 같다(TS 를 못 읽어 JS 로 복제) — 한쪽을 고치면 다른 쪽도.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = (process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "https://meeting-notes-beryl.vercel.app").replace(/\/+$/, "");
const TOKEN_FILE = path.join(ROOT, ".cafe24-token.json");

const env = {};
const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
const uploadSecret = (env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
if (!uploadSecret) { console.error("[중단] NAVER_COMMERCE_CLIENT_SECRET(보고 인증) 이 없습니다."); process.exit(1); }
const SHOP_URL = (env.CAFE24_SHOP_URL || "https://seamonster.kr").replace(/\/+$/, "");
const timeout = () => AbortSignal.timeout(30_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 조립 규칙(app/lib/detail-page.ts 와 동일) ----
const markerOpen = (id) => `<!-- sm:src=${id} -->`;
const markerClose = (id) => `<!-- /sm:src=${id} -->`;
const wrapBlock = (id, html) => `${markerOpen(id)}\n${String(html).trim()}\n${markerClose(id)}`;
const blockRegex = (id) => new RegExp(`<!--\\s*sm:src=${id}\\s*-->[\\s\\S]*?<!--\\s*/sm:src=${id}\\s*-->\\s*`, "g");
// 보존 블록 — 스킨이 아코디언으로 읽는 숨김 텍스트 블록(.smd-info / .wf-acc). 전체 교체 때 떼어 새 내용 맨 앞에 되돌린다.
//  새 내용에 이미 그 블록이 있으면(소스가 아코디언을 바꾸려는 뜻) 보존하지 않는다. 기준은 class 이름뿐.
const PRESERVE_OPEN = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:smd-info|wf-acc)\b[^"']*["'][^>]*>/i;
function extractPreserved(html) {
  const src = html ?? "";
  const m = PRESERVE_OPEN.exec(src);
  if (!m) return null;
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = m.index;
  let depth = 0, t;
  while ((t = re.exec(src))) {
    if (t[0].startsWith("</")) { depth--; if (depth === 0) { const end = t.index + t[0].length; return { block: src.slice(m.index, end), rest: (src.slice(0, m.index) + src.slice(end)).trim() }; } }
    else if (!/\/\s*>$/.test(t[0])) depth++;
  }
  return null;
}
function withPreserved(current, replacement, newHtml) {
  if (PRESERVE_OPEN.test(newHtml ?? "")) return replacement;
  const p = extractPreserved(current);
  if (p) console.log("    아코디언 블록(.smd-info) 보존");
  return p ? `${p.block}\n${replacement}` : replacement;
}
function mergeDescription(current, id, html, position) {
  const block = wrapBlock(id, html);
  const cur = current ?? "";
  if (position === "replace") return withPreserved(cur, block, html);
  if (blockRegex(id).test(cur)) {
    let first = true;
    return cur.replace(blockRegex(id), () => { if (first) { first = false; return block + "\n"; } return ""; }).trimEnd();
  }
  if (position === "prepend") return `${block}\n${cur}`.trimEnd();
  return `${cur.trimEnd()}\n${block}`.trimStart();
}
// 조합(161): 구성 블록을 전부 걷어낸 뒤 조합 순서대로 묶어서 position 에 넣는다 (= 순서 재정렬)
function removeBlocks(current, ids) {
  let out = current ?? "";
  for (const id of ids) out = out.replace(blockRegex(id), "");
  return out.trim();
}
function mergeSet(current, members, position) {
  const blocks = members.map((m) => wrapBlock(m.source_id, m.html)).join("\n");
  if (position === "replace") return withPreserved(current ?? "", blocks, members.map((m) => m.html).join("\n"));
  const rest = removeBlocks(current, members.map((m) => m.source_id));
  if (!rest) return blocks;
  return position === "prepend" ? `${blocks}\n${rest}` : `${rest}\n${blocks}`;
}

// ---- 카페24 토큰(실행당 1회, 파일 회전 저장) ----
let cafe24 = null;
async function getCafe24() {
  if (cafe24) return cafe24;
  const mallId = (env.CAFE24_MALL_ID || "").trim();
  const clientId = (env.CAFE24_CLIENT_ID || "").trim();
  const clientSecret = (env.CAFE24_CLIENT_SECRET || "").trim();
  if (!mallId || !clientId || !clientSecret || !fs.existsSync(TOKEN_FILE)) throw new Error("카페24 자격증명/토큰 없음");
  for (let attempt = 0; ; attempt++) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64") },
      signal: timeout(),
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refresh_token }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.access_token) {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(json, null, 2));
      cafe24 = { token: json.access_token, mallId };
      return cafe24;
    }
    if (attempt >= 1) throw new Error(`카페24 토큰 실패 (HTTP ${res.status}) ${json.error || ""} ${json.error_description || ""}`.trim());
    await sleep(3000);
  }
}

async function cafe24Api(method, p, body) {
  const { token, mallId } = await getCafe24();
  const res = await fetch(`https://${mallId}.cafe24api.com/api/v2/admin${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: timeout(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`카페24 ${method} ${p} (HTTP ${res.status}) ${json.error?.message || json.error?.code || ""}`.trim());
  return json;
}

async function report(id, payload) {
  const res = await fetch(`${SERVER}/api/detail/applies?mode=report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${uploadSecret}`, "Content-Type": "application/json" },
    signal: timeout(),
    body: JSON.stringify({ id, ...payload }),
  });
  if (!res.ok) console.error(`  보고 실패 #${id} (HTTP ${res.status})`);
}

// 반영 뒤 공개 상품 페이지 원본 HTML(JS 없이)에 마커가 전부 있는지 — 크롤러가 보는 것과 같은 조건
async function verifyPublic(productNo, sourceIds) {
  try {
    const res = await fetch(`${SHOP_URL}/product/detail.html?product_no=${productNo}`, {
      headers: { "User-Agent": "Mozilla/5.0 (seamonster-detail-verify)", "Cache-Control": "no-cache" },
      signal: timeout(),
    });
    if (!res.ok) return false;
    const html = await res.text();
    return sourceIds.every((id) => html.includes(markerOpen(id)) && html.includes(markerClose(id)));
  } catch { return false; }
}

async function main() {
  const claimRes = await fetch(`${SERVER}/api/detail/applies?mode=claim`, { method: "POST", headers: { Authorization: `Bearer ${uploadSecret}` }, signal: timeout() });
  const claimJson = await claimRes.json().catch(() => ({}));
  if (!claimRes.ok || !claimJson.ok) throw new Error(`선점 실패 (HTTP ${claimRes.status}) ${claimJson.error || ""}`.trim());
  const applies = claimJson.applies ?? [];
  if (applies.length === 0) return; // 조용히 종료
  console.log(`전송 ${applies.length}건 (${new Date().toISOString()})`);

  for (const a of applies) {
    const isSet = a.command === "set" && Array.isArray(a.members) && a.members.length > 0;
    const ids = isSet ? a.members.map((m) => Number(m.source_id)) : [a.source_id];
    const tag = `#${a.id} 상품 ${a.product_no} ${isSet ? `조합 ${a.set_id} [${ids.join(",")}]` : `소스 ${a.source_id}`}`;
    try {
      if (!isSet && (!a.source_id || typeof a.html !== "string")) throw new Error("소스 내용이 없는 명령입니다");
      const got = await cafe24Api("GET", `/products/${a.product_no}?shop_no=1&fields=product_no,product_name,description,mobile_description`);
      const prod = got.product;
      if (!prod) throw new Error("상품을 찾을 수 없습니다");
      const curDesc = String(prod.description ?? "");
      const curMobile = String(prod.mobile_description ?? "");
      const apply = (cur) => (isSet ? mergeSet(cur, a.members, a.position) : mergeDescription(cur, a.source_id, a.html, a.position));
      const request = { description: apply(curDesc) };
      // 모바일 상세설명을 따로 쓰는 상품이면 거기에도 같은 규칙으로(PC 만 바뀌고 모바일은 그대로인 사고 방지)
      if (curMobile.trim()) request.mobile_description = apply(curMobile);
      await cafe24Api("PUT", `/products/${a.product_no}`, { shop_no: 1, request });
      await sleep(1500); // 캐시·반영 대기
      const verified = await verifyPublic(a.product_no, ids);
      await report(a.id, { ok: true, verified, backup_html: curDesc });
      console.log(`  ${tag} 완료${verified ? "" : " (공개 페이지 마커 미확인)"}`);
    } catch (e) {
      const msg = e?.message || String(e);
      await report(a.id, { ok: false, error: msg });
      console.error(`  ${tag} 실패: ${msg}`);
    }
    await sleep(150); // 초당 40회 제한보다 훨씬 느리게
  }
}

main().catch((e) => { console.error(`[중단] ${e?.message || e}`); process.exit(1); });
