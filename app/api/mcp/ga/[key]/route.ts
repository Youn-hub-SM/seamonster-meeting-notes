// GA4 MCP 서버 — 주소 키 경로(2026-11-09). ChatGPT 사용자 지정 MCP 커넥터는 OAuth 또는 '인증 없음'만 지원해 헤더 키를 못 보낸다.
//  그래서 https://<도메인>/api/mcp/ga/<MCP_URL_KEY> 를 '인증 없음'으로 등록한다. 키가 주소에 있으니 공유 링크처럼 다루고,
//  새어 나갔다고 보이면 Vercel 환경 변수 MCP_URL_KEY 만 바꾸면 된다(헤더 키 MCP_API_KEY 와 별개). 도구·응답은 /api/mcp/ga 와 같다.
import { NextRequest } from "next/server";
import { authorizedByPath, gateResponse, mcpPost, mcpGet, mcpDelete } from "@/app/lib/mcp-ga";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ key: string }> };
const gate = async (ctx: Ctx) => gateResponse(authorizedByPath((await ctx.params).key), "MCP_URL_KEY");

export async function POST(req: NextRequest, ctx: Ctx) { return (await gate(ctx)) ?? mcpPost(req); }
export async function GET(_req: NextRequest, ctx: Ctx) { return (await gate(ctx)) ?? mcpGet(); }
export async function DELETE(_req: NextRequest, ctx: Ctx) { return (await gate(ctx)) ?? mcpDelete(); }
