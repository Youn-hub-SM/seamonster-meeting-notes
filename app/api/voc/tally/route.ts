import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getTallySecret } from "@/app/lib/voc-tally";
import { findRespondent, summarizeAnswers, type SurveyAnswer } from "@/app/lib/surveys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/voc/tally  — Tally 폼 제출 웹훅 → 설문 응답(survey_responses) 자동 등록.
//  VOC 클레임과 분리. 미들웨어 인증 예외. 서명 시크릿 설정 시 검증.

type TallyField = { key: string; label: string; type: string; value: unknown; options?: { id: string; text: string }[] };

function fieldValue(f: TallyField): { text: string; urls: string[] } {
  const v = f.value;
  if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "url" in (v[0] as object)) {
    return { text: (v as { name?: string }[]).map((x) => x.name || "").filter(Boolean).join(", "), urls: (v as { url: string }[]).map((x) => x.url).filter(Boolean) };
  }
  const resolve = (x: unknown): string => {
    if (f.options && typeof x === "string") return f.options.find((o) => o.id === x)?.text ?? x;
    return x == null ? "" : String(x);
  };
  if (Array.isArray(v)) return { text: v.map(resolve).join(", "), urls: [] };
  return { text: resolve(v), urls: [] };
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();

    const secret = await getTallySecret();
    if (secret) {
      const sig = req.headers.get("tally-signature") || "";
      const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");
      const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) { console.error("[voc/tally] 서명 불일치"); return NextResponse.json({ ok: false, error: "서명 검증 실패" }, { status: 401 }); }
    }

    const body = JSON.parse(raw) as { eventType?: string; data?: { submissionId?: string; formId?: string; formName?: string; createdAt?: string; fields?: TallyField[] } };
    if (body.eventType && body.eventType !== "FORM_RESPONSE") return NextResponse.json({ ok: true, skipped: body.eventType });

    const d = body.data || {};
    const answers: SurveyAnswer[] = [];
    const photos: string[] = [];
    for (const f of d.fields || []) {
      const { text, urls } = fieldValue(f);
      if (urls.length) photos.push(...urls);
      if (text.trim() || urls.length) answers.push({ label: f.label || "", value: text });
    }

    const row: Record<string, unknown> = {
      source: "tally",
      form_id: d.formId || null,
      form_name: d.formName || null,
      submission_id: d.submissionId || null,
      submitted_at: d.createdAt || null,
      respondent: findRespondent(answers),
      answers,
      summary: summarizeAnswers(answers),
      photos,
    };

    // 중복(웹훅 재시도) 방지
    if (d.submissionId) {
      const { data: dup } = await supabaseAdmin().from("survey_responses").select("id").eq("submission_id", d.submissionId).maybeSingle();
      if (dup) return NextResponse.json({ ok: true, duplicate: true });
    }

    const { data, error } = await supabaseAdmin().from("survey_responses").insert(row).select("id").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, id: data.id });
  } catch (err) {
    console.error("[voc/tally]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}
