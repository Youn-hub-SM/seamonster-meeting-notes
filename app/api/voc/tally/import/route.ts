import { NextRequest, NextResponse } from "next/server";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getTallyApiKey, getTallyFormId, getTallyCursor, setTallyCursor, tallyFetch, mapTallySubmission, type TallyQ, type TallySub } from "@/app/lib/voc-tally";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PAGES = 20;

type Q = TallyQ;
type Sub = TallySub;

// 2026-10-29: 미들웨어 matcher 가 /api/voc/tally 하위 경로까지 제외해 왔으므로 여기서 직접 로그인 쿠키를 검사한다(웹훅 /api/voc/tally 만 서명 검증으로 공개).
export async function POST(req: NextRequest) {
  const token = req.cookies.get("b2b_auth")?.value;
  if (!(await verifySession(token)) && !resolveUserName(token)) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 401 });
  try {
    const [apiKey, formId] = await Promise.all([getTallyApiKey(), getTallyFormId()]);
    if (!apiKey) return NextResponse.json({ ok: false, error: "Tally API 키를 먼저 저장하세요." }, { status: 400 });
    if (!formId) return NextResponse.json({ ok: false, error: "가져올 폼을 먼저 선택하세요." }, { status: 400 });

    const cursor = (await getTallyCursor()) || new Date(Date.now() - 60 * 86400_000).toISOString();

    // 이미 가져온 제출 set (중복 방지)
    const { data: existing } = await supabaseAdmin().from("survey_responses").select("submission_id").eq("source", "tally");
    const seen = new Set((existing || []).map((r) => r.submission_id as string));

    const qmap = new Map<string, Q>();
    const newRows: Record<string, unknown>[] = [];
    let scanned = 0, skipped = 0, maxAt = cursor;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const json = await tallyFetch(`/forms/${formId}/submissions?filter=completed&limit=100&page=${page}&startDate=${encodeURIComponent(cursor)}`, apiKey);
      for (const q of (json.questions || []) as Q[]) if (q.id) qmap.set(q.id, q);
      const subs = (json.submissions || []) as Sub[];
      for (const sub of subs) {
        scanned++;
        if (sub.submittedAt && sub.submittedAt > maxAt) maxAt = sub.submittedAt;
        if (seen.has(sub.id)) { skipped++; continue; }
        newRows.push(mapTallySubmission(sub, qmap, formId));
      }
      if (!json.hasMore || subs.length === 0) break;
    }

    let imported = 0;
    if (newRows.length) {
      const { error } = await supabaseAdmin().from("survey_responses").insert(newRows);
      if (error) throw error;
      imported = newRows.length;
    }
    if (maxAt > cursor) await setTallyCursor(maxAt);

    return NextResponse.json({ ok: true, imported, skipped, scanned });
  } catch (err) {
    console.error("[voc/tally/import]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "가져오기 실패") }, { status: 500 });
  }
}
