import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg, supabaseAdmin } from "@/app/lib/supabase";
import { verifySession, resolveUserName, isAdminName } from "@/app/lib/b2b-auth";
// migration 140(report_feedback) 미적용 감지 — report-glossary.ts 는 2026-10-27 용어 사전 폐기로 삭제
const PENDING_140 = "DB 준비 전입니다 — supabase/migrations/140_report_glossary_feedback.sql 을 적용하세요.";
const isPending140 = (err: unknown) => { const m = String((err as { message?: string })?.message ?? err ?? ""); return /report_feedback/.test(m) && /(does not exist|schema cache|Could not find)/i.test(m); };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI 비서 답 피드백(migration 140). POST {threadId, seq, ok, note?} / GET ?stats=1(관리자) 30일 집계 + 최근 '틀려요' 사유
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function who(req: NextRequest): Promise<string> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token) || "?";
}
const pending = () => NextResponse.json({ ok: false, error: PENDING_140, pending_migration: true }, { status: 503 });

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => ({}))) as { threadId?: string; seq?: number; ok?: boolean; note?: string };
    if (!b.threadId || !UUID_RE.test(b.threadId)) return NextResponse.json({ ok: false, error: "대화 번호가 올바르지 않습니다." }, { status: 400 });
    if (typeof b.ok !== "boolean") return NextResponse.json({ ok: false, error: "맞아요/틀려요 중 하나를 고르세요." }, { status: 400 });
    const note = String(b.note || "").trim().slice(0, 500) || null;
    const { error } = await supabaseAdmin().from("report_feedback").insert({ thread_id: b.threadId, seq: Number.isInteger(b.seq) ? b.seq : null, user_name: await who(req), ok: b.ok, note });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isPending140(e)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "피드백을 남기지 못했습니다.") }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await who(req);
    if (!isAdminName(user)) return NextResponse.json({ ok: false, error: "관리자만 볼 수 있습니다." }, { status: 403 });
    const since = new Date(Date.now() - 30 * 86400e3).toISOString();
    const sb = supabaseAdmin();
    const [all, recent] = await Promise.all([
      sb.from("report_feedback").select("ok").gte("created_at", since),
      sb.from("report_feedback").select("id, thread_id, seq, user_name, note, created_at").eq("ok", false).not("note", "is", null).order("created_at", { ascending: false }).limit(10),
    ]);
    if (all.error) throw all.error;
    if (recent.error) throw recent.error;
    const rows = (all.data || []) as { ok: boolean }[];
    return NextResponse.json({ ok: true, days: 30, good: rows.filter((r) => r.ok).length, bad: rows.filter((r) => !r.ok).length, recentBad: recent.data || [] });
  } catch (e) {
    if (isPending140(e)) return pending();
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "피드백 집계를 불러오지 못했습니다.") }, { status: 500 });
  }
}
