import { isGaConfigured, runGaReport } from "./ga";
import { getKv, setKv } from "./b2b-settings";

// GA4 '우리 속성에 실제로 있는 것' 자동 조사(2026-10-22 대표: "비서의 GA 탐색·해석 능력") — DB 의 살아 있는 스키마처럼,
//  최근 30일에 실제로 발생한 이벤트·주요 전환 이벤트·주요 페이지·사용자 정의 측정기준을 하루 한 번 읽어 AI 비서 지침에 붙인다.
//  없는 이벤트(예: add_to_cart)를 짐작해 조회하거나, /buy 가 무슨 화면인지 모른 채 답하는 것을 막는다.
//  저장: b2b_settings 'ga_catalog'(JSON) — 서버리스 인스턴스마다 다시 읽지 않게. 실패하면 마지막 성공본을 쓴다.

export type GaCatalog = {
  loadedAt: string;
  events: { name: string; count: number; users: number }[];     // 최근 30일 이벤트(건수 상위 60)
  keyEvents: { name: string; count: number }[];                 // 주요 이벤트(전환)로 표시된 것
  pages: { path: string; sessions: number; views: number }[];   // 세션 상위 40 페이지
  customDims: { api: string; label: string }[];                 // customEvent:xxx · customUser:xxx
  customMetrics: { api: string; label: string }[];
};

const KV = "ga_catalog";
const TTL_MS = 24 * 3600_000;
let mem: GaCatalog | null = null;

