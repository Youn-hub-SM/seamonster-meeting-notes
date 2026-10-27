// GA4 MCP 서버(2026-10-27) — Poke 같은 외부 AI 비서가 업무도우미의 GA4 조회 도구(ga_report·ga_funnel·ga_catalog)를 MCP 로 쓴다.
//  규격: MCP Streamable HTTP, 세션 없는 단일 요청(JSON-RPC 2.0 over POST). GET 은 405(서버 발신 스트림 없음).
//  인증: Authorization: Bearer <MCP_API_KEY> (또는 X-Api-Key 헤더). 키는 Vercel 환경 변수 MCP_API_KEY — 미설정이면 503.
//  미들웨어 보호 제외 경로(/api/mcp/*)라 여기서 직접 검사한다. GA 자격은 ga.ts(서비스 계정) 그대로 — 읽기 전용.
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { isGaConfigured, runGaReport, runGaFunnel, GA_DIMENSIONS, GA_METRICS, GA_MAX_DAYS, type GaDimensionKey, type GaMetricKey, type GaMatch, type GaFunnelStep } from "@/app/lib/ga";
import { gaCatalogPromptBlock } from "@/app/lib/ga-catalog";
import { validDate, kstDay, shift } from "@/app/lib/analyst";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SERVER = { name: "seamonster-helper-ga", version: "1.0.0" };
const PROTOCOL = "2025-06-18";
const MAX_TEXT = 40_000;

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function authorized(req: NextRequest): "ok" | "unset" | "denied" {
  const secret = (process.env.MCP_API_KEY || "").trim();
  if (!secret) return "unset";
  const h = req.headers.get("authorization") || "";
  const given = (h.toLowerCase().startsWith("bearer ") ? h.slice(7) : req.headers.get("x-api-key") || "").trim();
  if (!given || given.length !== secret.length) return "denied";
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret)) ? "ok" : "denied";
}

const dayCount = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3) + 1;
const DIM_KEYS = Object.keys(GA_DIMENSIONS);
const MET_KEYS = Object.keys(GA_METRICS);
const DIM_HELP = DIM_KEYS.map((k) => `${k}=${GA_DIMENSIONS[k as GaDimensionKey].label}`).join(", ");
const MET_HELP = MET_KEYS.map((k) => `${k}=${GA_METRICS[k as GaMetricKey].label}`).join(", ");

