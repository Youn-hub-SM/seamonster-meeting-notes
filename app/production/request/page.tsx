"use client";

import { RequestList } from "../RequestList";

// 생산 요청 — 신청번호별 요청 목록. 담당자 확인 → 제조사 요청서 전달 → 입고(도매 재고 반영).
//  재고 목록(/inventory)의 '선택 N종 생산 요청' 버튼이 만든 요청이 여기로 쌓인다.
export default function RequestPage() {
  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">생산 요청</h1>
          <p className="b2b-page-subtitle">담당자 확인 → 제조사 전달 → 입고(도매 재고 반영)</p>
        </div>
      </header>
      <RequestList />
    </>
  );
}