async function fetchMetadata(): Promise<{ customDims: GaCatalog["customDims"]; customMetrics: GaCatalog["customMetrics"] }> {
  // ga.ts 의 토큰·속성 ID 를 재사용하려고 runGaReport 와 같은 자격을 쓴다 — 메타데이터 끝점만 다르다
  const { propertyId, token } = await gaAuth();
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}/metadata`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const j = (await res.json().catch(() => ({}))) as { dimensions?: { apiName?: string; uiName?: string; customDefinition?: boolean }[]; metrics?: { apiName?: string; uiName?: string; customDefinition?: boolean }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`GA 메타데이터 ${res.status}: ${j.error?.message || "조회 실패"}`);
  const pick = (a?: { apiName?: string; uiName?: string; customDefinition?: boolean }[]) => (a || []).filter((d) => d.customDefinition && d.apiName).map((d) => ({ api: String(d.apiName), label: String(d.uiName || d.apiName) }));
  return { customDims: pick(j.dimensions), customMetrics: pick(j.metrics) };
}

// ga.ts 는 토큰 함수를 내보내지 않는다 — 같은 규칙(JWT RS256)으로 한 번 더 발급한다(1시간 캐시는 ga.ts 쪽과 별개, 하루 한 번이라 무방)
import { createSign } from "node:crypto";
let tok: { token: string; exp: number } | null = null;
async function gaAuth(): Promise<{ propertyId: string; token: string }> {
  const propertyId = (process.env.GA4_PROPERTY_ID || "").trim().replace(/^properties\//, "");
  const email = (process.env.GA_SA_EMAIL || "").trim();
  const key = (process.env.GA_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if (!propertyId || !email || !key) throw new Error("GA 자격이 설정되지 않았습니다.");
  if (tok && Date.now() < tok.exp - 300_000) return { propertyId, token: tok.token };
  const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }))}`;
  const sig = createSign("RSA-SHA256").update(input).sign(key);
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64(sig)}` }) });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(`GA 토큰 발급 실패: ${j.error_description || res.status}`);
  tok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return { propertyId, token: tok.token };
}

const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

async function build(): Promise<GaCatalog> {
  const until = shift(kst(), -1), since = shift(until, -29);
  const [ev, key, pg, meta] = await Promise.all([
    runGaReport({ since, until, dimensions: ["event_name"], metrics: ["event_count", "users"], limit: 60 }),
    runGaReport({ since, until, dimensions: ["event_name"], metrics: ["key_events"], limit: 20 }),
    runGaReport({ since, until, dimensions: ["page_path"], metrics: ["sessions", "page_views"], limit: 40 }),
    fetchMetadata(),
  ]);
  return {
    loadedAt: new Date().toISOString(),
    events: ev.rows.map((r) => ({ name: String(r["이벤트"]), count: Number(r["이벤트 수"]) || 0, users: Number(r["사용자"]) || 0 })),
    keyEvents: key.rows.map((r) => ({ name: String(r["이벤트"]), count: Number(r["주요 이벤트"]) || 0 })).filter((k) => k.count > 0),
    pages: pg.rows.map((r) => ({ path: String(r["페이지 경로"]), sessions: Number(r["세션"]) || 0, views: Number(r["페이지 조회"]) || 0 })),
    customDims: meta.customDims, customMetrics: meta.customMetrics,
  };
}

export async function getGaCatalog(opts?: { force?: boolean }): Promise<GaCatalog | null> {
  if (!isGaConfigured()) return null;
  if (!opts?.force && mem && Date.now() - Date.parse(mem.loadedAt) < TTL_MS) return mem;
  if (!opts?.force) {
    try { const raw = await getKv(KV); if (raw) { const c = JSON.parse(raw) as GaCatalog; if (Date.now() - Date.parse(c.loadedAt) < TTL_MS) { mem = c; return c; } mem = c; } } catch { /* 저장본 없음 */ }
  }
  try {
    const c = await build();
    mem = c;
    try { await setKv(KV, JSON.stringify(c)); } catch { /* 저장 실패해도 메모리로 쓴다 */ }
    return c;
  } catch (e) {
    console.warn("[ga-catalog] 조사 실패 — 마지막 성공본 사용", e instanceof Error ? e.message : e);
    return mem; // 없으면 null → 지침에 안 붙는다
  }
}

const n = (v: number) => v.toLocaleString("ko-KR");

// 비서 시스템 프롬프트(턴마다 붙는 블록)용 — 모델이 '있는 것'만 조회하고, 없는 것은 없다고 답하게
export async function gaCatalogPromptBlock(): Promise<string> {
  const c = await getGaCatalog();
  if (!c) return "";
  const names = new Set(c.events.map((e) => e.name));
  const missing = ["add_to_cart", "view_item", "add_payment_info", "add_shipping_info"].filter((e) => !names.has(e) || (c.events.find((x) => x.name === e)?.count ?? 0) < 50);
  const lines = [
    `[GA4 — 우리 속성에 실제로 있는 것(최근 30일 자동 조사, ${c.loadedAt.slice(0, 10)} 기준). 여기 없는 이벤트·측정기준은 조회하지 않습니다]`,
    `이벤트(건수·사용자): ${c.events.map((e) => `${e.name} ${n(e.count)}·${n(e.users)}`).join(", ")}`,
    c.keyEvents.length ? `주요 이벤트(GA 전환으로 표시): ${c.keyEvents.map((k) => `${k.name} ${n(k.count)}`).join(", ")}` : "",
    `주요 페이지(세션·조회): ${c.pages.map((p) => `${p.path} ${n(p.sessions)}·${n(p.views)}`).join(", ")}`,
    c.customDims.length ? `사용자 정의 측정기준(ga_report 의 custom_dimension 에 API 이름 그대로): ${c.customDims.map((d) => `${d.api}(${d.label})`).join(", ")}` : "",
    c.customMetrics.length ? `사용자 정의 측정항목: ${c.customMetrics.map((d) => `${d.api}(${d.label})`).join(", ")}` : "",
    missing.length ? `표준 전자상거래 이벤트 중 없거나 거의 없는 것: ${missing.join(", ")} — "장바구니 담기" 질문은 add_to_cart 대신 view_cart(장바구니 보기)·begin_checkout(결제 시작)으로 답하고 그 차이를 밝힙니다.` : "",
    `사이트 전용 이벤트 뜻: sm_click = 사이트 안 버튼·영역 클릭(sm_area 영역·sm_label 이름·sm_type 종류 측정기준으로 나눔), sm_view = 영역 노출, button_click(button_id·button_location), manualScrollDepth_25%~95% = 스크롤 깊이, 주문완료 = 주문 완료 화면 도달(purchase 와 거의 같음), form_start/form_submit = 회원가입·문의 폼.`,
  ].filter(Boolean);
  return lines.join("\n");
}
