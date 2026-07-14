"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Thresholds = {
  minSpend: number;
  testDailyPerCreative: number; testDays: number;
  aboPassRoas: number; aboMaxCpa: number; beatLiveCampaign: boolean; aboMinPurchases: number;
  scaleRoas: number; scaleDays: number; scalePct: number; declineRoas: number;
  libraryRoas: number;
};

type NumField = { key: Exclude<keyof Thresholds, "beatLiveCampaign">; label: string; hint: string; step?: number };
const GROUPS: { title: string; fields: NumField[] }[] = [
  {
    title: "① 소재테스트 (광고세트 예산 최적화 · ABO)",
    fields: [
      { key: "testDailyPerCreative", label: "소재당 일일 예산(원)", hint: "세트 권장예산 = 이 값 × 소재수 (예: 2만원 → 소재 2개 세트 4만원/일)" },
      { key: "testDays", label: "테스트 기간(일)", hint: "이 기간 또는 최소지출 도달까지 유지" },
      { key: "minSpend", label: "판정 최소 지출(원)", hint: "이 금액 미만이면 데이터 부족으로 판정 보류" },
    ],
  },
  {
    title: "② 우수소재 기준 (아래 중 하나만 충족해도 통과)",
    fields: [
      { key: "aboPassRoas", label: "ⓐ ROAS ≥", hint: "예: 2 = 200%(매출/지출 2배)", step: 0.1 },
      { key: "aboMaxCpa", label: "ⓑ 목표 전환단가(CPA) ≤ (원)", hint: "0 이면 미사용" },
      { key: "aboMinPurchases", label: "판정 전 최소 전환수 ≥", hint: "이만큼 전환이 있어야 판정(데이터 게이트)" },
    ],
  },
  {
    title: "③④ 본 캠페인 운영 · 증액 (캠페인 예산 최적화 · CBO)",
    fields: [
      { key: "scaleRoas", label: "증액 권장 ROAS ≥", hint: "이 이상이면 증액 권장", step: 0.1 },
      { key: "scalePct", label: "증액 비율(%)", hint: "부여 예산/효율 좋을 때 주 1회 이만큼 증액. 예: 20 = +20%" },
      { key: "scaleDays", label: "증액 유지일(일)", hint: "N일 이상 유지 시(현재는 선택 기간 기준)" },
      { key: "declineRoas", label: "효율 하락·위험 ROAS <", hint: "이 미만이면 위험소재로 판정(교체/종료 권장)", step: 0.1 },
    ],
  },
  {
    title: "⑤ 소재 라이브러리",
    fields: [
      { key: "libraryRoas", label: "라이브러리 저장 추천 ROAS ≥", hint: "이 이상 기록한 소재는 '라이브러리에 저장' 추천 (재사용용 아카이빙)", step: 0.1 },
    ],
  },
];

export default function MetaAdSettingsPage() {
  const [t, setT] = useState<Thresholds | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try { const j = await (await fetch("/api/meta-ad/settings", { cache: "no-store" })).json(); if (j.ok) setT(j.thresholds); }
      catch (e) { setErr(e instanceof Error ? e.message : "조회 오류"); }
    })();
  }, []);

  async function save() {
    if (!t) return;
    setSaving(true); setMsg(""); setErr("");
    try {
      const j = await (await fetch("/api/meta-ad/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) })).json();
      if (!j.ok) throw new Error(j.error);
      setT(j.thresholds); setMsg("저장됨");
    } catch (e) { setErr(e instanceof Error ? e.message : "저장 오류"); }
    setSaving(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">메타 광고 · 판정 기준 설정</h1>
          <p className="b2b-page-subtitle">소재테스트 예산·우수소재 기준·증액 규칙에 쓰이는 값입니다. 시기에 맞게 조정하세요. <Link href="/meta-ad">← 보드로</Link></p>
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 8, alignItems: "center" }}>
          {msg && <span style={{ fontSize: 12, color: "var(--sm-success)" }}>{msg}</span>}
          <button className="b2b-btn-primary" onClick={save} disabled={saving || !t}>{saving ? "저장 중..." : "저장"}</button>
        </div>
      </header>
      {err && <div className="b2b-error">{err}</div>}
      {!t ? <div className="b2b-loading">불러오는 중...</div> : (
        <div style={{ display: "grid", gap: 14, maxWidth: 620 }}>
          {GROUPS.map((g) => (
            <div key={g.title} className="b2b-card" style={{ padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 12, color: "var(--sm-dark)" }}>{g.title}</div>
              <div style={{ display: "grid", gap: 12 }}>
                {g.fields.map((f) => (
                  <label key={f.key} className="sm-row" style={{ justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <span style={{ fontSize: 13 }}><b>{f.label}</b><br /><span className="sm-faint" style={{ fontSize: 11 }}>{f.hint}</span></span>
                    <input type="number" step={f.step || 1} className="b2b-input b2b-money" style={{ width: 120, textAlign: "right" }}
                      value={t[f.key]} onChange={(e) => setT({ ...t, [f.key]: Number(e.target.value) })} />
                  </label>
                ))}
                {/* 우수소재 ③: 현재 캠페인 상회(체크박스) — ② 그룹에만 표시 */}
                {g.title.startsWith("②") && (
                  <label className="sm-row" style={{ justifyContent: "space-between", gap: 12, alignItems: "center", cursor: "pointer" }}>
                    <span style={{ fontSize: 13 }}><b>ⓒ 현재 운영 캠페인 ROAS 상회</b><br /><span className="sm-faint" style={{ fontSize: 11 }}>켜면 소재 ROAS가 현재 라이브 본 캠페인 평균 ROAS 이상이면 통과</span></span>
                    <input type="checkbox" className="b2b-checkbox" checked={t.beatLiveCampaign} onChange={(e) => setT({ ...t, beatLiveCampaign: e.target.checked })} />
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
