import bcrypt from "bcryptjs";

// 네이버 커머스API 클라이언트 — 등록 상품 카탈로그 동기화용 (조회 전용).
//  인증: client_id + timestamp 를 client_secret(bcrypt salt 형식)으로 해시 → base64 서명.
//  ⚠️ 커머스API 는 애플리케이션에 등록된 IP 에서만 호출이 허용될 수 있다 — Vercel 은 고정 IP 가
//  없으므로, 서버 호출이 IP 로 거부되면 로컬 실행 경로로 전환한다(테스트 라우트가 판별).
//  Node 런타임 전용(bcryptjs). 사용 라우트는 runtime="nodejs".

const BASE = "https://api.commerce.naver.com/external";

export function naverCredsStatus(): { ok: boolean; detail: string } {
  const id = (process.env.NAVER_COMMERCE_CLIENT_ID || "").trim();
  const secret = (process.env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
  if (!id && !secret) return { ok: false, detail: "NAVER_COMMERCE_CLIENT_ID / SECRET 이 모두 비어 있습니다 (Vercel 환경변수 확인)" };
  if (!id) return { ok: false, detail: "NAVER_COMMERCE_CLIENT_ID 가 비어 있습니다" };
  if (!secret) return { ok: false, detail: "NAVER_COMMERCE_CLIENT_SECRET 이 비어 있습니다" };
  return { ok: true, detail: `자격증명 있음 (ID ${id.length}자, SECRET ${secret.length}자)` };
}

// 토큰 캐시 — 커머스API 토큰은 수 시간 유효. 같은 함수 인스턴스 안에서만 재사용.
let cached: { token: string; expiresAt: number } | null = null;

export async function getNaverToken(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const id = (process.env.NAVER_COMMERCE_CLIENT_ID || "").trim();
  const secret = (process.env.NAVER_COMMERCE_CLIENT_SECRET || "").trim();
  const creds = naverCredsStatus();
  if (!creds.ok) return { ok: false, error: creds.detail };
  if (cached && cached.expiresAt > Date.now() + 60_000) return { ok: true, token: cached.token };

  const timestamp = Date.now();
  let sign: string;
  try {
    sign = Buffer.from(bcrypt.hashSync(`${id}_${timestamp}`, secret), "utf8").toString("base64");
  } catch {
    return { ok: false, error: "서명 생성 실패 — CLIENT_SECRET 형식이 올바르지 않습니다 (커머스API센터의 시크릿 그대로인지 확인)" };
  }
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({
      client_id: id,
      timestamp: String(timestamp),
      grant_type: "client_credentials",
      client_secret_sign: sign,
      type: "SELF",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; code?: string; message?: string; invalidInputs?: unknown };
  if (!res.ok || !json.access_token) {
    return { ok: false, error: `토큰 발급 실패 (HTTP ${res.status}) ${json.code || ""} ${json.message || ""}`.trim() };
  }
  cached = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 10800) * 1000 };
  return { ok: true, token: json.access_token };
}

export type NaverChannelProduct = {
  originProductNo: number;
  channelProductNo?: number;
  name: string;
  statusType?: string;
  sellerManagementCode?: string;
  stockQuantity?: number;
};

