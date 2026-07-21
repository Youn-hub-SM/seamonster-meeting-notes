import Link from "next/link";
import HomeQuickLaunch from "@/app/HomeQuickLaunch";
import HomeSitemap from "@/app/HomeSitemap";
import Icon from "@/app/components/Icon";

export const dynamic = "force-dynamic";

// 고정 바로가기 — 즐겨찾기/최근 방문과 무관하게 항상 노출.
const FIXED_LINKS = [
  { href: "/updates", label: "업데이트 노트", icon: "note" as const },
  { href: "/guide", label: "사용 가이드", icon: "book" as const },
  { href: "https://seamonster.gitbook.io/guide", label: "씨몬스터 가이드", icon: "link" as const, external: true },
];

export default function HomePage() {
  return (
    <div className="container">
      <h1 className="page-title" style={{ marginBottom: "var(--sm-space-6)" }}>씨몬스터 업무 도우미</h1>

      {/* 퀵런치 — 즐겨찾는 메뉴 + 최근 방문 (둘 다 없으면 아무것도 안 그림) */}
      <HomeQuickLaunch />

      {/* 고정 바로가기 */}
      <section className="home-section">
        <h2 className="home-section-title">바로가기</h2>
        <div className="home-grid" style={{ marginTop: 14 }}>
          {FIXED_LINKS.map((l) =>
            l.external ? (
              <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="home-tool-card">
                <span className="sm-row" style={{ gap: 10, minWidth: 0 }}>
                  <Icon name={l.icon} size={20} />
                  <span className="home-tool-name sm-ellipsis" style={{ fontSize: 17 }}>{l.label}</span>
                </span>
              </a>
            ) : (
              <Link key={l.href} href={l.href} className="home-tool-card">
                <span className="sm-row" style={{ gap: 10, minWidth: 0 }}>
                  <Icon name={l.icon} size={20} />
                  <span className="home-tool-name sm-ellipsis" style={{ fontSize: 17 }}>{l.label}</span>
                </span>
              </Link>
            )
          )}
        </div>
      </section>

      {/* 전체 사이트맵 — 사이드바(NAV)와 동일 구조 */}
      <HomeSitemap />
    </div>
  );
}
