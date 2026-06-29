"use client";

import TxnTable from "../TxnTable";

export default function ActivityPage() {
  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">활동 히스토리</h1><p className="b2b-page-subtitle">모든 입고·출고·조정 원장(최근순). 각 거래는 ‘취소’로 되돌릴 수 있습니다.</p></div>
      </header>
      <section className="b2b-card"><TxnTable /></section>
    </div>
  );
}
