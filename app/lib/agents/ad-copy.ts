// 광고 카피 에이전트 — 서버 전용. 매주 메타 광고 신규 소재 목록을 낸다(2026-11-11 대표 정의).
//  하는 일: ① 공식몰 리뷰·스마트스토어 문의·VOC 에서 고객의 말을 뽑고 ② 타깃의 최근 경향을 웹에서 조사하고
//   ③ 메타 광고 성과(효율 좋았던 것·해 보지 않은 것)와 담당자가 올린 타사 레퍼런스를 보고 ④ 신규 소재를 목록으로 낸다.
//  네 단계로 나눠 돈다(staged.ts — 단계마다 함수 호출이 따로): voice → trend → plan → write.
//   앞 두 단계는 조사 요약(facts.notes)만 남긴다. plan 이 광고 성과·레퍼런스까지 보고 어떤 소재를 낼지 정하고(notes.plan),
//   write 가 소재를 4건씩 나눠 동시에 문구를 쓴다. 피드백을 받으면 plan 부터 다시 돈다(조사 요약은 그대로).
//   ※ v1 은 plan 과 write 가 한 번의 AI 호출이었는데, 첫 실행(2026-11-11)에서 210초 안에 못 끝나 시간 초과로 실패했다 — 그래서 v2 에서 갈랐다.
//  개인정보: 고객 글은 가린 뒤(maskPii) AI 에만 보내고, 저장되는 요약에는 이름·연락처·주문 정보를 옮기지 않게 지침으로 막는다.
//  이 에이전트는 읽기만 한다 — 광고를 켜거나 끄지 않고, 메타에 아무것도 쓰지 않는다.
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getFeatureModel, effortParams } from "../ai-model";
import { anthropic, addUsage, kstTodayLabel, retryable, strictRejected, type AskUsage } from "../assistant";
import { collectVoiceFacts, voiceForAi, maskPii } from "../report-voice";
import { getInsights, isMetaAdConfigured, metaGet, type MetaInsight } from "../meta-ad";
import { getSavedCreatives } from "../meta-creatives";
import { getKv, setKv } from "../b2b-settings";
import { kstTodayIso } from "../production-schedule";
import type { AdIdea, AgentToolLog } from "./registry";
import { StageError, type StageCtx, type StageResult, type StagedRunner, type StageUsage } from "./staged";

export const AD_COPY = "ad-copy";
const BRIEF_KEY = "agent_brief:ad-copy";
export const getAdBrief = (): Promise<string> => getKv(BRIEF_KEY);
export const setAdBrief = (v: string): Promise<void> => setKv(BRIEF_KEY, v.slice(0, 4000));

const shift = (ymd: string, days: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const cut = (s: unknown, max: number) => { const t = String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };
const missingTable = (e: unknown, name: string) => {
  const m = String((e as { message?: string } | null)?.message ?? e ?? ""), code = (e as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205" || (m.includes(name) && /does not exist|schema cache|could not find/i.test(m));
};

// ── AI 호출 한 묶음 — 도구 차례(웹 검색 일시 멈춤 포함)를 돌려 글 또는 제출 도구의 입력을 받는다 ──
const SEARCH_USD = 0.01; // 웹 검색 1회($10 / 1,000회)
type Meter = { model: string; usage: AskUsage; rounds: number; searches: number; startedAt: number };
const meterOut = (m: Meter): { model: string; usage: StageUsage; est_usd: number } => ({
  model: m.model,
  usage: { input: m.usage.input + m.usage.cacheRead + m.usage.cacheWrite, output: m.usage.output, rounds: m.rounds, tool_calls: m.searches, elapsed_ms: Date.now() - m.startedAt },
  est_usd: Math.round((m.usage.estUsd + m.searches * SEARCH_USD) * 10000) / 10000,
});
const fail = (m: Meter, msg: string) => new StageError(msg, meterOut(m));

async function converse<T>(m: Meter, p: {
  system: string; content: Anthropic.ContentBlockParam[]; effort: "low" | "medium" | "high"; maxTokens: number; deadlineAt: number;
  submit?: { tool: (strict: boolean) => Anthropic.Tool; check: (input: unknown) => T | null };
  webSearch?: number;                    // 웹 검색 최대 횟수(없으면 검색 도구를 주지 않는다)
}): Promise<{ text: string; submitted: T | null }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: p.content }];
  let strict = true, retried = false, nudged = 0;
  for (let turn = 0; turn < 12; turn++) {
    const left = p.deadlineAt - Date.now();
    if (left < 25_000) throw fail(m, "작성 시간이 부족해 이 단계를 끝내지 못했습니다. [업무 요청]을 다시 누르세요.");
    const tools: Anthropic.ToolUnion[] = [
      ...(p.webSearch ? [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: p.webSearch, user_location: { type: "approximate" as const, country: "KR", timezone: "Asia/Seoul" } }] : []),
      ...(p.submit ? [p.submit.tool(strict)] : []),
    ];
    let res: Anthropic.Message;
    try {
      res = await anthropic.messages.create({
        model: m.model, max_tokens: p.maxTokens, system: p.system, messages,
        ...(tools.length ? { tools, tool_choice: { type: "auto" as const } } : {}),
        ...effortParams(m.model, p.effort),
      }, { timeout: Math.min(210_000, left - 10_000), maxRetries: 0 });
    } catch (e) {
      if (strict && p.submit && strictRejected(e)) { strict = false; continue; }
      if (!retried && retryable(e) && p.deadlineAt - Date.now() > 90_000) { retried = true; await new Promise((r) => setTimeout(r, 3000)); continue; }
      throw fail(m, e instanceof Error ? `AI 호출 실패: ${e.message}` : "AI 호출 실패");
    }
    m.rounds++;
    addUsage(m.usage, m.model, res.usage);
    m.searches += res.usage.server_tool_use?.web_search_requests || 0;
    if (res.stop_reason === "refusal") throw fail(m, "AI 안전 필터가 응답을 거절했습니다. 자료나 덧붙인 말을 바꿔 다시 시도하세요.");
    if (res.stop_reason === "max_tokens") throw fail(m, "AI 결과가 길어 중간에 잘렸습니다. [업무 요청]을 다시 누르세요.");
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "pause_turn") continue;        // 서버 도구(웹 검색)가 길어져 멈춘 것 — 그대로 다시 보내면 이어서 한다

    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
    if (!p.submit) return { text, submitted: null };
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      if (++nudged > 2) throw fail(m, "에이전트가 결과를 제출하지 않았습니다. [업무 요청]을 다시 누르세요.");
      messages.push({ role: "user", content: "결과는 제출 도구로 내야 합니다. 지금까지 정리한 내용으로 제출 도구를 호출하세요." });
      continue;
    }
    let got: T | null = null;
    const results: Anthropic.ToolResultBlockParam[] = uses.map((u) => {
      const ok = got == null ? p.submit!.check(u.input) : null;
      if (ok != null) { got = ok; return { type: "tool_result" as const, tool_use_id: u.id, content: "제출되었습니다." }; }
      return { type: "tool_result" as const, tool_use_id: u.id, content: "오류: 필요한 항목이 빠졌거나 형식이 다릅니다. 모든 항목을 채워 다시 제출하세요.", is_error: true };
    });
    if (got != null) return { text, submitted: got };
    messages.push({ role: "user", content: results });
  }
  throw fail(m, "에이전트가 결과를 내지 못했습니다. [업무 요청]을 다시 누르세요.");
}
const newMeter = async (): Promise<Meter> => ({
  model: await getFeatureModel("agent"), rounds: 0, searches: 0, startedAt: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estUsd: 0, estNote: "" },
});

