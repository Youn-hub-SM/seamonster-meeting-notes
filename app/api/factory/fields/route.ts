import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho } from "@/app/lib/factory-db";
import { DEFAULT_FACTORY_FIELDS, type FactoryFields } from "@/app/lib/factory";

export const dynamic = "force-dynamic";

// 파도소리 선택 칸(거래처·테잎색) 설정 + 이전에 적은 값 목록 (2026-11-17 대표 지시)
//  - 설정은 b2b_settings kv 'factory_fields' — 켜고 끄면 입출고 창·재고 목록에서 그 칸이 보이거나 숨는다. 모든 파도소리 계정이 바꿀 수 있다.
//  - 값 목록은 stock_txns 에서 최근에 쓴 순으로 모은다(취소 제외) — 입력칸의 드롭다운(datalist)에 쓴다. 자유 입력은 그대로 된다.
const KV_KEY = "factory_fields";
const MAX_SUGGEST = 50;

async function readFields(): Promise<FactoryFields> {
  try {
    const { data } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KV_KEY).maybeSingle();
    const v = (data?.value ?? {}) as Partial<FactoryFields>;
    return { partner: typeof v.partner === "boolean" ? v.partner : DEFAULT_FACTORY_FIELDS.partner, tape_color: typeof v.tape_color === "boolean" ? v.tape_color : DEFAULT_FACTORY_FIELDS.tape_color };
  } catch {
    return { ...DEFAULT_FACTORY_FIELDS };
  }
}

// 최근 순 고유 값 — 1000행 한도 안에서 최신 기록부터 본다(그 안에 없는 아주 옛 값은 빠질 수 있다 — 직접 치면 된다)
async function recentValues(col: "partner" | "tape_color"): Promise<string[]> {
  const { data, error } = await factoryDb().from("stock_txns").select(col)
    .is("cancelled_at", null).not(col, "is", null).order("created_at", { ascending: false }).limit(1000);
  if (error) {
    if (col === "tape_color" && /tape_color/.test(error.message)) return []; // 009 미적용
    throw error;
  }
  const seen = new Set<string>(); const out: string[] = [];
  for (const r of (data || []) as Record<string, unknown>[]) {
    const v = String(r[col] ?? "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v); out.push(v);
    if (out.length >= MAX_SUGGEST) break;
  }
  return out;
}

// GET — { fields, partners, tape_colors }
export async function GET(req: NextRequest) {
  try {
    await factoryWho(req);
    const [fields, partners, tape_colors] = await Promise.all([readFields(), recentValues("partner"), recentValues("tape_color")]);
    return NextResponse.json({ ok: true, fields, partners, tape_colors });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "칸 설정 조회 실패") }, { status: 500 });
  }
}

// POST { partner?: boolean, tape_color?: boolean } — 칸 켜기/끄기
export async function POST(req: NextRequest) {
  try {
    await factoryWho(req);
    const b = (await req.json().catch(() => ({}))) as Partial<FactoryFields>;
    const cur = await readFields();
    const next: FactoryFields = {
      partner: typeof b.partner === "boolean" ? b.partner : cur.partner,
      tape_color: typeof b.tape_color === "boolean" ? b.tape_color : cur.tape_color,
    };
    const { error } = await supabaseAdmin().from("b2b_settings")
      .upsert({ key: KV_KEY, value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return NextResponse.json({ ok: true, fields: next });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "칸 설정 저장 실패") }, { status: 500 });
  }
}
