"use client";

export default function ProductsUploadPage() {
  return (
    <div className="b2b-container" style={{ maxWidth: 760 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">품목 업로드</h1>
          <p className="b2b-page-subtitle">엑셀로 생산품목(제품표)을 한 번에 추가·갱신합니다.</p>
        </div>
      </header>

      <section className="b2b-card">
        <div className="b2b-empty" style={{ padding: "40px 20px" }}>
          <div className="b2b-empty-icon">📄</div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>준비 중 (Phase 1b)</div>
          <div style={{ color: "var(--sm-text-mid)", lineHeight: 1.6, fontSize: 14 }}>
            엑셀 파일(SKU·품목명·규격·단위·원가·판매가)을 올리면 SKU 기준으로<br />
            기존 품목은 갱신, 새 품목은 추가합니다. 적용 전에 미리보기로 확인할 수 있게 만들 예정입니다.
          </div>
        </div>
      </section>
    </div>
  );
}