const COMPANY = "씨몬스터는 냉동 순살 생선(가시를 발라낸 생선)을 공식몰·스마트스토어·쿠팡에서 파는 브랜드입니다.";

// ── 1단계: 고객 목소리 ──
type ReviewRow = { product_name: string | null; rating: number | null; title: string | null; content: string | null; written_at: string | null };
const REVIEW_DAYS = 90, REVIEW_MAX = 120, REVIEW_BUDGET = 26_000;
async function loadReviews(sb: SupabaseClient, today: string): Promise<{ ok: boolean; note?: string; total: number; items: { d: string; product: string; star: number | null; text: string }[] }> {
  const { data, error } = await sb.from("shop_reviews").select("product_name, rating, title, content, written_at")
    .gte("written_at", `${shift(today, -REVIEW_DAYS)}T00:00:00+09:00`).order("written_at", { ascending: false }).limit(600);
  if (error) return { ok: false, total: 0, items: [], note: missingTable(error, "shop_reviews") ? "공식몰 리뷰 수집 전(166 미적용)" : `공식몰 리뷰 조회 실패: ${String(error.message).slice(0, 120)}` };
  const rows = ((data ?? []) as ReviewRow[]).filter((r) => (r.content || "").replace(/\s+/g, "").length >= 12); // '좋아요' 같은 한마디는 재료가 못 된다
  if (!rows.length) return { ok: false, total: 0, items: [], note: `최근 ${REVIEW_DAYS}일 공식몰 리뷰가 없습니다(수집 전일 수 있음)` };
  // 낮은 별점(불만·장벽)을 먼저 챙기고 나머지는 최신순 — 글자 총량 안에서
  const low = rows.filter((r) => r.rating != null && r.rating <= 3).slice(0, 30);
  const rest = rows.filter((r) => !low.includes(r));
  const items: { d: string; product: string; star: number | null; text: string }[] = [];
  let used = 0;
  for (const r of [...low, ...rest]) {
    if (items.length >= REVIEW_MAX) break;
    const text = maskPii(cut([r.title, r.content].filter(Boolean).join(" — "), 320));
    if (used + text.length > REVIEW_BUDGET) break;
    used += text.length;
    items.push({ d: (r.written_at || "").slice(5, 10), product: cut(r.product_name, 40), star: r.rating, text });
  }
  return { ok: true, total: rows.length, items };
}

