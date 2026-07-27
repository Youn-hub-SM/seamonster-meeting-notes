import { NextResponse } from "next/server";
import { captureSlices, HtmlshotOptions } from "@/app/lib/htmlshot";

// 헤드리스 크롬 + 이미지 업로드 — 서버리스 최대 시간을 넉넉히
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const html = typeof body.html === "string" ? body.html : "";
    if (html.trim().length < 50) {
      return NextResponse.json({ error: "변환할 HTML 을 붙여넣어주세요." }, { status: 400 });
    }
    if (html.length > 800_000) {
      return NextResponse.json({ error: "HTML 이 너무 큽니다 (800KB 초과)." }, { status: 400 });
    }

    const opts: HtmlshotOptions = {
      html,
      width: clampInt(body.width, 300, 1600, 780),
      maxSliceHeight: clampInt(body.maxSliceHeight, 1000, 20000, 8000),
      format: body.format === "png" ? "png" : "jpeg",
      quality: clampInt(body.quality, 40, 100, 88),
      scale: body.scale === 2 ? 2 : 1,
      baseUrl: typeof body.baseUrl === "string" && /^https?:\/\//.test(body.baseUrl)
        ? body.baseUrl.replace(/\/+$/, "")
        : "https://seamonster.kr",
      expand: body.expand !== false,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    };

    const result = await captureSlices(opts);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("htmlshot render error:", error);
    const msg = error instanceof Error ? error.message : "이미지 변환 중 오류가 발생했습니다.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? Math.round(v) : parseInt(String(v), 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