const TOOLS = [
  {
    name: "ga_report",
    description: `씨몬스터 공식몰 GA4 리포트. 기간(어제까지, 최대 ${GA_MAX_DAYS}일)의 측정항목을 차원 0~3개로 나눠 돌려준다. 세션+구매를 함께 넣으면 구매 전환율(%) 열이 붙는다. since·until 을 비우면 최근 28일. 차원: ${DIM_HELP}. 측정항목: ${MET_HELP}. filter 로 특정 페이지·채널·캠페인만 거른다(예: page_path exact '/buy'). 메시지(알림톡·브랜드메시지) 성과는 dimensions ['source_medium','campaign'] 로 본다.`,
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        since: { type: "string", description: "시작일 YYYY-MM-DD" },
        until: { type: "string", description: "끝일 YYYY-MM-DD(어제 이전)" },
        dimensions: { type: "array", items: { type: "string", enum: DIM_KEYS }, description: "나눌 기준 0~3개. 비우면 기간 합계 한 줄" },
        metrics: { type: "array", minItems: 1, items: { type: "string", enum: MET_KEYS }, description: "측정항목 1개 이상" },
        limit: { type: "integer", description: "행 수 상한(기본 200, 최대 2000)" },
        filter: {
          type: "object", additionalProperties: false, required: ["dimension", "match", "value"],
          properties: { dimension: { type: "string", enum: DIM_KEYS }, match: { type: "string", enum: ["exact", "contains", "begins_with"] }, value: { type: "string" } },
          description: "행을 거를 조건 하나",
        },
        custom_dimension: { type: "string", description: "사용자 정의 측정기준 API 이름(예: customEvent:sm_label). ga_catalog 에 있는 것만" },
      },
      required: ["metrics"],
    },
  },
  {
    name: "ga_funnel",
    description: "GA4 유입경로 — 사용자가 단계(페이지·이벤트)를 차례로 밟았는지와 단계별 완료율·이탈률. 단계 2~10개, 각 단계는 page_path(페이지 경로)나 events(이벤트 이름 여러 개면 그중 하나) 또는 둘 다. '아무 행동 없이 나감'은 마지막 단계를 events ['click','scroll','view_item','select_item','add_to_cart','begin_checkout','purchase','page_view'] 로 두고 그 앞 단계의 이탈률을 읽는다. since·until 을 비우면 최근 28일.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        since: { type: "string", description: "시작일 YYYY-MM-DD" },
        until: { type: "string", description: "끝일 YYYY-MM-DD(어제 이전)" },
        steps: {
          type: "array", minItems: 2, maxItems: 10,
          items: {
            type: "object", additionalProperties: false, required: ["name"],
            properties: {
              name: { type: "string", description: "단계 이름(예: '메인')" },
              page_path: { type: "string", description: "페이지 경로(예: '/', '/buy')" },
              page_match: { type: "string", enum: ["exact", "contains", "begins_with"], description: "경로 비교 방식. 기본 exact" },
              events: { type: "array", items: { type: "string" }, description: "이벤트 이름 목록(그중 하나)" },
            },
          },
        },
        breakdown: { type: "string", enum: ["device", "channel"], description: "기기·채널 그룹별로 나눠 볼 때" },
      },
      required: ["steps"],
    },
  },
  {
    name: "ga_catalog",
    description: "우리 GA4 속성에 실제로 있는 것 — 최근 30일에 발생한 이벤트, 주요 이벤트(전환), 상위 페이지, 사용자 정의 측정기준. 이벤트·페이지 이름을 짐작하지 말고 먼저 이걸 본다.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

function period(input: Record<string, unknown>): { since: string; until: string } {
  const yesterday = kstDay(1);
  const until = typeof input.until === "string" && input.until.trim() ? input.until.trim() : yesterday;
  const since = typeof input.since === "string" && input.since.trim() ? input.since.trim() : shift(until, -27);
  if (!validDate(since) || !validDate(until) || since > until) throw new Error("since·until 은 YYYY-MM-DD 이고 since ≤ until 이어야 합니다.");
  if (until > yesterday) throw new Error(`GA4 는 어제(${yesterday})까지만 확정값입니다 — until 을 어제 이전으로.`);
  if (dayCount(since, until) > GA_MAX_DAYS) throw new Error(`GA4 조회는 ${GA_MAX_DAYS}일까지입니다.`);
  return { since, until };
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)} …(잘림)` : s);

async function callTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === "ga_catalog") {
    const block = await gaCatalogPromptBlock();
    return block || "GA4 자동 조사 결과가 아직 없습니다(연결 직후이거나 조회 실패).";
  }
  if (!isGaConfigured()) throw new Error("GA4 가 연결되어 있지 않습니다(관리자가 Vercel 환경 변수 GA4_PROPERTY_ID·GA_SA_EMAIL·GA_SA_PRIVATE_KEY 를 넣어야 합니다).");
  if (name === "ga_report") {
    const { since, until } = period(input);
    const dims = (Array.isArray(input.dimensions) ? input.dimensions : []).map(String).filter((d): d is GaDimensionKey => d in GA_DIMENSIONS).slice(0, 3);
    const mets = (Array.isArray(input.metrics) ? input.metrics : []).map(String).filter((m): m is GaMetricKey => m in GA_METRICS);
    if (!mets.length) throw new Error(`측정항목(metrics)이 하나 이상 필요합니다: ${MET_KEYS.join(", ")}`);
    const fi = input.filter && typeof input.filter === "object" ? (input.filter as { dimension?: unknown; match?: unknown; value?: unknown }) : null;
    const filter = fi && typeof fi.dimension === "string" && fi.dimension in GA_DIMENSIONS && typeof fi.value === "string" && fi.value.trim()
      ? { dimension: fi.dimension as GaDimensionKey, match: (["exact", "contains", "begins_with"].includes(String(fi.match)) ? fi.match : "exact") as GaMatch, value: fi.value.trim() } : null;
    const extraDimension = typeof input.custom_dimension === "string" && input.custom_dimension.trim() ? input.custom_dimension.trim() : null;
    const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(2000, Math.floor(input.limit)) : 200;
    const r = await runGaReport({ since, until, dimensions: dims, metrics: mets, limit, filter, extraDimension });
    return clip(`조회 기간 ${since} ~ ${until}\n${r.note}\n열: ${r.columns.join(" | ")}\n행 ${r.rowCount}${r.truncated ? "(상한에 잘림)" : ""}\n${JSON.stringify(r.rows)}`);
  }
  if (name === "ga_funnel") {
    const { since, until } = period(input);
    const steps: GaFunnelStep[] = (Array.isArray(input.steps) ? input.steps : []).map((st) => {
      const o = (st && typeof st === "object" ? st : {}) as Record<string, unknown>;
      return {
        name: String(o.name || ""), page_path: typeof o.page_path === "string" ? o.page_path : null,
        page_match: (["exact", "contains", "begins_with"].includes(String(o.page_match)) ? o.page_match : "exact") as GaMatch,
        events: Array.isArray(o.events) ? o.events.map(String) : null,
      };
    });
    if (steps.length < 2) throw new Error("단계(steps)는 2개 이상이어야 합니다.");
    const breakdown = input.breakdown === "device" || input.breakdown === "channel" ? input.breakdown : null;
    const r = await runGaFunnel({ since, until, steps, breakdown });
    return clip(`조회 기간 ${since} ~ ${until}\n${r.note}\n열: ${r.columns.join(" | ")}\n${JSON.stringify(r.rows)}`);
  }
  throw new Error(`없는 도구: ${name}`);
}

async function handle(msg: Rpc): Promise<unknown | null> {
  const id = msg.id;
  const method = String(msg.method || "");
  if (!method) return fail(id, -32600, "method 가 없습니다.");
  if (method.startsWith("notifications/")) return null; // 응답 없음
  if (method === "initialize") {
    const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL;
    return ok(id, {
      protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(asked) ? asked : PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
      instructions: "씨몬스터 공식몰(카페24) GA4 읽기 전용 도구. 날짜는 한국 시간, 어제까지 확정. 금액은 원(KRW). 이벤트·페이지 이름은 ga_catalog 로 먼저 확인한다. GA 구매는 매출 원장과 집계 기준이 달라 금액을 맞추지 않는다(답할 때 'GA 기준'이라고 적는다).",
    });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = String(msg.params?.name || "");
    const args = (msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, `없는 도구: ${name}`);
    try {
      const text = await callTool(name, args);
      return ok(id, { content: [{ type: "text", text }], isError: false });
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: e instanceof Error ? e.message : "조회 실패" }], isError: true });
    }
  }
  if (method === "resources/list") return ok(id, { resources: [] });
  if (method === "prompts/list") return ok(id, { prompts: [] });
  return fail(id, -32601, `지원하지 않는 메서드: ${method}`);
}

function gate(req: NextRequest): NextResponse | null {
  const a = authorized(req);
  if (a === "unset") return NextResponse.json({ ok: false, error: "MCP_API_KEY 가 설정되지 않았습니다(관리자: Vercel 환경 변수)." }, { status: 503 });
  if (a === "denied") return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  return null;
}

export async function POST(req: NextRequest) {
  const g = gate(req); if (g) return g;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json(fail(null, -32700, "JSON 파싱 실패"), { status: 400 }); }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as Rpc[];
  if (!msgs.length || msgs.some((m) => !m || typeof m !== "object")) return NextResponse.json(fail(null, -32600, "요청 형식이 올바르지 않습니다."), { status: 400 });
  const out = (await Promise.all(msgs.map(handle))).filter((r) => r !== null);
  if (!out.length) return new NextResponse(null, { status: 202 }); // 알림만 온 경우
  return NextResponse.json(batch ? out : out[0], { headers: { "Cache-Control": "no-store" } });
}

// 서버 발신 스트림(SSE)은 두지 않는다 — 세션 없는 단일 요청만. 클라이언트가 GET 으로 열려 하면 405 로 POST 를 안내.
export async function GET(req: NextRequest) {
  const g = gate(req); if (g) return g;
  return NextResponse.json({ ok: true, server: SERVER, transport: "streamable-http", note: "POST 로 JSON-RPC 요청을 보내세요. 서버 발신 스트림은 없습니다." }, { status: 405, headers: { Allow: "POST, DELETE" } });
}

export async function DELETE(req: NextRequest) {
  const g = gate(req); if (g) return g;
  return new NextResponse(null, { status: 200 }); // 세션이 없으니 종료할 것도 없다
}
