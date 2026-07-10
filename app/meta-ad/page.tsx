"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";

type Stat = { spend: number; impressions: number; clicks: number; ctr: number; cpc: number; purchases: number; purchaseValue: number; roas: number; cpa: number };
type Campaign = { id: string; name: string; status: string; effective_status: string; objective?: string; daily_budget?: string; lifetime_budget?: string; cbo: boolean; stat: Stat };
type Adset = { id: string; name: string; status: string; effective_status: string; campaign_id: string; daily_budget?: string; lifetime_budget?: string; abo: boolean; stat: Stat };
type Ad = { id: string; name: string; status: string; effective_status: string; adset_id: string; stat: Stat };
type Thresholds = { minSpend: number; aboPassRoas: number; aboMaxCpa: number; aboMinPurchases: number; scaleRoas: number; scaleDays: number; scalePct: number; declineRoas: number };
type Overview = { ok: boolean; error?: string; thresholds: Thresholds; campaigns: Campaign[]; adsets: Adset[]; ads: Ad[] };

const PRESETS = [
  { key: "today", label: "오늘" }, { key: "yesterday", label: "어제" },
  { key: "last_7d", label: "최근 7일" }, { key: "last_30d", label: "최근 30일" },
];
const won = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());
const pct = (n?: number) => (n == null ? "-" : `${n.toFixed(2)}%`);
const roasFmt = (n?: number) => (n == null ? "-" : n.toFixed(2));

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  const s: CSSProperties = { fontSize: 12, padding: "5px 12px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap", fontWeight: on ? 700 : 500, border: on ? "1px solid var(--sm-orange)" : "1px solid var(--sm-border)", background: on ? "var(--sm-orange-light)" : "var(--sm-white)", color: on ? "var(--sm-orange-hover)" : "var(--sm-text-mid)" };
  return <button type="button" onClick={onClick} style={s}>{children}</button>;
}
function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 6, background: `${color}1a`, color, whiteSpace: "nowrap" }}>{children}</span>;
}

