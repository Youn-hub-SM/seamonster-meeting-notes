import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { planReport } from "@/app/lib/report-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { question } — 자연어 질문 → Claude가 SQL 생성 → run_report(report_ro 권한)로 실행 → 표+플랜 반환.
export async function POST(req: NextRequest) {
  try {
    const { question } = (await req.json()) as { question?: string };
    const q = (question || "").trim();
    if (!q) return NextResponse.json({ ok: false, error: "질문을 입력하세요." }, { status: 400 });
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY 가 설정되어 있지 않습니다." }, { status: 503 });

    // 1) AI가 SQL·차트·루커SQL 계획 수립 (planReport 내부에서 단일 SELECT 검증)
    let plan;
    try {
      plan = await planReport(q);
    } catch (e) {
      return NextResponse.json({ ok: false, error: extractErrorMsg(e, "질문 해석 실패 — 조금 더 구체적으로 적어보세요.") }, { status: 400 });
    }

    // 2) 안전 실행: run_report 는 report_ro 권한(SELECT·비PII만) + 5000행 캡 + 15s 타임아웃
    const sb = supabaseAdmin();
    const { data, error } = await sb.rpc("run_report", { q: plan.sql });
    if (error) {
      // 권한거부(PII/쓰기)·문법오류 등 → 사용자에게 그대로 노출(플랜도 함께 보여 수정 유도)
      return NextResponse.json({ ok: false, error: `쿼리 실행 오류: ${error.message}`, plan }, { status: 400 });
    }

    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return NextResponse.json({ ok: true, plan, columns, rows, rowCount: rows.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "리포트 생성 실패") }, { status: 500 });
  }
}
