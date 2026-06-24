import Link from "next/link";
import { getGitbookUrl } from "@/app/lib/site-links";
import { CHANGELOG } from "@/app/lib/changelog";

export const dynamic = "force-dynamic";

const TOOLS = [
  { href: "/meeting", name: "회의록 정리" },
  { href: "/correct", name: "문장 교정" },
  { href: "/cs", name: "CS 코치" },
  { href: "/utm", name: "UTM 빌더" },
  { href: "/subscription", name: "정기배송 분석" },
  { href: "/b2b", name: "B2B 매니저" },
];

const TAG_STYLE: Record<string, { bg: string; color: string }> = {
  신규: { bg: "#e6ffed", color: "#22863a" },
  개선: { bg: "rgba(241,90,48,0.10)", color: "#D94E26" },
  수정: { bg: "#fff8e1", color: "#b08800" },
};

export default async function HomePage() {
  const gitbook = await getGitbookUrl();

  // 업데이트 노트의 최근 7일 항목에 NEW 뱃지
  const now = Date.now();
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const isNew = (dateStr: string) => now - new Date(dateStr).getTime() <= WEEK;

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
        {gitbook && (
          <a href={gitbook} target="_blank" rel="noopener noreferrer" className="home-tool-card is-external">
            <span className="home-tool-name">가이드라인 ↗</span>
          </a>
        )}
      </div>

      {/* 업데이트 노트 */}
      <section className="home-section">
        <h2 className="home-section-title">업데이트 노트</h2>
        <p className="home-section-sub">추가·개선된 기능을 여기에 모아둡니다. 무엇이 생겼는지 확인하고 바로 써보세요.</p>
        <div className="changelog-list">
          {CHANGELOG.map((c, i) => {
            const tag = TAG_STYLE[c.tag] ?? TAG_STYLE["개선"];
            return (
              <div key={i} className="change-item">
                <div className="change-meta">
                  {isNew(c.date) && <span className="change-new">NEW</span>}
                  <span className="change-tag" style={{ background: tag.bg, color: tag.color }}>{c.tag}</span>
                  <span className="change-date">{c.date}</span>
                  <span className="change-tool">{c.tool}</span>
                </div>
                <div className="change-title">{c.title}</div>
                <div className="change-desc">{c.desc}</div>
                {c.href && (
                  <Link href={c.href} className="change-link">바로 써보기 →</Link>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
