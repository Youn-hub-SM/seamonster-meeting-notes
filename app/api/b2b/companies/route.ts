import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeCompany, CompanyInput, stripMissingCompanyCols } from "@/app/lib/b2b-types";
import { logCompanyChange } from "@/app/lib/b2b-activity";

export const dynamic = "force-dynamic";

// 저장 행 — 화면이 보낸 키만이 아니라 정해진 칸 전부(계산서 칸은 128 미적용이면 빼고 재시도)
//  undefined 키는 JSON 에서 빠져 그 칸은 그대로 남는다(키를 안 보낸 옛 화면이 새 칸을 지우지 않게).
function companyRow(c: CompanyInput): Record<string, unknown> {
  return {
    name: c.name, biz_no: c.biz_no, ceo_name: c.ceo_name, contact_name: c.contact_name, contact_phone: c.contact_phone,
    contact_email: c.contact_email, address: c.address, payment_terms: c.payment_terms, notes: c.notes, biz_doc_path: c.biz_doc_path,
    biz_type: c.biz_type, biz_item: c.biz_item, biz_address: c.biz_address,
    tax_email: c.tax_email, tax_manager_name: c.tax_manager_name, tax_manager_phone: c.tax_manager_phone,
  };
}

export async function GET() {
  try {
    const sb = supabaseAdmin();
    const [companiesRes, ordersRes] = await Promise.all([
      sb.from("companies").select("*").order("name", { ascending: true }),
      sb.from("orders").select("company_id, order_date"),
    ]);
    if (companiesRes.error) throw companiesRes.error;
    if (ordersRes.error) throw ordersRes.error;

    // 업체별 최근 발주일 계산
    const lastOrderByCompany = new Map<string, string>();
    for (const o of (ordersRes.data ?? []) as { company_id: string; order_date: string }[]) {
      if (!o.company_id || !o.order_date) continue;
      const prev = lastOrderByCompany.get(o.company_id);
      if (!prev || o.order_date > prev) lastOrderByCompany.set(o.company_id, o.order_date);
    }

    const companies = ((companiesRes.data ?? []) as { id: string }[]).map((c) => ({
      ...c,
      last_order_date: lastOrderByCompany.get(c.id) ?? null,
    }));

    return NextResponse.json({ ok: true, companies });
  } catch (err) {
    console.error("[b2b/companies GET]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CompanyInput;
    if (!body.name?.trim()) {
      return NextResponse.json({ ok: false, error: "업체명은 필수입니다." }, { status: 400 });
    }
    const clean = normalizeCompany(body);
    const sb = supabaseAdmin();
    const row = companyRow(clean);
    let { data, error } = await sb.from("companies").insert(row).select().single();
    if (error && stripMissingCompanyCols(row, error.message)) ({ data, error } = await sb.from("companies").insert(row).select().single());
    if (error) throw error;
    await logCompanyChange("created", data.name);
    return NextResponse.json({ ok: true, company: data });
  } catch (err) {
    console.error("[b2b/companies POST]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "등록 실패") },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as CompanyInput;
    if (!body.id) {
      return NextResponse.json({ ok: false, error: "id가 필요합니다." }, { status: 400 });
    }
    if (!body.name?.trim()) {
      return NextResponse.json({ ok: false, error: "업체명은 필수입니다." }, { status: 400 });
    }
    const clean = normalizeCompany(body);
    const sb = supabaseAdmin();
    const row = companyRow(clean);
    let { data, error } = await sb.from("companies").update(row).eq("id", body.id).select().single();
    if (error && stripMissingCompanyCols(row, error.message)) ({ data, error } = await sb.from("companies").update(row).eq("id", body.id).select().single());
    if (error) throw error;
    await logCompanyChange("updated", data.name);
    return NextResponse.json({ ok: true, company: data });
  } catch (err) {
    console.error("[b2b/companies PUT]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "수정 실패") },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ ok: false, error: "id가 필요합니다." }, { status: 400 });
    }
    const sb = supabaseAdmin();
    const { data: snap } = await sb.from("companies").select("name").eq("id", id).single();
    const { error } = await sb.from("companies").delete().eq("id", id);
    if (error) {
      // FK 제약 (orders 가 참조 중) 등
      if (error.code === "23503") {
        return NextResponse.json(
          { ok: false, error: "이 업체로 등록된 발주가 있어 삭제할 수 없습니다." },
          { status: 409 }
        );
      }
      throw error;
    }
    if (snap?.name) await logCompanyChange("deleted", snap.name);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[b2b/companies DELETE]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "삭제 실패") },
      { status: 500 }
    );
  }
}
