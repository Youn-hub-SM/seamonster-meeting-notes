export const metadata = {
  title: "정기배송 분석 · 씨몬스터 업무 도우미",
};

// 배포(커밋)마다 쿼리가 바뀌어 정적 파일 캐시를 자동 무효화 → 강력새로고침 없이 최신 반영
const V = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || "dev";

export default function SubscriptionDashboardPage() {
  return (
    <iframe
      src={`/subscription-dashboard.html?v=${V}`}
      title="씨몬스터 정기배송 분석 대시보드"
      className="sm-iframe-fill"
    />
  );
}