const VOICE_SYSTEM = `당신은 ${COMPANY.replace("입니다.", "의 광고 카피 담당 에이전트입니다.")}
지금은 세 단계 중 첫 단계입니다. 고객이 남긴 글(공식몰 리뷰, 스마트스토어 문의, 접수된 VOC)을 읽고, 광고 소재를 쓸 때 쓸 수 있는 재료만 뽑아 정리합니다. 이 정리는 뒤 단계의 당신이 읽습니다.

[정리할 것]
## 사는 이유
- 고객이 실제로 말한 구매 이유와 만족한 점. 많이 나온 순서로, 각 항목에 대략 몇 건에서 나왔는지 적습니다.
## 고객이 쓰는 말
- 광고 문장에 그대로 살릴 만한 표현 조각(15자 안쪽). 누가 썼는지는 적지 않습니다.
## 쓰는 장면
- 누가, 언제, 어떻게 먹는지(예: 아이 반찬, 혼자 먹는 저녁). 글에 나온 것만 적습니다.
## 망설이는 이유
- 사기 전 걱정, 불만, 자주 묻는 것. 광고가 먼저 답해 주면 좋은 것 위주로.
## 타깃 단서
- 글에서 드러나는 고객의 모습(가족 구성, 생활 방식). 근거가 약하면 약하다고 적습니다.
## 자료 한계
- 자료가 적거나 빠진 부분(예: 리뷰 수집 전). 없으면 이 제목을 뺍니다.

[지킬 것]
- 받은 글에 있는 내용만 씁니다. 짐작으로 채우지 않습니다.
- 사람 이름, 연락처, 주소, 주문 정보는 옮겨 적지 않습니다.
- '##' 제목과 '-' 목록만 씁니다. 전체 1,500자 안쪽으로 씁니다.`;

async function stageVoice(c: StageCtx): Promise<StageResult> {
  const today = kstTodayIso();
  const m = await newMeter();
  const [voice, reviews] = await Promise.all([
    collectVoiceFacts(c.sb, { since: shift(today, -27), until: today }, { since: shift(today, -55), until: shift(today, -28) }),
    loadReviews(c.sb, today),
  ]);
  const warnings = [reviews.ok ? "" : reviews.note || "", voice.naver.ok ? "" : `스마트스토어 문의: ${voice.naver.note || "집계 없음"}`, voice.voc.ok ? "" : `VOC: ${voice.voc.note || "집계 없음"}`].filter(Boolean);
  const counts = { reviews: reviews.items.length, inquiries: voice.naver.items?.length || 0, voc: voice.voc.items?.length || 0 };
  if (!counts.reviews && !counts.inquiries && !counts.voc) {
    // 읽을 글이 하나도 없으면 AI 를 부르지 않는다
    return { ...meterOut(m), counts, warnings, note: { key: "voice", text: "## 자료 한계\n- 읽을 고객 글이 없습니다(리뷰·문의·VOC 모두 비어 있음)." } };
  }
  const { text } = await converse(m, {
    system: VOICE_SYSTEM, effort: "medium", maxTokens: 12000, deadlineAt: c.deadlineAt,
    content: [{ type: "text", text: `기준일 ${kstTodayLabel()}\n\n[공식몰 리뷰 — 최근 ${REVIEW_DAYS}일 ${reviews.total}건 중 ${reviews.items.length}건]\n${reviews.ok ? JSON.stringify(reviews.items) : reviews.note}\n\n[스마트스토어 문의·VOC — 최근 4주]\n${JSON.stringify(voiceForAi(voice))}` }],
  });
  if (!text) throw fail(m, "고객 목소리 정리가 비어 있습니다. [업무 요청]을 다시 누르세요.");
  return { ...meterOut(m), counts, warnings, note: { key: "voice", text: text.slice(0, 5000) } };
}

// ── 2단계: 타깃 트렌드(웹 조사) ──
const TREND_SEARCHES = 8;
const TREND_SYSTEM = `당신은 ${COMPANY.replace("입니다.", "의 광고 카피 담당 에이전트입니다.")}
지금은 세 단계 중 둘째 단계입니다. 우리 타깃이 요즘 무엇에 반응하는지를 웹에서 조사해 정리합니다. 이 정리는 뒤 단계의 당신이 광고 소재를 쓸 때 읽습니다.

[조사할 것]
- 타깃의 최근 식생활·장보기·육아·건강 관심사(최근 1~3개월). 타깃은 [타깃 메모]와 [고객 목소리]의 타깃 단서를 따릅니다.
- 앞으로 4주 안에 오는 시기 요인(절기, 명절, 방학, 날씨, 행사).
- 식품·간편식·수산물 광고와 SNS 콘텐츠에서 요즘 먹히는 형식과 말투.
- 수산물·냉동식품에 대한 최근 소비자 인식(걱정거리 포함).

[조사 방법]
- web_search 를 최대 ${TREND_SEARCHES}번 씁니다. 한국어로, 최근 자료가 나오게 검색합니다.
- 날짜가 오래됐거나 출처가 불분명한 내용은 버립니다. 확인하지 못한 것은 추측으로 채우지 않습니다.
- 조사가 끝나면 submit_trend 를 한 번 호출합니다. 글로만 답하고 끝내지 않습니다.

[제출 형식 — notes]
## 지금 타깃이 반응하는 것
- (경향 한 줄 + 광고에 어떻게 쓸 수 있는지 한 줄)
## 다가오는 시기
- (날짜와 함께)
## 먹히는 형식과 말투
- (형식·구성·표현)
## 조심할 것
- (피해야 할 표현, 부정적 인식. 없으면 이 제목을 뺍니다)
'##' 제목과 '-' 목록만 쓰고, 전체 1,500자 안쪽으로 씁니다. 항목마다 근거가 된 출처를 sources 에 넣습니다.`;

