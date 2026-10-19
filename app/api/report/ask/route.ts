import { NextRequest } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { askAssistant, type AskHistoryTurn } from "@/app/lib/assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 기한 270초(ASK_DEADLINE_MS) + 응답 여유

// POST { q, history? } — 데이터 비서(docs/assistant-plan.md 1차). NDJSON 스트리밍(한 줄에 JSON 하나):
//  진행: {"type":"progress","name":"run_sql","label":"채널별 10월 매출 조회","ms":1234}  (도구 호출마다)
//  끝:   {"type":"done","result":<AskResult>}
//  실패: {"type":"error","error":"문구"}
//  비로그인은 미들웨어가 막는다(공개 예외 없음). 로그인 이름은 서버 콘솔 한 줄 로그에만 쓴다.
const NDJSON = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" };
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

export async function POST(req: NextRequest) {
  let q = "", history: AskHistoryTurn[] | undefined;
  try {
    const body = (await req.json()) as { q?: string; history?: AskHistoryTurn[] };
    q = (body.q || "").trim();
    history = Array.isArray(body.history) ? body.history.filter((h) => h && typeof h.q === "string").slice(-8) : undefined; // 대화형(2026-10-19) — 최근 8턴
  } catch {
    return new Response(line({ type: "error", error: "요청 본문을 읽지 못했습니다." }), { status: 400, headers: NDJSON });
  }
  if (!q) return new Response(line({ type: "error", error: "질문을 입력하세요." }), { status: 400, headers: NDJSON });
  if (q.length > 2000) return new Response(line({ type: "error", error: "질문이 너무 깁니다(2,000자 이내)." }), { status: 400, headers: NDJSON });

  const token = req.cookies.get("b2b_auth")?.value;
  const user = (await verifySession(token)) || resolveUserName(token) || "?";

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => { try { controller.enqueue(enc.encode(line(o))); } catch { /* 클라이언트가 끊음 */ } };
      try {
        const result = await askAssistant({ q, history, user, onProgress: (p) => send({ type: "progress", ...p }) });
        send({ type: "done", result });
      } catch (e) {
        send({ type: "error", error: extractErrorMsg(e, "커스텀 리포트가 답하지 못했습니다.") });
      } finally {
        try { controller.close(); } catch { /* 이미 닫힘 */ }
      }
    },
  });
  return new Response(stream, { status: 200, headers: NDJSON });
}
