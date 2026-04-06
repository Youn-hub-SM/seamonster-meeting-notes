import { NextResponse } from "next/server";
import { correctText } from "@/app/lib/correct";

export async function POST(request: Request) {
  try {
    const { rawText } = await request.json();

    if (!rawText || typeof rawText !== "string" || rawText.trim().length < 5) {
      return NextResponse.json(
        { error: "교정할 문장을 5자 이상 입력해주세요." },
        { status: 400 }
      );
    }

    const result = await correctText(rawText.trim());
    return NextResponse.json(result);
  } catch (error) {
    console.error("Correct error:", error);
    return NextResponse.json(
      { error: "문장 교정 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
