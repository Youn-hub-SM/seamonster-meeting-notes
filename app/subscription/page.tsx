export const metadata = {
  title: "정기배송 분석 · 씨몬스터 내부 도구",
};

export default function SubscriptionDashboardPage() {
  return (
    <iframe
      src="/subscription-dashboard.html"
      title="씨몬스터 정기배송 분석 대시보드"
      style={{
        display: "block",
        width: "100%",
        height: "calc(100vh - 64px)",
        border: "none",
      }}
    />
  );
}
