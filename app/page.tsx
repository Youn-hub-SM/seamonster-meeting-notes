import ChangelogFeed from "@/app/components/ChangelogFeed";
import HomeQuickLaunch from "@/app/HomeQuickLaunch";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <div className="container">
      <h1 className="page-title" style={{ marginBottom: "var(--sm-space-6)" }}>씨몬스터 업무 도우미</h1>

      {/* 퀵런치 — 즐겨찾는 메뉴 + 최근 방문 (둘 다 없으면 아무것도 안 그림) */}
      <HomeQuickLaunch />

      {/* 업데이트 노트 — 메뉴별 필터 + 날짜별 묶음 */}
      <section className="home-section">
        <h2 className="home-section-title">업데이트 노트</h2>
        <ChangelogFeed />
      </section>
    </div>
  );
}
