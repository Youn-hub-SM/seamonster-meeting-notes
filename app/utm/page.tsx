export const metadata = {
  title: "UTM 만들기 · 씨몬스터 내부 도구",
};

// 배포(커밋)마다 쿼리가 바뀌어 정적 파일 캐시를 자동 무효화 → 강력새로고침 없이 최신 반영
const V = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || "dev";

export default function UtmBuilderPage() {
  return (
    <iframe
      src={`/utm-builder.html?v=${V}`}
      title="씨몬스터 UTM 만들기"
      style={{
        display: "block",
        width: "100%",
        height: "calc(100vh - 64px)",
        border: "none",
      }}
    />
  );
}