// 등록 상품 전체(원상품 단위) — 페이징으로 끝까지.
//  truncated: 페이지 캡(50)에 걸려 전체를 못 다 본 경우 — 호출자는 이때 stale 삭제를 건너뛰어야 한다.
export async function fetchAllProducts(token: string): Promise<{ products: NaverChannelProduct[]; truncated: boolean }> {
  const out: NaverChannelProduct[] = [];
  let truncated = false;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${BASE}/v1/products/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ page, size: 100 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new Error(`상품 목록 조회 실패 (HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim());
    }
    const json = (await res.json()) as {
      contents?: { originProductNo: number; channelProducts?: Record<string, unknown>[] }[];
      totalPages?: number;
    };
    for (const c of json.contents ?? []) {
      const cp = (c.channelProducts ?? [])[0] as Record<string, unknown> | undefined;
      out.push({
        originProductNo: c.originProductNo,
        channelProductNo: cp ? Number(cp.channelProductNo) : undefined,
        name: String(cp?.name ?? ""),
        statusType: cp ? String(cp.statusType ?? "") : undefined,
        sellerManagementCode: cp ? String(cp.sellerManagementCode ?? "") : undefined,
        stockQuantity: cp && cp.stockQuantity != null ? Number(cp.stockQuantity) : undefined,
      });
    }
    if (!json.totalPages || page >= json.totalPages) break;
    if (page === 50 && json.totalPages > 50) truncated = true;
  }
  return { products: out, truncated };
}

export type NaverCatalogItem = {
  item_key: string;
  origin_no: string;
  listing_name: string;
  item_kind: "product" | "option" | "supplement";
  item_name: string | null;
  sku_code: string;
  sale_status: string | null;
  stock_qty: number | null;
};

// 원상품 상세 → 옵션·추가상품을 카탈로그 행으로 펼침.
//  관리코드 필드명이 문서 버전에 따라 다르다(sellerManagerCode/sellerManagementCode) — 둘 다 읽는다.
export async function fetchOriginItems(token: string, p: NaverChannelProduct): Promise<NaverCatalogItem[]> {
  const res = await fetch(`${BASE}/v2/products/origin-products/${p.originProductNo}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000), // 응답을 물고 늘어지는 호출이 함수 maxDuration 을 잡아먹지 않게
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new Error(`상품 상세 조회 실패 (${p.originProductNo}, HTTP ${res.status}) ${j.code || ""} ${j.message || ""}`.trim());
  }
  const json = (await res.json()) as { originProduct?: Record<string, unknown> };
  const op = json.originProduct ?? {};
  const detail = (op.detailAttribute ?? {}) as Record<string, unknown>;
  const listingName = p.name || String(op.name ?? "");
  const originNo = String(p.originProductNo);
  const skuOf = (r: Record<string, unknown>) => String(r.sellerManagerCode ?? r.sellerManagementCode ?? "").trim();
  const items: NaverCatalogItem[] = [];

  const optionInfo = (detail.optionInfo ?? {}) as Record<string, unknown>;
  const combos = (optionInfo.optionCombinations ?? []) as Record<string, unknown>[];
  for (const c of combos) {
    const optName = [c.optionName1, c.optionName2, c.optionName3, c.optionName4]
      .filter((v) => v != null && String(v).trim() !== "")
      .map(String)
      .join(" / ");
    items.push({
      item_key: `${originNo}:option:${c.id}`,
      origin_no: originNo,
      listing_name: listingName,
      item_kind: "option",
      item_name: optName || null,
      sku_code: skuOf(c),
      sale_status: c.usable === false ? "UNUSABLE" : p.statusType || null,
      stock_qty: c.stockQuantity != null ? Number(c.stockQuantity) : null,
    });
  }

  const suppInfo = (detail.supplementProductInfo ?? {}) as Record<string, unknown>;
  const supps = (suppInfo.supplementProducts ?? []) as Record<string, unknown>[];
  for (const s of supps) {
    items.push({
      item_key: `${originNo}:supplement:${s.id}`,
      origin_no: originNo,
      listing_name: listingName,
      item_kind: "supplement",
      item_name: [s.groupName, s.name].filter((v) => v != null && String(v).trim() !== "").map(String).join(" - ") || null,
      sku_code: skuOf(s),
      sale_status: s.usable === false ? "UNUSABLE" : p.statusType || null,
      stock_qty: s.stockQuantity != null ? Number(s.stockQuantity) : null,
    });
  }

  // 옵션이 없는 단일 상품 — 상품 자체를 한 행으로
  if (combos.length === 0) {
    items.push({
      item_key: `${originNo}:product:0`,
      origin_no: originNo,
      listing_name: listingName,
      item_kind: "product",
      item_name: null,
      sku_code: (p.sellerManagementCode || skuOf(op)).trim(),
      sale_status: p.statusType || null,
      stock_qty: p.stockQuantity ?? null,
    });
  }
  return items;
}
