import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// 박스히어로(BoxHero) Open API 연동
//  - base: https://rest.boxhero-app.com, Bearer 토큰(설정>통합), 5 req/s
//  - 토큰은 b2b_settings('boxhero_token') 에만 저장. 코드/깃에는 넣지 않음.
//  - 서버 전용 (service role). 클라이언트로 원문 토큰을 절대 내보내지 않음.
// ─────────────────────────────────────────────

const BASE = "https://rest.boxhero-app.com";
const TOKEN_KEY = "boxhero_token";
const SAFETY_ATTR = "안전 재고"; // 박스히어로 품목 속성명(안전재고)

export async function getBoxheroToken(): Promise<string | null> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", TOKEN_KEY).maybeSingle();
    if (error || !data) return null;
    const v = data.value;
    const t = typeof v === "string" ? v : "";
    return t.trim() || null;
  } catch {
    return null;
  }
}

export async function setBoxheroToken(token: string): Promise<void> {
  const sb = supabaseAdmin();
  const clean = (token || "").trim();
  await sb.from("b2b_settings").upsert(
    { key: TOKEN_KEY, value: clean, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

// 화면 표시용 마스킹 (앞 6 + 뒤 4)
export function maskToken(token: string | null): string {
  if (!token) return "";
  if (token.length <= 12) return "••••";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export interface BoxheroItem {
  id: number;
  sku: string | null;
  name: string;
  quantity: number;     // 현재고(전체 위치 합)
  safety: number | null; // 안전 재고 (속성)
  cost: number | null;
}

interface RawAttr { name: string; type: string; value: string | number }
interface RawItem {
  id: number;
  name: string;
  sku: string | null;
  quantity: number;
  cost: string | null;
  attrs?: RawAttr[];
}

function parseItem(it: RawItem): BoxheroItem {
  const safetyAttr = (it.attrs || []).find((a) => a.name === SAFETY_ATTR);
  const safety = safetyAttr != null ? Number(safetyAttr.value) : null;
  return {
    id: it.id,
    sku: it.sku ? String(it.sku).trim() : null,
    name: it.name,
    quantity: Number(it.quantity) || 0,
    safety: safety != null && !Number.isNaN(safety) ? safety : null,
    cost: it.cost != null && it.cost !== "" ? Number(it.cost) : null,
  };
}

export class BoxheroError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// 전체 품목을 cursor 페이징으로 수집 (limit 최대 100).
export async function fetchBoxheroItems(token: string): Promise<BoxheroItem[]> {
  const out: BoxheroItem[] = [];
  let cursor: number | null = null;
  // 안전장치: 최대 50페이지(=5000개)
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${BASE}/v1/items`);
    url.searchParams.set("limit", "100");
    if (cursor != null) url.searchParams.set("cursor", String(cursor));

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = res.status === 401 || res.status === 403
        ? "박스히어로 토큰이 유효하지 않습니다. 설정에서 토큰을 확인하세요."
        : `박스히어로 API 오류 (${res.status}) ${body.slice(0, 120)}`;
      throw new BoxheroError(msg, res.status);
    }
    const json = (await res.json()) as { items?: RawItem[]; has_more?: boolean; cursor?: number | null };
    for (const it of json.items || []) out.push(parseItem(it));
    if (!json.has_more || json.cursor == null) break;
    cursor = json.cursor;
  }
  return out;
}

// 연결 테스트 — 1건만 받아 토큰 유효성 확인.
export async function testBoxheroToken(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${BASE}/v1/items?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return { ok: false, error: res.status === 401 || res.status === 403 ? "토큰이 유효하지 않습니다." : `오류 ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "연결 실패" };
  }
}
