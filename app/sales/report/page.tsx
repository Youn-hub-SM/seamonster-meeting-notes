export default function SalesReportPage() {
  return (
    <div className="b2b-container" style={{ maxWidth: 720 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">매출 리포트</h1>
          <p className="b2b-page-subtitle">일일·주간 매출 리포트를 생성해 미리보기로 확인한 뒤 메일로 발송합니다.</p>
        </div>
      </header>
      <section className="b2b-card">
        <p className="sm-faint" style={{ fontSize: 14, lineHeight: 1.6 }}>준비 중입니다(2차). 파이썬 일일/주간 리포트·HTML 이메일을 이식해, <strong>미리보기 → 발송</strong> 흐름으로 제공할 예정입니다.</p>
      </section>
    </div>
  );
}
