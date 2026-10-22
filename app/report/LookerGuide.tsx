"use client";

import { useState } from "react";

// 루커스튜디오(데이터 스튜디오) 적용 가이드 — AI 비서 화면 하단 접이식(2026-10-19 대화형 개편 때 분리, 내용 그대로)
export default function LookerGuide() {
  const [guideOpen, setGuideOpen] = useState(false);
  return (
    <section className="rp-guide">
      <button className="rp-guide-head" onClick={() => setGuideOpen((v) => !v)}>
        <span>루커스튜디오(데이터 스튜디오)에 적용하는 법</span>
        <span className="rp-guide-chev">{guideOpen ? "▾" : "▸"}</span>
      </button>
      {guideOpen && (
        <div className="rp-guide-body">
          <div className="rp-guide-block">
            <div className="rp-guide-title">A. 커스텀 쿼리 <span className="rp-guide-tag ok">Supabase 작업 불필요</span></div>
            <ol className="rp-guide-steps">
              <li>루커스튜디오 보고서 → <b>데이터 추가</b> → <b>PostgreSQL</b> 커넥터 (이미 연결돼 있으면 그 데이터소스 선택)</li>
              <li>접속정보 입력 후 <b>맞춤 쿼리(CUSTOM QUERY)</b> 선택</li>
              <li>복사한 <b>SELECT</b> 문을 붙여넣기 → <b>추가</b></li>
              <li>차트에 필드를 연결하면 끝</li>
            </ol>
          </div>
          <div className="rp-guide-block">
            <div className="rp-guide-title">B. 뷰 생성 <span className="rp-guide-tag warn">Supabase에 1회 적용 필요</span></div>
            <ol className="rp-guide-steps">
              <li>복사한 <code>create view ... ; grant ... to looker_ro;</code> 를 <b>Supabase 대시보드 → SQL Editor</b> 에 붙여넣고 <b>Run</b></li>
              <li>루커스튜디오 → <b>데이터 추가</b> → 아래 접속정보 → <b>테이블 목록에서 새 뷰 선택</b><br /><span className="sm-faint">(이미 데이터소스가 있으면: 데이터소스 편집 → 우측 상단 <b>필드 새로고침</b>)</span></li>
              <li>차트에 연결</li>
            </ol>
          </div>
          <div className="rp-guide-block">
            <div className="rp-guide-title">PostgreSQL 접속정보 (커넥터 최초 연결 시)</div>
            <div className="b2b-table-wrap">
            <table className="rp-guide-conn">
              <tbody>
                <tr><td>호스트</td><td><code>aws-1-ap-northeast-2.pooler.supabase.com</code></td></tr>
                <tr><td>포트</td><td><code>5432</code></td></tr>
                <tr><td>데이터베이스</td><td><code>postgres</code></td></tr>
                <tr><td>사용자</td><td><code>looker_ro.uwbkejkztuhzcesrffzq</code> <span className="sm-faint">(반드시 role.projectref)</span></td></tr>
                <tr><td>비밀번호</td><td>설정하신 looker_ro 비밀번호</td></tr>
                <tr><td>SSL</td><td>사용 (Enable SSL)</td></tr>
              </tbody>
            </table>
            </div>
          </div>
          <div className="rp-guide-block">
            <div className="rp-guide-title">자주 겪는 것</div>
            <ul className="rp-guide-tips">
              <li><b>날짜가 안 맞아요</b> → 보고서/데이터소스 타임존을 <b>(GMT+9) 서울</b>로 설정</li>
              <li><b>바뀐 데이터가 안 보여요</b> → 데이터소스 <b>새로고침</b> (기본 캐시 12시간)</li>
              <li><b>새 컬럼/뷰가 안 떠요</b> → 데이터소스 편집에서 <b>필드 새로고침</b></li>
              <li><b>팀원도 보게 하려면</b> → 데이터소스를 <b>소유자 자격증명</b>으로 공유</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
