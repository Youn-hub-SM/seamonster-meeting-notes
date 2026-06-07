import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { normalizeCompany, CompanyInput } from "@/app/lib/b2b-types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("companies")
      .select("*")
      .order("name", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ ok: true, companies: data ?? [] });
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
    const { data, error } = await sb
      .from("companies")
      .insert({
        name: clean.name,
        biz_no: clean.biz_no,
        ceo_name: clean.ceo_name,
        contact_name: clean.contact_name,
        contact_phone: clean.contact_phone,
        contact_email: clean.contact_email,
        address: clean.address,
        payment_terms: clean.payment_terms,
        notes: clean.notes,
      })
      .select()
      .single();
    if (error) throw error;
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
    const { data, error } = await sb
      .from("companies")
      .update({
        name: clean.name,
        biz_no: clean.biz_no,
        ceo_name: clean.ceo_name,
        contact_name: clean.contact_name,
        contact_phone: clean.contact_phone,
        contact_email: clean.contact_email,
        address: clean.address,
        payment_terms: clean.payment_terms,
        notes: clean.notes,
      })
      .eq("id", body.id)
      .select()
      .single();
    if (error) throw error;
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
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[b2b/companies DELETE]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "삭제 실패") },
      { status: 500 }
    );
  }
}
