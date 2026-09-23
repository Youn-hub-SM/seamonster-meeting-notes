"use client";

import { RequestList } from "../RequestList";

// 생산 요청 — 요청번호별 요청 목록. 요청서 만들기 → 확인 → 입고 기록에서 요청서 선택 → 마감.
//  재고 목록(/inventory)의 '선택 N종 생산 요청' 버튼이 이 화면으로 넘어와 새 생산 요청 창을 연다(요청 생성은 그 창에서).
export default function RequestPage() {
  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산 요청</h1>
          <p className="b2b-page-subtitle">요청서 만들기 → 확인 → 입고 기록에서 요청서 선택 → 마감</p>
        </div>
      </header>
      <RequestList />
    </>
  );
}
