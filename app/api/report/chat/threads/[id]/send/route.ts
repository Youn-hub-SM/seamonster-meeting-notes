import { NextRequest } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { runChatTurn, isPending139, PENDING_139, CHAT_MODEL_KEYS, type ChatEvent, type ChatModelKey } from "@/app/lib/chat-assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 기한 270초(CHAT_DEADLINE_MS) + 응답 여유

// POST { text } — 대화 한 턴. NDJSON 스트리밍(한 줄에 JSON 하나, chat-assistant ChatEvent):
//  {"type":"text","delta":"…"} 글자 흐름 / {"type":"tool",…,"status":"start|ok|fail"} 도구 칩 / {"type":"table","table":{…}} 표 카드
//  {"type":"done",…} 끝 / {"type":"error","error":"…"} 실패. 비로그인은 미들웨어가 막는다.
const NDJSON = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" };
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return new Response(line({ type: "error", error: "대화 번호가 올바르지 않습니다." }), { status: 400, headers: NDJSON });
  let text = "";
  let modelKey: ChatModelKey | null = null;
  try {
    const body = (await req.json()) as { text?: string; model?: string };
    text = String(body.text || "").trim();
    modelKey = (CHAT_MODEL_KEYS as readonly string[]).includes(String(body.model || "")) ? (body.model as ChatModelKey) : null; // 그 턴의 모델 선택(화면)
  }
  catch { return new Response(line({ type: "error", error: "요청 본문을 읽지 못했습니다." }), { status: 400, headers: NDJSON }); }
  if (!text) return new Response(line({ type: "error", error: "메시지를 입력하세요." }), { status: 400, headers: NDJSON });
  if (text.length > 4000) return new Response(line({ type: "error", error: "메시지가 너무 깁니다(4,000자 이내)." }), { status: 400, headers: NDJSON });

  const token = req.cookies.get("b2b_auth")?.value;
  const user = (await verifySession(token)) || resolveUserName(token) || "?";

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatEvent) => { try { controller.enqueue(enc.encode(line(e))); } catch { /* 클라이언트가 끊음 */ } };
      try {
        await runChatTurn({ threadId: id, text, user, modelKey, signal: req.signal, send }); // 화면 [중지] = 연결 끊기 → req.signal
      } catch (e) {
        send({ type: "error", error: isPending139(e) ? PENDING_139 : extractErrorMsg(e, "비서가 답하지 못했습니다.") });
      } finally {
        try { controller.close(); } catch { /* 이미 닫힘 */ }
      }
    },
  });
  return new Response(stream, { status: 200, headers: NDJSON });
}
