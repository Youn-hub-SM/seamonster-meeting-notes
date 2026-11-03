import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { adminOnly } from "@/app/lib/admin-req";
import { POSITIONS, type Position } from "@/app/lib/detail-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 상세페이지 소스(migration 160, detail_sources) — /detail 화면.
//  GET            → 소스 목록(html 포함) + 소스별 적용 완료 상품 수
//  POST {id?, name, html, position} → 생성/수정(html 이 바뀌면 version +1). 로그인 직원.
//  DELETE ?id=    → 삭제(적용 기록도 cascade). 관리자.

const isMissing = (e: { message?: string } | null | undefined) => !!e && /detail_sources|detail_applies|does not exist|schema cache/i.test(e.message || "");
const MISSING = NextResponse.json({ ok: false, error: "마이그레이션 160(detail_sources) 적용이 필요합니다." }, { status: 503 });

async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}

export async function GET(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("detail_sources").select("id, name, html, position, version, created_by, created_at, updated_by, updated_at").order("updated_at", { ascending: false });
    if (error) { if (isMissing(error)) return MISSING; throw error; }
    // 소스별 적용 완료 상품 수(최신 완료 기준이 아니라 완료된 상품번호 distinct)
    const { data: ap, error: aErr } = await sb.from("detail_applies").select("source_id, product_no, status");
    if (aErr && !isMissing(aErr)) throw aErr;
    const counts: Record<number, Set<number>> = {};
    for (const r of (ap ?? []) as { source_id: number; product_no: number; status: string }[]) {
      if (r.status !== "완료") continue;
      (counts[r.source_id] ||= new Set()).add(r.product_no);
    }
    const sources = (data ?? []).map((s) => ({ ...s, applied_count: counts[s.id]?.size ?? 0 }));
    return NextResponse.json({ ok: true, sources });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "소스 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const name = await loginName(req);
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { id?: number; name?: string; html?: string; position?: string };
    const srcName = String(body.name || "").trim();
    const html = String(body.html ?? "");
    const position = (POSITIONS as readonly string[]).includes(body.position || "") ? (body.position as Position) : "append";
    if (!srcName) return NextResponse.json({ ok: false, error: "소스 이름을 입력하세요." }, { status: 400 });
    if (html.length > 2_000_000) return NextResponse.json({ ok: false, error: "HTML 이 너무 깁니다(2MB 초과)." }, { status: 400 });
    const sb = supabaseAdmin();
    const now = new Date().toISOString();

    if (body.id) {
      const { data: cur, error: cErr } = await sb.from("detail_sources").select("id, html, version").eq("id", body.id).single();
      if (cErr) { if (isMissing(cErr)) return MISSING; return NextResponse.json({ ok: false, error: "소스를 찾을 수 없습니다." }, { status: 404 }); }
      const version = cur.html === html ? cur.version : cur.version + 1;
      const { data, error } = await sb.from("detail_sources")
        .update({ name: srcName, html, position, version, updated_by: name, updated_at: now })
        .eq("id", body.id).select("id, name, html, position, version, updated_at").single();
      if (error) throw error;
      return NextResponse.json({ ok: true, source: data });
    }
    const { data, error } = await sb.from("detail_sources")
      .insert({ name: srcName, html, position, version: 1, created_by: name, updated_by: name, created_at: now, updated_at: now })
      .select("id, name, html, position, version, updated_at").single();
    if (error) { if (isMissing(error)) return MISSING; throw error; }
    return NextResponse.json({ ok: true, source: data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "소스 저장 실패") }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const deny = await adminOnly(req);
    if (deny) return deny;
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { count } = await sb.from("detail_applies").select("id", { count: "exact", head: true }).eq("source_id", id).in("status", ["대기", "실행중"]);
    if (count) return NextResponse.json({ ok: false, error: "대기·실행중인 전송이 있어 지울 수 없습니다." }, { status: 409 });
    const { error } = await sb.from("detail_sources").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "소스 삭제 실패") }, { status: 500 });
  }
}
