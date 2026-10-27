import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession } from "@/app/lib/b2b-auth";
import { CUSTOMER_KINDS, customerPhoneDigits, type CustomerKind, type FlaggedCustomer } from "@/app/lib/fulfill-customers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 단골·블랙 고객 메모(fulfill_customers, migration 156)
//  · GET: 전체 목록(사용 안 함 포함)
//  · POST: 등록 { kind, name, phone?, address?, memo? }
//  · PUT: 수정 { id, kind?, name?, phone?, address?, memo?, active? }
//  · DELETE ?id=: 삭제
//  전화는 숫자만 저장(매출 PII 와 같은 정규화) — 9자리 미만·마스킹 번호는 오류. 표 없음(156 미적용)은 missing=true 로 알린다.

const missingTable = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table|schema cache/i.test(e.message || ""));
const MISSING_MSG = "supabase/migrations/156_fulfill_customers.sql 을 먼저 적용하세요 (fulfill_customers 표 없음)";

type Body = { id?: string; kind?: string; name?: string; phone?: string; address?: string; memo?: string; active?: boolean };

// 입력 검사 — 빈 필수칸은 지시문, 규칙 위반은 서술문(디자인 결정 3차)
function parse(body: Body, partial: boolean): { values: Partial<FlaggedCustomer>; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values: Partial<FlaggedCustomer> = {};
  if (!partial || body.kind !== undefined) {
    const kind = String(body.kind ?? "").trim() as CustomerKind;
    if (!CUSTOMER_KINDS.includes(kind)) errors.kind = "구분을 고르세요(단골·블랙)";
    else values.kind = kind;
  }
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (!name) errors.name = "이름을 입력하세요";
    else if (name.length > 40) errors.name = "40자 이하";
    else values.name = name;
  }
  if (!partial || body.phone !== undefined) {
    const raw = String(body.phone ?? "").trim();
    if (!raw) values.phone_digits = "";
    else {
      const d = customerPhoneDigits(raw);
      if (!d) errors.phone = "전화번호 형식이 아닙니다(숫자 9자리 이상, 010-0000-0000 같은 마스킹 번호 제외)";
      else values.phone_digits = d;
    }
  }
  if (!partial || body.address !== undefined) {
    const a = String(body.address ?? "").trim();
    if (a.length > 120) errors.address = "120자 이하"; else values.address = a;
  }
  if (!partial || body.memo !== undefined) {
    const m = String(body.memo ?? "").trim();
    if (m.length > 300) errors.memo = "300자 이하"; else values.memo = m;
  }
  if (body.active !== undefined) values.active = body.active === true;
  return { values, errors };
}

export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("fulfill_customers").select("*").order("kind", { ascending: true }).order("name", { ascending: true });
    if (error) {
      if (missingTable(error)) return NextResponse.json({ ok: true, customers: [], missing: true });
      throw error;
    }
    return NextResponse.json({ ok: true, customers: data ?? [], missing: false });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "고객 목록 조회 실패") }, { status: 500 });
  }
}

// 같은 전화가 이미 사용 중인 다른 고객에 등록돼 있으면 막는다(한 사람이 단골이면서 블랙일 수 없다)
async function phoneInUse(sb: ReturnType<typeof supabaseAdmin>, digits: string, exceptId: string | null): Promise<FlaggedCustomer | null> {
  if (!digits) return null;
  let q = sb.from("fulfill_customers").select("*").eq("phone_digits", digits).eq("active", true).limit(1);
  if (exceptId) q = q.neq("id", exceptId);
  const { data, error } = await q;
  if (error) throw error;
  return (data?.[0] as FlaggedCustomer | undefined) ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const { values, errors } = parse(body, false);
    if (Object.keys(errors).length) return NextResponse.json({ ok: false, error: "입력을 확인하세요", fields: errors }, { status: 400 });
    const sb = supabaseAdmin();
    const dup = await phoneInUse(sb, values.phone_digits || "", null).catch((e) => { if (missingTable(e)) return null; throw e; });
    if (dup) return NextResponse.json({ ok: false, error: `이미 등록된 전화번호입니다 — ${dup.kind} '${dup.name}'. 그 고객을 수정하세요.`, fields: { phone: `${dup.kind} '${dup.name}'에 등록된 번호` } }, { status: 400 });
    const by = await verifySession(req.cookies.get("b2b_auth")?.value);
    const { data, error } = await sb.from("fulfill_customers").insert({ ...values, created_by: by }).select("*").single();
    if (error) {
      if (missingTable(error)) return NextResponse.json({ ok: false, error: MISSING_MSG }, { status: 400 });
      throw error;
    }
    return NextResponse.json({ ok: true, customer: data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "고객 등록 실패") }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const { values, errors } = parse(body, true);
    if (Object.keys(errors).length) return NextResponse.json({ ok: false, error: "입력을 확인하세요", fields: errors }, { status: 400 });
    const sb = supabaseAdmin();
    if (values.phone_digits) {
      const dup = await phoneInUse(sb, values.phone_digits, id);
      if (dup) return NextResponse.json({ ok: false, error: `이미 등록된 전화번호입니다 — ${dup.kind} '${dup.name}'.`, fields: { phone: `${dup.kind} '${dup.name}'에 등록된 번호` } }, { status: 400 });
    }
    const { data, error } = await sb.from("fulfill_customers").update({ ...values, updated_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
    if (error) {
      if (missingTable(error)) return NextResponse.json({ ok: false, error: MISSING_MSG }, { status: 400 });
      throw error;
    }
    if (!data) return NextResponse.json({ ok: false, error: "고객을 찾을 수 없습니다 — 새로고침하세요." }, { status: 404 });
    return NextResponse.json({ ok: true, customer: data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "고객 수정 실패") }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = (req.nextUrl.searchParams.get("id") || "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { error } = await sb.from("fulfill_customers").delete().eq("id", id);
    if (error) {
      if (missingTable(error)) return NextResponse.json({ ok: false, error: MISSING_MSG }, { status: 400 });
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "고객 삭제 실패") }, { status: 500 });
  }
}
