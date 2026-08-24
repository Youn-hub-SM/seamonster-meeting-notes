import HomeQuickLaunch from "@/app/HomeQuickLaunch";
import HomeSitemap from "@/app/HomeSitemap";

export const dynamic = "force-dynamic";

// 홈 = 즐겨찾는 메뉴 + 전체 사이트맵.
//  최근 방문·고정 바로가기 블록은 제거(2026-08-24 대표 지시) — 사용 가이드·업데이트 노트·씨몬스터
//  가이드(GitBook)는 사이드바 최상단/기타에 있어 홈에서 중복이었다.

export default function HomePage() {
  return (
    <div className="container">
      <h1 className="page-title" style={{ marginBottom: "var(--sm-space-6)" }}>씨몬스터 업무 도우미</h1>

      {/* 퀵런치 — 즐겨찾는 메뉴 (없으면 아무것도 안 그림) */}
      <HomeQuickLaunch />

      {/* 전체 사이트맵 — 사이드바(NAV)와 동일 구조 */}
      <HomeSitemap />
    </div>
  );
}
