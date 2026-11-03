import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { isAdminReq } from "@/app/lib/admin-req";
import { POSITIONS } from "@/app/lib/detail-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 상세페이지 적용 기록·전송 큐(migration 160, detail_applies).
//  미들웨어 예외 경로(실행기의 Bearer 접근용)라 여기서 직접 인증한다.
//
//  화면(로그인 쿠키 — factory 역할 거부):
//    GET ?source_id=&product_no=&limit=   → 적용 기록(최신순, 기본 200건)
//    GET ?names=1,2,3                     → 카페24 카탈로그에서 상품명 조회 { "1": "상품명" }
//    POST { source_id, product_nos:number[] } → 전송 요청(대기 행 생성). 관리자만.
//        같은 소스·상품에 대기·실행중이 이미 있으면 건너뛴다.
//  실행기(Bearer NAVER_COMMERCE_CLIENT_SECRET 또는 크론 키):
//    POST ?mode=claim  → 대기(+10분 넘은 고아 실행중)를 원자적으로 '실행중' 선점 후 반환
//    POST ?mode=report { id, ok, error?, backup_html?, verified? } → 결과 기록('실행중' 행만)

const isMissing = (e: { message?: string } | null | undefined) => !!e && /detail_sources|detail_applies|does not exist|schema cache/i.test(e.message || "");
const MISSING = NextResponse.json({ ok: false, error: "마이그레이션 160(detail_applies) 적용이 필요합니다." }, { status: 503 });

function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET, process.env.DIGEST_CRON_KEY];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}

export async function GET(req: NextRequest) {
  try {
    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const sp = new URL(req.url).searchParams;
    const sb = supabaseAdmin();

    const names = sp.get("names");
    if (names !== null) {
      const nos = names.split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).slice(0, 500);
      if (nos.length === 0) return NextResponse.json({ ok: true, names: {} });
      const { data, error } = await sb.from("channel_catalog").select("origin_no, listing_name").eq("channel", "카페24").in("origin_no", nos);
      if (error && !/channel_catalog/i.test(error.message || "")) throw error;
      const out: Record<string, string> = {};
      for (const r of (data ?? []) as { origin_no: string; listing_name: string }[]) out[r.origin_no] = r.listing_name;
      return NextResponse.json({ ok: true, names: out });
    }

    let q = sb.from("detail_applies")
      .select("id, source_id, source_version, product_no, product_name, position, status, error, verified, requested_by, created_at, executed_at")
      .order("created_at", { ascending: false });
    const sid = Number(sp.get("source_id"));
    if (Number.isInteger(sid) && sid > 0) q = q.eq("source_id", sid);
    const pno = Number(sp.get("product_no"));
    if (Number.isInteger(pno) && pno > 0) q = q.eq("product_no", pno);
    const limit = Math.min(Math.max(Number(sp.get("limit")) || 200, 1), 1000);
    const { data, error } = await q.limit(limit);
    if (error) { if (isMissing(error)) return MISSING; throw error; }
    return NextResponse.json({ ok: true, applies: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "적용 기록 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const sb = supabaseAdmin();

    if (sp.get("mode") === "claim") {
      if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
      const orphanCut = new Date(Date.now() - 10 * 60_000).toISOString();
      const { data, error } = await sb.from("detail_applies")
        .update({ status: "실행중", claimed_at: new Date().toISOString() })
        .or(`status.eq.대기,and(status.eq.실행중,claimed_at.lt.${orphanCut})`)
        .select("id, source_id, product_no, html, position, created_at");
      if (error) { if (isMissing(error)) return MISSING; throw error; }
      const rows = (data ?? []).sort((a, b) => a.id - b.id);
      return NextResponse.json({ ok: true, applies: rows });
    }

    if (sp.get("mode") === "report") {
      if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
      const body = (await req.json().catch(() => ({}))) as { id?: number; ok?: boolean; error?: string; backup_html?: string; verified?: boolean };
      if (!body.id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
      const patch: Record<string, unknown> = {
        status: body.ok ? "완료" : "실패",
        error: body.ok ? null : String(body.error || "알 수 없는 오류").slice(0, 500),
        executed_at: new Date().toISOString(),
      };
      if (typeof body.backup_html === "string") patch.backup_html = body.backup_html;
      if (typeof body.verified === "boolean") patch.verified = body.verified;
      const { error } = await sb.from("detail_applies").update(patch).eq("id", body.id).eq("status", "실행중");
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    const name = await loginName(req);
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    if (!(await isAdminReq(req))) return NextResponse.json({ ok: false, error: "관리자만 보낼 수 있습니다." }, { status: 403 });
    const body = (await req.json().catch(() => ({}))) as { source_id?: number; product_nos?: number[] };
    const sourceId = Number(body.source_id);
    const nos = Array.from(new Set((body.product_nos ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))).slice(0, 500);
    if (!Number.isInteger(sourceId) || sourceId <= 0) return NextResponse.json({ ok: false, error: "소스를 고르세요." }, { status: 400 });
    if (nos.length === 0) return NextResponse.json({ ok: false, error: "상품번호를 입력하세요." }, { status: 400 });

    const { data: src, error: sErr } = await sb.from("detail_sources").select("id, html, position, version").eq("id", sourceId).single();
    if (sErr) { if (isMissing(sErr)) return MISSING; return NextResponse.json({ ok: false, error: "소스를 찾을 수 없습니다." }, { status: 404 }); }
    if (!(POSITIONS as readonly string[]).includes(src.position)) return NextResponse.json({ ok: false, error: "소스의 넣는 자리가 올바르지 않습니다." }, { status: 400 });
    if (!String(src.html || "").trim()) return NextResponse.json({ ok: false, error: "소스 HTML 이 비어 있습니다." }, { status: 400 });

    // 이미 대기·실행중인 (소스, 상품)은 건너뛴다 — 같은 값을 두 번 쏘지 않게
    const { data: pending, error: pErr } = await sb.from("detail_applies").select("product_no").eq("source_id", sourceId).in("status", ["대기", "실행중"]).in("product_no", nos);
    if (pErr) throw pErr;
    const skip = new Set((pending ?? []).map((r: { product_no: number }) => r.product_no));
    const targets = nos.filter((n) => !skip.has(n));

    const { data: cat, error: cErr } = await sb.from("channel_catalog").select("origin_no, listing_name").eq("channel", "카페24").in("origin_no", targets.map(String));
    if (cErr && !/channel_catalog/i.test(cErr.message || "")) throw cErr;
    const nameOf: Record<string, string> = {};
    for (const r of (cat ?? []) as { origin_no: string; listing_name: string }[]) nameOf[r.origin_no] = r.listing_name;

    if (targets.length > 0) {
      const rows = targets.map((n) => ({
        source_id: sourceId, source_version: src.version, product_no: n, product_name: nameOf[String(n)] ?? null,
        html: src.html, position: src.position, status: "대기", requested_by: name,
      }));
      const { error } = await sb.from("detail_applies").insert(rows);
      if (error) throw error;
    }
    return NextResponse.json({ ok: true, queued: targets.length, skipped: Array.from(skip) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "전송 요청 실패") }, { status: 500 });
  }
}
