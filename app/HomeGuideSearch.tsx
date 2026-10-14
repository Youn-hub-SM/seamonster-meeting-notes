"use client";

// 홈 상단 '사용 가이드' 진입(2026-10-14 D4) — 검색칸 + [가이드 열기]. 검색어 입력 뒤 Enter → /guide?q=검색어.
//  안내문은 없다(카피 규칙). 같은 줄 끝에 '새 업데이트 N건' 링크(D2).

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import HomeUpdates from "./HomeUpdates";

export default function HomeGuideSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");

  return (
    <form
      className="home-guide-row"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const v = q.trim();
        router.push(v ? `/guide?q=${encodeURIComponent(v)}` : "/guide");
      }}
    >
      <input type="search" className="b2b-input home-guide-input" placeholder="가이드 검색" aria-label="가이드 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      <Link href="/guide" className="b2b-btn-secondary home-guide-open">가이드 열기</Link>
      <HomeUpdates />
    </form>
  );
}
