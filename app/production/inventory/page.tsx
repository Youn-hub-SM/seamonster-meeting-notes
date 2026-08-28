"use client";

// 2026-07-29: '생산' 화면은 재고 목록(/inventory)으로 통합됨 — 북마크 호환용 리다이렉트만 남김.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ProductionInventoryRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/inventory"); }, [router]);
  return <div className="b2b-container"><div className="b2b-loading">재고 목록으로 이동 중...</div></div>;
}
