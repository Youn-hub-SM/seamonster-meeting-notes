"use client";

// 홈 첫 줄(유일한 히어로, 2026-10-17 디자인 4차 D1·대표 결정 1b) — "10월 17일 금요일, 현석" + 그 아래 한 문장 "오늘 발송 2건, 입금 대기 3건 7,334,800원".
//  숫자 카드·타일이 아니라 글 한 줄(오늘 할 일 카드는 10-14 폐기 — 되살리지 않는다).
//  날짜는 브라우저의 오늘(KST 고정)로 먼저 그리고, 이름은 /api/b2b/auth 가 오면 뒤에 잇는다(제목이 바뀌며 깜빡이지 않게 날짜는 처음부터).
//  비로그인·파도소리(factory)면 제목 '씨몬스터 업무 도우미' 로 폴백. 문장은 /api/home/today 가 오기 전엔 빈 줄(스켈레톤 없음).

import { useEffect, useState } from "react";
import { qtyText, wonText } from "@/app/lib/format";

const FALLBACK_TITLE = "씨몬스터 업무 도우미";

function todayLabel(): string {
  // "10월 17일 금요일" — 브라우저 시각을 KST 로 고정해 표기(서버·클라이언트가 같은 글자를 내야 하이드레이션이 조용하다)
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "long" }).format(new Date());
}

type Today = { ship: number; unpaid: { count: number; remaining: number } };

export function todaySentence(t: Today): string {
  const parts: string[] = [];
  if (t.ship > 0) parts.push(`오늘 발송 ${qtyText(t.ship, "건")}`);
  if (t.unpaid.count > 0) {
    const amt = t.unpaid.remaining > 0 ? ` ${wonText(t.unpaid.remaining)}` : "";
    parts.push(`입금 대기 ${qtyText(t.unpaid.count, "건")}${amt}`);
  }
  return parts.length ? parts.join(", ") : "오늘 발송 없음, 입금 대기 없음";
}

export default function HomeToday() {
  const [date] = useState(todayLabel);
  // null = 아직 모름(날짜만), "" = 폴백(비로그인·파도소리), 그 외 = 이름
  const [name, setName] = useState<string | null>(null);
  const [line, setLine] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/b2b/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive) setName(j?.ok && j.role !== "factory" && j.name ? String(j.name) : ""); })
      .catch(() => { if (alive) setName(""); });
    fetch("/api/home/today", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.ok) setLine(todaySentence({ ship: Number(j.ship) || 0, unpaid: { count: Number(j.unpaid?.count) || 0, remaining: Number(j.unpaid?.remaining) || 0 } })); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const title = name === "" ? FALLBACK_TITLE : name ? `${date}, ${name}` : date;
  return (
    <div>
      <h1 className="b2b-page-title" suppressHydrationWarning>{title}</h1>
      <p className="home-today-line">{line}</p>
    </div>
  );
}
