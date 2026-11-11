import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { getReport, markApplied } from "@/app/lib/agents/store";
import { createProductionRequest, CreateError } from "@/app/lib/production-request-create";
import type { AppliedItem } from "@/app/lib/agents/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST { items: [{ sku, qty }], due_date? } — 보고서의 제안을 사람이 확인·수정한 수량으로 도매 생산 요청서('도매 납품')를 만든다.
//  에이전트는 요청서를 만들지 못한다 — 이 버튼을 누른 사람이 작성자다. 상태는 '요청'(화면의 '확정 필요')으로 시작한다.
//  품목은 보고서의 제안 안에서만 고른다(수량 0 = 제외). 같은 보고서로 두 번 누르면 재시도 키(136)로 첫 요청서를 돌려준다.
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    const sb = supabaseAdmin();
    const report = await getReport(sb, id);
    if (!report) return NextResponse.json({ ok: false, error: "없는 보고서입니다." }, { status: 404 });
    if (report.agent !== "wholesale-request") return NextResponse.json({ ok: false, error: "요청서를 만들 수 없는 보고서입니다." }, { status: 400 });
    if (report.status !== "done") return NextResponse.json({ ok: false, error: "완료된 보고서만 요청서로 만들 수 있습니다." }, { status: 409 });
    if (report.request_id) return NextResponse.json({ ok: false, error: `이미 요청서 ${report.request_no || ""} 로 만들었습니다.` }, { status: 409 });

    const b = (await req.json()) as { items?: { sku?: string; qty?: number }[]; due_date?: string };
    const bySku = new Map(report.draft.map((d) => [d.sku, d]));
    const applied: AppliedItem[] = [];
    const seen = new Set<string>();
    for (const it of Array.isArray(b.items) ? b.items : []) {
      const sku = String(it.sku || "").toUpperCase();
      const d = bySku.get(sku);
      const qty = Math.round((Number(it.qty) || 0) * 100) / 100;
      if (!d || !d.product_id || qty <= 0 || seen.has(sku)) continue;
      seen.add(sku);
      applied.push({ sku, product_id: d.product_id, qty, draft_qty: d.qty });
    }
    if (!applied.length) return NextResponse.json({ ok: false, error: "요청할 품목의 수량을 1개 이상 입력하세요." }, { status: 400 });

    const token = req.cookies.get("b2b_auth")?.value;
    const who = (await verifySession(token)) || resolveUserName(token);
    const reasonOf = (sku: string) => bySku.get(sku)?.reason || "";
    const { request } = await createProductionRequest(sb, {
      purpose: "도매 납품",
      due_date: DATE_RE.test(String(b.due_date || "")) ? String(b.due_date) : null,
      memo: `AI 에이전트 보고서(${report.version})로 작성${report.summary ? ` — ${report.summary}` : ""}`.slice(0, 500),
      items: applied.map((a) => ({ product_id: a.product_id, requested_qty: a.qty, memo: reasonOf(a.sku).slice(0, 200) || null })),
      status: "요청",
      created_by: who,
      client_key: `agent:${report.id}`,
    });
    await markApplied(sb, id, { request_id: request.id, request_no: request.req_no, applied, who });
    return NextResponse.json({ ok: true, report: await getReport(sb, id), request_no: request.req_no });
  } catch (err) {
    if (err instanceof CreateError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    console.error("[agents/apply POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "요청서를 만들지 못했습니다") }, { status: 500 });
  }
}
