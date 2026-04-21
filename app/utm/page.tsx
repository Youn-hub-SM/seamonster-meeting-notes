export const metadata = {
  title: "UTM 빌더 · 씨몬스터 내부 도구",
};

export default function UtmBuilderPage() {
  return (
    <iframe
      src="/utm-builder.html"
      title="씨몬스터 UTM 빌더"
      style={{
        display: "block",
        width: "100%",
        height: "calc(100vh - 64px)",
        border: "none",
      }}
    />
  );
}
