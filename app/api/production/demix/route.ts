import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import {
  getDemixEnabled, setDemixEnabled,
  getDemixSkus, setDemixSkus,
  getDemixFactor, setDemixFactor,
  DEFAULT_DEMIX_FACTOR,
} from "@/app/lib/production-config";

export const dynamic = "force-dynamic";

// GET — 도매 de-mix 설정(켜짐·화이트리스트·계수)
export async function GET() {
  try {
    const [enabled, skus, factor] = await Promise.all([getDemixEnabled(), getDemixSkus(), getDemixFactor()]);
    return NextResponse.json({ ok: true, enabled, skus, factor, defaultFactor: DEFAULT_DEMIX_FACTOR });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { enabled?, skus?, factor? } — 일부만 보내면 그 항목만 저장
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as { enabled?: boolean; skus?: string[]; factor?: number };
    if (typeof body.enabled === "boolean") await setDemixEnabled(body.enabled);
    if (Array.isArray(body.skus)) await setDemixSkus(body.skus);
    if (body.factor != null) await setDemixFactor(Number(body.factor));
    const [enabled, skus, factor] = await Promise.all([getDemixEnabled(), getDemixSkus(), getDemixFactor()]);
    return NextResponse.json({ ok: true, enabled, skus, factor });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
