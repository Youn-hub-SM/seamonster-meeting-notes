import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";
import { isAdminReq } from "@/app/lib/admin-req";
import { POSITIONS, type SetMember } from "@/app/lib/detail-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 상세페이지 적용 기록·전송 큐(migration 160 detail_applies, 161 조합 확장).
//  미들웨어 예외 경로(실행기의 Bearer 접근용)라 여기서 직접 인증한다.
//
//  화면(로그인 쿠키 — factory 역할 거부):
//    GET ?source_id=&product_no=&limit=   → 적용 기록(최신순, 기본 200건). source_id 는 조합 안에 든 것도 잡는다
//    GET ?names=1,2,3                     → 카페24 카탈로그에서 상품명 조회 { "1": "상품명" }
//    GET ?applied_for=SOURCE_ID           → 그 소스가 들어간 상품번호(완료 기준, 소스·조합 모두) — '전체 다시 쏘기'용
//    POST { source_id, product_nos }      → 소스 하나 전송 요청. 관리자만.
//    POST { set_id, product_nos }         → 조합 전송 요청(구성 소스를 쏜 시점 스냅샷으로 담는다). 관리자만.
//        같은 소스/조합·상품에 대기·실행중이 이미 있으면 건너뛴다.
//  실행기(Bearer NAVER_COMMERCE_CLIENT_SECRET 또는 크론 키):
//    POST ?mode=claim  → 대기(+10분 넘은 고아 실행중)를 원자적으로 '실행중' 선점 후 반환
//    POST ?mode=report { id, ok, error?, backup_html?, verified? } → 결과 기록('실행중' 행만)

const isMissing = (e: { message?: string } | null | undefined) => !!e && /detail_sources|detail_applies|does not exist|schema cache/i.test(e.message || "");
const isNoSetCols = (e: { message?: string } | null | undefined) => !!e && /command|set_id|set_name|members/i.test(e.message || "") && /column|schema cache/i.test(e.message || "");
const MISSING = NextResponse.json({ ok: false, error: "마이그레이션 160(detail_applies) 적용이 필요합니다." }, { status: 503 });
const MISSING_161 = NextResponse.json({ ok: false, error: "마이그레이션 161(detail_sets) 적용이 필요합니다." }, { status: 503 });

const BASE_COLS = "id, source_id, source_version, product_no, product_name, position, status, error, verified, requested_by, created_at, executed_at";
const SET_COLS = `${BASE_COLS}, command, set_id, set_name, members`;

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

type ApplyRow = {
  id: number; source_id: number | null; source_version: number | null; product_no: number; product_name: string | null; position: string;
  status: string; error: string | null; verified: boolean | null; requested_by: string | null; created_at: string; executed_at: string | null;
  command?: string; set_id?: number | null; set_name?: string | null; members?: SetMember[] | null;
};

/** 161 미적용이면 조합 칸 없이 다시 읽는다 */
async function readApplies(sb: ReturnType<typeof supabaseAdmin>, build: (cols: string) => PromiseLike<{ data: unknown; error: { message?: string } | null }>): Promise<{ rows: ApplyRow[]; sets: boolean } | { error: { message?: string } }> {
  const a = await build(SET_COLS);
  if (!a.error) return { rows: (a.data ?? []) as ApplyRow[], sets: true };
  if (!isNoSetCols(a.error)) return { error: a.error };
  const b = await build(BASE_COLS);
  if (b.error) return { error: b.error };
  return { rows: (b.data ?? []) as ApplyRow[], sets: false };
}

