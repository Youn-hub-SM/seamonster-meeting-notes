// AI 비서 — DB 밖·코드 계산 데이터 도구(2026-10-20 대표: "AI 비서의 역할과 능력을 더 키우고 싶다")
//  · ad_performance  : 메타·네이버 광고 성과를 광고 API 에서 바로(종합 리포트 collectAds 재사용 — DB 에 광고 표가 없다)
//  · ad_breakdown    : 캠페인 하나의 광고세트(메타)·광고그룹(네이버) 분해(종합 리포트 도구 재사용)
//  · stock_status    : 창고 칸별 현재고·세트 가능 수량(공용 readStockMap — SQL 로 흉내 내면 칸·세트·선점이 틀린다)
//  · listing_status  : 채널별 판매 상태·채널 재고 + 최근 상품 품절·판매중지 명령(channel_commands 는 SQL 차단 표라 이 도구로만)
//  · ga_report       : GA4 데이터 API(2026-10-22) — 세션·사용자·구매를 채널 그룹·소스/매체·캠페인·랜딩·기기·날짜로. 자격은 env(ga.ts)
//  · docs_search/docs_list/docs_read : 회사 공용 문서(SharePoint·OneDrive, 2026-10-25) — Microsoft Graph 앱 자격으로 검색·목록·본문. 읽을 곳은 설정의 ms365_sources
//  모두 읽기 전용. 광고를 끄거나 예산을 바꾸는 쓰기는 없다.
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectAds, newCache, runTool as runAnalystTool, validDate, kstDay, shift, type AdsCache, type AdsFacts } from "./analyst";
import { withTimeout } from "./assistant";
import { isGaConfigured, runGaReport, runGaFunnel, GA_DIMENSIONS, GA_METRICS, GA_MAX_DAYS, type GaDimensionKey, type GaMetricKey, type GaMatch, type GaFunnelStep } from "./ga";
import { searchDocs, listDocs, readDoc, DOC_PAGE_CHARS } from "./ms365-docs";

export const LIVE_TOOL_NAMES = ["ad_performance", "ad_breakdown", "stock_status", "listing_status", "ga_report", "ga_funnel", "docs_search", "docs_list", "docs_read"] as const;
export type LiveToolName = (typeof LIVE_TOOL_NAMES)[number];
export const isLiveTool = (n: string): n is LiveToolName => (LIVE_TOOL_NAMES as readonly string[]).includes(n);

export const ADS_TIMEOUT_MS = 80_000;       // 매체별 60초 상한(collectAds) + 여유
const NAVER_CONV_MS = 20_000;               // 네이버 구매 전환(하루 단위 리포트) — 넘으면 '미확정'
const MAX_AD_DAYS = 186;

const periodProps = {
  since: { type: "string", description: "조회 시작일 YYYY-MM-DD" },
  until: { type: "string", description: "조회 끝일 YYYY-MM-DD(오늘 이전)" },
  compare_since: { type: ["string", "null"], description: "비교 기간 시작일. null 이면 바로 앞 같은 길이 기간" },
  compare_until: { type: ["string", "null"], description: "비교 기간 끝일. null 이면 바로 앞 같은 길이 기간" },
};

