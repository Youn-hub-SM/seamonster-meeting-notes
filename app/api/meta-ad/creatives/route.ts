import { NextRequest, NextResponse } from "next/server";
import { getSavedCreatives, addSavedCreative, deleteSavedCreative, type CreativeFormat } from "@/app/lib/meta-creatives";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → 저장된 소재 목록
export async function GET() {
  try {
    return NextResponse.json({ ok: true, creatives: await getSavedCreatives() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "조회 실패" }, { status: 500 });
  }
}

// POST { name, format, hook, story, offer, adLibraryUrl?, note?, roas?, ... } → 저장(3요소 필수)
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const str = (v: unknown) => String(v ?? "").trim();
    const name = str(b.name), hook = str(b.hook), story = str(b.story), offer = str(b.offer);
    if (!name) return NextResponse.json({ ok: false, error: "소재 이름을 입력하세요." }, { status: 400 });
    // 소재 기획 규칙: 후킹·스토리·제안 3요소 필수
    const missing = [!hook && "후킹", !story && "스토리", !offer && "제안"].filter(Boolean);
    if (missing.length) return NextResponse.json({ ok: false, error: `${missing.join("·")} 을(를) 채워주세요 (모든 소재는 후킹+스토리+제안 3요소 필수).` }, { status: 400 });
    const url = str(b.adLibraryUrl);
    if (url && !/^https?:\/\//i.test(url)) return NextResponse.json({ ok: false, error: "광고 라이브러리 URL 은 http(s):// 로 시작해야 합니다." }, { status: 400 });

    const num = (v: unknown) => (v == null || v === "" ? undefined : Number(v) || 0);
    const rec = await addSavedCreative({
      name,
      format: (b.format === "이미지" ? "이미지" : "영상") as CreativeFormat,
      hook, story, offer,
      adLibraryUrl: url,
      note: str(b.note) || undefined,
      roas: num(b.roas), spend: num(b.spend), purchases: num(b.purchases),
      sourceAdId: str(b.sourceAdId) || undefined,
    });
    return NextResponse.json({ ok: true, creative: rec });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "저장 실패" }, { status: 500 });
  }
}

// DELETE ?id= → 삭제
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 필요" }, { status: 400 });
    await deleteSavedCreative(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "삭제 실패" }, { status: 500 });
  }
}
