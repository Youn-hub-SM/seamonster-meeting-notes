"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Thresholds = {
  minSpend: number; aboPassRoas: number; aboMaxCpa: number; aboMinPurchases: number;
  scaleRoas: number; scaleDays: number; scalePct: number; declineRoas: number;
};

const FIELDS: { key: keyof Thresholds; label: string; hint: string; step?: number }[] = [
  { key: "minSpend", label: "판정 최소 지출(원)", hint: "이 금액 미만이면 데이터 부족으로 판정 보류" },
  { key: "aboPassRoas", label: "소재테스트 통과 ROAS ≥", hint: "예: 2 = 200%(매출/지출 2배)", step: 0.1 },
  { key: "aboMinPurchases", label: "소재테스트 통과 구매수 ≥", hint: "최소 구매 건수" },
  { key: "aboMaxCpa", label: "소재테스트 통과 CPA ≤ (원)", hint: "0 이면 미사용" },
  { key: "scaleRoas", label: "증액 권장 ROAS ≥", hint: "이 이상이면 증액 권장", step: 0.1 },
  { key: "scaleDays", label: "증액 권장 유지일(일)", hint: "N일 이상 유지 시(현재는 선택 기간 기준)" },
  { key: "scalePct", label: "증액 권장 비율(%)", hint: "예: 20 = +20%" },
  { key: "declineRoas", label: "효율 하락 ROAS <", hint: "이 미만이면 효율 하락 경고", step: 0.1 },
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
      setT(j.thresholds); setMsg("✅ 저장됨");
    } catch (e) { setErr(e instanceof Error ? e.message : "저장 오류"); }
    setSaving(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">메타 광고 · 판정 기준 설정</h1>
          <p className="b2b-page-subtitle">단계 판정(ABO 통과·증액 권장·효율 하락)에 쓰이는 기준값입니다. 시기에 맞게 조정하세요. <Link href="/meta-ad">← 보드로</Link></p>
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 8, alignItems: "center" }}>
          {msg && <span style={{ fontSize: 12, color: "var(--sm-success)" }}>{msg}</span>}
          <button className="b2b-btn-primary" onClick={save} disabled={saving || !t}>{saving ? "저장 중..." : "저장"}</button>
        </div>
      </header>
      {err && <div className="b2b-error">{err}</div>}
      {!t ? <div className="b2b-loading">불러오는 중...</div> : (
        <div className="b2b-card" style={{ padding: 16, maxWidth: 560 }}>
          <div style={{ display: "grid", gap: 12 }}>
            {FIELDS.map((f) => (
              <label key={f.key} className="sm-row" style={{ justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: 13 }}><b>{f.label}</b><br /><span className="sm-faint" style={{ fontSize: 11 }}>{f.hint}</span></span>
                <input type="number" step={f.step || 1} className="b2b-input b2b-money" style={{ width: 120, textAlign: "right" }}
                  value={t[f.key]} onChange={(e) => setT({ ...t, [f.key]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
