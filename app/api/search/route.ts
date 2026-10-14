import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";

// 전역 검색(Ctrl+K) '데이터' 묶음 — 발주번호·거래처·품목(SKU) 각 5건. 2026-10-14 UX 3차 C5.
//  인증은 미들웨어가 /api/* 전체를 게이트하므로(공개 예외에 넣지 않는다) 여기선 따로 확인하지 않는다.
//  집계별 try/catch — 한 테이블 조회가 실패해도 나머지 묶음은 그대로 내려간다.

export const runtime = "nodejs";

export type SearchDataHit = {
  kind: "order" | "company" | "product";
  id: string;
  label: string;   // 첫 줄(예: "발주 20260914-003")
  sub: string;     // 둘째 줄(예: "씨푸드마트 · 발송대기")
  href: string;
};

const PER_GROUP = 5;

// ilike 패턴 문자(% _ \) 는 글자 그대로 찾도록 이스케이프한다(.ilike() 단독 호출용).
function likePattern(q: string): string {
  return "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
}
// .or() 문자열 안에서는 이스케이프가 통하지 않으므로 필터 문법 문자(, ( ) ")와 패턴 문자(% _ \)를 아예 지운다.
function orSafe(q: string): string {
  return q.replace(/[,()"\\%_]/g, "");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ ok: true, data: [] as SearchDataHit[] });

  const sb = supabaseAdmin();
  const data: SearchDataHit[] = [];
  const pattern = likePattern(q);

  // 발주 — orders.order_no 부분일치. 상세 화면(/b2b/orders/{id})으로 바로 간다(목록은 ?q= 를 받지 않는다).
  try {
    const { data: rows, error } = await sb
      .from("orders")
      .select("id, order_no, status, order_date, companies:company_id(name)")
      .ilike("order_no", pattern)
      .order("order_date", { ascending: false })
      .limit(PER_GROUP);
    if (error) throw error;
    type Row = { id: string; order_no: string | null; status: string | null; companies?: { name?: string } | { name?: string }[] | null };
    for (const r of (rows as unknown as Row[]) || []) {
      const c = Array.isArray(r.companies) ? r.companies[0] : r.companies;
      data.push({
        kind: "order",
        id: r.id,
        label: `발주 ${r.order_no || "(번호 없음)"}`,
        sub: [c?.name || "(미지정)", r.status || ""].filter(Boolean).join(" · "),
        href: `/b2b/orders/${r.id}`,
      });
    }
  } catch (err) {
    console.error("[search orders]", err);
  }

  // 거래처 — companies.name 부분일치 → 업체 상세
  try {
    const { data: rows, error } = await sb
      .from("companies")
      .select("id, name, contact_name")
      .ilike("name", pattern)
      .order("name", { ascending: true })
      .limit(PER_GROUP);
    if (error) throw error;
    type Row = { id: string; name: string; contact_name: string | null };
    for (const r of (rows as Row[]) || []) {
      data.push({ kind: "company", id: r.id, label: r.name, sub: ["거래처", r.contact_name || ""].filter(Boolean).join(" · "), href: `/b2b/companies/${r.id}` });
    }
  } catch (err) {
    console.error("[search companies]", err);
  }

  // 품목 — products.name·sku 부분일치 → 상품 마스터 목록(상세 화면·?q= 수신 없음)
  try {
    const safe = orSafe(q);
    if (safe.length >= 2) {
      const p = `%${safe}%`;
      const { data: rows, error } = await sb
        .from("products")
        .select("id, name, sku, spec, active")
        .or(`name.ilike.${p},sku.ilike.${p}`)
        .order("active", { ascending: false })
        .order("name", { ascending: true })
        .limit(PER_GROUP);
      if (error) throw error;
      type Row = { id: string; name: string; sku: string | null; spec: string | null; active: boolean };
      for (const r of (rows as Row[]) || []) {
        data.push({
          kind: "product",
          id: r.id,
          label: [r.name, r.spec || ""].filter(Boolean).join(" "),
          sub: ["품목", r.sku || "", r.active === false ? "사용 안함" : ""].filter(Boolean).join(" · "),
          href: "/b2b/products",
        });
      }
    }
  } catch (err) {
    console.error("[search products]", err);
  }

  return NextResponse.json({ ok: true, data });
}
