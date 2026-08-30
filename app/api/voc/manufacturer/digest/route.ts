import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getFeatureModel } from "@/app/lib/ai-model";

export const dynamic = "force-dynamic";
// 데이터가 많은 달은 AI 생성이 60초를 넘겨 플랫폼이 함수를 끊었다(클라이언트엔 JSON 아닌
//  "An error occurred…" 텍스트가 내려가 파싱 오류로 보임) → 여유 있게 연장(120s 선례: sales/export).
export const maxDuration = 120;

const MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_CLAIMS = 300;
const MAX_SURVEYS = 200;

// 제조사 공유용 '고객 반응' 서술형 초안 — 실제 양식(고객 문의·설문 / 긍정·부정 / 공통·제품별)에 맞춤.
function buildSystem(y: string, m: string): string {
  return `당신은 씨몬스터(냉동 수산물 가공·판매)에서 매월 제조사에 보낼 '고객 반응' 자료를 작성합니다.
아래 JSON은 ${y}년 ${m}월 한 달간 접수된 고객 클레임/문의(claims)와 설문 응답(surveys)입니다.
이를 제조사가 보기 좋게 정성적으로 요약한 문서를 작성하세요.

[작성 규칙]
- 한국어. 데이터에 있는 내용만(추측·과장·창작 금지). 비슷한 의견은 묶고, 제품이 특정되면 제품별로 분류.
- 불릿은 명사형/간결체("~함", "~발견", "~요청"). 건수가 의미 있으면 "(N건)"처럼 덧붙여도 됨.
- 제품이 특정되지 않은 공통 의견은 '공통'으로, 특정 제품 의견은 그 제품명으로 묶음.
- 클레임(품질·이물·가시·포장·해동 등 문제 제기)과 단순 문의(질문: 검사 여부·원물 크기·가공 방식 등)를 구분.
- 모든 불릿은 "- 라벨 : 내용" 형태로 시작한다. 라벨 = 분류(가시/이물·포장·해동 등) 또는 제품명, 콜론(:) 필수. 화면·Word 가 라벨을 굵게 표시하므로 형태가 어긋나면 서식이 빠진다. (단 '1. 이번 달 종합' 섹션은 서술형 불릿 허용)
- '1. 이번 달 종합'의 비교는 입력의 prevSummary(전월 집계)만 근거로 한다. 전월 데이터가 없으면 "- 전월 데이터 없음" 한 줄. '앞으로의 요구'는 이번 달 데이터에 근거해 제조사에 요청할 개선·확인 사항만 적고, 없으면 "- 해당 없음".
- 설문은 긍정의견과 개선/부정의견으로 나누고, 개선/부정은 공통 → 제품별 순.
- 내용이 없는 섹션은 "- 해당 없음" 한 줄.

[출력 형식] — 아래 골격의 '순수 텍스트'만 반환(코드블록·머리말·해설 금지). 제목 포함:
${y}년 ${m}월 고객 반응

1. 이번 달 종합
가. 지난달과의 비교
- (prevSummary 와 이번 달 데이터를 대조한 증감·변화 불릿, 건수·유형 중심 1~3개)
나. 이번 달 특이사항
- (새로 나타났거나 특정 제품·유형에 몰린 이슈. 없으면 "- 특이사항 없음")
다. 이번 달 주요 정리
- (이번 달 전체를 2~4개 불릿으로 요약)
라. 앞으로의 요구
- (제조사에 요청할 개선·확인 사항. 없으면 "- 해당 없음")

2. 고객 문의
가. 클레임
- (제품 공통 또는 제품별 클레임 불릿)
나. 그 외 문의
- (단순 문의 불릿)

3. 고객 설문조사
가. 긍정의견
- (불릿)
나. 개선/부정의견
- 공통
  (공통 개선의견 불릿; 들여쓰기 없이 '- '로 시작해도 됨)
- (제품명) : (그 제품 개선의견)`;
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ ok: false, error: "AI 키(ANTHROPIC_API_KEY)가 설정되어 있지 않습니다." }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as { month?: string };
    const month = body.month && MONTH_RE.test(body.month) ? body.month : "";
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const [y, m] = month.split("-");
    const mNum = String(Number(m)); // 표시는 앞 0 제거(예: 06 → 6월)
    const from = `${month}-01`;
    const to = new Date(Number(y), Number(m), 0).toISOString().slice(0, 10);
    const sb = supabaseAdmin();

    // 1) 이달 클레임/문의 (설문 소스 제외)
    const { data: vocData, error: vocErr } = await sb
      .from("voc")
      .select("received_at, product, category, content, cause, customer_note")
      .neq("source", "설문")
      .gte("received_at", from).lte("received_at", to)
      .order("received_at", { ascending: true })
      .limit(MAX_CLAIMS);
    if (vocErr) throw vocErr;
    // 아주 긴 내용만 자르되, 잘렸다는 표식을 남긴다 — 표식이 없으면 AI가 끊긴 문장을 그대로 인용한다.
    const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …(이하 생략)" : s);
    const claims = (vocData ?? []).map((r) => ({
      product: r.product || "", type: r.category,
      content: cut(String(r.content || ""), 600),
      cause: r.cause ? cut(String(r.cause), 240) : undefined,
    }));

    // 2) 이달 설문 응답 (submitted_at 또는 created_at 기준)
    const { data: srData } = await sb
      .from("survey_responses")
      .select("submitted_at, created_at, summary, answers")
      .limit(1000);
    const surveys = (srData ?? [])
      .filter((r) => String((r.submitted_at as string) || (r.created_at as string) || "").slice(0, 7) === month)
      .slice(0, MAX_SURVEYS)
      .map((r) => {
        const ans = Array.isArray(r.answers) ? (r.answers as { label?: string; value?: string }[]) : [];
        const text = ans.map((a) => `${a.label ? a.label + ": " : ""}${a.value ?? ""}`).filter(Boolean).join(" / ");
        return { text: (text || String(r.summary || "")).slice(0, 400) };
      })
      .filter((s) => s.text.trim());

    // 0) 전월 집계 — '1. 이번 달 종합'의 비교 근거(원문은 보내지 않고 건수·유형 분포만)
    const prevD = new Date(Number(y), Number(m) - 2, 1);
    const prevMonth = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, "0")}`;
    const { data: prevVoc } = await sb
      .from("voc").select("category")
      .neq("source", "설문")
      .gte("received_at", `${prevMonth}-01`)
      .lte("received_at", new Date(prevD.getFullYear(), prevD.getMonth() + 1, 0).toISOString().slice(0, 10))
      .limit(2000);
    const prevCat = new Map<string, number>();
    for (const r of prevVoc ?? []) prevCat.set(r.category || "미분류", (prevCat.get(r.category || "미분류") || 0) + 1);
    const prevSurveyCnt = (srData ?? []).filter((r) => String((r.submitted_at as string) || (r.created_at as string) || "").slice(0, 7) === prevMonth).length;
    const catTop = [...prevCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} ${n}건`).join(" · ");
    const prevSummary = (prevVoc?.length || prevSurveyCnt)
      ? `전월(${Number(prevMonth.slice(5, 7))}월): 클레임·문의 ${prevVoc?.length ?? 0}건${catTop ? ` (${catTop})` : ""} · 설문 ${prevSurveyCnt}건`
      : "전월 데이터 없음";

    if (claims.length === 0 && surveys.length === 0) {
      return NextResponse.json({ ok: false, error: `${y}년 ${m}월에 집계할 클레임·설문이 없습니다.`, counts: { claims: 0, surveys: 0 } }, { status: 400 });
    }

    const model = await getFeatureModel("voc");
    // SDK 는 핸들러 안에서 생성 — 모듈 초기화에서 만들면 키 미설정 시 import 자체가 죽어
    //  위의 친절한 400 응답 대신 플랫폼 오류 텍스트가 내려간다.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 8000, // 데이터 많은 달에 4000 으로는 출력이 문장 중간에서 끊겼다
      system: buildSystem(y, mNum),
      messages: [{ role: "user", content: JSON.stringify({ prevSummary, claims, surveys }) }],
    });
    let draft = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    draft = draft.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
    // 그래도 출력 한도에 걸려 끊겼으면 문서에 조용히 남기지 말고 표시 — 편집 칸에서 보고 지우거나 다시 생성
    if (resp.stop_reason === "max_tokens") {
      draft += "\n\n(주의: 내용이 길어 뒷부분이 잘렸습니다 — '다시 생성'을 누르거나, 이 문단을 지우고 직접 보완하세요)";
    }

    return NextResponse.json({ ok: true, draft, counts: { claims: claims.length, surveys: surveys.length } });
  } catch (err) {
    console.error("[voc/manufacturer/digest]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "초안 생성 실패") }, { status: 500 });
  }
}