export default function MetaAdPage() {
  const [status, setStatus] = useState<{ configured: boolean; connected?: boolean; error?: string; account?: { name?: string } } | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [preset, setPreset] = useState("last_7d");
  const [tab, setTab] = useState<"campaign" | "adset" | "ad">("campaign");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try { const s = await (await fetch("/api/meta-ad/status", { cache: "no-store" })).json(); setStatus({ configured: !!s.configured, connected: s.connected, error: s.error, account: s.account }); }
      catch { setStatus({ configured: false }); }
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j: Overview = await (await fetch(`/api/meta-ad/overview?datePreset=${preset}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setOv(j);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [preset]);
  useEffect(() => { if (status?.connected) load(); }, [status?.connected, load]);

  const th = ov?.thresholds;
  const adsetByCampaign = useMemo(() => {
    const m: Record<string, number> = {};
    (ov?.adsets || []).forEach((a) => { m[a.campaign_id] = (m[a.campaign_id] || 0) + 1; });
    return m;
  }, [ov]);

  // 단계 판정
  function campaignStage(c: Campaign) {
    if (!th) return null;
    const s = c.stat; const enough = s.spend >= th.minSpend;
    if (c.cbo) {
      if (!enough) return <Badge color="#868e96">CBO · 데이터 부족</Badge>;
      if (s.roas >= th.scaleRoas) return <Badge color="#2f9e44">③ 증액 권장 +{th.scalePct}%</Badge>;
      if (s.roas < th.declineRoas) return <Badge color="#e03131">④ 효율 하락</Badge>;
      return <Badge color="#f76707">② CBO 정상</Badge>;
    }
    return <Badge color="#4c6ef5">ABO 캠페인</Badge>;
  }
  function adsetStage(a: Adset) {
    if (!th || !a.abo) return a.abo ? null : <Badge color="#adb5bd">CBO 하위</Badge>;
    const s = a.stat; if (s.spend < th.minSpend) return <Badge color="#868e96">① 테스트 중</Badge>;
    const pass = s.roas >= th.aboPassRoas && s.purchases >= th.aboMinPurchases && (th.aboMaxCpa === 0 || (s.cpa > 0 && s.cpa <= th.aboMaxCpa));
    return pass ? <Badge color="#2f9e44">① 통과 → CBO 승격</Badge> : <Badge color="#868e96">① 미달</Badge>;
  }

  async function toggle(id: string, current: string, name: string) {
    const next = current === "ACTIVE" ? "PAUSED" : "ACTIVE";
    if (!window.confirm(`"${name}"\n\n실제 메타 광고를 ${next === "ACTIVE" ? "켤까요? (ON)" : "끌까요? (OFF)"}`)) return;
    setBusyId(id); setError("");
    try {
      const j = await (await fetch("/api/meta-ad/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: next }) })).json();
      if (!j.ok) throw new Error(j.error);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "상태 변경 실패"); }
    setBusyId(null);
  }

  const rows = tab === "campaign" ? (ov?.campaigns || []) : tab === "adset" ? (ov?.adsets || []) : (ov?.ads || []);
  const shown = useMemo(() => [...rows].sort((a, b) => b.stat.spend - a.stat.spend), [rows]);
  const totals = useMemo(() => shown.reduce((t, r) => ({ spend: t.spend + r.stat.spend, purch: t.purch + r.stat.purchases, val: t.val + r.stat.purchaseValue }), { spend: 0, purch: 0, val: 0 }), [shown]);
  const blendRoas = totals.spend ? totals.val / totals.spend : 0;

  const Switch = ({ id, st, name }: { id: string; st: string; name: string }) => {
    const on = st === "ACTIVE"; const busy = busyId === id;
    return (
      <button onClick={() => toggle(id, st, name)} disabled={busy} title={on ? "끄기" : "켜기"}
        style={{ width: 40, height: 22, borderRadius: 999, border: "none", cursor: busy ? "wait" : "pointer", background: on ? "var(--sm-success)" : "var(--sm-border)", position: "relative", opacity: busy ? 0.5 : 1, flex: "0 0 auto" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
      </button>
    );
  };

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">메타 광고</h1>
          <p className="b2b-page-subtitle">4단계(ABO→CBO→증액→효율하락) 기준으로 소재를 판정합니다. {status?.account?.name ? <b>· {status.account.name}</b> : null} <Link href="/meta-ad/settings">기준 설정</Link></p>
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {PRESETS.map((p) => <Chip key={p.key} on={preset === p.key} onClick={() => setPreset(p.key)}>{p.label}</Chip>)}
          <button className="b2b-btn-secondary" onClick={load} disabled={loading || !status?.connected}>{loading ? "..." : "새로고침"}</button>
        </div>
      </header>

      {status && !status.configured && (
        <div className="b2b-error" style={{ background: "var(--sm-warning-bg)", color: "var(--sm-warning)", border: "1px solid #f0d9a8" }}>
          <strong>메타 API 연결 대기 중.</strong> <code>META_ACCESS_TOKEN</code>·<code>META_AD_ACCOUNT_ID</code> 를 넣으세요.
        </div>
      )}
      {status?.configured && status.connected === false && <div className="b2b-error"><strong>연결 실패</strong> — {status.error}</div>}
      {error && <div className="b2b-error">{error}</div>}

      {status?.connected && (
        <>
          {/* 단계 범례 */}
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10, fontSize: 11 }}>
            <Badge color="#4c6ef5">① ABO 테스트</Badge><Badge color="#f76707">② CBO 경쟁</Badge>
            <Badge color="#2f9e44">③ 증액 권장</Badge><Badge color="#e03131">④ 효율 하락</Badge>
            <span className="sm-faint">ROAS=매출÷지출(배수). 기준값은 <Link href="/meta-ad/settings">설정</Link>에서.</span>
          </div>

          {/* KPI */}
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", marginBottom: 12 }}>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">지출</div><div className="b2b-stat-card-value b2b-money">{won(totals.spend)}원</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">구매수</div><div className="b2b-stat-card-value b2b-money">{won(totals.purch)}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">매출</div><div className="b2b-stat-card-value b2b-money">{won(totals.val)}원</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">ROAS</div><div className="b2b-stat-card-value b2b-money" style={{ color: "var(--sm-orange)" }}>{roasFmt(blendRoas)}</div></div>
          </div>

          {/* 탭 */}
          <div className="sm-row" style={{ gap: 6, marginBottom: 10 }}>
            {([["campaign", `캠페인 ${ov?.campaigns.length ?? ""}`], ["adset", `광고세트 ${ov?.adsets.length ?? ""}`], ["ad", `소재 ${ov?.ads.length ?? ""}`]] as const).map(([k, l]) =>
              <Chip key={k} on={tab === k} onClick={() => setTab(k)}>{l}</Chip>)}
          </div>

          {loading ? <div className="b2b-loading">불러오는 중...</div> : (
            <div className="b2b-table-wrap">
              <table className="b2b-table" style={{ fontSize: 12.5 }}>
                <thead><tr>
                  <th>ON</th><th>{tab === "campaign" ? "캠페인" : tab === "adset" ? "광고세트" : "소재"}</th><th>단계</th>
                  <th className="num">지출</th><th className="num">구매</th><th className="num">매출</th><th className="num">ROAS</th><th className="num">CPA</th><th className="num">CTR</th>
                  {tab !== "ad" && <th className="num">예산</th>}
                </tr></thead>
                <tbody>
                  {shown.map((r) => {
                    const s = r.stat; const budget = "daily_budget" in r ? (r.daily_budget || r.lifetime_budget) : undefined;
                    const stage = tab === "campaign" ? campaignStage(r as Campaign) : tab === "adset" ? adsetStage(r as Adset) : null;
                    const roasColor = s.spend >= (th?.minSpend ?? 0) && s.purchases > 0 ? (s.roas >= (th?.scaleRoas ?? 99) ? "var(--sm-success)" : s.roas < (th?.declineRoas ?? 0) ? "#e03131" : undefined) : undefined;
                    return (
                      <tr key={r.id} style={r.effective_status !== "ACTIVE" && r.status !== "ACTIVE" ? { opacity: 0.55 } : undefined}>
                        <td><Switch id={r.id} st={r.status} name={r.name} /></td>
                        <td style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}
                          {tab === "campaign" && adsetByCampaign[r.id] ? <span className="sm-faint" style={{ fontSize: 10 }}> · 세트 {adsetByCampaign[r.id]}</span> : null}</td>
                        <td>{stage}</td>
                        <td className="num b2b-money" style={{ fontWeight: 600 }}>{won(s.spend)}</td>
                        <td className="num b2b-money">{won(s.purchases)}</td>
                        <td className="num b2b-money">{won(s.purchaseValue)}</td>
                        <td className="num b2b-money" style={roasColor ? { color: roasColor, fontWeight: 700 } : undefined}>{s.purchases > 0 ? roasFmt(s.roas) : "-"}</td>
                        <td className="num b2b-money">{s.cpa > 0 ? won(s.cpa) : "-"}</td>
                        <td className="num">{pct(s.ctr)}</td>
                        {tab !== "ad" && <td className="num b2b-money">{budget ? won(Number(budget)) : "-"}</td>}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr style={{ borderTop: "2px solid var(--sm-border)", fontWeight: 700, background: "var(--sm-bg-soft,#fafafa)" }}>
                  <td></td><td>합계 {shown.length}</td><td></td>
                  <td className="num b2b-money">{won(totals.spend)}</td><td className="num b2b-money">{won(totals.purch)}</td>
                  <td className="num b2b-money">{won(totals.val)}</td><td className="num b2b-money" style={{ color: "var(--sm-orange)" }}>{roasFmt(blendRoas)}</td>
                  <td className="num">-</td><td className="num">-</td>{tab !== "ad" && <td className="num">-</td>}
                </tr></tfoot>
              </table>
            </div>
          )}
          <p className="sm-faint" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
            · ON 스위치는 <b>실제 메타 광고</b>를 켜고/끕니다(확인창 있음). · 단계 판정은 <Link href="/meta-ad/settings">설정</Link>의 기준값 기준. · ‘증액 권장’은 ROAS만 충족돼도 표시되며, 실제 예산 증액은 메타에서 직접(추후 원클릭 예정).
          </p>
        </>
      )}
    </div>
  );
}