export function liveToolDefs(strict: boolean): Anthropic.Tool[] {
  const s = strict ? { strict: true } : {};
  return [
    {
      name: "ad_performance", ...s,
      description: "메타 광고·네이버 검색광고의 기간 성과를 광고 API 에서 바로 조회합니다(DB 에 없는 데이터). 매체 합계와 캠페인별 지출·노출·클릭·CTR·CPC·구매·CPA·구매액·ROAS, 비교 기간 지출·ROAS. 광고비·ROAS·광고 효율 질문이나 매출 변화가 광고와 관련 있는지 볼 때 씁니다. 결과는 표 카드로 붙습니다. 최대 186일, 20~60초 걸립니다.",
      input_schema: { type: "object", additionalProperties: false, required: ["since", "until", "compare_since", "compare_until"], properties: periodProps },
    },
    {
      name: "ad_breakdown", ...s,
      description: "캠페인 하나를 메타 광고세트별 또는 네이버 광고그룹별로 나눠 기간·비교 기간 성과를 봅니다. campaign_id 는 ad_performance 결과의 id 를 씁니다(같은 기간 값으로).",
      input_schema: {
        type: "object", additionalProperties: false, required: ["platform", "campaign_id", "since", "until", "compare_since", "compare_until"],
        properties: { platform: { type: "string", enum: ["meta", "naver"] }, campaign_id: { type: "string" }, ...periodProps },
      },
    },
    {
      name: "stock_status", ...s,
      description: "SKU 하나의 창고 현재고(소매·도매·프로모션·도매 대량 칸, 오늘 뒤 선점까지 뺀 가용). 세트는 구성품으로 만들 수 있는 수. 지금 재고가 있나·재고 없음인가 질문은 SQL 대신 이 도구를 씁니다(SKU 여러 개면 함께 여러 번 호출).",
      input_schema: { type: "object", additionalProperties: false, required: ["sku"], properties: { sku: { type: "string", description: "SKU 코드" } } },
    },
    {
      name: "listing_status", ...s,
      description: "SKU 하나의 채널별 현재 판매 상태·채널 재고(매일 새벽 동기화)와 최근 14일 상품 품절·판매중지·재고 변경 명령. 판매가 갑자기 줄었을 때 상품 품절·판매중지였는지 확인합니다.",
      input_schema: { type: "object", additionalProperties: false, required: ["sku"], properties: { sku: { type: "string", description: "SKU 코드" } } },
    },
    {
      name: "ga_report", ...s,
      description: "구글 애널리틱스(GA4) 공식몰 유입·행동 데이터를 바로 조회합니다(DB 에 없음). 세션·사용자·신규·참여·장바구니·결제 시작·구매·구매액·페이지 조회·이탈률·참여율·이벤트 수·평균 세션 시간을 날짜·채널 그룹·소스/매체·캠페인·랜딩 페이지·페이지 경로·페이지 제목·이벤트·기기·신규/재방문으로 나눠 봅니다(상품명 차원은 상품 측정항목과만). filter 로 특정 페이지('/buy')·채널만 거릅니다. '어디서 들어왔나·유입은 늘었는데 왜 안 샀나·전환율·특정 페이지 이탈률' 질문에 씁니다. 세션+구매를 함께 넣으면 구매 전환율 열이 붙습니다. 페이지 사이의 이동·단계별 이탈은 ga_funnel. 결과는 표 카드로 붙습니다. 최대 400일.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["since", "until", "dimensions", "metrics", "limit", "filter", "custom_dimension"],
        properties: {
          since: { type: "string", description: "시작일 YYYY-MM-DD" },
          until: { type: "string", description: "끝일 YYYY-MM-DD(어제 이전)" },
          dimensions: { type: "array", items: { type: "string", enum: Object.keys(GA_DIMENSIONS) }, description: "나눌 기준 0~3개. 비우면 기간 합계 한 줄" },
          metrics: { type: "array", minItems: 1, items: { type: "string", enum: Object.keys(GA_METRICS) }, description: "측정항목 1개 이상" },
          limit: { type: ["integer", "null"], description: "행 수 상한(기본 200, 최대 5000)" },
          custom_dimension: { type: ["string", "null"], description: "사용자 정의 측정기준 API 이름 하나(예: customEvent:sm_label). 지침의 'GA4 — 우리 속성에 실제로 있는 것' 목록에 있는 것만. 보통 null" },
          filter: {
            type: ["object", "null"], additionalProperties: false, required: ["dimension", "match", "value"],
            description: "행을 거를 조건 하나(없으면 null). 예: 페이지 '/buy'만 → {dimension:'page_path', match:'exact', value:'/buy'}",
            properties: { dimension: { type: "string", enum: Object.keys(GA_DIMENSIONS) }, match: { type: "string", enum: ["exact", "contains", "begins_with"] }, value: { type: "string" } },
          },
        },
      },
    },
    {
      name: "ga_funnel", ...s,
      description: "GA4 유입경로 — 사용자가 단계(페이지·이벤트)를 차례로 밟았는지와 단계별 완료율·이탈률. '메인에서 /buy 로 간 사람 중 아무 행동 없이 나간 비율'처럼 페이지 사이의 이동·이탈 질문에 씁니다. 단계 2~10개, 각 단계는 page_path(페이지 경로)나 events(이벤트 이름, 여러 개면 그중 하나) 또는 둘 다. '아무 행동'은 마지막 단계를 events ['click','scroll','view_item','select_item','add_to_cart','begin_checkout','purchase','page_view'] 처럼 두고 그 앞 단계의 이탈률을 읽습니다. 결과는 표 카드로 붙습니다.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["since", "until", "steps", "breakdown"],
        properties: {
          since: { type: "string", description: "시작일 YYYY-MM-DD" },
          until: { type: "string", description: "끝일 YYYY-MM-DD(어제 이전)" },
          steps: {
            type: "array", minItems: 2, maxItems: 10,
            items: {
              type: "object", additionalProperties: false, required: ["name", "page_path", "page_match", "events"],
              properties: {
                name: { type: "string", description: "단계 이름(한국어, 예: '메인')" },
                page_path: { type: ["string", "null"], description: "페이지 경로(예: '/', '/buy'). 없으면 null" },
                page_match: { type: ["string", "null"], enum: ["exact", "contains", "begins_with", null], description: "경로 비교 방식. 보통 exact" },
                events: { type: ["array", "null"], items: { type: "string" }, description: "이벤트 이름 목록(그중 하나). 없으면 null" },
              },
            },
          },
          breakdown: { type: ["string", "null"], enum: ["device", "channel", null], description: "기기·채널 그룹별로 나눠 볼 때. 보통 null" },
        },
      },
    },
    {
      name: "docs_search", ...s,
      description: "회사 공용 문서함(Microsoft 365 SharePoint·OneDrive)에서 문서를 찾습니다 — 파일 이름과 본문(인덱싱된 것)을 함께 검색. 계약서·매뉴얼·보고서·회의 자료처럼 DB 에 없는 '문서'를 물으면 먼저 이 도구로 찾고, 결과의 ref 로 docs_read 를 불러 본문을 읽습니다. 검색어는 짧은 핵심어(문서 이름에 있을 법한 말) 1~3개. 결과는 표 카드로 붙습니다.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["query", "source", "limit"],
        properties: {
          query: { type: "string", description: "검색어(핵심어, 한국어 그대로)" },
          source: { type: ["string", "null"], description: "문서함 이름 일부(지침의 '회사 문서함' 목록). null 이면 전체" },
          limit: { type: ["integer", "null"], description: "결과 수 상한(기본 20, 최대 50)" },
        },
      },
    },
    {
      name: "docs_list", ...s,
      description: "회사 공용 문서함의 폴더 목록(파일·하위 폴더 이름, 수정일, 크기). '어떤 문서가 있나·최근에 올라온 문서'처럼 구조를 볼 때나 검색이 못 찾을 때 폴더를 따라가며 씁니다. path 는 문서함 루트 기준 경로('' 이면 루트, '보고서/2026' 처럼).",
      input_schema: {
        type: "object", additionalProperties: false, required: ["source", "path"],
        properties: {
          source: { type: ["string", "null"], description: "문서함 이름 일부. null 이면 전체(루트만)" },
          path: { type: ["string", "null"], description: "폴더 경로. null 또는 '' 이면 루트" },
        },
      },
    },
    {
      name: "docs_read", ...s,
      description: "문서 하나의 본문을 글로 읽습니다(docx·pptx·xlsx·pdf·txt·csv·md, 옛 doc·xls·ppt 는 변환). ref 는 docs_search·docs_list 결과의 ref 값 그대로. 한 번에 약 2만 4천 자이고 더 있으면 next 값이 돌아오니 offset 에 넣어 이어 읽습니다. 요약·답변에는 문서 이름과 위치를 함께 적습니다.",
      input_schema: {
        type: "object", additionalProperties: false, required: ["ref", "offset"],
        properties: {
          ref: { type: "string", description: "문서 ref(드라이브:항목)" },
          offset: { type: ["integer", "null"], description: "이어 읽을 시작 위치(글자). 처음은 null" },
        },
      },
    },
  ];
}

