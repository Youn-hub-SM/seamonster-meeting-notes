import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getTallyApiKey, getTallyFormId, getTallyCursor, setTallyCursor, tallyFetch } from "@/app/lib/voc-tally";
import { VOC_CATEGORIES } from "@/app/lib/voc";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
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

// 제출 → VOC 행. 폼이 제각각이라 모든 Q&A 를 내용에 그대로 보존하고, 유형·사진만 가볍게 추출.
function mapSubmission(sub: Sub, qmap: Map<string, Q>): Record<string, unknown> {
  const photos: string[] = [];
  const lines: string[] = [];
  let category = "기타";
  for (const r of sub.responses || []) {
    const q: Q = qmap.get(r.questionId) || { id: "" };
    const title = (q.title || "").trim();
    const type = (q.type || "").toUpperCase();
    if (type.includes("FILE") || type.includes("UPLOAD")) {
      if (Array.isArray(r.answer)) for (const it of r.answer) { const u = it && typeof it === "object" ? (it as { url?: string }).url : null; if (u) photos.push(u); }
      continue;
    }
    const ans = r.formattedAnswer != null && r.formattedAnswer !== "" ? stringify(r.formattedAnswer) : stringify(r.answer);
    if (!ans) continue;
    if (/(유형|분류|카테고리)/.test(title.replace(/\s/g, "")) && (VOC_CATEGORIES as readonly string[]).includes(ans)) category = ans;
    lines.push(title ? `${title}: ${ans}` : ans);
  }
  const row: Record<string, unknown> = {
    source: "설문",
    channel: "설문(Tally)",
    received_at: (sub.submittedAt || "").slice(0, 10) || TODAY(),
    category,
    content: lines.join("\n") || "(설문 응답)",
    created_by: `tally:${sub.id}`,
  };
  if (photos.length) row.photos = photos;
  return row;
}

export async function POST() {
  try {
    const [apiKey, formId] = await Promise.all([getTallyApiKey(), getTallyFormId()]);
    if (!apiKey) return NextResponse.json({ ok: false, error: "Tally API 키를 먼저 저장하세요." }, { status: 400 });
    if (!formId) return NextResponse.json({ ok: false, error: "가져올 폼을 먼저 선택하세요." }, { status: 400 });

    // 60일 전 또는 마지막 가져온 시각 이후만 (증분)
    const cursor = (await getTallyCursor()) || new Date(Date.now() - 60 * 86400_000).toISOString();

    // 이미 가져온 제출 set (중복 방지)
    const { data: existing } = await supabaseAdmin().from("voc").select("created_by").like("created_by", "tally:%");
    const seen = new Set((existing || []).map((r) => r.created_by as string));

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
        if (seen.has(`tally:${sub.id}`)) { skipped++; continue; }
        newRows.push(mapSubmission(sub, qmap));
      }
      if (!json.hasMore || subs.length === 0) break;
    }

    let imported = 0;
    if (newRows.length) {
      const { error } = await supabaseAdmin().from("voc").insert(newRows);
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
