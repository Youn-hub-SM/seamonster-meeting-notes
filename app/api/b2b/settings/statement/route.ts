import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getKv, setKv } from "@/app/lib/b2b-settings";

export const dynamic = "force-dynamic";

// 거래명세표 발행용 공급자(우리 회사) 정보 + 직인 이미지.
//  b2b_settings KV 에 저장(마이그레이션 불필요): statement_supplier(JSON 문자열), statement_stamp(data URL).

export type StatementSupplier = {
  name: string;      // 상호
  biz_no: string;    // 사업자등록번호
  ceo: string;       // 대표자
  addr: string;      // 사업장 소재지
  biz_type: string;  // 업태
  biz_item: string;  // 종목
  email: string;     // 이메일
};

const EMPTY: StatementSupplier = { name: "", biz_no: "", ceo: "", addr: "", biz_type: "", biz_item: "", email: "youn@seamonster.kr" };

export async function GET() {
  try {
    const [raw, stamp] = await Promise.all([getKv("statement_supplier"), getKv("statement_stamp")]);
    let supplier: StatementSupplier = EMPTY;
    try { if (raw) supplier = { ...EMPTY, ...(JSON.parse(raw) as Partial<StatementSupplier>) }; } catch { /* 손상 시 빈값 */ }
    return NextResponse.json({ ok: true, supplier, stamp: stamp || "" });
  } catch (err) {
    console.error("[b2b/settings/statement GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { supplier?: Partial<StatementSupplier>; stamp?: string };
    if (b.supplier) {
      const s: StatementSupplier = { ...EMPTY };
      for (const k of Object.keys(EMPTY) as (keyof StatementSupplier)[]) s[k] = String(b.supplier[k] ?? "").trim();
      await setKv("statement_supplier", JSON.stringify(s));
    }
    if (b.stamp !== undefined) {
      const stamp = String(b.stamp || "");
      if (stamp && !stamp.startsWith("data:image/")) {
        return NextResponse.json({ ok: false, error: "직인은 이미지 파일이어야 합니다." }, { status: 400 });
      }
      if (stamp.length > 700_000) {
        return NextResponse.json({ ok: false, error: "직인 이미지가 너무 큽니다(500KB 이하 PNG 권장)." }, { status: 400 });
      }
      await setKv("statement_stamp", stamp); // 빈 문자열이면 직인 제거
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[b2b/settings/statement POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
