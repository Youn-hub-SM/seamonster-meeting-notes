import ChangelogFeed from "@/app/components/ChangelogFeed";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <div className="container">
      <h1 className="page-title">씨몬스터 업무 도우미</h1>
      <p className="page-subtitle">업무 도구는 왼쪽 메뉴에서. 새 기능은 아래 업데이트 노트에 정리됩니다.</p>

      {/* 업데이트 노트 — 메뉴별 필터 + 날짜별 묶음 */}
      <section className="home-section">
        <h2 className="home-section-title">업데이트 노트</h2>
        <p className="home-section-sub">추가·개선된 기능을 날짜별로 모아둡니다. 메뉴별로 걸러서 보세요.</p>
        <ChangelogFeed />
      </section>
    </div>
  );
}
