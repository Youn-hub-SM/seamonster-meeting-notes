import { NextResponse } from "next/server";
import { generateCsReply } from "@/app/lib/cs";

export async function POST(request: Request) {
  try {
    const { query } = await request.json();

    if (!query || typeof query !== "string" || query.trim().length < 5) {
      return NextResponse.json(
        { error: "고객 문의 내용을 5자 이상 입력해주세요." },
        { status: 400 }
      );
    }

    const result = await generateCsReply(query.trim());
    return NextResponse.json(result);
  } catch (error) {
    console.error("CS error:", error);
    return NextResponse.json(
      { error: "답변 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
