import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getKv, setKv } from "@/app/lib/b2b-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 정기배송 분석(iframe 대시보드) — 제외할 신청자/수령자 이름·옵션 키워드 기본값.
//  전 사용자 공용(b2b_settings KV). 대시보드가 페이지 로드 시 GET 해서 필터 입력칸을 채우고,
//  '기본값으로 저장' 버튼이 POST 한다. 저장값이 없으면 HTML 의 하드코딩 기본값 그대로.
const KEY = "subscription_exclude";

export async function GET() {
  try {
    const raw = await getKv(KEY);
    if (!raw) return NextResponse.json({ ok: true, saved: false, names: null, opts: null });
    const v = JSON.parse(raw) as { names?: unknown; opts?: unknown };
    return NextResponse.json({
      ok: true, saved: true,
      names: typeof v.names === "string" ? v.names : null,
      opts: typeof v.opts === "string" ? v.opts : null,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { names?: unknown; opts?: unknown };
    const names = String(b.names ?? "").slice(0, 500);
    const opts = String(b.opts ?? "").slice(0, 500);
    await setKv(KEY, JSON.stringify({ names, opts }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "설정 저장 실패") }, { status: 500 });
  }
}