export function liveToolLabel(name: string, input: Record<string, unknown>): string {
  const range = `${String(input.since || "")}~${String(input.until || "")}`;
  if (name === "ad_performance") return `광고 성과(메타·네이버) ${range}`;
  if (name === "ad_breakdown") return `${input.platform === "naver" ? "네이버 광고그룹" : "메타 광고세트"} 분해 ${range}`;
  if (name === "stock_status") return `현재고: ${String(input.sku || "").slice(0, 40)}`;
  if (name === "listing_status") return `채널 판매 상태: ${String(input.sku || "").slice(0, 40)}`;
  if (name === "ga_report") {
    const dims = (Array.isArray(input.dimensions) ? input.dimensions : []).map((d) => GA_DIMENSIONS[String(d) as GaDimensionKey]?.label || String(d)).join("·");
    const f = input.filter && typeof input.filter === "object" ? (input.filter as { value?: unknown }).value : null;
    return `GA4 ${dims || "합계"}${f ? ` (${String(f).slice(0, 30)})` : ""} ${range}`;
  }
  if (name === "ga_funnel") {
    const names = (Array.isArray(input.steps) ? input.steps : []).map((st) => String((st as { name?: unknown }).name || "")).filter(Boolean).join(" → ");
    return `GA4 유입경로 ${names.slice(0, 60)} ${range}`;
  }
  if (name === "docs_search") return `문서 검색: ${String(input.query || "").slice(0, 40)}${input.source ? ` (${String(input.source).slice(0, 20)})` : ""}`;
  if (name === "docs_list") return `문서함 목록: ${[input.source, input.path].filter(Boolean).map(String).join(" / ").slice(0, 50) || "루트"}`;
  if (name === "docs_read") return `문서 읽기${Number(input.offset) > 0 ? ` (이어서 ${Number(input.offset).toLocaleString("ko-KR")}자부터)` : ""}`;
  return name;
}