type TrendSubmit = { notes: string; sources: { title: string; url: string }[] };
const trendTool = (strict: boolean): Anthropic.Tool => ({
  name: "submit_trend", ...(strict ? { strict: true } : {}),
  description: "타깃 트렌드 조사 결과를 제출합니다. 조사가 끝나면 정확히 한 번 호출합니다.",
  input_schema: {
    type: "object", additionalProperties: false, required: ["notes", "sources"],
    properties: {
      notes: { type: "string", description: "조사 정리(마크다운 — ## 제목, - 목록)" },
      sources: { type: "array", description: "근거로 쓴 출처", items: { type: "object", additionalProperties: false, required: ["title", "url"], properties: { title: { type: "string" }, url: { type: "string" } } } },
    },
  },
});
const checkTrend = (input: unknown): TrendSubmit | null => {
  const s = input as Partial<TrendSubmit> | null;
  return s && typeof s.notes === "string" && s.notes.trim() && Array.isArray(s.sources) ? (s as TrendSubmit) : null;
};

async function stageTrend(c: StageCtx): Promise<StageResult> {
  const m = await newMeter();
  const brief = await getAdBrief();
  const { submitted } = await converse<TrendSubmit>(m, {
    system: TREND_SYSTEM, effort: "medium", maxTokens: 12000, deadlineAt: c.deadlineAt, webSearch: TREND_SEARCHES,
    submit: { tool: trendTool, check: checkTrend },
    content: [{ type: "text", text: `기준일 ${kstTodayLabel()}\n\n[타깃 메모 — 담당자가 적은 것]\n${brief || "없음(고객 목소리의 타깃 단서로 판단)"}\n\n[고객 목소리 — 첫 단계 정리]\n${c.notes.voice || "없음"}\n\n[덧붙인 말]\n${c.report.instruction || "없음"}` }],
  });
  const s = submitted as TrendSubmit;
  const sources = s.sources.filter((x) => /^https?:\/\//.test(String(x?.url || ""))).slice(0, 12).map((x) => `- ${cut(x.title, 80)} ${String(x.url).slice(0, 300)}`);
  const tool_log: AgentToolLog[] = m.searches ? [{ name: "web_search", title: `웹 검색 ${m.searches}회`, ok: true }] : [];
  return {
    ...meterOut(m), counts: { searches: m.searches }, tool_log,
    warnings: m.searches ? [] : ["웹 검색을 하지 못해 트렌드 조사가 일반 지식에 기댔습니다."],
    note: { key: "trend", text: `${s.notes.trim().slice(0, 5000)}${sources.length ? `\n## 출처\n${sources.join("\n")}` : ""}` },
  };
}

// ── 3단계 자료: 메타 광고 성과 ──
const AD_DAYS = 90, AD_MAX = 60;
type CreativeNode = {
  name?: string; effective_status?: string; created_time?: string;
  creative?: {
    title?: string; body?: string;
    object_story_spec?: { link_data?: { message?: string; name?: string; child_attachments?: unknown[] }; video_data?: { message?: string; title?: string } };
    asset_feed_spec?: { bodies?: { text?: string }[]; titles?: { text?: string }[]; videos?: unknown[] };
  };
};
type AdRow = { 광고: string; 상태: string; 시작: string; 형식: string; 제목: string; 본문: string; 광고비: number; 구매: number; ROAS: number; 클릭률: number; 구매당비용: number };
async function loadAdHistory(today: string): Promise<{ ok: boolean; note?: string; rows: AdRow[]; avgRoas: number; totalAds: number }> {
  if (!isMetaAdConfigured()) return { ok: false, note: "메타 광고 연결 전", rows: [], avgRoas: 0, totalAds: 0 };
  const { byId } = await getInsights("ad", { since: shift(today, -AD_DAYS), until: today }, false, true);
  const ranked = Object.entries(byId).filter(([, v]) => v.spend > 0).sort((a, b) => b[1].spend - a[1].spend);
  if (!ranked.length) return { ok: false, note: `최근 ${AD_DAYS}일 집행한 광고가 없습니다`, rows: [], avgRoas: 0, totalAds: 0 };
  const top = ranked.slice(0, AD_MAX);
  const nodes: Record<string, CreativeNode> = {};
  for (let i = 0; i < top.length; i += 20) {   // 여러 id 를 한 번에(행마다 소재 명세가 커서 20개씩)
    const part = await metaGet<Record<string, CreativeNode>>("/", {
      ids: top.slice(i, i + 20).map(([id]) => id).join(","),
      fields: "name,effective_status,created_time,creative{title,body,object_story_spec,asset_feed_spec}",
    });
    Object.assign(nodes, part);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rows = top.map(([id, v]: [string, MetaInsight]): AdRow => {
    const n = nodes[id] || {}, cr = n.creative || {}, oss = cr.object_story_spec || {}, afs = cr.asset_feed_spec || {};
    const body = cr.body || oss.link_data?.message || oss.video_data?.message || (afs.bodies || []).slice(0, 2).map((b) => b.text).filter(Boolean).join(" / ");
    const title = cr.title || oss.link_data?.name || oss.video_data?.title || (afs.titles || []).slice(0, 2).map((t) => t.text).filter(Boolean).join(" / ");
    const format = oss.video_data || afs.videos?.length ? "영상" : oss.link_data?.child_attachments?.length ? "캐러셀" : "이미지";
    const links = v.linkClicks ?? v.clicks;
    return {
      광고: cut(n.name || id, 80), 상태: n.effective_status === "ACTIVE" ? "게재 중" : "꺼짐", 시작: (n.created_time || "").slice(0, 10), 형식: format,
      제목: cut(title, 80), 본문: cut(body, 350), 광고비: Math.round(v.spend), 구매: Math.round(v.purchases), ROAS: r2(v.roas),
      클릭률: v.impressions ? r2((links / v.impressions) * 100) : 0, 구매당비용: Math.round(v.cpa),
    };
  });
  const spend = ranked.reduce((s, [, v]) => s + v.spend, 0), value = ranked.reduce((s, [, v]) => s + v.purchaseValue, 0);
  return { ok: true, rows, avgRoas: spend ? r2(value / spend) : 0, totalAds: ranked.length };
}

// ── 3단계 자료: 타사 레퍼런스(담당자가 올린 것) ──
export type AdReference = { id: string; brand: string; channel: string | null; url: string | null; copy_text: string | null; note: string | null; images: string[]; created_by: string | null; created_at: string };
const REF_MAX = 40, REF_IMAGES = 8;
export async function listReferences(sb: SupabaseClient, limit = 200): Promise<AdReference[]> {
  const { data, error } = await sb.from("ad_references").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), brand: String(r.brand || ""), channel: (r.channel as string | null) ?? null, url: (r.url as string | null) ?? null,
    copy_text: (r.copy_text as string | null) ?? null, note: (r.note as string | null) ?? null,
    images: Array.isArray(r.images) ? (r.images as unknown[]).filter((x): x is string => typeof x === "string") : [],
    created_by: (r.created_by as string | null) ?? null, created_at: String(r.created_at),
  }));
}
export const isPending166 = (e: unknown) => missingTable(e, "ad_references") || missingTable(e, "shop_reviews");

