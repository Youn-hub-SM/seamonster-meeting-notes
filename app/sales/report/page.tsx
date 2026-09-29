import SalesReportPanel from "../SalesReportPanel";

export default function SalesReportPage() {
  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">매출 리포트</h1>
        </div>
      </header>
      <SalesReportPanel />
    </div>
  );
}