// 표 카드(report_tables 에 그대로 저장) — sql 칸은 '-- ' 주석으로 SQL 이 아님을 밝힌다(화면이 저장·엑셀·SQL 버튼을 숨김)
export type LiveTable = { title: string; sql: string; columns: string[]; rows: Record<string, unknown>[] };
export type LiveState = { ads: Map<string, { cache: AdsCache; facts: Promise<{ ads: AdsFacts; aiAds: Record<string, unknown> }> }> };
export const newLiveState = (): LiveState => ({ ads: new Map() });

const AD_SQL_NOTE = "-- 광고 API 실시간 조회(SQL 아님 · 저장·엑셀·루커 불가)";
const dayCount = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3) + 1;

function periods(input: Record<string, unknown>): { cur: { since: string; until: string }; prev: { since: string; until: string } } {
  const since = String(input.since || "").trim(), until = String(input.until || "").trim();
  if (!validDate(since) || !validDate(until)) throw new Error("since·until 은 YYYY-MM-DD 여야 합니다.");
  if (since > until) throw new Error("since 가 until 보다 늦습니다.");
  const today = kstDay(0);
  if (until > today) throw new Error(`until 은 오늘(${today}) 이전이어야 합니다.`);
  const n = dayCount(since, until);
  if (n > MAX_AD_DAYS) throw new Error(`광고 조회는 ${MAX_AD_DAYS}일까지입니다(요청 ${n}일). 기간을 나눠 조회하세요.`);
  const cs = typeof input.compare_since === "string" ? input.compare_since.trim() : "";
  const cu = typeof input.compare_until === "string" ? input.compare_until.trim() : "";
  if (cs || cu) {
    if (!validDate(cs) || !validDate(cu) || cs > cu) throw new Error("비교 기간(compare_since·compare_until)이 올바르지 않습니다.");
    if (dayCount(cs, cu) > MAX_AD_DAYS) throw new Error(`비교 기간도 ${MAX_AD_DAYS}일까지입니다.`);
    return { cur: { since, until }, prev: { since: cs, until: cu } };
  }
  return { cur: { since, until }, prev: { since: shift(since, -n), until: shift(since, -1) } };
}

