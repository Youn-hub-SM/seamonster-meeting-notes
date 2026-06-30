"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CHANGELOG, changeMenu, MENU_ORDER } from "@/app/lib/changelog";

const TAG_STYLE: Record<string, { bg: string; color: string }> = {
  신규: { bg: "var(--sm-success-bg)", color: "var(--sm-success)" },
  개선: { bg: "rgba(241,90,48,0.10)", color: "#D94E26" },
  수정: { bg: "var(--sm-warning-bg)", color: "var(--sm-warning)" },
};

export default function ChangelogFeed() {
  const [menu, setMenu] = useState("전체");
  const now = Date.now();
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const isNew = (dateStr: string) => now - new Date(dateStr).getTime() <= WEEK;

  // 메뉴별 건수 + 등장 메뉴(필터 칩) — nav 순서대로
  const { menus, counts } = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of CHANGELOG) c.set(changeMenu(e.tool), (c.get(changeMenu(e.tool)) || 0) + 1);
    const present = [...c.keys()];
    const ordered = MENU_ORDER.filter((m) => c.has(m)).concat(present.filter((m) => !MENU_ORDER.includes(m)));
    return { menus: ordered, counts: c };
  }, []);

  const filtered = useMemo(() => (menu === "전체" ? CHANGELOG : CHANGELOG.filter((c) => changeMenu(c.tool) === menu)), [menu]);

  // 날짜별 묶기 (필터 적용 후, CHANGELOG 는 최신순)
  const groups = useMemo(() => {
    const gs: { date: string; items: typeof CHANGELOG }[] = [];
    const byDate = new Map<string, number>();
    for (const c of filtered) {
      let gi = byDate.get(c.date);
      if (gi === undefined) { gi = gs.length; byDate.set(c.date, gi); gs.push({ date: c.date, items: [] }); }
      gs[gi].items.push(c);
    }
    return gs;
  }, [filtered]);

  return (
    <>
      <div className="sm-tabs" style={{ flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <button className={`sm-tab ${menu === "전체" ? "is-active" : ""}`} onClick={() => setMenu("전체")}>전체<span className="sm-tab-count">{CHANGELOG.length}</span></button>
        {menus.map((m) => (
          <button key={m} className={`sm-tab ${menu === m ? "is-active" : ""}`} onClick={() => setMenu(m)}>{m}<span className="sm-tab-count">{counts.get(m) || 0}</span></button>
        ))}
      </div>

      <div className="changelog-list">
        {groups.length === 0 ? (
          <div className="sm-faint" style={{ fontSize: 13, padding: "12px 2px" }}>해당 메뉴의 업데이트가 없습니다.</div>
        ) : groups.map((g) => (
          <div key={g.date} className="change-day">
            <div className="change-day-head">
              <span className="change-day-date">{g.date}</span>
              {isNew(g.date) && <span className="change-new">NEW</span>}
              <span className="change-day-count">{g.items.length}건</span>
            </div>
            <div className="change-day-items">
              {g.items.map((c, i) => {
                const tag = TAG_STYLE[c.tag] ?? TAG_STYLE["개선"];
                return (
                  <div key={i} className="change-row">
                    <span className="change-tag" style={{ background: tag.bg, color: tag.color }}>{c.tag}</span>
                    <div className="change-row-main">
                      <div className="change-row-title">
                        {c.title}
                        <span className="change-tool">{c.tool}</span>
                      </div>
                      <div className="change-desc">{c.desc}</div>
                      {c.href && <Link href={c.href} className="change-link">바로 써보기 →</Link>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
