import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { VOC_CATEGORIES, VOC_CAT_STATUSES, VOC_FAULTS, suggestFault, type VocCategoryRow } from "@/app/lib/voc";

export const dynamic = "force-dynamic";

// VOC 문제 유형 마스터(072 voc_categories) — 유형 추가/편집 + 유형별 개선 상태.
//  072 미적용 환경 폴백: 기존 하드코딩 8종을 읽기 전용(managed:false)으로 합성해 화면이 죽지 않게 한다.

const missing = (msg: string) => /voc_categories|relation|schema cache/i.test(msg);

function fallbackRows(): VocCategoryRow[] {
  return VOC_CATEGORIES.map((name, i) => ({
    id: name, name, fault: suggestFault(name), status: "관찰" as const,
    resolved_at: null, sort: i + 1, active: true, memo: null,
  }));
}

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin()
      .from("voc_categories").select("*").order("sort", { ascending: true }).order("name", { ascending: true });
    if (error) {
      if (missing(error.message)) return NextResponse.json({ ok: true, categories: fallbackRows(), managed: false });
      throw error;
    }
    return NextResponse.json({ ok: true, categories: data ?? [], managed: true });
  } catch (err) {
    console.error("[voc/categories GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "유형 조회 실패") }, { status: 500 });
  }
}

// POST { id?, name, fault?, sort?, active?, memo? } — 생성/수정. 이름 변경 시 기존 voc 행의 category 도 함께 갱신.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Partial<VocCategoryRow>;
    const name = String(b.name || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "유형 이름을 입력하세요." }, { status: 400 });
    if (name.length > 30) return NextResponse.json({ ok: false, error: "유형 이름은 30자 이내로." }, { status: 400 });
    const fault = VOC_FAULTS.includes(b.fault as never) ? b.fault : "미분류";
    const sb = supabaseAdmin();

    const patch: Record<string, unknown> = {
      name, fault,
      sort: Number.isFinite(Number(b.sort)) ? Math.round(Number(b.sort)) : 0,
      active: b.active !== false,
      memo: String(b.memo || "").trim() || null,
      updated_at: new Date().toISOString(),
    };

    if (b.id) {
      // 이름이 바뀌면 기존 VOC 행의 category 를 새 이름으로 캐스케이드(집계 연속성 유지)
      const { data: prev, error: pe } = await sb.from("voc_categories").select("name").eq("id", b.id).single();
      if (pe) throw pe;
      const { error } = await sb.from("voc_categories").update(patch).eq("id", b.id);
      if (error) throw error;
      if (prev && prev.name !== name) {
        const { error: ce } = await sb.from("voc").update({ category: name }).eq("category", prev.name);
        if (ce) throw ce;
      }
    } else {
      const { error } = await sb.from("voc_categories").insert(patch);
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return NextResponse.json({ ok: false, error: "이미 있는 유형 이름입니다." }, { status: 400 });
        throw error;
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[voc/categories POST]", err);
    const msg = extractErrorMsg(err, "유형 저장 실패");
    return NextResponse.json({ ok: false, error: missing(msg) ? "072_voc_categories.sql 마이그레이션을 먼저 적용하세요." : msg }, { status: 500 });
  }
}

// PATCH { id, status } — 유형별 개선 상태 변경. '개선완료' 전환 시 resolved_at 기록(재발로 되돌려도 지우지 않음 → 결산 소급 불변).
export async function PATCH(req: NextRequest) {
  try {
    const b = (await req.json()) as { id?: string; status?: string };
    if (!b.id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    if (!VOC_CAT_STATUSES.includes(b.status as never)) return NextResponse.json({ ok: false, error: "상태가 올바르지 않습니다." }, { status: 400 });
    const patch: Record<string, unknown> = { status: b.status, updated_at: new Date().toISOString() };
    if (b.status === "개선완료") patch.resolved_at = new Date().toISOString();
    const { data, error } = await supabaseAdmin().from("voc_categories").update(patch).eq("id", b.id).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, category: data });
  } catch (err) {
    console.error("[voc/categories PATCH]", err);
    const msg = extractErrorMsg(err, "상태 변경 실패");
    return NextResponse.json({ ok: false, error: missing(msg) ? "072_voc_categories.sql 마이그레이션을 먼저 적용하세요." : msg }, { status: 500 });
  }
}

// DELETE ?id= — 해당 유형을 쓰는 VOC 가 있으면 삭제 대신 비활성(과거 데이터 보존), 없으면 삭제.
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { data: row, error: re } = await sb.from("voc_categories").select("name").eq("id", id).single();
    if (re) throw re;
    const { count } = await sb.from("voc").select("id", { count: "exact", head: true }).eq("category", row.name);
    if ((count ?? 0) > 0) {
      const { error } = await sb.from("voc_categories").update({ active: false, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      return NextResponse.json({ ok: true, deactivated: true, used: count });
    }
    const { error } = await sb.from("voc_categories").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true, deleted: true });
  } catch (err) {
    console.error("[voc/categories DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
