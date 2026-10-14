"use client";

// 홈 '새 업데이트 N건' 링크(2026-10-14 D2) — 사이드바 배지와 같은 계산(app/lib/updates-seen.ts). 0건이면 아무것도 안 그린다.

import { useEffect, useState } from "react";
import Link from "next/link";
import { countNewUpdates, readUpdatesSeenAt } from "./lib/updates-seen";

export default function HomeUpdates() {
  const [n, setN] = useState(0);
  useEffect(() => { setN(countNewUpdates(readUpdatesSeenAt())); }, []);
  if (n <= 0) return null;
  return <Link href="/updates" className="sm-link home-updates-link">새 업데이트 {n}건</Link>;
}
