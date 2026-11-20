import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { factoryWho, readFactoryCompany, FACTORY_COMPANY_KEY as KV_KEY } from "@/app/lib/factory-db";
import { MAX_IMAGE_CHARS, type FactoryCompany } from "@/app/lib/factory-partners";

export const dynamic = "force-dynamic";

// 파도소리 회사 정보(출고증에 찍히는 상호·대표·전화·팩스·로고·직인) — b2b_settings kv 'factory_company'. 보기는 모든 계정, 고치기는 관리자.
const TEXT: (keyof FactoryCompany)[] = ["name", "ceo", "tel", "fax"];
const IMAGES: (keyof FactoryCompany)[] = ["logo", "seal"];

export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    return NextResponse.json({ ok: true, company: await readFactoryCompany(), admin: u.admin });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "회사 정보 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    if (!u.admin) return NextResponse.json({ ok: false, error: "권한이 없습니다." }, { status: 403 });
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const next = await readFactoryCompany();
    for (const k of TEXT) {
      if (b[k] === undefined) continue;
      const v = String(b[k] ?? "").trim();
      if (v.length > 60) return NextResponse.json({ ok: false, error: "입력이 너무 깁니다(60자까지)." }, { status: 400 });
      next[k] = v;
    }
    for (const k of IMAGES) {
      if (b[k] === undefined) continue;
      const v = String(b[k] ?? "");
      if (v && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return NextResponse.json({ ok: false, error: "그림은 PNG·JPG 파일만 넣을 수 있습니다." }, { status: 400 });
      if (v.length > MAX_IMAGE_CHARS) return NextResponse.json({ ok: false, error: "그림이 너무 큽니다(300KB 까지)." }, { status: 400 });
      next[k] = v;
    }
    const { error } = await supabaseAdmin().from("b2b_settings")
      .upsert({ key: KV_KEY, value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return NextResponse.json({ ok: true, company: next });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "회사 정보 저장 실패") }, { status: 500 });
  }
}
