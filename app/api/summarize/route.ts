import { NextResponse } from "next/server";
import { summarizeMeeting } from "@/app/lib/claude";
import { saveMeeting } from "@/app/lib/meetings";
import { Meeting } from "@/app/lib/types";

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

    const slug = result.title
      .replace(/[^\w가-힣\s]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 30);
    const suffix = Math.random().toString(36).slice(2, 6);
    const id = `${result.date}_${slug}-${suffix}`;

    const meeting: Meeting = {
      id,
      title: result.title,
      date: result.date,
      createdAt: new Date().toISOString(),
      timelineSummary: result.timelineSummary,
      decisions: result.decisions,
      todos: result.todos,
      rawText: rawText.trim(),
    };

    await saveMeeting(meeting);

    return NextResponse.json(meeting);
  } catch (error) {
    console.error("Summarize error:", error);
    return NextResponse.json(
      { error: "회의록 정리 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
