import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getTallyApiKey, getTallyFormId, getTallyCursor, setTallyCursor, tallyFetch } from "@/app/lib/voc-tally";
import { findRespondent, summarizeAnswers, type SurveyAnswer } from "@/app/lib/surveys";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PAGES = 20;

type Q = { id: string; type?: string; title?: string };
type Resp = { questionId: string; answer?: unknown; formattedAnswer?: unknown };
type Sub = { id: string; submittedAt?: string; responses?: Resp[] };

function stringify(a: unknown): string {
  if (a == null) return "";
  if (Array.isArray(a)) return a.map(stringify).filter(Boolean).join(", ");
  if (typeof a === "object") { try { return JSON.stringify(a); } catch { return ""; } }
  return String(a);
}

// 제출 → 설문 응답 행. 폼이 제각각이라 모든 Q&A 를 그대로 보존, 파일은 photos 로 분리.
function mapSubmission(sub: Sub, qmap: Map<string, Q>, formId: string): Record<string, unknown> {
  const answers: SurveyAnswer[] = [];
  const photos: string[] = [];
  for (const r of sub.responses || []) {
    const q: Q = qmap.get(r.questionId) || { id: "" };
    const title = (q.title || "").trim();
    const type = (q.type || "").toUpperCase();
    if (type.includes("FILE") || type.includes("UPLOAD")) {
      if (Array.isArray(r.answer)) for (const it of r.answer) { const u = it && typeof it === "object" ? (it as { url?: string }).url : null; if (u) photos.push(u); }
      const fa = stringify(r.formattedAnswer);
      if (fa) answers.push({ label: title || "첨부", value: fa });
      continue;
    }
    const ans = r.formattedAnswer != null && r.formattedAnswer !== "" ? stringify(r.formattedAnswer) : stringify(r.answer);
    if (!ans && !title) continue;
    answers.push({ label: title, value: ans });
  }
  return {
    source: "tally",
    form_id: formId,
    submission_id: sub.id,
    submitted_at: sub.submittedAt || null,
    respondent: findRespondent(answers),
    answers,
    summary: summarizeAnswers(answers),
    photos,
  };
}

export async function POST() {
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
        newRows.push(mapSubmission(sub, qmap, formId));
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
