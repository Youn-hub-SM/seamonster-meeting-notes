"use client";

import { useEffect, useState } from "react";

type Thresholds = {
  minSpend: number;
  testDailyPerCreative: number; testDays: number;
  aboPassRoas: number; aboMaxCpa: number; beatLiveCampaign: boolean; aboMinPurchases: number;
  scaleRoas: number; scaleDays: number; scalePct: number; declineRoas: number;
  libraryRoas: number;
};

type NumField = { key: Exclude<keyof Thresholds, "beatLiveCampaign">; label: string; hint?: string; step?: number };
const GROUPS: { title: string; fields: NumField[] }[] = [
  {
    title: "① 소재테스트 (ABO)",
    fields: [
      { key: "testDailyPerCreative", label: "소재당 일일 예산(원)", hint: "세트 권장예산 = 이 값 × 소재수" },
      { key: "testDays", label: "테스트 기간(일)" },
      { key: "minSpend", label: "판정 최소 지출(원)" },
    ],
  },
  {
    title: "② 우수소재 기준 (아래 중 하나만 충족해도 통과)",
    fields: [
      { key: "aboPassRoas", label: "ⓐ ROAS ≥", hint: "2 = 200%", step: 0.1 },
      { key: "aboMaxCpa", label: "ⓑ 목표 전환단가(CPA) ≤ (원)", hint: "0 이면 미사용" },
      { key: "aboMinPurchases", label: "판정 전 최소 전환수 ≥" },
    ],
  },
  {
    title: "③④ 본 캠페인 운영 · 증액 (CBO)",
    fields: [
      { key: "scaleRoas", label: "증액 권장 ROAS ≥", step: 0.1 },
      { key: "scalePct", label: "증액 비율(%)" },
      { key: "scaleDays", label: "증액 유지일(일)", hint: "어제까지 연속으로 ROAS 기준을 넘긴 일수" },
      { key: "declineRoas", label: "효율 하락·위험 ROAS <", step: 0.1 },
    ],
  },
  {
    title: "⑤ 소재 라이브러리",
    fields: [
      { key: "libraryRoas", label: "라이브러리 저장 추천 ROAS ≥", step: 0.1 },
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
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 8, alignItems: "center" }}>
          {msg && <span style={{ fontSize: 15, color: "var(--sm-success)" }}>{msg}</span>}
          <button className="b2b-btn-primary" onClick={save} disabled={saving || !t}>{saving ? "저장 중..." : "저장"}</button>
        </div>
      </header>
      {err && <div className="b2b-error">{err}</div>}
      {!t ? <div className="b2b-loading">불러오는 중...</div> : (
        <div style={{ display: "grid", gap: 14, maxWidth: 620 }}>
          {GROUPS.map((g) => (
            <div key={g.title} className="b2b-card" style={{ padding: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12, color: "var(--sm-dark)" }}>{g.title}</div>
              <div style={{ display: "grid", gap: 12 }}>
                {g.fields.map((f) => (
                  <label key={f.key} className="sm-row" style={{ justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <span style={{ fontSize: 15 }}><b>{f.label}</b>{f.hint && <><br /><span className="sm-faint" style={{ fontSize: 15 }}>{f.hint}</span></>}</span>
                    <input type="number" step={f.step || 1} className="b2b-input b2b-money" style={{ width: 120, textAlign: "right" }}
                      value={t[f.key]} onChange={(e) => setT({ ...t, [f.key]: Number(e.target.value) })} />
                  </label>
                ))}
                {/* 우수소재 ③: 현재 캠페인 상회(체크박스) — ② 그룹에만 표시 */}
                {g.title.startsWith("②") && (
                  <label className="sm-row" style={{ justifyContent: "space-between", gap: 12, alignItems: "center", cursor: "pointer" }}>
                    <span style={{ fontSize: 15 }}><b>ⓒ 현재 운영 캠페인 ROAS 상회</b><br /><span className="sm-faint" style={{ fontSize: 15 }}>기준 = 라이브 본 캠페인 평균 ROAS</span></span>
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
