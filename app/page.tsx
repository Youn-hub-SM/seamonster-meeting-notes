import HomeQuickLaunch from "@/app/HomeQuickLaunch";
import HomeSitemap from "@/app/HomeSitemap";

// 홈 = 즐겨찾는 메뉴 + 전체 사이트맵.
//  최근 방문·고정 바로가기 블록은 제거(2026-08-24 대표 지시) — 사용 가이드·업데이트 노트·씨몬스터
//  가이드(GitBook)는 사이드바 최상단/기타에 있어 홈에서 중복이었다.
//  셸은 다른 화면과 같은 .b2b-main > .b2b-container > .b2b-page-head (2026-10-14 C7 — 레거시 .container/.page-title 폐기).
//  루트 라우트라 layout 이 없어 .b2b-main 래퍼를 여기서 직접 둔다(notice/layout.tsx 와 같은 역할).

export default function HomePage() {
  return (
    <div className="b2b-main">
      <div className="b2b-container">
        <header className="b2b-page-head">
          <div><h1 className="b2b-page-title">씨몬스터 업무 도우미</h1></div>
        </header>

        {/* 퀵런치 — 즐겨찾는 메뉴 (없으면 아무것도 안 그림) */}
        <HomeQuickLaunch />

        {/* 전체 사이트맵 — 사이드바(NAV)와 동일 구조 */}
        <HomeSitemap />
      </div>
    </div>
  );
}
