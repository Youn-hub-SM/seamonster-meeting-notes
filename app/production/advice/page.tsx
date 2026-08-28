"use client";

// 2026-08-28 정리: '생산 조언' 단독 화면은 재고 목록(/inventory)의 [AI 조언] 버튼으로 통합됨 —
//  옛 업데이트 노트 링크·북마크 호환용 리다이렉트만 남김(/production/inventory 와 같은 패턴).
//  단독 화면은 채널 구분 없이 AI 를 호출해 통합 화면과 결과가 달랐고, 진입점이 둘이라 토큰 비용도 중복됐다.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ProductionAdviceRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/inventory"); }, [router]);
  return <div className="b2b-loading">재고 목록으로 이동 중...</div>;
}
