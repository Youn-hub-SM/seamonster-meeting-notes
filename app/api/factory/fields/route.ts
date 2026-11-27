import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { factoryDb, factoryWho } from "@/app/lib/factory-db";
import { DEFAULT_FACTORY_FIELDS, DEFAULT_STORAGE, isDefaultStorage, type FactoryFields } from "@/app/lib/factory";

export const dynamic = "force-dynamic";

// 파도소리 선택 칸(거래처·테잎색) 설정 + 이전에 적은 값 목록 (2026-11-17 대표 지시)
//  - 설정은 b2b_settings kv 'factory_fields' — 켜고 끄면 입출고 창·재고 목록에서 그 칸이 보이거나 숨는다. 모든 파도소리 계정이 바꿀 수 있다.
//  - 값 목록은 stock_txns 에서 최근에 쓴 순으로 모은다(취소 제외) — 입력칸의 드롭다운(datalist)에 쓴다. 자유 입력은 그대로 된다.
const KV_KEY = "factory_fields";
const MAX_SUGGEST = 50;
// 입고지 목록(011, 화면 이름은 입고지) — b2b_settings kv 'factory_storages'. 기본 입고지(구평)는 늘 맨 앞에 있고 지울 수 없다. 추가·삭제는 관리자만.
//  kv 가 아직 없으면 구평·외부(2026-11-27 대표 지시) — 한 번이라도 저장하면 그 목록이 전부다(외부를 빼면 빠진 채로 남는다).
const STORAGE_KEY = "factory_storages";
const MAX_STORAGES = 40;

const INITIAL_STORAGES = [DEFAULT_STORAGE, "외부"];
async function readStorages(): Promise<string[]> {
  try {
    const { data } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", STORAGE_KEY).maybeSingle();
    if (!data) return [...INITIAL_STORAGES];
    const v = Array.isArray(data.value) ? (data.value as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
    return [DEFAULT_STORAGE, ...v.filter((x) => !isDefaultStorage(x))].slice(0, MAX_STORAGES);
  } catch {
    return [...INITIAL_STORAGES];
  }
}
// 011(구분·보관처·단가·이동) 적용 여부 — 적용 전에는 화면이 새 칸을 보이지 않는다
// 거래처 목록(012)의 이름 — 기록 창의 거래처 칸이 이 목록을 먼저 보여 준다. 표가 없으면 빈 목록
async function partnerNames(): Promise<string[]> {
  const { data, error } = await factoryDb().from("partners").select("name").order("name").limit(1000);
  if (error) return [];
  return ((data || []) as { name: string }[]).map((p) => p.name);
}
async function kindsReady(): Promise<boolean> {
  const { error } = await factoryDb().from("stock_txns").select("kind, storage, unit_price, move_id").limit(1);
  return !error;
}

async function readFields(): Promise<FactoryFields> {
  try {
    const { data } = await supabaseAdmin().from("b2b_settings").select("value").eq("key", KV_KEY).maybeSingle();
    const v = (data?.value ?? {}) as Partial<FactoryFields>;
    const pick = (k: keyof FactoryFields) => (typeof v[k] === "boolean" ? (v[k] as boolean) : DEFAULT_FACTORY_FIELDS[k]);
    return { partner: pick("partner"), tape_color: pick("tape_color"), vessel: pick("vessel") };
  } catch {
    return { ...DEFAULT_FACTORY_FIELDS };
  }
}

// 최근 순 고유 값 — 1000행 한도 안에서 최신 기록부터 본다(그 안에 없는 아주 옛 값은 빠질 수 있다 — 직접 치면 된다)
async function recentValues(col: "partner" | "tape_color" | "vessel"): Promise<string[]> {
  const { data, error } = await factoryDb().from("stock_txns").select(col)
    .is("cancelled_at", null).not(col, "is", null).order("created_at", { ascending: false }).limit(1000);
  if (error) {
    if (col === "tape_color" && /tape_color/.test(error.message)) return []; // 009 미적용
    if (col === "vessel" && /vessel/.test(error.message)) return []; // 012 미적용
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

// GET — { fields, partners, tape_colors, vessels, storages, kinds, admin }
export async function GET(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    const [fields, recent, tape_colors, vessels, storages, kinds, listed] = await Promise.all([readFields(), recentValues("partner"), recentValues("tape_color"), recentValues("vessel"), readStorages(), kindsReady(), partnerNames()]);
    // 목록에 등록된 거래처 먼저, 그 뒤에 목록에 없는 최근 입력값
    const partners = [...listed, ...recent.filter((x) => !listed.includes(x))];
    return NextResponse.json({ ok: true, fields, partners, tape_colors, vessels, storages, kinds, admin: u.admin });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "칸 설정 조회 실패") }, { status: 500 });
  }
}

// POST { partner?: boolean, tape_color?: boolean } — 칸 켜기/끄기
// POST { add_storage?: 이름, remove_storage?: 이름 } — 입고지 목록(관리자만). 목록에서 지워도 기록·재고에는 그대로 남는다(고르는 목록에서만 빠진다)
export async function POST(req: NextRequest) {
  try {
    const u = await factoryWho(req);
    const b = (await req.json().catch(() => ({}))) as Partial<FactoryFields> & { add_storage?: unknown; remove_storage?: unknown };
    if (b.add_storage !== undefined || b.remove_storage !== undefined) {
      if (!u.admin) return NextResponse.json({ ok: false, error: "입고지 목록은 관리자만 바꿀 수 있습니다." }, { status: 403 });
      let list = await readStorages();
      const add = String(b.add_storage ?? "").trim(), rm = String(b.remove_storage ?? "").trim();
      if (add) {
        if (add.length > 40) return NextResponse.json({ ok: false, error: "입고지 이름이 너무 깁니다(40자까지)." }, { status: 400 });
        if (list.length >= MAX_STORAGES) return NextResponse.json({ ok: false, error: `입고지는 ${MAX_STORAGES}곳까지 둘 수 있습니다.` }, { status: 400 });
        if (!list.includes(add)) list.push(add);
      }
      if (rm && !isDefaultStorage(rm)) list = list.filter((x) => x !== rm);
      const { error } = await supabaseAdmin().from("b2b_settings")
        .upsert({ key: STORAGE_KEY, value: list.filter((x) => x !== DEFAULT_STORAGE), updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) throw error;
      return NextResponse.json({ ok: true, storages: list });
    }
    const cur = await readFields();
    const next: FactoryFields = {
      partner: typeof b.partner === "boolean" ? b.partner : cur.partner,
      tape_color: typeof b.tape_color === "boolean" ? b.tape_color : cur.tape_color,
      vessel: typeof b.vessel === "boolean" ? b.vessel : cur.vessel,
    };
    const { error } = await supabaseAdmin().from("b2b_settings")
      .upsert({ key: KV_KEY, value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return NextResponse.json({ ok: true, fields: next });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "칸 설정 저장 실패") }, { status: 500 });
  }
}
