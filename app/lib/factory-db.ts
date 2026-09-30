// 파도소리 재고 — 서버 전용 DB 접근. 화면에서 import 하지 말 것(서비스 키가 번들에 실린다).

import type { NextRequest } from "next/server";
import { supabaseAdmin } from "./supabase";
import { verifySession, resolveUserName, isAdminName } from "./b2b-auth";

// factory 스키마 전용 핸들. **파도소리 라우트는 supabaseAdmin() 대신 반드시 이걸 쓴다.**
//  public(매출·고객·재고)에 실수로 손이 닿지 않게 하는 앱 레이어 경계다 — 이 핸들로는
//  factory 스키마의 테이블만 조회된다.
//  사전 조건: Dashboard > Settings > API > Exposed schemas 에 factory 추가(migration factory/001 주석 참조).
export function factoryDb() {
  return supabaseAdmin().schema("factory");
}

export async function factoryActor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// 품목 등록·수정(설정)은 관리자만 — 미들웨어는 파도소리 계정도 /api/factory/* 를 통과시키므로 라우트에서 막는다.
export async function factoryWho(req: NextRequest): Promise<{ name: string | null; admin: boolean }> {
  const name = await factoryActor(req);
  return { name, admin: !!name && isAdminName(name) };
}

// migration factory/005 미적용 — 새 테이블·뷰·함수가 없다는 오류
export function isPending005(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err ?? "");
  return /(products|stock_txns|stock_lots|product_changes|post_stock_txns|cancel_stock_txn|delete_product)/.test(m)
    && /(does not exist|schema cache|Could not find)/i.test(m);
}
export const PENDING_005 = "DB 준비 전입니다 — supabase/migrations/factory/005_products_stock_ledger.sql 을 적용하세요.";

// ── 품목 입력 정리(등록·수정 공용) ──────────────────────────────────
export type ProductPatch = Partial<{
  sku: string; name: string; origin: string | null; note: string | null;
  cost: number | null; price: number | null; stock_tracked: boolean;
}>;
export const MASTER_FIELDS = ["sku", "name", "origin", "note", "stock_tracked"] as const; // 관리자만
export const PRICE_FIELDS = ["cost", "price"] as const;                                  // 모든 계정(이력 남김)

// 들어온 키만 정리한다(수정 = 부분 갱신). 잘못된 값은 error.
export function parseProductInput(b: Record<string, unknown>): { patch: ProductPatch; error?: string } {
  const patch: ProductPatch = {};
  const txt = (v: unknown) => { const s = String(v ?? "").trim(); return s || null; };
  if ("sku" in b) {
    const s = String(b.sku ?? "").trim().toUpperCase();
    if (!s) return { patch, error: "SKU 를 입력하세요." };
    if (s.length > 60) return { patch, error: "SKU 가 너무 깁니다." };
    patch.sku = s;
  }
  if ("name" in b) {
    const s = String(b.name ?? "").trim();
    if (!s) return { patch, error: "품목을 입력하세요." };
    patch.name = s;
  }
  if ("origin" in b) patch.origin = txt(b.origin);
  if ("note" in b) patch.note = txt(b.note);
  for (const k of PRICE_FIELDS) {
    if (!(k in b)) continue;
    const raw = String(b[k] ?? "").replace(/[,\s원]/g, "");
    if (!raw) { patch[k] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { patch, error: `${k === "cost" ? "제품원가" : "판매가"}는 0 이상 숫자로 입력하세요.` };
    patch[k] = Math.round(n);
  }
  if ("stock_tracked" in b) patch.stock_tracked = b.stock_tracked !== false;
  return { patch };
}

// 변경 이력 값 — 문자열로 남긴다(null = 빈 값)
export function histValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "사용" : "사용안함";
  return String(v);
}
