import SalesReportPanel from "../SalesReportPanel";

export default function SalesReportPage() {
  return (
    <div className="b2b-container" style={{ maxWidth: 760 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">매출 리포트</h1>
          <p className="b2b-page-subtitle">일일·주간 리포트를 생성해 미리보기로 확인한 뒤 메일로 발송합니다. 일요일 기준일은 자동으로 금~일 합산됩니다.</p>
        </div>
      </header>
      <SalesReportPanel />
    </div>
  );
}
