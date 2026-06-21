import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import {
  getUrlPresets,
  setUrlPresets,
  getSourceMediumMap,
  setSourceMediumMap,
  type UrlPreset,
  type SourceMediumMap,
} from "@/app/lib/utm";

export const dynamic = "force-dynamic";

// GET /api/utm/settings — 즐겨찾기 + 소스·매체 맵
export async function GET() {
  try {
    const [presets, sourceMediumMap] = await Promise.all([getUrlPresets(), getSourceMediumMap()]);
    return NextResponse.json({ ok: true, presets, sourceMediumMap });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/utm/settings — { presets?, sourceMediumMap? } 둘 중 보낸 것만 저장
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      presets?: UrlPreset[];
      sourceMediumMap?: SourceMediumMap;
    };

    const tasks: Promise<void>[] = [];
    if (Array.isArray(body.presets)) {
      const clean = body.presets
        .filter((p) => p && typeof p.value === "string" && p.value.trim())
        .map((p) => ({ label: String(p.label ?? "").trim() || p.value, value: p.value.trim() }));
      tasks.push(setUrlPresets(clean));
    }
    if (body.sourceMediumMap && typeof body.sourceMediumMap === "object") {
      const clean: SourceMediumMap = {};
      for (const [src, meds] of Object.entries(body.sourceMediumMap)) {
        if (!src) continue;
        clean[src] = Array.isArray(meds) ? meds.filter((m) => typeof m === "string" && m.trim()) : [];
      }
      tasks.push(setSourceMediumMap(clean));
    }

    if (!tasks.length) {
      return NextResponse.json({ ok: false, error: "저장할 항목이 없습니다." }, { status: 400 });
    }
    await Promise.all(tasks);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
