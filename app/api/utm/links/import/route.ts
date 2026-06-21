import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

// 기존 구글시트 UTM 기록을 utm_links 로 일괄 이관.
// body: { rows: [{ date?, baseUrl, source, medium, campaign, content, term, fullUrl }] }
//   - date 는 구 시트의 '생성일시'(한국어 로캘 문자열). 파싱되면 created_at 으로 보존.
//   - rows 는 시트 순서(위=오래된 것)대로 보내면 순서가 유지됨.
//   - full_url 중복은 건너뜀(이미 있으면 추가 안 함).

// "2026. 6. 21. 오후 3:45:12" 형태의 한국어 로캘 일시 → ISO(UTC). 실패 시 null.
function parseKoreanDateTime(s: string): string | null {
  if (!s || typeof s !== "string") return null;
  const m = s.match(
    /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) return null;
  const [, y, mo, d, ampm, hhRaw, mm, ss] = m;
  let hh = parseInt(hhRaw, 10);
  if (ampm === "오후" && hh < 12) hh += 12;
  if (ampm === "오전" && hh === 12) hh = 0;
  // 입력은 KST(UTC+9) 기준 → UTC 로 변환해 정확한 순간 저장
  const ms = Date.UTC(+y, +mo - 1, +d, hh - 9, +mm, ss ? +ss : 0);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: Array<Record<string, unknown>> };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) {
      return NextResponse.json({ ok: false, error: "가져올 행이 없습니다." }, { status: 400 });
    }

    const sb = supabaseAdmin();

    // 기존 full_url 집합 — 중복 방지
    const { data: existing, error: exErr } = await sb.from("utm_links").select("full_url");
    if (exErr) throw exErr;
    const seen = new Set((existing ?? []).map((r) => r.full_url));

    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    // 날짜 파싱 실패분의 순서 보존용 기준 시각
    const baseMs = Date.now() - rows.length * 1000;

    const toInsert: Array<Record<string, unknown>> = [];
    let skipped = 0;
    rows.forEach((r, i) => {
      const fullUrl = str(r.fullUrl);
      if (!fullUrl) {
        skipped++;
        return;
      }
      if (seen.has(fullUrl)) {
        skipped++;
        return;
      }
      seen.add(fullUrl);
      const createdAt = parseKoreanDateTime(str(r.date)) ?? new Date(baseMs + i * 1000).toISOString();
      toInsert.push({
        created_at: createdAt,
        base_url: str(r.baseUrl),
        source: str(r.source),
        medium: str(r.medium),
        campaign: str(r.campaign),
        content: str(r.content),
        term: str(r.term),
        note: str(r.note),
        full_url: fullUrl,
      });
    });

    let inserted = 0;
    if (toInsert.length) {
      const { error } = await sb.from("utm_links").insert(toInsert);
      if (error) throw error;
      inserted = toInsert.length;
    }

    return NextResponse.json({ ok: true, inserted, skipped });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "가져오기 실패") }, { status: 500 });
  }
}
