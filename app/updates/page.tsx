import ChangelogFeed from "@/app/components/ChangelogFeed";

export const dynamic = "force-dynamic";

// 업데이트 노트 — 홈에서 분리한 전용 화면. 데이터는 app/lib/changelog.ts.
export default function UpdatesPage() {
  return (
    <div className="b2b-container" style={{ maxWidth: 860 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">업데이트 노트</h1>
        </div>
      </header>
      <ChangelogFeed />
    </div>
  );
}
