import Link from "next/link";

// 예정 기능 로드맵 (실제 구현은 이후 단계)
const FEATURES = [
  { href: "/voc/stats", title: "통계·리포트", desc: "유형·기간·채널별 VOC 건수와 추세를 한눈에." },
  { href: "/voc/insights", title: "AI 인사이트", desc: "반복되는 불만·원인을 AI가 요약·분류해 줍니다." },
  { href: "/voc/loss", title: "손해금액 산정", desc: "건별 보상·손해 금액을 기록·집계." },
  { href: "/voc/reviews", title: "후기 수집", desc: "상품 후기 등 외부 의견을 모아 봅니다." },
  { href: "/voc/reports", title: "보고서·요청서(PDF)", desc: "보고서·요청서 양식을 PDF로 추출." },
  { href: "/voc/export", title: "검색결과 추출", desc: "필터링한 VOC를 엑셀/CSV로 추출." },
  { href: "/voc/sentiment", title: "긍정·부정 분석", desc: "내용을 긍정/부정으로 자동 분류." },
  { href: "/voc/settings", title: "설정·탈리 연동", desc: "탈리(Tally) 폼과 연동해 답변을 자동 수집." },
];

export default function VocHome() {
  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">VOC 관리</h1>
          <p className="b2b-page-subtitle">고객의 소리(VOC)를 모아 처리·분석·보고하는 도구입니다. (구축 중)</p>
        </div>
      </header>

      <section className="b2b-card" style={{ marginBottom: 18 }}>
        <div className="b2b-card-head"><h2 className="b2b-card-title">처리 상태</h2></div>
        <div className="b2b-empty" style={{ padding: "36px 20px", textAlign: "center", color: "var(--sm-text-mid)", lineHeight: 1.6 }}>
          접수된 VOC를 상태별(접수 · 처리중 · 완료)로 관리하는 메인 화면이 들어올 자리입니다. (준비 중)
        </div>
      </section>

      <h2 className="b2b-card-title" style={{ margin: "8px 2px 12px" }}>예정 기능</h2>
      <div className="voc-grid">
        {FEATURES.map((f) => (
          <Link key={f.href} href={f.href} className="voc-card">
            <div className="voc-card-title">{f.title}<span className="voc-soon">준비 중</span></div>
            <div className="voc-card-desc">{f.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
