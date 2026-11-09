// GA4 MCP 서버(2026-10-27) — Poke 같은 외부 AI 비서가 업무도우미의 GA4 조회 도구(ga_report·ga_funnel·ga_catalog)를 MCP 로 쓴다.
//  인증: Authorization: Bearer <MCP_API_KEY> (또는 X-Api-Key 헤더). 키는 Vercel 환경 변수 MCP_API_KEY — 미설정이면 503.
//  헤더를 못 보내는 클라이언트(ChatGPT 커넥터)는 /api/mcp/ga/[key] 경로를 쓴다. 로직은 app/lib/mcp-ga.ts 공용.
import { NextRequest } from "next/server";
import { authorizedByHeader, gateResponse, mcpPost, mcpGet, mcpDelete } from "@/app/lib/mcp-ga";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const gate = (req: NextRequest) => gateResponse(authorizedByHeader(req), "MCP_API_KEY");

export async function POST(req: NextRequest) { return gate(req) ?? mcpPost(req); }
export async function GET(req: NextRequest) { return gate(req) ?? mcpGet(); }
export async function DELETE(req: NextRequest) { return gate(req) ?? mcpDelete(); }
