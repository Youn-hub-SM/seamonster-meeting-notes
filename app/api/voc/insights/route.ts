import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getCurrentModel } from "@/app/lib/ai-model";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_ROWS = 250; // 토큰 보호: 최근 N건만 분석

const SYSTEM = `당신은 씨몬스터(냉동 수산물 가공·판매)의 VOC(고객 클레임) 분석가입니다.
아래는 접수된 클레임 목록(JSON)입니다. 데이터에 근거해 "무엇이 반복되고, 왜 생기며, 무엇을 바꿔야 하는지"를 도출하세요.

규칙:
- 한국어 존댓말. 간결하고 행동가능하게. 추측·미사여구 금지. 데이터에 없는 건 지어내지 말 것.
- patterns: 실제로 반복되는 불만 유형을 빈도순 최대 6개. count 는 해당 패턴에 속하는 대략 건수(정수).
- rootCauses: 패턴들의 공통 근본 원인 최대 5개(포장·배송·품질관리·가시제거·표기 등 구체적으로).
- improvements: 재발을 줄일 구체적 개선책 최대 6개. effort(난이도: 낮음|중간|높음)와 impact(기대효과 한 줄) 포함.
- riskAlerts: 손해금액이 크거나 반복 심한, 즉시 대응이 필요한 항목 최대 3개(없으면 빈 배열).

순수 JSON만 반환(코드블록·설명 금지):
{"summary":"전체 진단 2~3문장","patterns":[{"title":"","count":0,"detail":"한 줄"}],"rootCauses":[{"cause":"","detail":"한 줄"}],"improvements":[{"action":"","effort":"낮음|중간|높음","impact":"한 줄"}],"riskAlerts":["한 줄"]}`;

export async function POST() {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ ok: false, error: "AI 키(ANTHROPIC_API_KEY)가 설정되어 있지 않습니다." }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin()
      .from("voc")
      .select("received_at, channel, source, product, purchase_place, category, content, cause, resolution, status, loss_amount")
      .order("received_at", { ascending: false })
      .limit(MAX_ROWS);
    if (error) throw error;

    const rows = data ?? [];
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "분석할 VOC가 없습니다. 먼저 클레임을 등록하세요." }, { status: 400 });
    }

    // 토큰 절약: 본문은 200자로 컷
    const payload = rows.map((r) => ({
      date: r.received_at,
      channel: r.channel,
      source: r.source,
      product: r.product,
      place: r.purchase_place,
      category: r.category,
      content: (r.content || "").slice(0, 200),
      cause: r.cause,
      status: r.status,
      loss: r.loss_amount || 0,
    }));

    const model = await getCurrentModel();
    const response = await anthropic.messages.create({
      model,
      max_tokens: 6000,
      system: SYSTEM,
      messages: [{ role: "user", content: `총 ${rows.length}건의 VOC:\n${JSON.stringify(payload)}` }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const stripped = text.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim();
    const s = stripped.indexOf("{");
    const e = stripped.lastIndexOf("}");
    const candidate = s >= 0 && e > s ? stripped.slice(s, e + 1) : stripped;

    let insight;
    try {
      insight = JSON.parse(candidate);
    } catch {
      insight = { summary: stripped.slice(0, 800), patterns: [], rootCauses: [], improvements: [], riskAlerts: ["응답 형식 파싱 실패 — 요약만 표시합니다."] };
    }

    return NextResponse.json({ ok: true, insight, analyzed: rows.length, model });
  } catch (err) {
    console.error("[voc insights]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "분석 실패") }, { status: 500 });
  }
}
