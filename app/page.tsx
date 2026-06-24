import Link from "next/link";
import { CHANGELOG } from "@/app/lib/changelog";

export const dynamic = "force-dynamic";

const TOOLS = [
  { href: "/meeting", name: "회의록 정리" },
  { href: "/correct", name: "문장 교정" },
  { href: "/cs", name: "CS 코치" },
  { href: "/utm", name: "UTM 빌더" },
  { href: "/subscription", name: "정기배송 분석" },
  { href: "/b2b", name: "B2B 매니저" },
  { href: "/production", name: "생산관리" },
];

const TAG_STYLE: Record<string, { bg: string; color: string }> = {
  신규: { bg: "#e6ffed", color: "#22863a" },
  개선: { bg: "rgba(241,90,48,0.10)", color: "#D94E26" },
  수정: { bg: "#fff8e1", color: "#b08800" },
};

export default function HomePage() {
  // 업데이트 노트의 최근 7일 항목에 NEW 뱃지
  const now = Date.now();
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const isNew = (dateStr: string) => now - new Date(dateStr).getTime() <= WEEK;

  // 날짜별로 묶기 (CHANGELOG 는 최신순)
  const groups: { date: string; items: typeof CHANGELOG }[] = [];
  const byDate = new Map<string, number>();
  for (const c of CHANGELOG) {
    let gi = byDate.get(c.date);
    if (gi === undefined) { gi = groups.length; byDate.set(c.date, gi); groups.push({ date: c.date, items: [] }); }
    groups[gi].items.push(c);
  }

  return (
    <div className="container">
      <h1 className="page-title">씨몬스터 내부도구</h1>
      <p className="page-subtitle">업무 도구를 한곳에서. 새 기능은 아래 업데이트 노트에 정리됩니다.</p>

      {/* 도구 바로가기 */}
      <div className="home-grid">
        {TOOLS.map((t) => (
          <Link key={t.href} href={t.href} className="home-tool-card">
            <span className="home-tool-name">{t.name}</span>
          </Link>
        ))}
      </div>

      {/* 업데이트 노트 — 날짜별 묶음 */}
      <section className="home-section">
        <h2 className="home-section-title">업데이트 노트</h2>
        <p className="home-section-sub">추가·개선된 기능을 날짜별로 모아둡니다. 무엇이 생겼는지 확인하고 바로 써보세요.</p>
        <div className="changelog-list">
          {groups.map((g) => (
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
      </section>
    </div>
  );
}
