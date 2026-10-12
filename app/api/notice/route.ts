import { NextResponse } from "next/server";
import { generateNotice, NoticeInputError, type NoticeRefine } from "@/app/lib/notice";
import { AiResponseError } from "@/app/lib/ai-model";

export const maxDuration = 120; // AI 요청 55초 × 2회 안

// 인증: middleware.ts 가 /api/* 전체를 로그인 게이트 안에 둔다(공개 예외 목록에 없음) — 추가 코드 없음.
// POST /api/notice — { type, values, refine?, previous? } → { ok, text, model }
export async function POST(request: Request) {
  try {
    let body: { type?: unknown; values?: unknown; refine?: unknown; previous?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "요청 본문을 읽지 못했습니다." }, { status: 400 });
    }
    if (typeof body.type !== "string" || !body.type) {
      return NextResponse.json({ ok: false, error: "공지 유형이 필요합니다." }, { status: 400 });
    }
    if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
      return NextResponse.json({ ok: false, error: "입력 항목이 필요합니다." }, { status: 400 });
    }
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.values as Record<string, unknown>)) {
      if (typeof v === "string") values[k] = v;
    }
    const refine = typeof body.refine === "string" ? (body.refine as NoticeRefine) : null;
    const previous = typeof body.previous === "string" ? body.previous : undefined;

    const { text, model } = await generateNotice({ type: body.type, values, refine, previous });
    return NextResponse.json({ ok: true, text, model });
  } catch (error) {
    if (error instanceof NoticeInputError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    console.error("[notice POST]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof AiResponseError ? error.message : "공지 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
