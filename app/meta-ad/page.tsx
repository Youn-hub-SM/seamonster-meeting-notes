"use client";

import { useEffect, useState } from "react";

type Stage = { no: number; key: string; title: string; sub: string; desc: string; color: string; defined: boolean };

// 사용자 정의 5단계 파이프라인(스펙 기반). 세부 기준은 추후 설정에서 커스텀.
const STAGES: Stage[] = [
  { no: 1, key: "abo", title: "ABO 테스트", sub: "광고세트 예산 최적화", color: "#4c6ef5", defined: true,
    desc: "광고 소재를 특정 예산·목표 기준으로 A/B 테스트. 기준을 통과한 소재만 2단계로 승격합니다." },
  { no: 2, key: "cbo", title: "CBO 경쟁", sub: "캠페인 예산 최적화", color: "#f76707", defined: true,
    desc: "ABO를 통과한 소재들이 한 캠페인에서 경쟁하며 집행. 대부분의 비용과 효율이 여기서 발생합니다." },
  { no: 3, key: "scale", title: "비용 증액", sub: "스케일업", color: "#2f9e44", defined: true,
    desc: "설정 기준(예: ROAS n% 이상 · n일 이상 유지) 충족 시 예산 +20% 증액을 권장하는 알림을 띄웁니다." },
  { no: 4, key: "decline", title: "효율 하락", sub: "리프레시", color: "#e8590c", defined: true,
    desc: "효율이 떨어지는 구간. ABO를 통과한 새 소재가 계속 유입되도록 관리합니다." },
  { no: 5, key: "stage5", title: "5단계", sub: "정의 필요", color: "#868e96", defined: false,
    desc: "스펙에 5단계라고 되어 있으나 세부 정의가 아직 없습니다. 어떤 단계인지 알려주시면 반영하겠습니다." },
];

export default function MetaAdPage() {
  const [status, setStatus] = useState<{ configured: boolean; connected?: boolean; error?: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await (await fetch("/api/meta-ad/status", { cache: "no-store" })).json();
        setStatus({ configured: !!s.configured, connected: s.connected, error: s.error });
      } catch { setStatus({ configured: false }); }
    })();
  }, []);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">메타 광고</h1>
          <p className="b2b-page-subtitle">ABO → CBO → 증액 → 효율하락으로 이어지는 <b>단계별 광고 관리</b>. 객관적 기준으로 소재를 판정하고, 기준은 설정에서 시기별로 커스텀합니다.</p>
        </div>
      </header>

      {status && !status.configured && (
        <div className="b2b-error" style={{ background: "var(--sm-warning-bg)", color: "var(--sm-warning)", border: "1px solid #f0d9a8" }}>
          <strong>메타 마케팅 API 연결 대기 중.</strong> <code>META_ACCESS_TOKEN</code>·<code>META_AD_ACCOUNT_ID</code>(app-scoped) 자격을 넣으면 소재·성과 조회와 켜기/끄기가 활성화됩니다.
        </div>
      )}
      {status?.configured && status.connected === false && <div className="b2b-error"><strong>연결 실패</strong> — {status.error || "자격 확인"}</div>}

      {/* 5단계 파이프라인 개요 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginBottom: 16 }}>
        {STAGES.map((s) => (
          <div key={s.key} style={{ border: `1px solid var(--sm-border)`, borderTop: `3px solid ${s.color}`, borderRadius: 12, padding: "14px 14px", background: "var(--sm-white)", opacity: s.defined ? 1 : 0.72 }}>
            <div className="sm-row" style={{ gap: 8, alignItems: "baseline", marginBottom: 4 }}>
              <span style={{ fontWeight: 800, fontSize: 20, color: s.color }}>{s.no}</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{s.title}</div>
                <div className="sm-faint" style={{ fontSize: 11 }}>{s.sub}</div>
              </div>
            </div>
            <p style={{ fontSize: 12, color: "var(--sm-text-mid)", lineHeight: 1.55, margin: "6px 0 0" }}>{s.desc}</p>
          </div>
        ))}
      </div>

      <div className="b2b-card" style={{ padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>다음 단계 (구축 예정)</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--sm-text-mid)", lineHeight: 1.9 }}>
          <li>메타 마케팅 API 연동 — 캠페인/광고세트/소재 + 성과(지출·ROAS·CPA·구매수) 조회, 광고 켜기/끄기.</li>
          <li>단계별 보드 — 소재가 어느 단계에 있는지, ABO 통과·CBO 경쟁·증액 대상·효율 하락을 한눈에.</li>
          <li>객관적 판정 — 설정한 기준(ROAS·기간·예산·목표)에 따라 통과/증액/경고를 자동 표시(AI 없이 규칙 기반).</li>
          <li>설정 — 시기별로 기준을 바꿀 수 있는 커스텀 설정.</li>
        </ul>
      </div>
    </div>
  );
}
