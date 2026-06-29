import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { VOC_SOURCES, VOC_CATEGORIES, VOC_STATUSES, VOC_SENTIMENTS } from "@/app/lib/voc";

export const dynamic = "force-dynamic";

// 폼이 실제로 다루는 사용자 입력 필드만 허용(매스 어사인 방지).
// source(수집방식)·assignee·sentiment·loss_amount 는 자동수집/정산 전용 → 전용 경로에서만 기록.
const EDITABLE = ["received_at", "channel", "customer", "purchase_date", "production_date", "purchase_place", "product", "category", "content", "resolution", "cause", "status", "improvement", "photos"] as const;

// "" → null 로 강등할 nullable 컬럼. 그 외(NOT NULL/Default 보유: received_at·category·status·content·photos)는
// "" 면 키 자체를 생략 → POST 는 DB default, PATCH 는 기존값 유지(NOT NULL 위반 방지).
const NULLABLE = new Set(["channel", "customer", "purchase_date", "production_date", "purchase_place", "product", "resolution", "cause", "improvement"]);

const ENUMS: Record<string, readonly string[]> = { source: VOC_SOURCES, category: VOC_CATEGORIES, status: VOC_STATUSES, sentiment: VOC_SENTIMENTS };
const DATE_FIELDS = ["received_at", "purchase_date", "production_date"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LEN = 5000;

function pick(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of EDITABLE) {
    if (body[f] === undefined) continue;
    if (body[f] === "") {
      if (NULLABLE.has(f)) out[f] = null; // nullable 만 null 로
      continue; // NOT NULL/Default 컬럼은 빈값이면 생략
    }
    out[f] = body[f];
  }
  // photos 는 문자열 URL 배열만 허용(null/잘못된 형식이면 생략 → DB default/기존값 유지)
  if ("photos" in out) {
    if (Array.isArray(out.photos)) out.photos = (out.photos as unknown[]).filter((x) => typeof x === "string");
    else delete out.photos;
  }
  return out;
}

// 잘못된 enum·날짜형식·과대 페이로드를 DB 에 닿기 전 400 으로 차단.
function validate(row: Record<string, unknown>): string | null {
  for (const [k, allowed] of Object.entries(ENUMS))
    if (row[k] != null && !allowed.includes(String(row[k]))) return `${k} 값이 올바르지 않습니다.`;
  for (const k of DATE_FIELDS)
    if (row[k] != null && !DATE_RE.test(String(row[k]))) return "날짜 형식(YYYY-MM-DD)이 올바르지 않습니다.";
  for (const k of Object.keys(row))
    if (typeof row[k] === "string" && (row[k] as string).length > MAX_LEN) return "입력이 너무 깁니다.";
  return null;
}

// GET /api/voc?status=&source=&q= — 목록
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let q = supabaseAdmin().from("voc").select("*").order("received_at", { ascending: false }).order("created_at", { ascending: false });
    const status = sp.get("status");
    const source = sp.get("source");
    const search = sp.get("q");
    if (status) q = q.eq("status", status);
    if (source) q = q.eq("source", source);
    if (search) {
      // PostgREST or() 필터 주입 방지: 값을 따옴표로 감싸 콤마/괄호/점이 구분자로 해석되지 않게 하고,
      // 내부 큰따옴표·백슬래시만 이스케이프, 길이 100자 제한.
      const v = search.slice(0, 100).replace(/[\\"]/g, (m) => "\\" + m);
      if (v.trim()) {
        const pat = `%${v}%`;
        q = q.or(`content.ilike."${pat}",customer.ilike."${pat}",product.ilike."${pat}"`);
      }
    }
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({ ok: true, rows: data ?? [] });
  } catch (err) {
    console.error("[voc GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST — 등록
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (body.content === undefined || String(body.content ?? "").trim() === "") {
      return NextResponse.json({ ok: false, error: "상세내용을 입력하세요." }, { status: 400 });
    }
    const row = pick(body);
    const verr = validate(row);
    if (verr) return NextResponse.json({ ok: false, error: verr }, { status: 400 });
    const { data, error } = await supabaseAdmin().from("voc").insert(row).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, row: data });
  } catch (err) {
    console.error("[voc POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}

// PATCH { id, ...fields } — 수정(상태 변경 포함)
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown> & { id?: string };
    if (!body.id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    // content 를 명시적으로 빈값으로 보낸 경우만 차단(상태만 바꾸는 PATCH 는 통과).
    if (body.content !== undefined && String(body.content ?? "").trim() === "") {
      return NextResponse.json({ ok: false, error: "상세내용을 입력하세요." }, { status: 400 });
    }
    const picked = pick(body);
    const verr = validate(picked);
    if (verr) return NextResponse.json({ ok: false, error: verr }, { status: 400 });
    const row = { ...picked, updated_at: new Date().toISOString() };
    const { data, error } = await supabaseAdmin().from("voc").update(row).eq("id", body.id).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, row: data });
  } catch (err) {
    console.error("[voc PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "수정 실패") }, { status: 500 });
  }
}

// DELETE ?id=
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const { error } = await supabaseAdmin().from("voc").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[voc DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
