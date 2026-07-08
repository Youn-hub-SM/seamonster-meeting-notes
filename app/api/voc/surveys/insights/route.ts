import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getFeatureModel } from "@/app/lib/ai-model";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_ROWS = 300;

const SYSTEM = `당신은 씨몬스터(냉동 수산물·이유식/화식용 생선) 설문 응답 분석가입니다.
아래는 고객 설문 응답 목록(JSON, 각 응답은 질문:답변 배열)입니다. 불만 클레임이 아니라 만족도·사용후기 성격입니다.

규칙:
- 한국어 존댓말. 데이터에 근거. 추측·과장 금지. 응답이 적으면 적은 대로 신중히.
- highlights: 반복되는 만족 요인·구매 이유·활용 방식 최대 6개(빈도 느낌 포함).
- improvements: 아쉬운 점·개선 요청에서 추려낸 실행 가능한 개선점 최대 5개.
- quotes: 마케팅·리뷰에 쓸 만한 인상적인 실제 응답 인용 최대 4개(원문 그대로 짧게).
- sentiment: 전반 감성 한 줄(긍정/중립/부정 비중 느낌).

순수 JSON만 반환(코드블록·설명 금지):
{"summary":"전체 요약 2~3문장","sentiment":"한 줄","highlights":[{"point":"","detail":"한 줄"}],"improvements":[{"point":"","detail":"한 줄"}],"quotes":["..."]}`;

export async function POST() {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ ok: false, error: "AI 키(ANTHROPIC_API_KEY)가 설정되어 있지 않습니다." }, { status: 400 });
    }
    const { data, error } = await supabaseAdmin()
      .from("survey_responses")
      .select("answers, submitted_at")
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .limit(MAX_ROWS);
    if (error) throw error;
    const rows = data ?? [];
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "분석할 설문 응답이 없습니다." }, { status: 400 });

    const payload = rows.map((r) => (Array.isArray(r.answers) ? (r.answers as { label: string; value: string }[]).map((a) => `${a.label}: ${a.value}`) : []));

    const model = await getFeatureModel("voc");
    const response = await anthropic.messages.create({
      model,
      max_tokens: 5000,
      system: SYSTEM,
      messages: [{ role: "user", content: `총 ${rows.length}건의 설문 응답:\n${JSON.stringify(payload)}` }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const stripped = text.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim();
    const s = stripped.indexOf("{"), e = stripped.lastIndexOf("}");
    const candidate = s >= 0 && e > s ? stripped.slice(s, e + 1) : stripped;
    let insight;
    try { insight = JSON.parse(candidate); }
    catch { insight = { summary: stripped.slice(0, 800), sentiment: "", highlights: [], improvements: [], quotes: [] }; }

    return NextResponse.json({ ok: true, insight, analyzed: rows.length });
  } catch (err) {
    console.error("[voc/surveys/insights]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "분석 실패") }, { status: 500 });
  }
}
