import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { adminOnly } from "@/app/lib/admin-req";
import { POSITIONS, type Position } from "@/app/lib/detail-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 소스 조합(migration 161, detail_sets) — /detail 화면.
//  GET                                → 조합 목록(구성 소스 id 순서 포함)
//  POST {id?, name, members:number[], position} → 생성/수정. 로그인 직원.
//  DELETE ?id=                        → 삭제(적용 기록의 set_id 는 null 로 남는다). 관리자.

const isMissing = (e: { message?: string } | null | undefined) => !!e && /detail_sets|does not exist|schema cache/i.test(e.message || "");
const MISSING = NextResponse.json({ ok: false, error: "마이그레이션 161(detail_sets) 적용이 필요합니다." }, { status: 503 });

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
    const { data, error } = await sb.from("detail_sets").select("id, name, members, position, updated_by, updated_at").order("updated_at", { ascending: false });
    if (error) { if (isMissing(error)) return NextResponse.json({ ok: true, sets: [], unavailable: true }); throw error; }
    return NextResponse.json({ ok: true, sets: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조합 조회 실패") }, { status: 500 });
  }
}

// 가져오기 스크립트용 Bearer(업로드 공용 시크릿) — sources 와 같은 규칙
function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET, process.env.DIGEST_CRON_KEY];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

export async function POST(req: NextRequest) {
  try {
    const name = (await loginName(req)) || (bearerOk(req) ? "가져오기" : null);
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { id?: number; name?: string; members?: number[]; position?: string };
    const setName = String(body.name || "").trim();
    const members = Array.from(new Set((body.members ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0)));
    const position = (POSITIONS as readonly string[]).includes(body.position || "") ? (body.position as Position) : "append";
    if (!setName) return NextResponse.json({ ok: false, error: "조합 이름을 입력하세요." }, { status: 400 });
    if (members.length === 0) return NextResponse.json({ ok: false, error: "구성 소스를 하나 이상 고르세요." }, { status: 400 });
    const sb = supabaseAdmin();
    // 구성 소스가 실제로 있는지
    const { data: srcs, error: sErr } = await sb.from("detail_sources").select("id").in("id", members);
    if (sErr) throw sErr;
    const have = new Set((srcs ?? []).map((s: { id: number }) => s.id));
    const missing = members.filter((m) => !have.has(m));
    if (missing.length) return NextResponse.json({ ok: false, error: `없는 소스가 있습니다: ${missing.join(", ")}` }, { status: 400 });

    const now = new Date().toISOString();
    if (body.id) {
      const { data, error } = await sb.from("detail_sets")
        .update({ name: setName, members, position, updated_by: name, updated_at: now })
        .eq("id", body.id).select("id, name, members, position, updated_at").single();
      if (error) { if (isMissing(error)) return MISSING; throw error; }
      return NextResponse.json({ ok: true, set: data });
    }
    const { data, error } = await sb.from("detail_sets")
      .insert({ name: setName, members, position, created_by: name, updated_by: name, created_at: now, updated_at: now })
      .select("id, name, members, position, updated_at").single();
    if (error) { if (isMissing(error)) return MISSING; throw error; }
    return NextResponse.json({ ok: true, set: data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조합 저장 실패") }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const deny = await adminOnly(req);
    if (deny) return deny;
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { count } = await sb.from("detail_applies").select("id", { count: "exact", head: true }).eq("set_id", id).in("status", ["대기", "실행중"]);
    if (count) return NextResponse.json({ ok: false, error: "대기·실행중인 전송이 있어 지울 수 없습니다." }, { status: 409 });
    const { error } = await sb.from("detail_sets").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조합 삭제 실패") }, { status: 500 });
  }
}