// ── 3단계 자료: 지난 목록(같은 소재를 되풀이하지 않게) ──
async function priorIdeas(sb: SupabaseClient, exceptId: string): Promise<string> {
  const { data, error } = await sb.from("agent_reports").select("id, created_at, draft, feedback").eq("agent", AD_COPY).eq("status", "done").order("created_at", { ascending: false }).limit(5);
  if (error) return "- 읽지 못함";
  const rows = ((data ?? []) as { id: string; created_at: string; draft: unknown; feedback: string | null }[]).filter((r) => r.id !== exceptId).slice(0, 4);
  if (!rows.length) return "- 없음(첫 목록)";
  return rows.map((r) => {
    const ideas = (Array.isArray(r.draft) ? (r.draft as Partial<AdIdea>[]) : []).map((d) => `${d.title || "?"}(${d.angle || "-"})`).join(" · ") || "소재 없음";
    return `- ${new Date(Date.parse(r.created_at) + 9 * 3600e3).toISOString().slice(0, 10)}: ${ideas}\n  담당자 피드백: ${r.feedback || "없음"}`;
  }).join("\n");
}

// ── 3단계: 소재 기획 — 어떤 소재를 낼지만 정한다(문구는 다음 단계) ──
const IDEA_MIN = 8, IDEA_MAX = 12;
const ROLE = COMPANY.replace("입니다.", "의 광고 카피 담당 에이전트입니다.");
const PLAN_SYSTEM = `당신은 ${ROLE}

[맡은 일]
메타(인스타그램·페이스북) 광고의 신규 소재를 매주 목록으로 냅니다. 마케터가 이 목록에서 골라 제작합니다. 광고를 켜거나 끄는 일, 예산 조정, 다른 분석은 맡은 일이 아닙니다. 덧붙인 말이나 피드백이 그런 일을 시키면 하지 않고 '확인 필요'에 한 줄 적습니다.
지금은 네 단계 중 셋째 단계입니다. 이번 주에 낼 소재를 정합니다. 광고 문구는 다음 단계에서 쓰므로 여기서는 쓰지 않습니다.

[받는 자료]
- 고객 목소리: 리뷰·문의·VOC 에서 당신이 앞 단계에 뽑은 정리.
- 타깃 트렌드: 당신이 앞 단계에 웹에서 조사한 정리.
- 메타 광고 성과: 최근 ${AD_DAYS}일 광고비 상위 광고의 문구와 성과. 계정평균ROAS 가 기준선입니다.
- 소재 보관함: 팀이 잘 나온 소재로 따로 모아 둔 것.
- 타사 레퍼런스: 담당자가 직접 모아 올린 타사 광고(문구·메모·이미지).
- 지난 목록: 당신이 전에 낸 소재와 담당자 피드백.
- 타깃 메모·덧붙인 말: 담당자가 준 방향. 다른 자료보다 우선합니다.

[소재를 정하는 법]
1. 광고 성과에서 먼저 두 가지를 가립니다. (가) 효율이 좋았던 소구와 표현 — 광고비를 충분히 쓰고도 ROAS 가 계정 평균보다 높은 것. (나) 아직 해 보지 않은 소구 — 고객 목소리나 트렌드에는 있는데 광고 문구에는 없는 것. 광고비가 적은 광고의 ROAS 는 우연일 수 있으니 근거로 삼지 않습니다.
2. 목록은 '새 시도'와 '변주'를 섞습니다. 새 시도 = (나)에서 나온 소재. 변주 = (가)를 형식·후킹·대상만 바꾼 소재. 새 시도가 절반을 넘게 합니다.
3. 고객 목소리에 없는 효능·수치·후기를 근거로 삼지 않습니다.
4. 타사 레퍼런스는 구조와 접근만 참고합니다. 타사 이름이나 문구를 소재에 쓰지 않습니다.
5. 지난 목록에 있던 소재를 이름만 바꿔 다시 내지 않습니다. 담당자 피드백이 있으면 그 방향을 미리 반영합니다.
6. 소재는 ${IDEA_MIN}~${IDEA_MAX}건, 먼저 만들 만한 순서로 냅니다. 자료가 부족하면 건수를 줄이고 이유를 적습니다.

[피드백을 받았을 때]
담당자 피드백과 당신이 냈던 목록(번호 포함)을 함께 받습니다. 피드백이 말한 것은 그대로 반영합니다. 피드백이 말하지 않은 소재는 바꾸지 않고 keep_no 에 그 소재의 번호를 적습니다(문구까지 그대로 남습니다). 문구만 고치라는 피드백이면 keep_no 를 0 으로 하고 angle 에 무엇을 고칠지 적습니다.

[제출 — submit_plan 을 정확히 한 번 호출합니다. 글로만 답하고 끝내지 않습니다]
- summary: 한 문장. 이번 주 목록의 방향.
- ideas: 소재 배열. 항목마다
  · title 소재 이름(15자 안쪽) · kind '새 시도' 또는 '변주' · angle 소구점 한 줄 · target 누구에게 한 줄 · format '이미지'·'영상'·'캐러셀'
  · basis 근거 한두 문장(어느 고객 목소리·트렌드·광고 성과·레퍼런스에서 나왔는지, 숫자가 있으면 숫자와 함께)
  · keep_no 피드백 반영 때 그대로 둘 지난 소재의 번호. 새로 쓰거나 고칠 소재, 그리고 피드백이 없을 때는 0.
- body_md: 아래 틀. '##' 제목, '-' 목록, '**굵게**' 만 씁니다.

## 광고 성과에서 본 것
- (효율이 좋았던 소구, 효율이 나빴던 소구, 아직 해 보지 않은 소구)
## 이번 주 방향
- (목록을 이렇게 짠 이유)
## 확인 필요
- (사람이 확인할 것. 없으면 이 제목을 뺍니다)`;

