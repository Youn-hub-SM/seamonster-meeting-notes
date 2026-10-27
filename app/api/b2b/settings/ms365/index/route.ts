import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg, supabaseAdmin } from "@/app/lib/supabase";
import { adminOnly } from "@/app/lib/admin-req";
import { isMsConfigured } from "@/app/lib/msgraph";
import { reindexNow } from "@/app/lib/ms365-docs";
import { lastIndexRun } from "@/app/lib/ms365-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Hobby 도 Fluid compute 에서 300초까지(2026 기준) — 색인 한 번에 더 많이 읽는다

// GET — 마지막 색인 요약 + 상태별 건수 + 실패 사유 상위(어떤 파일이 왜 안 읽혔는지 — 관리자가 브라우저로 열어 본다)
export async function GET(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny;
  const sb = supabaseAdmin();
  const counts: Record<string, number> = {};
  for (const st of ["ok", "skipped", "error", "pending"]) {
    const { count } = await sb.from("ms365_doc_index").select("ref", { count: "exact", head: true }).eq("status", st);
    counts[st] = count || 0;
  }
  const { data: errRows } = await sb.from("ms365_doc_index").select("name, path, size_kb, error, indexed_at").eq("status", "error").order("indexed_at", { ascending: false }).limit(300);
  const byReason = new Map<string, { count: number; samples: string[] }>();
  for (const r of errRows || []) {
    const key = String(r.error || "").replace(/\d+/g, "#").slice(0, 120);
    const b = byReason.get(key) || { count: 0, samples: [] };
    b.count++; if (b.samples.length < 3) b.samples.push(`${r.path || r.name} (${r.size_kb}KB)`);
    byReason.set(key, b);
  }
  const reasons = [...byReason.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.count - a.count).slice(0, 15);
  return NextResponse.json({ ok: true, last: await lastIndexRun(), counts, errorReasons: reasons, recentErrors: (errRows || []).slice(0, 20) });
}

// POST — 문서 색인 갱신(관리자). 시간 예산 280초 안에서 바뀐 파일만 읽는다. 남으면 다음 실행(크론·버튼)이 이어서.
export async function POST(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny;
  try {
    if (!isMsConfigured()) return NextResponse.json({ ok: false, error: "Vercel 환경 변수 MS_TENANT_ID·MS_CLIENT_ID·MS_CLIENT_SECRET 가 없습니다(docs/ms365-setup.md)." }, { status: 400 });
    const s = await reindexNow({ budgetMs: 280_000 });
    return NextResponse.json({ ok: true, summary: s });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "색인 갱신 실패") }, { status: 500 });
  }
}
