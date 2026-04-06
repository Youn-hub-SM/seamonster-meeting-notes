import { NextResponse } from "next/server";
import { summarizeMeeting } from "@/app/lib/claude";

export async function POST(request: Request) {
  try {
    const { rawText } = await request.json();

    if (!rawText || typeof rawText !== "string" || rawText.trim().length < 10) {
      return NextResponse.json(
        { error: "회의 내용을 10자 이상 입력해주세요." },
        { status: 400 }
      );
    }

    const result = await summarizeMeeting(rawText.trim());

    return NextResponse.json({
      title: result.title,
      date: result.date,
      createdAt: new Date().toISOString(),
      timelineSummary: result.timelineSummary,
      decisions: result.decisions,
      todos: result.todos,
      rawText: rawText.trim(),
    });
  } catch (error) {
    console.error("Summarize error:", error);
    return NextResponse.json(
      { error: "회의록 정리 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