function adsFor(state: LiveState, input: Record<string, unknown>) {
  const { cur, prev } = periods(input);
  const key = `${cur.since}|${cur.until}|${prev.since}|${prev.until}`;
  let hit = state.ads.get(key);
  if (!hit) {
    const cache = newCache(cur, prev);
    hit = { cache, facts: collectAds(cache, NAVER_CONV_MS) };
    hit.facts.catch(() => state.ads.delete(key)); // 실패한 조회는 다음 호출에서 다시
    state.ads.set(key, hit);
  }
  return hit;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function adTables(ads: AdsFacts, cur: { since: string; until: string }, prev: { since: string; until: string }): LiveTable[] {
  const out: LiveTable[] = [];
  const m = ads.meta;
  if (m?.ok) {
    const columns = ["캠페인", "상태", "지출(원)", "노출", "링크 클릭", "CTR(%)", "CPC(원)", "구매", "CPA(원)", "구매액(원)", "ROAS(배)", "비교 지출(원)", "비교 ROAS(배)"];
    const rows: Record<string, unknown>[] = [
      { "캠페인": "합계", "상태": "", "지출(원)": m.spend, "노출": m.impressions, "링크 클릭": m.clicks, "CTR(%)": m.ctr, "CPC(원)": m.cpc, "구매": m.purchases, "CPA(원)": m.cpa, "구매액(원)": m.value, "ROAS(배)": m.roas, "비교 지출(원)": m.prev_spend, "비교 ROAS(배)": m.prev_roas },
      ...m.campaigns.map((c) => ({ "캠페인": c.name, "상태": c.status, "지출(원)": c.spend, "노출": c.impressions, "링크 클릭": c.clicks, "CTR(%)": c.ctr, "CPC(원)": c.cpc, "구매": c.purchases, "CPA(원)": c.cpa, "구매액(원)": c.value, "ROAS(배)": c.roas, "비교 지출(원)": c.prev_spend, "비교 ROAS(배)": c.prev_roas })),
    ];
    out.push({ title: `메타 광고 캠페인 성과 ${cur.since}~${cur.until} (비교 ${prev.since}~${prev.until})`, sql: `${AD_SQL_NOTE}\n-- 메타: 지출·ROAS 는 VAT 제외, 구매·구매액은 메타 픽셀 기준`, columns, rows });
  }
  const n = ads.naver;
  if (n?.ok) {
    const columns = ["캠페인", "유형", "광고비 VAT포함(원)", "노출", "클릭", "CTR(%)", "CPC(원)", "평균 순위", "전체 전환", "구매", "CPA(원)", "구매액(원)", "ROAS(배)", "비교 광고비(원)"];
    const rows: Record<string, unknown>[] = [
      { "캠페인": "합계", "유형": "", "광고비 VAT포함(원)": n.cost_vat_incl, "노출": n.imp, "클릭": n.clicks, "CTR(%)": n.ctr, "CPC(원)": n.cpc, "평균 순위": null, "전체 전환": null, "구매": n.purchases, "CPA(원)": null, "구매액(원)": n.purchase_sales, "ROAS(배)": n.roas, "비교 광고비(원)": n.prev_cost },
      ...n.campaigns.map((c) => ({ "캠페인": c.name, "유형": c.type, "광고비 VAT포함(원)": c.cost_vat_incl, "노출": c.imp, "클릭": c.clicks, "CTR(%)": c.ctr, "CPC(원)": c.cpc, "평균 순위": c.avg_rank, "전체 전환": c.conv_all, "구매": c.purchases, "CPA(원)": c.cpa, "구매액(원)": c.purchase_sales, "ROAS(배)": c.roas, "비교 광고비(원)": c.prev_cost })),
    ];
    out.push({ title: `네이버 검색광고 캠페인 성과 ${cur.since}~${cur.until} (비교 ${prev.since}~${prev.until})`, sql: `${AD_SQL_NOTE}\n-- 네이버: 광고비는 VAT 포함, ROAS 는 VAT 제외 광고비 기준, 구매 ${n.purchase_status}`, columns, rows });
  }
  return out;
}

function breakdownTable(platform: string, body: string, title: string): LiveTable | null {
  const nl = body.indexOf("\n");
  if (nl < 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body.slice(nl + 1)); } catch { return null; }
  const list = (Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown[] })?.rows) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(list) || !list.length) return null;
  if (platform === "meta") {
    const columns = ["광고세트", "상태", "지출(원)", "구매", "ROAS(배)", "비교 지출(원)", "비교 구매", "비교 ROAS(배)"];
    const rows = list.map((r) => {
      const c = (r.current || {}) as Record<string, unknown>, p = (r.previous || {}) as Record<string, unknown>;
      return { "광고세트": r.name, "상태": r.status, "지출(원)": num(c.spend), "구매": num(c.purchases), "ROAS(배)": num(c.roas), "비교 지출(원)": num(p.spend), "비교 구매": num(p.purchases), "비교 ROAS(배)": num(p.roas) };
    });
    return { title, sql: `${AD_SQL_NOTE}\n-- 메타 광고세트: VAT 제외, 픽셀 기준`, columns, rows };
  }
  const columns = ["광고그룹", "상태", "광고비 VAT포함(원)", "클릭", "전체 전환", "구매", "비교 광고비(원)", "비교 전체 전환"];
  const rows = list.map((r) => {
    const c = (r.current || {}) as Record<string, unknown>;
    return { "광고그룹": r.name, "상태": r.status, "광고비 VAT포함(원)": num(c.cost_vat_incl), "클릭": num(c.clicks), "전체 전환": num(c.conv_all), "구매": num(c.purchases), "비교 광고비(원)": num(r.previous_cost_vat_incl), "비교 전체 전환": num(r.previous_conv_all) };
  });
  return { title, sql: `${AD_SQL_NOTE}\n-- 네이버 광고그룹: 광고비 VAT 포함`, columns, rows };
}

