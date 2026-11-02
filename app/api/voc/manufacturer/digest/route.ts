import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getFeatureModel, effortParams, readText } from "@/app/lib/ai-model";
import { maskPii, answerBody } from "@/app/lib/report-voice";
import { buildVocMonthlyFacts, audienceOf, categoriesFor, type VocMonthlyFacts, type VocAudience } from "@/app/lib/voc-monthly-facts";

export const dynamic = "force-dynamic";
// 데이터가 많은 달은 AI 생성이 60초를 넘겨 플랫폼이 함수를 끊었다(클라이언트엔 JSON 아닌
//  "An error occurred…" 텍스트가 내려가 파싱 오류로 보임) → 여유 있게 연장(120s 선례: sales/export).
export const maxDuration = 300; // 큰 달 + 생각 — AI 요청 270초 상한(2026-09-29, 5.x 전환)

const MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_CLAIMS = 300;
const MAX_SURVEYS = 200;
const MAX_INQUIRIES = 200; // 스마트스토어 고객문의·상품문의(137) — 한 달치, 질문 500자·답변 300자 상한
const NAVER = "스마트스토어";  // channel_inquiries.channel — report-voice.ts 와 같은 값

// 제조사 공유용 '고객 반응' 완성 리포트(2026-11-02 업그레이드 — 기획안 docs/voc-monthly-report-plan.md).
//  숫자는 전부 facts(코드 집계: 판매·배송 대비 VOC율·어종·채널·유형·귀책·문의)에서만 인용하고, AI 는 뜻을 묶어 쓴다.
//  섹션·헤딩은 고정 — 화면 렌더러가 헤딩 뒤에 차트를 끼우고, Word 변환기가 같은 구조를 서식화한다.
//  손해 청구(마지막 절)는 코드가 붙인다(화면 claimText). 2026-11-02 대표: 스마트스토어 고객문의·상품문의(137)도 '3. 고객 문의'에 반영,
//  글은 나열이 아니라 종합 리포트처럼 해석 문장으로(사실 → 원인 확인됨/추정 → 제조사가 볼 점), 어종은 VOC 가 있는 것만.
function buildSystem(y: string, m: string, audience: VocAudience): string {
  const mfg = audience === "제조사";
  const intro = mfg
    ? `당신은 씨몬스터(냉동 수산물 가공·판매)에서 매월 제조사(파도소리)에 제출하는 '고객 반응' 리포트를 작성합니다. 제조사가 그대로 읽을 완성본입니다(초안 아님).
이 리포트는 제조·품질·포장에 관한 이야기만 다룹니다. facts 와 claims 는 이미 품질·가시·이물·포장 유형으로만 집계돼 있습니다. 배송 지연·누락·오배송·결제·쿠폰·주문 처리·채널 운영 같은 씨몬스터 쪽 일은 쓰지 않습니다(문의·설문에 섞여 있어도 뺍니다).`
    : `당신은 씨몬스터(냉동 수산물 가공·판매) 내부용 '월간 VOC 분석' 리포트를 작성합니다. 대표와 담당자가 운영 전체를 한눈에 보는 완성본입니다.
제조 품질뿐 아니라 배송·누락·오배송(물류), 채널별 차이, 귀책(제조사/물류/자사/고객)별 손해, 문의 응대 속도(미답변·답변 시간), 첫구매·재구매 비중까지 종합합니다.`;
  return `${intro}
입력 JSON: facts(코드가 계산한 숫자 — ${y}년 ${m}월 VOC 건수·판매 수량·배송 건수·VOC율·6개월 추이·어종별·채널별·유형별·귀책별·스마트스토어 문의·전월·전년 같은 달),
claims(업무도우미에 접수된 클레임·문의 원문), inquiries(스마트스토어 고객문의·상품문의의 질문·답변), surveys(설문 응답).

[숫자 규칙 — 가장 중요]
- 모든 수치는 facts 에 있는 값만 그대로 씁니다. 목록(claims·inquiries·surveys)을 직접 세어 건수를 만들지 않습니다(세다 틀립니다). facts 에 없는 숫자는 쓰지 않습니다.
- VOC율은 "판매 1,000개당 N건"(rate_qty) 또는 "택배 1,000건당 N건"(rate_parcel)으로 적습니다. null 이면 율을 언급하지 않고 건수만 씁니다.
- 비교는 facts.summary.prev(전월)·yoy(전년 같은 달)·by_species/by_channel 의 prev_rate·trend 만 근거로 합니다. 없으면 "비교 자료 없음".
- facts.notes 에 적힌 제외·폴백 사유(미매칭 N건, 원장 없음 등)는 '1. 이번 달 종합' 끝에 "- 집계 참고 : …" 한 줄로 그대로 밝힙니다.

[글 규칙 — 종합 리포트와 같은 결: 나열이 아니라 해석]
- 1·2절은 문장으로 씁니다(단락 2~5문장). "무엇이 달라졌는지(사실) → 왜 그런지(원문에 근거가 있으면 '확인됨', 없으면 '추정') → 그래서 제조사가 보면 좋은 점" 흐름으로, 읽는 사람이 한 번에 판단할 수 있게 씁니다.
- 어종별·채널별·유형별 수치 전체는 시스템이 표와 차트로 붙입니다. 글에서는 값을 줄줄이 나열하지 말고, 율이 가장 높은 곳·전월보다 오른 곳·눈에 띄는 변화 1~3개만 숫자와 함께 짚습니다. 한 문장에 숫자는 두 개까지.
- 어종 이름은 facts.by_species.name 그대로(삼치·참돔·달고기 …). by_species 는 이번 달 VOC 가 있는 어종만 들어 있습니다 — 없는 어종을 '0건'이라고 쓰지 않습니다.
- 3·4절은 사례를 뜻으로 묶은 불릿 "- 라벨 : 한두 문장"(라벨 = 어종·제품·유형, 콜론 필수 — 화면·Word 가 라벨을 굵게 표시). 같은 사례는 한 번만. claims 와 inquiries 는 같은 기준: 품질·이물·가시·포장·해동·배송 상태 같은 문제 제기는 '가. 클레임', 원물·가공·보관·조리법 같은 질문은 '나. 그 외 문의'. 문의에 답변이 있으면 끝에 "(답변: 요지)".
- 설문은 긍정과 개선·부정으로 나누고, 개선·부정은 공통 → 제품별 순.
- 5절은 이번 달 facts·원문에 근거해 ${mfg ? "제조사가 할 행동만 최대 5개(어떤 어종·공정·포장을 어떻게)" : "담당자가 확인·조치할 것만 최대 5개(누가 무엇을 — 물류·채널·응대·제조사 전달 포함)"}. 없으면 "- 해당 없음". 내용이 없는 절은 "- 해당 없음" 한 줄.
- 존댓말 평서문('~했습니다'), 이모지 없음, 분석 과정·표현 설명은 쓰지 않고 결론만. 고객 이름·아이디·연락처·주문번호는 옮겨 쓰지 않습니다.
${mfg
    ? "- 제조사용이므로 문의는 원물·가공·보관·조리·품질에 관한 것만, 설문은 제품(맛·식감·가시·포장·양)에 관한 의견만 고릅니다. 배송·주문·쿠폰·채널 이야기는 쓰지 않습니다."
    : "- 내부용이므로 유형 전체를 다루고, 귀책(facts.by_fault)과 채널(facts.by_channel), 문의 응대(facts.inquiries 의 미답변·avg_answer_h), 첫/재구매(facts.buyer)를 함께 해석합니다."}

[출력 형식] — 아래 골격의 '순수 텍스트'만(코드블록·머리말·해설 금지). 헤딩 글자·번호를 바꾸지 않습니다.
${mfg ? `${y}년 ${m}월 고객 반응` : `${y}년 ${m}월 VOC 분석 (내부용)`}

한 줄 요약
(1~2문장: 이번 달 VOC율이 판매 대비 어땠고, 가장 중요한 변화 한 가지)

1. 이번 달 종합
(단락: 전월·작년 같은 달 대비 VOC율·건수·${mfg ? "제조사 귀책 손해액" : "손해액(귀책별)"}의 변화와 그 뜻. 끝에 facts.notes 가 있으면 "집계 참고: …" 한 문장으로 그대로)

2. 판매 대비 VOC 분석
가. 어종별
(단락: 율이 가장 높은 어종과 오른 어종, 주요 유형, 원인 — 확인됨/추정)
${mfg
    ? `나. 유형별 흐름
(단락: 이번 달 많은 유형, 전월 대비 늘어난 유형, 6개월 흐름에서 눈에 띄는 점)`
    : `나. 채널별
(단락: 율이 높은 채널과 그 이유. 도매(facts.wholesale)가 있으면 한 문장 추가)
다. 유형·귀책별 흐름
(단락: 이번 달 많은 유형과 귀책, 전월 대비 늘어난 유형, 6개월 흐름에서 눈에 띄는 점)`}

3. 고객 문의
가. 클레임
- (어종·제품 : 묶은 사례 한두 문장)
나. 그 외 문의
- (주제 : 질문 요지 (답변: 요지))${mfg ? "" : `
다. 응대
- (응대 : 미답변·답변 시간·반복 문의 — facts.inquiries 값으로 한두 문장)`}

4. 고객 설문
가. 긍정의견
- (주제 : 한두 문장)
나. 개선·부정의견
- 공통 : (공통 개선의견)
- (제품명) : (그 제품 개선의견)

5. ${mfg ? "제조사 요청 사항" : "내부 확인할 것"}
- (행동 : 무엇을 어떻게 — 근거 수치)`;
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ ok: false, error: "AI 키(ANTHROPIC_API_KEY)가 설정되어 있지 않습니다." }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as { month?: string; audience?: string };
    const month = body.month && MONTH_RE.test(body.month) ? body.month : "";
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const audience = audienceOf(body.audience); // 제조사(품질·가시·이물·포장만) / 내부(전체)
    const scopeCats = categoriesFor(audience);
    const [y, m] = month.split("-");
    const mNum = String(Number(m)); // 표시는 앞 0 제거(예: 06 → 6월)
    const from = `${month}-01`;
    const to = new Date(Number(y), Number(m), 0).toISOString().slice(0, 10);
    const sb = supabaseAdmin();

    // 0) 숫자 — 코드 집계(159, 용도별 범위). 원문과 병렬로 읽는다.
    const factsP = buildVocMonthlyFacts(sb, month, { categories: scopeCats });

    // 1) 이달 클레임/문의 원문 (설문 소스 제외)
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
    const claims = (vocData ?? []).filter((r) => !scopeCats || scopeCats.includes((r.category || "").trim())).map((r) => ({
      product: r.product || "", type: r.category,
      content: cut(maskPii(String(r.content || "")), 600),
      cause: r.cause ? cut(maskPii(String(r.cause)), 240) : undefined,
    }));

    // 1-2) 이달 스마트스토어 고객문의·상품문의(137 channel_inquiries) — 문의 등록 시각(KST)이 그 달인 것.
    //  개인정보: 이름·아이디는 137 에 없고, 질문·답변 본문은 maskPii 로 연락처·이메일·긴 번호를 가린다. 137 미적용이면 조용히 생략(counts.inquiries = null).
    const mStart = `${month}-01T00:00:00+09:00`;
    const nextD = new Date(Number(y), Number(m), 1);
    const mEnd = `${nextD.getFullYear()}-${String(nextD.getMonth() + 1).padStart(2, "0")}-01T00:00:00+09:00`;
    const inqRes = await sb.from("channel_inquiries")
      .select("kind, product_name, category, title, question, answer, answered, asked_at")
      .eq("channel", NAVER).gte("asked_at", mStart).lt("asked_at", mEnd)
      .order("asked_at", { ascending: true }).limit(MAX_INQUIRIES);
    const inqMissing = !!inqRes.error && /channel_inquiries|42P01|PGRST205/i.test(`${inqRes.error.message} ${inqRes.error.code}`);
    if (inqRes.error && !inqMissing) throw inqRes.error;
    const tidy = (v: string | null | undefined, n: number) => { const t = maskPii(String(v || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim()); return t ? cut(t, n) : undefined; };
    const kstMd = (iso: string | null) => (iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(5, 10) : "");
    const inquiries = (inqRes.data ?? []).map((r) => ({
      kind: r.kind, date: kstMd(r.asked_at), product: tidy(r.product_name, 60), category: tidy(r.category, 30), title: tidy(r.title, 80),
      question: tidy(r.question, 500) || "(본문 없음)", answer: r.answered ? tidy(answerBody(r.answer), 300) : undefined, answered: !!r.answered,
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
        return { text: maskPii((text || String(r.summary || "")).slice(0, 400)) };
      })
      .filter((s) => s.text.trim());

    const facts: VocMonthlyFacts = await factsP;

    if (claims.length === 0 && surveys.length === 0 && inquiries.length === 0) {
      return NextResponse.json({ ok: false, error: `${y}년 ${m}월에 집계할 클레임·문의·설문이 없습니다.`, counts: { claims: 0, surveys: 0, inquiries: inqMissing ? null : 0 } }, { status: 400 });
    }

    const model = await getFeatureModel("voc"); // 기본 Fable 5.1(2026-10-19) — 대표 결정 5: 가장 정확한 모델·effort high
    // SDK 는 핸들러 안에서 생성 — 모듈 초기화에서 만들면 키 미설정 시 import 자체가 죽어
    //  위의 친절한 400 응답 대신 플랫폼 오류 텍스트가 내려간다.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // AI 에 주는 facts 는 화면용 전부가 아니라 글에 필요한 것만(토큰) — 추이는 월·건수·율만, 어종·채널은 표 그대로.
    const factsForAi = {
      month: facts.month, sales_as_of: facts.sales_as_of, notes: facts.notes, summary: facts.summary,
      trend: facts.trend.map((t) => ({ ym: t.ym, voc: t.voc, rate_qty: t.rate_qty })),
      by_category: facts.by_category, by_category_trend: facts.by_category_trend, by_fault: facts.by_fault,
      by_species: facts.by_species.map((s) => ({ name: s.name, voc: s.voc, mfg: s.mfg, loss: s.loss, sold_qty: s.sold_qty, rate: s.rate, prev_rate: s.prev_rate, top_category: s.top_category })),
      by_channel: facts.by_channel, wholesale: facts.wholesale, buyer: facts.buyer,
      inquiries: facts.inquiries, unmatched: facts.unmatched,
    };
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 16000, // 데이터 많은 달에 4000 으로는 출력이 문장 중간에서 끊겼다 — 5.x 는 생각 토큰도 이 한도에 들어간다
      ...effortParams(model, "high"),
      system: buildSystem(y, mNum, audience),
      messages: [{ role: "user", content: JSON.stringify({ facts: factsForAi, claims, inquiries, surveys }) }],
    }, { timeout: 270_000, maxRetries: 0 }); // 라우트 maxDuration 300 안(집계 시간 포함)
    let draft = readText(resp, { allowTruncated: true }); // 잘려도 보여 주고 아래에서 표시한다(거절은 오류)
    draft = draft.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
    // 그래도 출력 한도에 걸려 끊겼으면 문서에 조용히 남기지 말고 표시 — 편집 칸에서 보고 지우거나 다시 생성
    if (resp.stop_reason === "max_tokens") {
      draft += "\n\n(주의: 내용이 길어 뒷부분이 잘렸습니다 — '다시 생성'을 누르거나, 이 문단을 지우고 직접 보완하세요)";
    }

    return NextResponse.json({ ok: true, draft, facts, audience, counts: { claims: claims.length, surveys: surveys.length, inquiries: inqMissing ? null : inquiries.length } });
  } catch (err) {
    console.error("[voc/manufacturer/digest]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "리포트 생성 실패") }, { status: 500 });
  }
}
