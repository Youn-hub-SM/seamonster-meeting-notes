import { NextRequest, NextResponse } from "next/server";
import { listIgMedia } from "@/app/lib/instagram";
import { getIgAccounts } from "@/app/lib/ig-dm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?account=<igUserId> — 그 계정의 최근 게시물(규칙 만들 때 픽커용)
export async function GET(req: NextRequest) {
  try {
    const igUserId = new URL(req.url).searchParams.get("account") || "";
    const acc = (await getIgAccounts()).find((a) => a.igUserId === igUserId);
    if (!acc) return NextResponse.json({ ok: false, error: "등록되지 않은 계정입니다." }, { status: 404 });
    const media = await listIgMedia(acc.token, 25);
    return NextResponse.json({
      ok: true,
      media: media.map((m) => ({
        id: m.id,
        caption: (m.caption || "").slice(0, 80),
        permalink: m.permalink || "",
        thumb: m.media_type === "VIDEO" ? m.thumbnail_url || "" : m.media_url || "",
        timestamp: m.timestamp || "",
      })),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "게시물 조회 실패" }, { status: 500 });
  }
}
