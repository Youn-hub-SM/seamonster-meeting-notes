import HomeGuideSearch from "@/app/HomeGuideSearch";
import HomeToday from "@/app/HomeToday";
import HomeQuickLaunch from "@/app/HomeQuickLaunch";
import HomeSitemap from "@/app/HomeSitemap";

// 홈 = 가이드 검색(D4) + 즐겨찾는 메뉴(없으면 역할 바로가기, D3) + 전체 메뉴. 2026-10-14 어포던스 2차(오늘 할 일 카드는 대표 결정으로 삭제).
//  안내문은 쓰지 않는다(카피 규칙). 사용 가이드·업데이트 노트 링크는 사이드바 최상단에 있고, 홈은 검색칸·'새 업데이트 N건'으로만 진입을 더한다.
//  셸은 다른 화면과 같은 .b2b-main > .b2b-container > .b2b-page-head (2026-10-14 C7 — 레거시 .container/.page-title 폐기).
//  루트 라우트라 layout 이 없어 .b2b-main 래퍼를 여기서 직접 둔다(notice/layout.tsx 와 같은 역할).
//  첫 줄(2026-10-17 디자인 4차 D1, 대표 결정 1b): 제목 대신 "10월 17일 금요일, 현석" + 그 아래 오늘 발송·입금 대기 한 문장 — HomeToday.tsx.

export default function HomePage() {
  return (
    <div className="b2b-main">
      <div className="b2b-container">
        <header className="b2b-page-head">
          <HomeToday />
        </header>

        {/* 가이드 검색 + [가이드 열기] + 새 업데이트 N건 — 제목 아래 한 줄 */}
        <HomeGuideSearch />

        {/* 퀵런치 — 즐겨찾는 메뉴 (없으면 역할 묶음 바로가기 4개) */}
        <HomeQuickLaunch />

        {/* 전체 메뉴 — 사이드바(NAV)와 동일 구조, 분류별 구역 + 툴 카드 */}
        <HomeSitemap />
      </div>
    </div>
  );
}
