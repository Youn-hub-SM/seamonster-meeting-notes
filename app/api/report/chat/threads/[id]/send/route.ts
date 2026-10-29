import { NextRequest, after } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { runChatTurn, isPending139, PENDING_139, CHAT_MODEL_KEYS, getRunningSince, markRunning, clearRunning, stopRequested, type ChatEvent, type ChatModelKey } from "@/app/lib/chat-assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 기한 270초(CHAT_DEADLINE_MS) + 응답 여유

// POST { text } — 대화 한 턴. NDJSON 스트리밍(한 줄에 JSON 하나, chat-assistant ChatEvent):
//  {"type":"text","delta":"…"} 글자 흐름 / {"type":"tool",…,"status":"start|ok|fail"} 도구 칩 / {"type":"table","table":{…}} 표 카드
//  {"type":"done",…} 끝 / {"type":"error","error":"…"} 실패. 비로그인은 미들웨어가 막는다.
//  2026-10-29: 턴은 화면 연결과 무관하게 끝까지 돈다 — 스트림은 연결돼 있는 동안만 보여 주고, 끊겨도 after() 가 함수를 붙잡아 DB 에 저장한다.
//  [중지]는 연결 끊기가 아니라 /stop 표식(3초마다 확인). 같은 스레드에 턴이 돌고 있으면 409.
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

  if (await getRunningSince(id)) return new Response(line({ type: "error", error: "비서가 아직 앞 질문에 답하는 중입니다. 끝나면 다시 보내 주세요." }), { status: 409, headers: NDJSON });
  try { await markRunning(id); } catch (e) { return new Response(line({ type: "error", error: extractErrorMsg(e, "실행 표식을 저장하지 못했습니다.") }), { status: 500, headers: NDJSON }); }

  const enc = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatEvent) => { if (closed) return; try { controller.enqueue(enc.encode(line(e))); } catch { closed = true; /* 클라이언트가 끊음 — 서버는 계속 */ } };
      const ctrl = new AbortController(); // 서버 쪽 중지 — /stop 표식을 3초마다 본다(화면 연결 끊김은 중지가 아니다)
      const poll = setInterval(() => { stopRequested(id).then((v) => { if (v) ctrl.abort(); }).catch(() => { /* 표식 조회 실패는 무시 */ }); }, 3000);
      const run = (async () => {
        try {
          await runChatTurn({ threadId: id, text, user, modelKey, signal: ctrl.signal, send });
        } catch (e) {
          send({ type: "error", error: isPending139(e) ? PENDING_139 : extractErrorMsg(e, "비서가 답하지 못했습니다.") });
        } finally {
          clearInterval(poll);
          try { await clearRunning(id); } catch { /* 표식은 5분 뒤 자동 만료 */ }
          closed = true;
          try { controller.close(); } catch { /* 이미 닫힘 */ }
        }
      })();
      after(() => run); // 연결이 끊겨도 플랫폼이 함수를 끝까지 살려 둔다
      await run;
    },
    cancel() { closed = true; }, // 화면이 떠남 — 스트림만 닫고 턴은 계속
  });
  return new Response(stream, { status: 200, headers: NDJSON });
}
