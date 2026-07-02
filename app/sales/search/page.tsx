export default function SalesSearchPage() {
  return (
    <div className="b2b-container" style={{ maxWidth: 720 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">주문 검색</h1>
          <p className="b2b-page-subtitle">전화번호로 해당 고객의 구매/재구매 이력을 조회합니다.</p>
        </div>
      </header>
      <section className="b2b-card">
        <p className="sm-faint" style={{ fontSize: 14, lineHeight: 1.6 }}>준비 중입니다(3차). 전화번호를 HMAC로 변환해 고객 조회 테이블에서 이력을 찾는 검색을 제공할 예정입니다.</p>
      </section>
    </div>
  );
}
