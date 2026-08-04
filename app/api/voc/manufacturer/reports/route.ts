import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { MFG_FAULT } from "@/app/lib/voc-manufacturer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 월간 VOC 리포트 저장/조회 (migration 086 voc_monthly_reports).
//  GET  ?month=YYYY-MM → 그 달의 저장 리포트들 + 수신처(제조사명) 자동완성 목록
//                        + 손해 청구 섹션용 '제조사 귀책' 클레임 원본(설문 제외).
//  POST { month, recipient, draft, counts } → (월, 수신처) 단위 upsert(자동 저장).
//  086 미적용 환경: 저장/목록만 비활성(needsMigration=true), 클레임 조회는 정상 동작.

const MONTH_RE = /^\d{4}-\d{2}$/;
const isMissingTable = (msg: string) => /voc_monthly_reports|42P01/i.test(msg);

export async function GET(req: NextRequest) {
  try {
    const month = req.nextUrl.searchParams.get("month") || "";
    if (!MONTH_RE.test(month)) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const from = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const to = new Date(y, m, 0).toISOString().slice(0, 10);

    // 손해 청구 섹션용 클레임(개선요청서·정산 엑셀과 동일 기준: 제조사 귀책 · 설문 제외)
    const { data: claims, error: cErr } = await sb
      .from("voc").select("*")
      .eq("fault", MFG_FAULT).neq("source", "설문")
      .gte("received_at", from).lte("received_at", to)
      .order("received_at", { ascending: true });
    if (cErr) throw cErr;

    let reports: { recipient: string; draft: string; counts: unknown; updated_at: string }[] = [];
    let recipients: string[] = [];
    let needsMigration = false;
    const r1 = await sb.from("voc_monthly_reports")
      .select("recipient, draft, counts, updated_at")
      .eq("month", month).order("updated_at", { ascending: false });
    if (r1.error) {
      if (!isMissingTable(r1.error.message)) throw r1.error;
      needsMigration = true; // 086 미적용 — 저장 없이 진행
    } else {
      reports = (r1.data ?? []) as typeof reports;
      const r2 = await sb.from("voc_monthly_reports").select("recipient").neq("recipient", "");
      recipients = [...new Set(((r2.data ?? []) as { recipient: string }[]).map((x) => x.recipient))].sort((a, b) => a.localeCompare(b, "ko"));
    }

    return NextResponse.json({ ok: true, reports, recipients, claims: claims ?? [], needsMigration });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "리포트 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => ({}))) as { month?: string; recipient?: string; draft?: string; counts?: unknown };
    const month = MONTH_RE.test(String(b.month || "")) ? String(b.month) : "";
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const draft = String(b.draft || "");
    if (!draft.trim()) return NextResponse.json({ ok: false, error: "저장할 내용이 없습니다." }, { status: 400 });
    const recipient = String(b.recipient || "").slice(0, 100);

    const { error } = await supabaseAdmin().from("voc_monthly_reports").upsert(
      { month, recipient, draft, counts: b.counts ?? null, updated_at: new Date().toISOString() },
      { onConflict: "month,recipient" },
    );
    if (error) {
      if (isMissingTable(error.message)) {
        return NextResponse.json({ ok: false, needsMigration: true, error: "저장하려면 마이그레이션 086(voc_monthly_reports)을 적용하세요." }, { status: 400 });
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "리포트 저장 실패") }, { status: 500 });
  }
}
