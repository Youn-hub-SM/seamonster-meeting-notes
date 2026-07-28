"use client";

import { RequestList } from "../RequestList";

// 도매 재고 생산 요청 — 메뉴에서는 숨김('안씀' 처리). 목록·입고는 생산 일정(/production) 하단에서 사용.
//  이 주소를 직접 열면 같은 목록이 그대로 동작한다(북마크 호환).
export default function RequestPage() {
  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">도매 재고 생산 요청</h1>
          <p className="b2b-page-subtitle">입고 시 도매 재고에 반영됩니다</p>
        </div>
      </header>
      <RequestList />
    </>
  );
}