const memberIds = (r: ApplyRow): number[] => (r.command === "set" && Array.isArray(r.members)) ? r.members.map((m) => Number(m.source_id)) : (r.source_id ? [r.source_id] : []);

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

    const appliedFor = Number(sp.get("applied_for"));
    if (Number.isInteger(appliedFor) && appliedFor > 0) {
      // 그 소스가 들어간 상품: 상품별 최신 완료 행에 소스가 포함돼 있으면 '적용됨'
      const res = await readApplies(sb, (cols) => sb.from("detail_applies").select(cols).eq("status", "완료").order("created_at", { ascending: false }).limit(5000));
      if ("error" in res) { if (isMissing(res.error)) return MISSING; throw res.error; }
      const seen = new Map<number, boolean>(); // product_no → 최신 완료 행이 소스를 포함하는가(첫 행만)
      for (const r of res.rows) {
        if (!memberIds(r).includes(appliedFor)) continue;
        if (!seen.has(r.product_no)) seen.set(r.product_no, true);
      }
      return NextResponse.json({ ok: true, product_nos: Array.from(seen.keys()) });
    }

    const sid = Number(sp.get("source_id"));
    const pno = Number(sp.get("product_no"));
    const limit = Math.min(Math.max(Number(sp.get("limit")) || 200, 1), 1000);
    const res = await readApplies(sb, (cols) => {
      let q = sb.from("detail_applies").select(cols).order("created_at", { ascending: false });
      if (Number.isInteger(pno) && pno > 0) q = q.eq("product_no", pno);
      // 소스 필터는 조합 행까지 잡아야 해서 넉넉히 읽고 아래서 거른다
      return q.limit(Number.isInteger(sid) && sid > 0 ? Math.max(limit * 5, 1000) : limit);
    });
    if ("error" in res) { if (isMissing(res.error)) return MISSING; throw res.error; }
    let rows = res.rows;
    if (Number.isInteger(sid) && sid > 0) rows = rows.filter((r) => memberIds(r).includes(sid)).slice(0, limit);
    return NextResponse.json({ ok: true, applies: rows, sets: res.sets });
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
      const claim = (cols: string) => sb.from("detail_applies")
        .update({ status: "실행중", claimed_at: new Date().toISOString() })
        .or(`status.eq.대기,and(status.eq.실행중,claimed_at.lt.${orphanCut})`)
        .select(cols);
      let { data, error } = await claim("id, source_id, product_no, html, position, created_at, command, set_id, members");
      if (error && isNoSetCols(error)) ({ data, error } = await claim("id, source_id, product_no, html, position, created_at"));
      if (error) { if (isMissing(error)) return MISSING; throw error; }
      const rows = ((data ?? []) as unknown as { id: number }[]).sort((a, b) => a.id - b.id);
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
    const body = (await req.json().catch(() => ({}))) as { source_id?: number; set_id?: number; product_nos?: number[] };
    const nos = Array.from(new Set((body.product_nos ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))).slice(0, 500);
    if (nos.length === 0) return NextResponse.json({ ok: false, error: "상품번호를 입력하세요." }, { status: 400 });

    const { data: cat, error: cErr } = await sb.from("channel_catalog").select("origin_no, listing_name").eq("channel", "카페24").in("origin_no", nos.map(String));
    if (cErr && !/channel_catalog/i.test(cErr.message || "")) throw cErr;
    const nameOf: Record<string, string> = {};
    for (const r of (cat ?? []) as { origin_no: string; listing_name: string }[]) nameOf[r.origin_no] = r.listing_name;

    // ── 조합 전송 ──
    const setId = Number(body.set_id);
    if (Number.isInteger(setId) && setId > 0) {
      const { data: set, error: sErr } = await sb.from("detail_sets").select("id, name, members, position").eq("id", setId).single();
      if (sErr) { if (/detail_sets|schema cache/i.test(sErr.message || "")) return MISSING_161; return NextResponse.json({ ok: false, error: "조합을 찾을 수 없습니다." }, { status: 404 }); }
      const ids: number[] = (set.members ?? []).map(Number);
      if (ids.length === 0) return NextResponse.json({ ok: false, error: "조합에 구성 소스가 없습니다." }, { status: 400 });
      if (!(POSITIONS as readonly string[]).includes(set.position)) return NextResponse.json({ ok: false, error: "조합의 넣는 자리가 올바르지 않습니다." }, { status: 400 });
      const { data: srcs, error: srcErr } = await sb.from("detail_sources").select("id, html, version").in("id", ids);
      if (srcErr) throw srcErr;
      const byId = new Map((srcs ?? []).map((s: { id: number; html: string; version: number }) => [s.id, s]));
      const members: SetMember[] = [];
      for (const id of ids) {
        const s = byId.get(id);
        if (!s) return NextResponse.json({ ok: false, error: `조합의 소스 #${id} 가 없습니다. 조합을 고치세요.` }, { status: 400 });
        if (!String(s.html || "").trim()) return NextResponse.json({ ok: false, error: `소스 #${id} 의 HTML 이 비어 있습니다.` }, { status: 400 });
        members.push({ source_id: s.id, version: s.version, html: s.html });
      }
      const { data: pending, error: pErr } = await sb.from("detail_applies").select("product_no").eq("set_id", setId).in("status", ["대기", "실행중"]).in("product_no", nos);
      if (pErr) { if (isNoSetCols(pErr)) return MISSING_161; throw pErr; }
      const skip = new Set((pending ?? []).map((r: { product_no: number }) => r.product_no));
      const targets = nos.filter((n) => !skip.has(n));
      if (targets.length > 0) {
        const rows = targets.map((n) => ({
          command: "set", set_id: setId, set_name: set.name, members,
          source_id: null, source_version: null, html: null,
          product_no: n, product_name: nameOf[String(n)] ?? null, position: set.position, status: "대기", requested_by: name,
        }));
        const { error } = await sb.from("detail_applies").insert(rows);
        if (error) { if (isNoSetCols(error)) return MISSING_161; throw error; }
      }
      return NextResponse.json({ ok: true, queued: targets.length, skipped: Array.from(skip) });
    }

    // ── 소스 하나 전송 ──
    const sourceId = Number(body.source_id);
    if (!Number.isInteger(sourceId) || sourceId <= 0) return NextResponse.json({ ok: false, error: "소스나 조합을 고르세요." }, { status: 400 });
    const { data: src, error: sErr } = await sb.from("detail_sources").select("id, html, position, version").eq("id", sourceId).single();
    if (sErr) { if (isMissing(sErr)) return MISSING; return NextResponse.json({ ok: false, error: "소스를 찾을 수 없습니다." }, { status: 404 }); }
    if (!(POSITIONS as readonly string[]).includes(src.position)) return NextResponse.json({ ok: false, error: "소스의 넣는 자리가 올바르지 않습니다." }, { status: 400 });
    if (!String(src.html || "").trim()) return NextResponse.json({ ok: false, error: "소스 HTML 이 비어 있습니다." }, { status: 400 });

    const { data: pending, error: pErr } = await sb.from("detail_applies").select("product_no").eq("source_id", sourceId).in("status", ["대기", "실행중"]).in("product_no", nos);
    if (pErr) throw pErr;
    const skip = new Set((pending ?? []).map((r: { product_no: number }) => r.product_no));
    const targets = nos.filter((n) => !skip.has(n));
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
