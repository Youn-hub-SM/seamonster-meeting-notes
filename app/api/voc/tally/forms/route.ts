import { NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getTallyApiKey, tallyFetch } from "@/app/lib/voc-tally";

export const dynamic = "force-dynamic";

// GET /api/voc/tally/forms — 저장된 API 키로 Tally 폼 목록 조회(가져올 폼 선택용)
export async function GET() {
  try {
    const apiKey = await getTallyApiKey();
    if (!apiKey) return NextResponse.json({ ok: false, error: "Tally API 키를 먼저 저장하세요." }, { status: 400 });

    const json = await tallyFetch("/forms", apiKey);
    const items: unknown[] = Array.isArray(json) ? json : (json.items || json.forms || []);
    const forms = items.map((f) => {
      const o = f as { id?: string; name?: string; title?: string };
      return { id: o.id || "", name: o.name || o.title || o.id || "(이름 없음)" };
    }).filter((f) => f.id);
    return NextResponse.json({ ok: true, forms });
  } catch (err) {
    console.error("[voc/tally/forms]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "폼 조회 실패") }, { status: 500 });
  }
}
