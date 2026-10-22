import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho, isPending005, PENDING_005, isMissingSpec, PENDING_006_HINT } from "@/app/lib/factory-db";
import { productKey, type FactoryProduct } from "@/app/lib/factory";

export const dynamic = "force-dynamic";

// POST { items: [{ name, origin? }] } — 입고 창에서 바로 품목 등록(모든 계정, 2026-10-20 대표 지시:
//  "입고 품목이 워낙 많아 상품마스터를 거칠 수 없다"). 상품마스터 화면은 품목의 모든 칸을 다룬다.
//  - 받는 칸은 품목명·규격·원산지뿐(규격은 factory/006). SKU 는 자동(PD-0001…) — 상품마스터에서 바꿀 수 있다.
//  - 같은 품목명(공백 정리·대소문자 무시)+규격+원산지가 이미 있으면 새로 만들지 않고 그 품목을 돌려준다.
//    입고 저장이 실패해 다시 눌러도 품목이 두 번 생기지 않는다(입고 창은 저장할 때 이걸 먼저 부른다).
//  - 응답 products 는 items 와 같은 순서. 등록 이력은 DB 트리거(product_changes '등록')가 남긴다.
const MAX_ITEMS = 100;
const SKU_PREFIX = "PD-";
const norm = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ");
const key = (name: string, spec: string | null, origin: string | null) => productKey({ name, spec, origin });

export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.name) return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
    const b = (await req.json().catch(() => ({}))) as { items?: { name?: unknown; spec?: unknown; origin?: unknown }[] };
    const items = (Array.isArray(b.items) ? b.items : []).map((x) => ({ name: norm(x?.name), spec: norm(x?.spec) || null, origin: norm(x?.origin) || null }));
    if (items.length === 0) return NextResponse.json({ ok: false, error: "등록할 품목이 없습니다." }, { status: 400 });
    if (items.length > MAX_ITEMS) return NextResponse.json({ ok: false, error: `한 번에 ${MAX_ITEMS}개까지 등록할 수 있습니다.` }, { status: 400 });
    for (const it of items) {
      if (!it.name) return NextResponse.json({ ok: false, error: "새 품목의 품목명을 입력하세요." }, { status: 400 });
      if (it.name.length > 100) return NextResponse.json({ ok: false, error: `품목명이 너무 깁니다: ${it.name.slice(0, 20)}…` }, { status: 400 });
      if (it.spec && it.spec.length > 60) return NextResponse.json({ ok: false, error: `${it.name}: 규격이 너무 깁니다(60자까지).` }, { status: 400 });
    }

    const db = factoryDb();
    const { data: all, error: ae } = await db.from("products").select("*");
    if (ae) throw ae;
    const existing = new Map<string, FactoryProduct>();
    let maxNo = 0;
    for (const p of (all || []) as FactoryProduct[]) {
      existing.set(key(norm(p.name), norm(p.spec) || null, norm(p.origin) || null), p);
      const m = p.sku.toUpperCase().match(/^PD-(\d+)$/);
      if (m) maxNo = Math.max(maxNo, Number(m[1]));
    }

    const out: FactoryProduct[] = [];
    let created = 0;
    let warn: string | undefined;
    for (const it of items) {
      const k = key(it.name, it.spec, it.origin);
      const hit = existing.get(k);
      if (hit) {
        if (!hit.stock_tracked) {
          return NextResponse.json({ ok: false, error: `${hit.name}: '재고관리 사용안함' 품목입니다 — 상품마스터에서 재고관리를 켜세요.` }, { status: 400 });
        }
        out.push(hit);
        continue;
      }
      // SKU 채번 — 동시에 두 사람이 등록해 번호가 겹치면(유니크 위반) 다음 번호로 다시
      let row: FactoryProduct | null = null;
      for (let attempt = 0; attempt < 5 && !row; attempt++) {
        maxNo += 1;
        const sku = `${SKU_PREFIX}${String(maxNo).padStart(4, "0")}`;
        const base = { sku, name: it.name, origin: it.origin, stock_tracked: true, created_by: u.name, updated_by: u.name };
        let { data, error } = await db.from("products").insert({ ...base, spec: it.spec }).select("*").single();
        if (error && isMissingSpec(error)) {
          // 006 미적용 — 규격 없이 등록(규격은 적용 뒤 상품마스터에서)
          ({ data, error } = await db.from("products").insert(base).select("*").single());
          if (it.spec) warn = PENDING_006_HINT;
        }
        if (!error) { row = data as FactoryProduct; break; }
        if ((error as { code?: string }).code !== "23505") throw error;
      }
      if (!row) return NextResponse.json({ ok: false, error: "SKU 를 만들지 못했습니다. 다시 저장하세요." }, { status: 409 });
      existing.set(k, row);
      out.push(row);
      created++;
    }
    return NextResponse.json({ ok: true, products: out, created, warn });
  } catch (err) {
    if (isPending005(err)) return NextResponse.json({ ok: false, error: PENDING_005, pending_migration: true }, { status: 503 });
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "품목 등록 실패") }, { status: 500 });
  }
}