const AD_RULES = "해석 규칙: 메타 ROAS·구매는 메타 픽셀 기준, 네이버 구매는 네이버 전환 기준이라 실제 매출(sales_orders)과 다릅니다. ROAS 는 배수(3.2 = 320%)이고 두 매체 모두 VAT 제외 광고비 기준입니다. 네이버 광고비(cost_vat_incl)는 VAT 포함입니다. 네이버 conv_all 은 장바구니 등 전체 전환이라 구매와 비교하지 않습니다. 마지막 며칠의 구매는 전환 지연으로 늘어날 수 있습니다. 네이버 구매가 '미확정'이면 0 이라고 단정하지 않습니다. prev_* 는 비교 기간 합계입니다(기간 길이가 다르면 하루 평균끼리 비교). 광고 성과를 좋다·나쁘다로 단정하지 않고, 사용자가 물을 때만 근거와 함께 '추정:'으로 판단합니다. 광고를 끄거나 예산을 바꾸라고 단정하지 않습니다(실행은 사람).";

// 실행 — content 는 모델에 돌려줄 글, tables 는 화면 표 카드
export async function runLiveTool(sb: SupabaseClient, state: LiveState, name: LiveToolName, input: Record<string, unknown>): Promise<{ content: string; tables: LiveTable[] }> {
  if (name === "ad_performance") {
    const hit = adsFor(state, input);
    const r = await withTimeout(hit.facts, ADS_TIMEOUT_MS);
    if (r === "timeout") throw new Error(`광고 API 응답 시간 초과(${ADS_TIMEOUT_MS / 1000}초)`);
    const { ads, aiAds } = r;
    if (!ads.meta && !ads.naver) return { content: "광고 API 가 설정되어 있지 않습니다(메타·네이버 자격 없음).", tables: [] };
    const fails = [ads.meta && !ads.meta.ok ? `메타 조회 실패: ${ads.meta.error}` : "", ads.naver && !ads.naver.ok ? `네이버 조회 실패: ${ads.naver.error}` : ""].filter(Boolean);
    const body = JSON.stringify(aiAds);
    return {
      content: `${AD_RULES}\n${fails.length ? `${fails.join(" / ")}\n` : ""}캠페인은 지출 상위 20개만(전체는 표 카드). ${body.length > 16000 ? `${body.slice(0, 16000)} …(잘림)` : body}`,
      tables: adTables(ads, hit.cache.cur, hit.cache.prev),
    };
  }
  if (name === "ad_breakdown") {
    const platform = input.platform === "naver" ? "naver" : "meta";
    const cid = String(input.campaign_id || "").trim();
    if (!cid || cid.length > 40) throw new Error("campaign_id 가 올바르지 않습니다.");
    const hit = adsFor(state, input);
    const r = await withTimeout(hit.facts, ADS_TIMEOUT_MS); // 네이버 광고그룹 원자료(cache)를 채운다
    if (r === "timeout") throw new Error(`광고 API 응답 시간 초과(${ADS_TIMEOUT_MS / 1000}초)`);
    const ctx = { since: hit.cache.cur.since, end: hit.cache.cur.until, maxDays: MAX_AD_DAYS };
    const out = await withTimeout(runAnalystTool(sb, ctx, hit.cache, platform === "meta" ? "meta_campaign_adsets" : "naver_campaign_adgroups", { campaign_id: cid }), 60_000);
    if (out === "timeout") throw new Error("광고 API 응답 시간 초과(60초)");
    const camp = platform === "meta" ? r.ads.meta?.campaigns.find((c) => c.id === cid)?.name : r.ads.naver?.campaigns.find((c) => c.id === cid)?.name;
    const t = breakdownTable(platform, out, `${platform === "meta" ? "메타 광고세트" : "네이버 광고그룹"} — ${camp || cid} ${hit.cache.cur.since}~${hit.cache.cur.until}`);
    return { content: `${AD_RULES}\n${out}`, tables: t ? [t] : [] };
  }
  if (name === "ga_report") {
    if (!isGaConfigured()) return { content: "GA4 가 연결되어 있지 않습니다(관리자가 Vercel 환경 변수 GA4_PROPERTY_ID·GA_SA_EMAIL·GA_SA_PRIVATE_KEY 를 넣어야 합니다). 유입·전환 데이터는 지금 볼 수 없습니다.", tables: [] };
    const since = String(input.since || "").trim(), until = String(input.until || "").trim();
    if (!validDate(since) || !validDate(until) || since > until) throw new Error("since·until 은 YYYY-MM-DD 이고 since ≤ until 이어야 합니다.");
    const yesterday = kstDay(-1);
    if (until > yesterday) throw new Error(`GA4 는 어제(${yesterday})까지만 확정값입니다 — until 을 어제 이전으로.`);
    if (dayCount(since, until) > GA_MAX_DAYS) throw new Error(`GA4 조회는 ${GA_MAX_DAYS}일까지입니다.`);
    const dims = (Array.isArray(input.dimensions) ? input.dimensions : []).map(String).filter((d): d is GaDimensionKey => d in GA_DIMENSIONS).slice(0, 3);
    const mets = (Array.isArray(input.metrics) ? input.metrics : []).map(String).filter((m): m is GaMetricKey => m in GA_METRICS);
    const fi = input.filter && typeof input.filter === "object" ? (input.filter as { dimension?: unknown; match?: unknown; value?: unknown }) : null;
    const filter = fi && typeof fi.dimension === "string" && fi.dimension in GA_DIMENSIONS && typeof fi.value === "string" && fi.value.trim()
      ? { dimension: fi.dimension as GaDimensionKey, match: (["exact", "contains", "begins_with"].includes(String(fi.match)) ? fi.match : "exact") as GaMatch, value: fi.value.trim() } : null;
    const extraDimension = typeof input.custom_dimension === "string" && input.custom_dimension.trim() ? input.custom_dimension.trim() : null;
    const r = await runGaReport({ since, until, dimensions: dims, metrics: mets, limit: typeof input.limit === "number" ? input.limit : 200, filter, extraDimension });
    const title = `GA4 ${dims.map((d) => GA_DIMENSIONS[d].label).join("·") || "합계"}${filter ? ` (${GA_DIMENSIONS[filter.dimension].label} ${filter.value})` : ""} ${since}~${until}`;
    const body = JSON.stringify(r.rows.slice(0, 120));
    return {
      content: `${r.note}\n행 ${r.rowCount}${r.truncated ? "(상한에 잘림)" : ""} — 아래는 앞 120행(전체는 표 카드)\n${body.length > 14000 ? `${body.slice(0, 14000)} …(잘림)` : body}`,
      tables: [{ title, sql: "-- GA4 API 실시간 조회(SQL 아님 · 저장·엑셀·루커 불가)", columns: r.columns, rows: r.rows }],
    };
  }
  if (name === "ga_funnel") {
    if (!isGaConfigured()) return { content: "GA4 가 연결되어 있지 않습니다(관리자가 Vercel 환경 변수를 넣어야 합니다).", tables: [] };
    const since = String(input.since || "").trim(), until = String(input.until || "").trim();
    if (!validDate(since) || !validDate(until) || since > until) throw new Error("since·until 은 YYYY-MM-DD 이고 since ≤ until 이어야 합니다.");
    const yesterday = kstDay(-1);
    if (until > yesterday) throw new Error(`GA4 는 어제(${yesterday})까지만 확정값입니다 — until 을 어제 이전으로.`);
    if (dayCount(since, until) > GA_MAX_DAYS) throw new Error(`GA4 조회는 ${GA_MAX_DAYS}일까지입니다.`);
    const steps: GaFunnelStep[] = (Array.isArray(input.steps) ? input.steps : []).map((st) => {
      const o = (st && typeof st === "object" ? st : {}) as Record<string, unknown>;
      return {
        name: String(o.name || ""), page_path: typeof o.page_path === "string" ? o.page_path : null,
        page_match: (["exact", "contains", "begins_with"].includes(String(o.page_match)) ? o.page_match : "exact") as GaMatch,
        events: Array.isArray(o.events) ? o.events.map(String) : null,
      };
    });
    const breakdown = input.breakdown === "device" || input.breakdown === "channel" ? input.breakdown : null;
    const r = await runGaFunnel({ since, until, steps, breakdown });
    const title = `GA4 유입경로 ${steps.map((s2) => s2.name).join(" → ").slice(0, 70)} ${since}~${until}`;
    return {
      content: `${r.note}\n${JSON.stringify(r.rows).slice(0, 12000)}`,
      tables: [{ title, sql: "-- GA4 유입경로 API 실시간 조회(SQL 아님 · 저장·엑셀·루커 불가)", columns: r.columns, rows: r.rows }],
    };
  }
  if (name === "docs_search") {
    const query = String(input.query || "").trim();
    if (!query) throw new Error("query 가 비어 있습니다.");
    const r = await searchDocs({ query, source: typeof input.source === "string" ? input.source : null, limit: typeof input.limit === "number" ? input.limit : 20 });
    const rows = r.hits.map((h) => ({ 이름: h.name, 종류: h.kind === "folder" ? "폴더" : "파일", 위치: `${h.source} / ${h.path}`, 수정일: h.modified, "크기(KB)": h.sizeKb, ref: h.ref, 링크: h.url }));
    return {
      content: `${r.note ? `${r.note}\n` : ""}${r.hits.length ? `${r.hits.length}건 — 본문은 docs_read(ref)로 읽습니다.\n${JSON.stringify(rows.map(({ 링크: _l, ...x }) => x))}` : "찾은 문서가 없습니다. 검색어를 바꾸거나(짧은 핵심어·파일 이름에 있을 말) docs_list 로 폴더를 따라가 보세요."}`,
      tables: r.hits.length ? [{ title: `문서 검색 '${query}'`, sql: "-- Microsoft 365 문서함 검색(SQL 아님 · 저장·엑셀·루커 불가)", columns: ["이름", "종류", "위치", "수정일", "크기(KB)", "ref", "링크"], rows }] : [],
    };
  }
  if (name === "docs_list") {
    const r = await listDocs({ source: typeof input.source === "string" ? input.source : null, path: typeof input.path === "string" ? input.path : null });
    const rows = r.hits.map((h) => ({ 이름: h.name, 종류: h.kind === "folder" ? "폴더" : "파일", 위치: `${h.source} / ${h.path}`, 수정일: h.modified, "크기(KB)": h.sizeKb, ref: h.ref, 링크: h.url }));
    return {
      content: `${r.where}: ${r.hits.length}개\n${JSON.stringify(rows.map(({ 링크: _l, ...x }) => x)).slice(0, 14000)}`,
      tables: r.hits.length ? [{ title: `문서함 ${r.where}`, sql: "-- Microsoft 365 문서함 목록(SQL 아님 · 저장·엑셀·루커 불가)", columns: ["이름", "종류", "위치", "수정일", "크기(KB)", "ref", "링크"], rows }] : [],
    };
  }
  if (name === "docs_read") {
    const r = await readDoc({ ref: String(input.ref || ""), offset: typeof input.offset === "number" ? input.offset : null });
    const head = `문서: ${r.name} (${r.path}) — 전체 ${r.total.toLocaleString("ko-KR")}자 중 ${r.offset.toLocaleString("ko-KR")}~${(r.offset + r.text.length).toLocaleString("ko-KR")}자${r.next != null ? ` · 더 있음 → offset ${r.next}` : " · 끝"}${r.url ? `\n링크: ${r.url}` : ""}`;
    return { content: `${head}\n\n${r.text}`, tables: [] };
  }
  // 재고·채널 상태 — 오늘 기준(listing 명령은 최근 14일)
  const today = kstDay(0);
  const out = await runAnalystTool(sb, { since: shift(today, -14), end: today, maxDays: 62 }, newCache({ since: today, until: today }, { since: today, until: today }), name, { sku: input.sku });
  return { content: out, tables: [] };
}
