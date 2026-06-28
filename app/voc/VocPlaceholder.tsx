import Link from "next/link";

// VOC 관리툴의 '준비 중' 기능 자리. 실제 구현 전까지 메뉴가 404 안 나게 채워둠.
export default function VocPlaceholder({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">{title}</h1>
          <p className="b2b-page-subtitle">VOC 관리 · 구축 중인 기능</p>
        </div>
      </header>
      <section className="b2b-card">
        <div className="b2b-empty" style={{ padding: "48px 20px", textAlign: "center" }}>
          <div className="b2b-empty-icon">🛠️</div>
          <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 16 }}>준비 중인 기능입니다</div>
          <div style={{ color: "var(--sm-text-mid)", maxWidth: 540, margin: "0 auto", lineHeight: 1.65 }}>{desc}</div>
          <div style={{ marginTop: 22 }}><Link href="/voc" className="b2b-btn-secondary">← VOC 관리 홈</Link></div>
        </div>
      </section>
    </div>
  );
}
