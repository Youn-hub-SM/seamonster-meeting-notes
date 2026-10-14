"use client";

// 홈 '오늘 할 일'(2026-10-14 D1) — /api/home/todo 의 건수를 .b2b-stat-card 링크 카드로.
//  0건 카드는 숨기고 전부 0이면 섹션을 그리지 않는다. 불러오는 중에도 아무것도 안 그린다(깜빡임 금지).
//  파도소리 계정(role factory)은 그리지 않는다. 색은 쓰지 않는다 — 라벨 12px 회색 + 건수 검정(tabular-nums 는 .b2b-stat-card-value 기본).

import { useEffect, useState } from "react";
import Link from "next/link";

type TodoItem = { key: string; label: string; count: number; href?: string };

export default function HomeTodo() {
  const [items, setItems] = useState<TodoItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [auth, todo] = await Promise.all([
          fetch("/api/b2b/auth", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
          fetch("/api/home/todo", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        ]);
        if (!alive) return;
        if (!auth?.ok || auth.role === "factory" || !todo?.ok) { setItems([]); return; }
        setItems((todo.items as TodoItem[]).filter((x) => x.count > 0));
      } catch { if (alive) setItems([]); }
    })();
    return () => { alive = false; };
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <section className="home-section">
      <h2 className="home-section-title">오늘 할 일</h2>
      <div className="home-todo-grid">
        {items.map((it) => {
          const body = (
            <>
              <div className="b2b-stat-card-label">{it.label}</div>
              <div className="b2b-stat-card-value">{it.count.toLocaleString()}<span className="home-todo-unit">건</span></div>
            </>
          );
          return it.href ? (
            <Link key={it.key} href={it.href} className="b2b-stat-card home-todo-card">{body}</Link>
          ) : (
            <div key={it.key} className="b2b-stat-card home-todo-card is-static">{body}</div>
          );
        })}
      </div>
    </section>
  );
}