type PlanItem = { title: string; kind: AdIdea["kind"]; angle: string; target: string; format: AdIdea["format"]; basis: string; keep_no: number };
type Plan = { summary: string; body_md: string; ideas: PlanItem[] };
const str = { type: "string" as const };
const planTool = (strict: boolean): Anthropic.Tool => ({
  name: "submit_plan", ...(strict ? { strict: true } : {}),
  description: "이번 주에 낼 소재 기획과 보고서를 제출합니다. 정확히 한 번 호출합니다.",
  input_schema: {
    type: "object", additionalProperties: false, required: ["summary", "ideas", "body_md"],
    properties: {
      summary: { type: "string", description: "한 문장 요약" },
      ideas: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["title", "kind", "angle", "target", "format", "basis", "keep_no"],
          properties: {
            title: str, kind: { type: "string", enum: ["새 시도", "변주"] }, angle: str, target: str,
            format: { type: "string", enum: ["이미지", "영상", "캐러셀"] }, basis: str,
            keep_no: { type: "integer", description: "그대로 둘 지난 소재의 번호. 새로 쓰거나 고칠 소재는 0" },
          },
        },
      },
      body_md: { type: "string", description: "보고서 본문(마크다운 — ## 제목, - 목록, **굵게** 만)" },
    },
  },
});
const checkPlan = (input: unknown): Plan | null => {
  const s = input as Partial<Plan> | null;
  return s && typeof s.summary === "string" && Array.isArray(s.ideas) && typeof s.body_md === "string" ? (s as Plan) : null;
};
const FORMATS = ["이미지", "영상", "캐러셀"];
const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

