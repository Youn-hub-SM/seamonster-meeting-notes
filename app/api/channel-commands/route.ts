import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySessionFull, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 채널 재고 명령 큐 (migration 108) — SKU 리스팅 찾기의 '수량 적용(품절=0)' 버튼.
//  네이버·쿠팡 쓰기 API 는 등록 IP 전용이라 Vercel 이 직접 실행하지 못한다 —
//  화면이 여기로 명령을 넣으면(대기) 중계 서버 크론이 2분마다 가져가 실행하고 결과를 보고한다.
//  미들웨어 예외 경로(실행기의 Bearer 접근용)라 여기서 직접 인증한다.
//
//  화면(로그인 쿠키 — factory(외부 제조사) 역할은 거부):
//    POST { channel, item_key, origin_no, listing_name, item_name?, sku_code?, qty } → 명령 생성
//    GET  ?recent=1 → 최근 명령 100건(상태 표시용)
//  실행기(Bearer NAVER_COMMERCE_CLIENT_SECRET 또는 크론 키):
//    POST ?mode=claim → 대기 명령을 원자적으로 '실행중' 선점 후 반환(경합·이중 실행 방지의 핵심).
//                       10분 넘게 '실행중'인 고아(죽은 실행기)도 재선점한다.
//    POST ?mode=report { id, ok, qty, error? } → 실행 결과 기록('실행중'+같은 qty 인 행만 —
//                       선점 사이에 값이 바뀌었으면 남겨서 재실행되게 한다)

const CHANNELS = new Set(["스마트스토어", "쿠팡", "카페24"]);

function bearerOk(req: NextRequest): boolean {
  const authz = req.headers.get("authorization") || "";
  const keys = [process.env.NAVER_COMMERCE_CLIENT_SECRET, process.env.CRON_SECRET, process.env.DIGEST_CRON_KEY];
  return keys.some((k) => k && k.trim() && authz === `Bearer ${k.trim()}`);
}

// 내부 직원만 — factory(파도소리) 역할은 실채널 재고 명령에 접근 불가(미들웨어 예외 경로라 여기서 직접 차단)
async function loginName(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get("b2b_auth")?.value;
  const sess = await verifySessionFull(t);
  if (sess) return sess.role === "factory" ? null : sess.name;
  return resolveUserName(t) || null;
}

export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const sb = supabaseAdmin();

    if (!(await loginName(req))) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const { data, error } = await sb
      .from("channel_commands")
      .select("id, channel, item_key, listing_name, item_name, sku_code, qty, status, error, created_at, executed_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      if (/channel_commands/i.test(error.message || "")) {
        return NextResponse.json({ ok: false, error: "마이그레이션 108(channel_commands) 적용이 필요합니다." }, { status: 503 });
      }
      throw error;
    }
    return NextResponse.json({ ok: true, commands: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "명령 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const sb = supabaseAdmin();

    if (sp.get("mode") === "claim") {
      // 실행기 선점 — '대기' 와 10분 넘은 고아 '실행중'을 원자적으로 '실행중' 전환하며 가져간다.
      //  update 가 반환한 행이 곧 실행 스냅샷이라, 이후의 수량 변경은 새 명령(insert)으로만 가능해
      //  옛 값이 새 값을 덮는 경합이 구조적으로 사라진다.
      if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
      const orphanCut = new Date(Date.now() - 10 * 60_000).toISOString();
      const { data, error } = await sb
        .from("channel_commands")
        .update({ status: "실행중", claimed_at: new Date().toISOString() })
        .or(`status.eq.대기,and(status.eq.실행중,claimed_at.lt.${orphanCut})`)
        .select("id, channel, item_key, origin_no, qty, command");
      if (error) throw error;
      return NextResponse.json({ ok: true, commands: data ?? [] });
    }

    if (sp.get("mode") === "report") {
      if (!bearerOk(req)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
      const body = (await req.json().catch(() => ({}))) as { id?: number; ok?: boolean; qty?: number; error?: string };
      if (!body.id || !Number.isInteger(Number(body.qty))) {
        return NextResponse.json({ ok: false, error: "id / qty 가 필요합니다." }, { status: 400 });
      }
      const { error } = await sb
        .from("channel_commands")
        .update({
          status: body.ok ? "완료" : "실패",
          error: body.ok ? null : String(body.error || "알 수 없는 오류").slice(0, 500),
          executed_at: new Date().toISOString(),
        })
        .eq("id", body.id)
        .eq("status", "실행중")
        .eq("qty", Number(body.qty)); // 선점 스냅샷과 값이 다르면 남겨서 재실행되게 한다
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    const name = await loginName(req);
    if (!name) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as {
      channel?: string; command?: string; item_key?: string; origin_no?: string;
      listing_name?: string; item_name?: string | null; sku_code?: string; qty?: number;
    };
    if (!body.channel || !CHANNELS.has(body.channel)) {
      return NextResponse.json({ ok: false, error: "channel 이 올바르지 않습니다." }, { status: 400 });
    }

    // 카탈로그 동기화 명령 — 화면 버튼이 채널별로 등록, 실행기가 서버의 동기화 스크립트를 돌린다
    if (body.command === "sync_catalog") {
      body.item_key = "sync";
      body.origin_no = "-";
      body.listing_name = "카탈로그 동기화";
      body.qty = 0;
    } else if (body.command && body.command !== "set_stock") {
      return NextResponse.json({ ok: false, error: "지원하지 않는 command 입니다." }, { status: 400 });
    }

    if (!body.item_key || !body.origin_no || !body.listing_name) {
      return NextResponse.json({ ok: false, error: "item_key / origin_no / listing_name 이 필요합니다." }, { status: 400 });
    }
    const qty = Number(body.qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > 99999) {
      return NextResponse.json({ ok: false, error: "수량은 0~99999 정수여야 합니다 (0 = 품절)." }, { status: 400 });
    }

    // 같은 아이템의 '대기' 명령이 있으면 값만 갱신(연타 방지) — 조건부 update 라 실행기가 그 사이
    //  선점('실행중')했으면 갱신되지 않고 아래 insert 로 새 명령이 생긴다(옛 값이 새 값을 덮는 경합 차단).
    const { data: bumped, error: bumpErr } = await sb
      .from("channel_commands")
      .update({ qty, requested_by: name, created_at: new Date().toISOString() })
      .eq("channel", body.channel)
      .eq("item_key", body.item_key)
      .eq("status", "대기")
      .select("id");
    if (bumpErr) throw bumpErr;
    if (bumped && bumped.length > 0) {
      return NextResponse.json({ ok: true, id: bumped[0].id, updated: true });
    }

    const { data, error } = await sb
      .from("channel_commands")
      .insert({
        channel: body.channel,
        item_key: body.item_key,
        origin_no: body.origin_no,
        listing_name: body.listing_name,
        item_name: body.item_name ?? null,
        sku_code: (body.sku_code || "").trim(),
        command: body.command === "sync_catalog" ? "sync_catalog" : "set_stock",
        qty,
        requested_by: name,
      })
      .select("id")
      .single();
    if (error) {
      if (/channel_commands/i.test(error.message || "")) {
        return NextResponse.json({ ok: false, error: "마이그레이션 108(channel_commands) 적용이 필요합니다." }, { status: 503 });
      }
      throw error;
    }
    return NextResponse.json({ ok: true, id: data.id });
  } catch (err) {
    console.error("[channel-commands]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "명령 처리 실패") }, { status: 500 });
  }
}
