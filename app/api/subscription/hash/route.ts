import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { subHash, subHashKey, type HashKind } from "@/app/lib/subscription-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/subscription/hash { values: string[] } — 정기배송 분석 화면의 '이름 제외'·'이름/아이디 검색'용.
//  자동 수집 데이터는 이름·아이디를 암호화 값으로만 갖고 있어, 입력값을 같은 방식으로 바꿔 비교한다(127).
//  응답: { name: string[], member: string[] } — values 와 같은 순서. 로그인 사용자만(미들웨어).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { values?: unknown };
    const values = (Array.isArray(b.values) ? b.values : []).slice(0, 50).map((v) => String(v ?? "").slice(0, 100));
    const key = subHashKey();
    const of = (kind: HashKind) => values.map((v) => subHash(kind, v, key) ?? "");
    return NextResponse.json({ ok: true, name: of("name"), member: of("member") });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "변환 실패") }, { status: 500 });
  }
}
