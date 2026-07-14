import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { planReport, type ReportTurn } from "@/app/lib/report-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { question, history? } — 자연어 질문(+후속 정제) → Claude가 SQL 생성 → run_report 실행 → 표+플랜 반환.
export async function POST(req: NextRequest) {
  try {
    const { question, history } = (await req.json()) as { question?: string; history?: ReportTurn[] };
    const q = (question || "").trim();
    if (!q) return NextResponse.json({ ok: false, error: "질문을 입력하세요." }, { status: 400 });
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY 가 설정되어 있지 않습니다." }, { status: 503 });

    // 1) AI가 SQL·차트·루커SQL 계획 수립 (planReport 내부에서 단일 SELECT 검증)
    let plan;
    try {
      plan = await planReport(q, Array.isArray(history) ? history : undefined);
    } catch (e) {
      return NextResponse.json({ ok: false, error: extractErrorMsg(e, "질문 해석 실패 — 조금 더 구체적으로 적어보세요.") }, { status: 400 });
    }

    // 2) 안전 실행 + 자동 교정: 실패 시 오류를 AI에 되먹여 SQL 고쳐 재실행(최대 2회)
    const sb = supabaseAdmin();
    const hist = Array.isArray(history) ? history : undefined;
    let data: unknown = null;
    let error: { message: string } | null = null;
    let corrected = 0;
    for (let attempt = 0; ; attempt++) {
      const res = await sb.rpc("run_report", { q: plan.sql });
      data = res.data; error = res.error;
      if (!error) break;
      if (attempt >= 2) break; // 최대 2회 교정
      try {
        plan = await planReport(q, hist, { sql: plan.sql, error: error.message });
        corrected++;
      } catch {
        break; // 교정 SQL 이 검증 실패(비허용 관계 등) → 원래 오류로 종료
      }
    }
    if (error) {
      // 교정 후에도 실패 → 오류·플랜 노출
      return NextResponse.json({ ok: false, error: `쿼리 실행 오류: ${error.message}`, plan, corrected }, { status: 400 });
    }

    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return NextResponse.json({ ok: true, plan, columns, rows, rowCount: rows.length, corrected });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "리포트 생성 실패") }, { status: 500 });
  }
}
