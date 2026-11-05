import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import {
  getUrlPresets,
  setUrlPresets,
  getSourceMediumMap,
  setSourceMediumMap,
  getContentSlugs,
  setContentSlugs,
  getCrmMediaExtra,
  setCrmMediaExtra,
  type UrlPreset,
  type SourceMediumMap,
  type ContentSlugs,
} from "@/app/lib/utm";
import { CRM_MEDIA, CRM_SOURCE, SLUG_RE, type CrmMediumExtra } from "@/app/lib/utm-rules";

export const dynamic = "force-dynamic";

// GET /api/utm/settings — 즐겨찾기 + 소스·매체 맵 + CRM 규칙(매체 4종·슬러그 사전)
export async function GET() {
  try {
    const [presets, sourceMediumMap, contentSlugs, crmMediaExtra] = await Promise.all([getUrlPresets(), getSourceMediumMap(), getContentSlugs(), getCrmMediaExtra()]);
    return NextResponse.json({ ok: true, presets, sourceMediumMap, contentSlugs, crmMediaExtra, crm: { source: CRM_SOURCE, media: CRM_MEDIA } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/utm/settings — { presets?, sourceMediumMap?, contentSlugs? } 보낸 것만 저장
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      presets?: UrlPreset[];
      sourceMediumMap?: SourceMediumMap;
      contentSlugs?: ContentSlugs;
      crmMediaExtra?: CrmMediumExtra[];
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
    if (body.contentSlugs && typeof body.contentSlugs === "object") {
      const clean: ContentSlugs = {};
      for (const [k, v] of Object.entries(body.contentSlugs)) {
        const key = String(k ?? "").trim();
        const val = String(v ?? "").trim().toLowerCase();
        if (key && val) clean[key] = val;
      }
      tasks.push(setContentSlugs(clean));
    }
    if (Array.isArray(body.crmMediaExtra)) {
      const seen = new Set<string>();
      const clean: CrmMediumExtra[] = [];
      for (const m of body.crmMediaExtra) {
        const value = String(m?.value ?? "").trim().toLowerCase();
        if (!value || !SLUG_RE.test(value) || seen.has(value)) continue;
        seen.add(value);
        clean.push({ value, label: String(m?.label ?? "").trim() || value });
      }
      tasks.push(setCrmMediaExtra(clean));
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