async function stagePlan(c: StageCtx): Promise<StageResult> {
  const today = kstTodayIso();
  const m = await newMeter();
  const warnings: string[] = [];
  const [ads, refs, saved, prior, brief] = await Promise.all([
    loadAdHistory(today).catch((e) => ({ ok: false as const, note: `메타 광고 성과 조회 실패: ${String((e as Error)?.message || e).slice(0, 140)}`, rows: [] as AdRow[], avgRoas: 0, totalAds: 0 })),
    listReferences(c.sb, REF_MAX).catch((e) => { warnings.push(missingTable(e, "ad_references") ? "타사 레퍼런스 표가 없습니다(166 미적용)." : "타사 레퍼런스를 읽지 못했습니다."); return [] as AdReference[]; }),
    getSavedCreatives().catch(() => []),
    priorIdeas(c.sb, c.report.id),
    getAdBrief(),
  ]);
  if (!ads.ok) warnings.push(`${ads.note} — 광고 성과 없이 작성했습니다.`);
  if (!refs.length && !warnings.some((w) => w.includes("레퍼런스"))) warnings.push("올라온 타사 레퍼런스가 없습니다.");

  const refText = refs.map((r, i) => ({ 번호: i + 1, 브랜드: r.brand, 채널: r.channel, 문구: cut(r.copy_text, 600) || null, 메모: cut(r.note, 300) || null, 이미지: r.images.length, 올린날: r.created_at.slice(0, 10) }));
  // 이미지는 최근 레퍼런스부터 8장까지 — 공개 주소 그대로 보낸다
  const images: { n: number; url: string }[] = [];
  refs.forEach((r, i) => { for (const url of r.images) if (images.length < REF_IMAGES && /^https:\/\//.test(url)) images.push({ n: i + 1, url }); });
  const prev = c.revise?.ideas || [];
  const revised = c.revise
    ? `[담당자 피드백]\n${c.revise.feedback}\n\n[당신이 낸 목록]\n${JSON.stringify(prev.map((d, i) => ({ 번호: i + 1, ...d })))}\n\n`
    : "";
  const content: Anthropic.ContentBlockParam[] = [
    ...images.flatMap(({ n, url }): Anthropic.ContentBlockParam[] => [{ type: "text", text: `타사 레퍼런스 ${n}번 이미지` }, { type: "image", source: { type: "url", url } }]),
    {
      type: "text",
      text: [
        c.revise ? "담당자 피드백을 반영한 소재 기획 전체를 submit_plan 으로 제출하세요." : "이번 주에 낼 소재를 정해 submit_plan 으로 제출하세요.",
        `기준일 ${kstTodayLabel()}`,
        `${revised}[타깃 메모]\n${brief || "없음"}`,
        `[덧붙인 말]\n${c.report.instruction || "없음"}`,
        `[고객 목소리]\n${c.notes.voice || "없음"}`,
        `[타깃 트렌드]\n${c.notes.trend || "없음"}`,
        `[메타 광고 성과 — 최근 ${AD_DAYS}일, 집행 광고 ${ads.totalAds}개 중 광고비 상위 ${ads.rows.length}개, 계정평균ROAS ${ads.avgRoas}]\n${ads.ok ? JSON.stringify(ads.rows) : ads.note}`,
        `[소재 보관함]\n${saved.length ? JSON.stringify(saved.slice(0, 20).map((x) => ({ 이름: x.name, 형식: x.format, 후킹: cut(x.hook, 150), 스토리: cut(x.story, 200), 제안: cut(x.offer, 150), ROAS: x.roas ?? null }))) : "없음"}`,
        `[타사 레퍼런스 — 담당자가 올린 ${refs.length}건]\n${refs.length ? JSON.stringify(refText) : "없음"}`,
        `[지난 목록 — 최신순]\n${prior}`,
      ].join("\n\n"),
    },
  ];
  // 생각(thinking)도 max_tokens 에 들어간다 — medium·8000 은 생각만으로 한도를 채워 잘렸다(2026-11-11 v2 첫 실행, 119초).
  //  low 로 생각을 줄이고 한도는 넉넉히. 초당 약 65토큰이라 호출 제한 210초 안에 쓸 수 있는 양은 13,000토큰 안팎이다.
  const { submitted } = await converse<Plan>(m, {
    system: PLAN_SYSTEM, effort: "low", maxTokens: 16000, deadlineAt: c.deadlineAt,
    submit: { tool: planTool, check: checkPlan }, content,
  });
  const s = submitted as Plan;
  const seen = new Set<string>();
  const ideas: PlanItem[] = [];
  for (const it of s.ideas) {
    const title = cut(it?.title, 60);
    if (!title || seen.has(title) || ideas.length >= 15) continue;
    seen.add(title);
    const keep = Number(it.keep_no);
    ideas.push({
      title, kind: it.kind === "변주" ? "변주" : "새 시도", angle: clip(it.angle, 300), target: clip(it.target, 200),
      format: FORMATS.includes(it.format) ? it.format : "이미지", basis: clip(it.basis, 600),
      keep_no: Number.isInteger(keep) && keep >= 1 && keep <= prev.length ? keep : 0,
    });
  }
  const plan: Plan = { summary: s.summary.trim().slice(0, 300), body_md: s.body_md.trim().slice(0, 12000), ideas };
  if (!ideas.length && !plan.body_md) throw fail(m, "AI 가 빈 기획을 돌려주었습니다. [업무 요청]을 다시 누르세요.");
  return { ...meterOut(m), counts: { ads: ads.rows.length, references: refs.length }, warnings, note: { key: "plan", text: JSON.stringify(plan) } };
}

// ── 4단계: 카피 작성 — 기획한 소재를 4건씩 나눠 동시에 쓴다(한 번에 다 쓰면 한 호출이 210초를 넘긴다) ──
const WRITE_CHUNK = 4;
const WRITE_SYSTEM = `당신은 ${ROLE}
지금은 마지막 단계입니다. 앞 단계에서 정한 소재마다 메타(인스타그램·페이스북) 광고 문구를 씁니다. 소재의 이름·소구점·대상·형식은 정해진 그대로 따릅니다.

[쓰는 법]
1. 모든 소재는 후킹, 스토리, 제안 세 가지를 갖춥니다. 후킹은 첫 문장이나 영상 첫 1~3초, 스토리는 문제에서 공감을 거쳐 해결로 가는 전개, 제안은 혜택과 행동 유도입니다.
2. 고객이 실제로 쓴 말(고객 목소리)을 살립니다. 고객 목소리에 없는 효능·수치·후기를 지어내지 않습니다.
3. 식품 광고에서 문제가 되는 표현은 쓰지 않습니다: 질병 예방·치료 효과, 근거 없는 최상급('최고', '1위'), 확인되지 않은 원산지·인증·할인 조건. 가격·할인·증정은 받은 자료에 있는 것만 쓰고, 없으면 제안을 일반적인 행동 유도로 씁니다.
4. 타사 이름이나 타사 문구를 쓰지 않습니다.
5. 소재끼리 첫 문장과 말투가 겹치지 않게 씁니다.

[제출 — submit_copies 를 정확히 한 번 호출합니다. 글로만 답하고 끝내지 않습니다]
받은 소재마다 한 항목씩, no 는 받은 번호 그대로.
- hook 후킹 한두 문장 · story 스토리 두세 문장 · offer 제안 한 문장
- primary_text 광고 본문(바로 붙여 넣을 수 있게, 줄바꿈 포함 300자 안쪽) · headline 제목(25자 안쪽)
- visual 비주얼·촬영 안내 한두 문장`;

type Copy = { no: number; hook: string; story: string; offer: string; primary_text: string; headline: string; visual: string };
const copiesTool = (strict: boolean): Anthropic.Tool => ({
  name: "submit_copies", ...(strict ? { strict: true } : {}),
  description: "소재별 광고 문구를 제출합니다. 정확히 한 번 호출합니다.",
  input_schema: {
    type: "object", additionalProperties: false, required: ["copies"],
    properties: {
      copies: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["no", "hook", "story", "offer", "primary_text", "headline", "visual"],
          properties: { no: { type: "integer", description: "받은 소재 번호 그대로" }, hook: str, story: str, offer: str, primary_text: str, headline: str, visual: str },
        },
      },
    },
  },
});
const checkCopies = (input: unknown): Copy[] | null => {
  const s = input as { copies?: Copy[] } | null;
  return s && Array.isArray(s.copies) && s.copies.length ? s.copies : null;
};

async function stageWrite(c: StageCtx): Promise<StageResult> {
  const m = await newMeter();
  let plan: Plan;
  try { plan = JSON.parse(c.notes.plan || "") as Plan; } catch { throw fail(m, "소재 기획을 읽지 못했습니다. [업무 요청]을 다시 누르세요."); }
  const prev = c.revise?.ideas || [];
  const todo = plan.ideas.map((it, i) => ({ no: i + 1, it })).filter(({ it }) => !(it.keep_no && prev[it.keep_no - 1]));
  const brief = await getAdBrief();
  const shared = `[타깃 메모]\n${brief || "없음"}\n\n[덧붙인 말]\n${c.report.instruction || "없음"}\n\n${c.revise ? `[담당자 피드백]\n${c.revise.feedback}\n\n` : ""}[고객 목소리]\n${c.notes.voice || "없음"}\n\n[타깃 트렌드]\n${(c.notes.trend || "없음").split("\n## 출처")[0]}`;
  const chunks: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += WRITE_CHUNK) chunks.push(todo.slice(i, i + WRITE_CHUNK));
  const others = (chunk: typeof todo) => plan.ideas.map((it, i) => ({ no: i + 1, title: it.title })).filter((x) => !chunk.some((y) => y.no === x.no)).map((x) => `${x.no} ${x.title}`).join(" · ");
  // 묶음마다 따로 부른다 — 한 묶음이 실패해도 나머지 문구는 살린다(실패한 소재는 문구 없이 목록에 남고 경고가 붙는다)
  const results = await Promise.allSettled(chunks.map((chunk) => converse<Copy[]>(m, {
    system: WRITE_SYSTEM, effort: "low", maxTokens: 12000, deadlineAt: c.deadlineAt,
    submit: { tool: copiesTool, check: checkCopies },
    content: [{ type: "text", text: `아래 소재 ${chunk.length}건의 광고 문구를 써서 submit_copies 로 제출하세요.\n\n[쓸 소재]\n${JSON.stringify(chunk.map(({ no, it }) => ({ no, 이름: it.title, 구분: it.kind, 소구점: it.angle, 대상: it.target, 형식: it.format, 근거: it.basis })))}\n\n[같은 목록의 다른 소재 — 겹치지 않게 참고만]\n${others(chunk) || "없음"}\n\n${shared}` }],
  })));
  const byNo = new Map<number, Copy>();
  let failed = "";
  results.forEach((r) => {
    if (r.status === "fulfilled") for (const cp of r.value.submitted || []) byNo.set(Number(cp.no), cp);
    else failed = r.reason instanceof Error ? r.reason.message : "AI 호출 실패";
  });
  if (todo.length && !byNo.size) throw fail(m, failed || "문구를 하나도 쓰지 못했습니다. [업무 요청]을 다시 누르세요.");

  const warnings: string[] = [];
  const missing: number[] = [];
  const draft: AdIdea[] = plan.ideas.map((it, i) => {
    const kept = it.keep_no ? prev[it.keep_no - 1] : undefined;
    if (kept) return kept;                                  // 피드백이 말하지 않은 소재 — 문구까지 그대로
    const cp = byNo.get(i + 1);
    if (!cp) missing.push(i + 1);
    return {
      title: it.title, kind: it.kind, angle: it.angle, target: it.target, format: it.format, basis: it.basis,
      hook: clip(cp?.hook, 400), story: clip(cp?.story, 800), offer: clip(cp?.offer, 400),
      primary_text: clip(cp?.primary_text, 1200), headline: clip(cp?.headline, 120), visual: clip(cp?.visual, 500),
    };
  });
  if (missing.length) warnings.push(`${missing.join("·")}번 소재는 문구를 쓰지 못했습니다${failed ? `(${failed.slice(0, 80)})` : ""}. 피드백으로 다시 요청하세요.`);
  return { ...meterOut(m), warnings, final: { summary: plan.summary, body_md: plan.body_md, draft } };
}

// v1(2026-11-11) = voice → trend → compose(기획+문구 한 번에). 첫 실행에서 compose 가 시간 초과로 실패해 종료 — 실행기는 남기지 않는다.
export const AD_COPY_V2: StagedRunner = { stages: [stageVoice, stageTrend, stagePlan, stageWrite], reviseFrom: 2 };
