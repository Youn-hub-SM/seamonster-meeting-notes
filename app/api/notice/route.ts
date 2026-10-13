import { NextResponse } from "next/server";
import { generateNotice, NoticeInputError, type NoticeRefine } from "@/app/lib/notice";
import { AiResponseError } from "@/app/lib/ai-model";

export const maxDuration = 120; // AI 요청 55초 × 2회 안

// 인증: middleware.ts 가 /api/* 전체를 로그인 게이트 안에 둔다(공개 예외 목록에 없음) — 추가 코드 없음.
// POST /api/notice — { channel, text, type?, extras?, refine?, previous? }
//   → { ok, type, typeLabel, fields, missing, optional, text, limit, model }
//   AI 호출 1회로 유형 판단 + 항목 추출 + 초안. type 을 주면 그 유형으로 고정, extras 는 항목에 직원이 넣은 값(본문보다 우선 — type 이 있을 때만 쓴다).
export async function POST(request: Request) {
  try {
    let body: { channel?: unknown; text?: unknown; type?: unknown; extras?: unknown; refine?: unknown; previous?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "요청 본문을 읽지 못했습니다." }, { status: 400 });
    }
    if (typeof body.channel !== "string" || !body.channel) {
      return NextResponse.json({ ok: false, error: "채널을 선택해 주세요." }, { status: 400 });
    }
    if (typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ ok: false, error: "공지할 내용을 입력해 주세요." }, { status: 400 });
    }
    const type = typeof body.type === "string" && body.type ? body.type : null;
    const extras: Record<string, string> = {};
    if (body.extras && typeof body.extras === "object" && !Array.isArray(body.extras)) {
      for (const [k, v] of Object.entries(body.extras as Record<string, unknown>)) {
        if (typeof v === "string") extras[k] = v;
      }
    }
    const refine = typeof body.refine === "string" ? (body.refine as NoticeRefine) : null;
    const previous = typeof body.previous === "string" ? body.previous : undefined;

    const r = await generateNotice({ channel: body.channel, text: body.text, type, extras, refine, previous });
    return NextResponse.json({ ok: true, ...r });
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
