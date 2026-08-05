// 파도소리 입출고 — 서버 전용 DB 접근. 화면에서 import 하지 말 것(서비스 키가 번들에 실린다).

import type { NextRequest } from "next/server";
import { supabaseAdmin } from "./supabase";
import { verifySession, resolveUserName } from "./b2b-auth";

// factory 스키마 전용 핸들. **파도소리 라우트는 supabaseAdmin() 대신 반드시 이걸 쓴다.**
//  public(매출·고객·재고)에 실수로 손이 닿지 않게 하는 앱 레이어 경계다 — 이 핸들로는
//  factory 스키마의 테이블만 조회된다.
//  사전 조건: Dashboard > Settings > API > Exposed schemas 에 factory 추가(migration factory/001 주석 참조).
export function factoryDb() {
  return supabaseAdmin().schema("factory");
}

// 씨몬스터 생산요청을 읽기 전용으로 보여줄 때만 public 을 본다(SELECT 전용).
export function publicDb() {
  return supabaseAdmin();
}

export async function factoryActor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}
