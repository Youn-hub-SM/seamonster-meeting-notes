import Link from "next/link";
import { getGitbookUrl } from "@/app/lib/site-links";
import { CHANGELOG } from "@/app/lib/changelog";

export const dynamic = "force-dynamic";

const TOOLS = [
  { href: "/meeting", emoji: "📝", name: "회의록 정리", desc: "녹취·메모를 붙여넣으면 시간순 요약·결정·할 일로 정리" },
  { href: "/correct", emoji: "✍️", name: "문장 교정", desc: "씨몬스터 톤앤매너에 맞게 문장 다듬기" },
  { href: "/cs", emoji: "🎧", name: "CS 코치", desc: "상황을 적으면 매뉴얼 근거로 행동 코칭 + 답변 초안" },
  { href: "/utm", emoji: "🔗", name: "UTM 빌더", desc: "채널별 추적 링크 생성·관리 (팀 공용 히스토리)" },
  { href: "/subscription", emoji: "📦", name: "정기배송 분석", desc: "구독 CSV 분석 + KPI 추세 관찰" },
  { href: "/b2b", emoji: "🏢", name: "B2B 매니저", desc: "발주·업체·원가·이익률·매출·입금 관리" },
];

const TAG_STYLE: Record<string, { bg: string; color: string }> = {
  신규: { bg: "#e6ffed", color: "#22863a" },
  개선: { bg: "rgba(241,90,48,0.10)", color: "#D94E26" },
  수정: { bg: "#fff8e1", color: "#b08800" },
};

export default async function HomePage() {
  const gitbook = await getGitbookUrl();

  return (
    <div className="container">
      <h1 className="page-title">씨몬스터 내부도구</h1>
      <p className="page-subtitle">업무 도구를 한곳에서. 새 기능은 아래 업데이트 노트에 정리됩니다.</p>

      {/* 도구 바로가기 */}
      <div className="home-grid">
        {TOOLS.map((t) => (
          <Link key={t.href} href={t.href} className="home-tool-card">
            <span className="home-tool-emoji">{t.emoji}</span>
            <span className="home-tool-name">{t.name}</span>
            <span className="home-tool-desc">{t.desc}</span>
          </Link>
        ))}
        {gitbook && (
          <a href={gitbook} target="_blank" rel="noopener noreferrer" className="home-tool-card is-external">
            <span className="home-tool-emoji">📖</span>
            <span className="home-tool-name">가이드라인 ↗</span>
            <span className="home-tool-desc">사내 매뉴얼·규정 (GitBook, 새 탭)</span>
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
