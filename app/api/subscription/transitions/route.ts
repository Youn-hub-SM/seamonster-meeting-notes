import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { isMissingTable, STATE_LOG_TABLE, loadCurrentRoundDist, type RoundDist } from "@/app/lib/subscription-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/subscription/transitions — 정기배송 상태 변경 로그(129).
//  신청 단위 상태(U/P/C)가 달라진 기록만. 이름·연락처 없음, 회원 아이디는 암호화 값. 로그인 사용자만(미들웨어).
//  129 미적용·수집 전이면 ok:true, events:[] — 화면은 '아직 기록 없음'으로 표시.
//  정렬: 관측일(changed_on) 최신 먼저. 로그는 '변화'만 쌓여 작으므로 상한 넉넉히(5000).
export async function GET() {
  try {
    const sb = supabaseAdmin();

    // 현재(오늘) 회차 분포 — 127 품목 데이터만으로 계산. 전이 로그(129) 없이도 바로 볼 수 있다.
    let currentRounds: RoundDist | null = null;
    try { currentRounds = await loadCurrentRoundDist(sb); }
    catch (e) { if (!isMissingTable(e as { message?: string })) throw e; /* 127 미적용 — null */ }

    // 전이 로그. select("*") 로 받아 round·cycle 컬럼이 아직 없는 환경(129 구버전)에서도 깨지지 않게 한다.
    const { data, error } = await sb
      .from(STATE_LOG_TABLE)
      .select("*")
      .order("changed_on", { ascending: false })
      .order("id", { ascending: false })
      .limit(5000);
    if (error) {
      if (isMissingTable(error)) return NextResponse.json({ ok: true, events: [], currentRounds, notApplied: true });
      throw error;
    }
    return NextResponse.json({ ok: true, events: data ?? [], currentRounds });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "상태 변경 조회 실패") }, { status: 500 });
  }
}
