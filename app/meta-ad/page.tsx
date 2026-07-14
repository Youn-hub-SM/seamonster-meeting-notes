"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";

type Stat = { spend: number; impressions: number; clicks: number; ctr: number; cpc: number; purchases: number; purchaseValue: number; roas: number; cpa: number };
type Campaign = { id: string; name: string; status: string; effective_status: string; objective?: string; daily_budget?: string; lifetime_budget?: string; cbo: boolean; stat: Stat };
type Adset = { id: string; name: string; status: string; effective_status: string; campaign_id: string; daily_budget?: string; lifetime_budget?: string; abo: boolean; stat: Stat };
type Ad = { id: string; name: string; status: string; effective_status: string; adset_id: string; stat: Stat };
type Thresholds = {
  minSpend: number; testDailyPerCreative: number; testDays: number;
  aboPassRoas: number; aboMaxCpa: number; beatLiveCampaign: boolean; aboMinPurchases: number;
  scaleRoas: number; scaleDays: number; scalePct: number; declineRoas: number;
  libraryRoas: number;
};
type Overview = { ok: boolean; error?: string; thresholds: Thresholds; campaigns: Campaign[]; adsets: Adset[]; ads: Ad[]; cached?: boolean };

const PRESETS = [
  { key: "today", label: "오늘" }, { key: "yesterday", label: "어제" },
  { key: "last_7d", label: "최근 7일" }, { key: "last_30d", label: "최근 30일" },
];
const won = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());
const pct = (n?: number) => (n == null ? "-" : `${n.toFixed(2)}%`);
const roasFmt = (n?: number) => (n == null ? "-" : n.toFixed(2));

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function presetRange(key: string): { since: string; until: string } {
  const now = new Date();
  const back = (n: number) => { const x = new Date(now); x.setDate(x.getDate() - n); return ymd(x); };
  if (key === "today") return { since: back(0), until: back(0) };
  if (key === "yesterday") return { since: back(1), until: back(1) };
  if (key === "last_30d" || key === "last30days") return { since: back(30), until: back(1) };
  return { since: back(7), until: back(1) };
}
const rangeLabel = (key: string) => { const r = presetRange(key); return r.since === r.until ? r.since : `${r.since} ~ ${r.until}`; };

type StageInfo = { key: string; label: string; color: string; action?: string };
const STAGE_SHORT: Record<string, string> = {
  material: "소재테스트 캠페인", performance: "성과테스트", scale: "증액 권장", decline: "효율 하락", insufficient: "데이터 부족",
  pass: "✅ 우수소재", danger: "⚠️ 위험소재", fail: "관찰", testing: "테스트 중", sub: "본 캠페인 하위",
};
const STAGE_ORDER = ["pass", "danger", "testing", "fail", "scale", "performance", "decline", "material", "sub", "insufficient"];

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  const s: CSSProperties = { fontSize: 12, padding: "5px 12px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap", fontWeight: on ? 700 : 500, border: on ? "1px solid var(--sm-orange)" : "1px solid var(--sm-border)", background: on ? "var(--sm-orange-light)" : "var(--sm-white)", color: on ? "var(--sm-orange-hover)" : "var(--sm-text-mid)" };
  return <button type="button" onClick={onClick} style={s}>{children}</button>;
}
function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 6, background: `${color}1a`, color, whiteSpace: "nowrap" }}>{children}</span>;
}

// 본 캠페인 진입용 광고세트 이름 만들기: "yyyy-mm-dd 메시지"
function NameHelper({ today }: { today: string }) {
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const name = `${today} ${msg}`.trim();
  return (
    <div className="sm-row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--sm-text-mid)" }}>세트 이름 만들기</span>
      <code style={{ fontSize: 11.5, background: "var(--sm-white)", padding: "3px 7px", borderRadius: 6, border: "1px solid var(--sm-border)" }}>{today}</code>
      <input value={msg} onChange={(e) => { setMsg(e.target.value); setCopied(false); }} placeholder="주요 메시지 (예: 무료배송 강조)"
        className="b2b-input" style={{ width: 200, fontSize: 12, padding: "5px 9px" }} />
      <button type="button" className="b2b-btn-secondary" style={{ fontSize: 12, padding: "5px 10px" }}
        onClick={() => { navigator.clipboard?.writeText(name); setCopied(true); }}>{copied ? "복사됨 ✓" : "복사"}</button>
      {msg && <span className="sm-faint" style={{ fontSize: 11 }}>→ {name}</span>}
    </div>
  );
}

// 권장 행동 한 줄 — 클릭하면 해당 단계로 필터.
function RecoRow({ color, icon, title, items, onClick }: { color: string; icon: string; title: string; items: string[]; onClick: () => void }) {
  return (
    <div>
      <button onClick={onClick} style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, fontSize: 12.5, fontWeight: 700, color }}>{icon} {title} →</button>
      <div className="sm-faint" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.5 }}>{items.slice(0, 6).join(" · ")}{items.length > 6 ? ` 외 ${items.length - 6}건` : ""}</div>
    </div>
  );
}

export default function MetaAdPage() {
  const [status, setStatus] = useState<{ configured: boolean; connected?: boolean; error?: string; account?: { name?: string } } | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [preset, setPreset] = useState("last_7d");
  const [tab, setTab] = useState<"campaign" | "adset" | "ad">("adset");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [liveOnly, setLiveOnly] = useState(true);
  const [resultsOnly, setResultsOnly] = useState(true);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [showPlaybook, setShowPlaybook] = useState(false);
  const today = ymd(new Date());

  useEffect(() => {
    (async () => {
      try { const s = await (await fetch("/api/meta-ad/status", { cache: "no-store" })).json(); setStatus({ configured: !!s.configured, connected: s.connected, error: s.error, account: s.account }); }
      catch { setStatus({ configured: false }); }
    })();
  }, []);

  const load = useCallback(async (force = false) => {
    setLoading(true); setError("");
    try {
      const j: Overview = await (await fetch(`/api/meta-ad/overview?datePreset=${preset}${force ? "&fresh=1" : ""}`, { cache: "no-store" })).json();
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
  // 광고세트별 소재(광고) 수 — 소재테스트 권장예산 계산용
  const adsByAdset = useMemo(() => {
    const m: Record<string, number> = {};
    (ov?.ads || []).forEach((a) => { m[a.adset_id] = (m[a.adset_id] || 0) + 1; });
    return m;
  }, [ov]);
  // 현재 운영 중인 본 캠페인(라이브 CBO) 평균 ROAS — 우수소재 '캠페인 상회' 벤치마크
  const liveCampaignRoas = useMemo(() => {
    const camps = (ov?.campaigns || []).filter((c) => c.cbo && c.effective_status === "ACTIVE" && c.stat.spend >= (th?.minSpend ?? 0));
    const spend = camps.reduce((s, c) => s + c.stat.spend, 0);
    const val = camps.reduce((s, c) => s + c.stat.purchaseValue, 0);
    return spend > 0 ? val / spend : 0;
  }, [ov, th]);

  // ── 단계 판정(엔티티별 순수 함수 — 표·권장행동 양쪽서 재사용) ──
  const classifyCampaign = useCallback((c: Campaign): StageInfo => {
    const s = c.stat;
    if (!c.cbo) return { key: "material", label: "① 소재테스트 캠페인", color: "#4c6ef5", action: "광고세트 탭에서 소재별로 판정" };
    const budget = Number(c.daily_budget) || 0;
    const up = Math.round(budget * (1 + (th?.scalePct ?? 0) / 100));
    if (s.spend < (th?.minSpend ?? 0)) return { key: "insufficient", label: "성과테스트 · 데이터 부족", color: "#868e96", action: `지출 ${won(th?.minSpend)}원까지 대기 후 판정` };
    if (s.roas >= (th?.scaleRoas ?? 99)) return { key: "scale", label: `③ 증액 권장 +${th?.scalePct}%`, color: "#2f9e44", action: budget ? `증액: 일 ${won(budget)}원 → ${won(up)}원 (+${th?.scalePct}%, 주 1회)` : `예산 +${th?.scalePct}% 증액 (주 1회)` };
    if (s.roas < (th?.declineRoas ?? 0)) return { key: "decline", label: "④ 효율 하락", color: "#e03131", action: "소재 점검 후 교체 · 개선 없으면 예산 축소/종료" };
    return { key: "performance", label: "② 성과테스트(운영)", color: "#f76707", action: "운영 유지 · 모니터링" };
  }, [th]);

  const classifyAdset = useCallback((a: Adset): StageInfo => {
    if (!a.abo) return { key: "sub", label: "본 캠페인 하위 세트", color: "#adb5bd", action: "본 캠페인(CBO) 소속 — 캠페인 탭에서 관리" };
    const s = a.stat;
    const creatives = adsByAdset[a.id] || 1;
    const recBudget = (th?.testDailyPerCreative || 0) * creatives;
    const budgetNote = `권장 일예산 ${won(recBudget)}원 (소재 ${creatives}개 × ${won(th?.testDailyPerCreative)}원)`;
    if (s.spend < (th?.minSpend ?? 0)) return { key: "testing", label: "① 테스트 중", color: "#868e96", action: `${th?.testDays}일/지출 ${won(th?.minSpend)}원까지 유지 · ${budgetNote}` };
    const roasOk = s.roas >= (th?.aboPassRoas ?? 99);
    const cpaOk = (th?.aboMaxCpa ?? 0) > 0 && s.cpa > 0 && s.cpa <= (th?.aboMaxCpa ?? 0);
    const beatOk = !!th?.beatLiveCampaign && liveCampaignRoas > 0 && s.roas >= liveCampaignRoas;
    const pass = s.purchases >= (th?.aboMinPurchases ?? 1) && (roasOk || cpaOk || beatOk);
    if (pass) {
      const why = roasOk ? `ROAS ${roasFmt(s.roas)}≥${th?.aboPassRoas}` : beatOk ? `현 캠페인 ROAS ${roasFmt(liveCampaignRoas)} 상회` : cpaOk ? `CPA ${won(s.cpa)}≤${won(th?.aboMaxCpa)}` : "기준 충족";
      return { key: "pass", label: "✅ 우수소재 → 본 캠페인", color: "#2f9e44", action: `본 캠페인(CBO)에 새 세트로 추가 · 이름 "${today} 메시지" (${why})` };
    }
    // 위험: 전환은 충분한데 ROAS가 하락 기준 미만 → 교체/종료
    if (s.purchases >= (th?.aboMinPurchases ?? 1) && s.roas < (th?.declineRoas ?? 0)) {
      return { key: "danger", label: "⚠️ 위험소재", color: "#e03131", action: `ROAS ${roasFmt(s.roas)} < ${th?.declineRoas} — 소재 교체 또는 종료` };
    }
    const why = s.purchases < (th?.aboMinPurchases ?? 1) ? `전환 ${s.purchases}건 (기준 ${th?.aboMinPurchases})` : `ROAS ${roasFmt(s.roas)}`;
    return { key: "fail", label: "관찰 필요", color: "#868e96", action: `기준 미달(${why}) — 관찰 또는 소재 교체` };
  }, [th, adsByAdset, liveCampaignRoas, today]);

  const classify = useCallback((r: Campaign | Adset | Ad): StageInfo | null => {
    if (!th) return null;
    if (tab === "campaign") return classifyCampaign(r as Campaign);
    if (tab === "adset") return classifyAdset(r as Adset);
    return null;
  }, [tab, th, classifyCampaign, classifyAdset]);

  // 권장 행동 목록 — 현재 라이브 상태 전체를 훑어 조치가 필요한 항목을 모음(탭 무관).
  const recos = useMemo(() => {
    if (!th || !ov) return null;
    const liveAdsets = (ov.adsets || []).filter((a) => a.effective_status === "ACTIVE");
    const liveCamps = (ov.campaigns || []).filter((c) => c.effective_status === "ACTIVE");
    return {
      pass: liveAdsets.filter((a) => classifyAdset(a).key === "pass"),
      danger: liveAdsets.filter((a) => classifyAdset(a).key === "danger"),
      scale: liveCamps.filter((c) => classifyCampaign(c).key === "scale"),
      decline: liveCamps.filter((c) => classifyCampaign(c).key === "decline"),
      library: (ov.ads || [])
        .filter((a) => a.effective_status === "ACTIVE" && a.stat.spend >= th.minSpend && a.stat.purchases > 0 && a.stat.roas >= (th.libraryRoas || 99))
        .sort((a, b) => b.stat.roas - a.stat.roas),
    };
  }, [th, ov, classifyAdset, classifyCampaign]);

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
  const passFilters = useCallback((r: { effective_status: string; stat: Stat }) =>
    (!liveOnly || r.effective_status === "ACTIVE") && (!resultsOnly || r.stat.spend > 0), [liveOnly, resultsOnly]);
  const filtered = useMemo(() => rows.filter(passFilters), [rows, passFilters]);
  const shown = useMemo(() => {
    const list = stageFilter ? filtered.filter((r) => classify(r)?.key === stageFilter) : filtered;
    return [...list].sort((a, b) => b.stat.spend - a.stat.spend);
  }, [filtered, stageFilter, classify]);
  const visN = (arr?: { effective_status: string; stat: Stat }[]) => (arr ? arr.filter(passFilters).length : "");
  const stageGroups = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of filtered) { const k = classify(r)?.key; if (k) counts[k] = (counts[k] || 0) + 1; }
    return STAGE_ORDER.filter((k) => counts[k]).map((k) => ({ key: k, n: counts[k] }));
  }, [filtered, classify]);
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
          <p className="b2b-page-subtitle">소재테스트 → 우수소재 → 본 캠페인 → 증액. 각 광고의 <b>다음 행동</b>을 규칙대로 안내합니다. {status?.account?.name ? <b>· {status.account.name}</b> : null} <Link href="/meta-ad/settings">기준 설정</Link> · <Link href="/meta-ad/library">소재 라이브러리</Link></p>
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {PRESETS.map((p) => <Chip key={p.key} on={preset === p.key} onClick={() => setPreset(p.key)}>{p.label}</Chip>)}
          <span className="sm-faint" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{rangeLabel(preset)}{ov?.cached ? " · 캐시" : ""}</span>
          <button className="b2b-btn-secondary" onClick={() => load(true)} disabled={loading || !status?.connected}>{loading ? "..." : "새로고침"}</button>
        </div>
      </header>

      {status && !status.configured && (
        <div className="b2b-error" style={{ background: "var(--sm-warning-bg)", color: "var(--sm-warning)", border: "1px solid #f0d9a8" }}>
          <strong>메타 API 연결 대기 중.</strong> <code>META_ACCESS_TOKEN</code>·<code>META_AD_ACCOUNT_ID</code> 를 넣으세요.
        </div>
      )}
      {status?.configured && status.connected === false && <div className="b2b-error"><strong>연결 실패</strong> — {status.error}</div>}
      {error && <div className="b2b-error">{error}</div>}

      {status?.connected && th && (
        <>
          {/* 🎯 권장 행동 목록 (항상 열림) */}
          <div className="b2b-card" style={{ marginBottom: 12, padding: "12px 14px" }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: "var(--sm-dark)", marginBottom: 8 }}>🎯 지금 할 일 <span className="sm-faint" style={{ fontWeight: 400, fontSize: 11 }}>· 현재 상황 기반 권장 행동 (라이브 기준)</span></div>
            {!recos || (recos.pass.length + recos.danger.length + recos.scale.length + recos.decline.length + recos.library.length) === 0 ? (
              <div className="sm-faint" style={{ fontSize: 12.5 }}>지금 특별히 조치할 항목이 없습니다 👍 (테스트·모니터링 유지)</div>
            ) : (
              <div className="sm-col" style={{ gap: 9 }}>
                {recos.pass.length > 0 && <RecoRow color="#2f9e44" icon="🟢" title={`우수소재 ${recos.pass.length}건 → 본 캠페인에 새 세트로 추가`} items={recos.pass.map((a) => a.name)} onClick={() => { setTab("adset"); setStageFilter("pass"); }} />}
                {recos.danger.length > 0 && <RecoRow color="#e03131" icon="🔴" title={`위험소재 ${recos.danger.length}건 → 소재 교체/종료`} items={recos.danger.map((a) => a.name)} onClick={() => { setTab("adset"); setStageFilter("danger"); }} />}
                {recos.scale.length > 0 && <RecoRow color="#2f9e44" icon="📈" title={`증액 가능 캠페인 ${recos.scale.length}건 → 주 1회 +${th.scalePct}%`} items={recos.scale.map((c) => c.name)} onClick={() => { setTab("campaign"); setStageFilter("scale"); }} />}
                {recos.decline.length > 0 && <RecoRow color="#e03131" icon="📉" title={`효율 하락 캠페인 ${recos.decline.length}건 → 소재 점검`} items={recos.decline.map((c) => c.name)} onClick={() => { setTab("campaign"); setStageFilter("decline"); }} />}
                {recos.library.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "#7048e8" }}>⭐ 라이브러리 저장 추천 {recos.library.length}건 <span className="sm-faint" style={{ fontWeight: 400 }}>(ROAS ≥ {th.libraryRoas} · 재사용 아카이빙)</span></div>
                    <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 5 }}>
                      {recos.library.slice(0, 12).map((a) => (
                        <Link key={a.id} className="rp-chip" style={{ textDecoration: "none" }}
                          href={`/meta-ad/library?name=${encodeURIComponent(a.name)}&roas=${a.stat.roas.toFixed(2)}&adid=${a.id}&spend=${Math.round(a.stat.spend)}&purchases=${a.stat.purchases}`}>
                          {a.name.length > 22 ? a.name.slice(0, 22) + "…" : a.name} · ROAS {roasFmt(a.stat.roas)} 저장→
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 운영 규칙(플레이북) */}
          <div className="b2b-card" style={{ padding: 0, marginBottom: 12, borderColor: "var(--sm-orange-border, #f0c9a8)" }}>
            <button type="button" onClick={() => setShowPlaybook((v) => !v)}
              style={{ width: "100%", textAlign: "left", background: "var(--sm-orange-light)", border: "none", cursor: "pointer", padding: "10px 14px", borderRadius: showPlaybook ? "10px 10px 0 0" : 10, fontSize: 13.5, fontWeight: 800, color: "var(--sm-orange-hover)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>📋 운영 규칙 (플레이북)</span><span style={{ fontSize: 12 }}>{showPlaybook ? "접기 ▲" : "펼치기 ▼"}</span>
            </button>
            {showPlaybook && (
              <div style={{ padding: 14, display: "grid", gap: 10, fontSize: 12.5, lineHeight: 1.55 }}>
                <div><Badge color="#4c6ef5">① 소재테스트 (ABO)</Badge> <b>1세트=1소재</b>, 소재당 <b>{won(th.testDailyPerCreative)}원/일 · {th.testDays}일</b>. AB테스트는 한 세트에 소재를 몰아넣고 소재당 예산 추가(2개=일 {won(th.testDailyPerCreative * 2)}원).</div>
                <div><Badge color="#2f9e44">② 우수소재</Badge> 다음 중 하나 충족 → <b>ROAS ≥ {th.aboPassRoas}</b>{th.aboMaxCpa > 0 ? <> · <b>CPA ≤ {won(th.aboMaxCpa)}원</b></> : null}{th.beatLiveCampaign ? <> · <b>현 캠페인 ROAS 상회</b>{liveCampaignRoas > 0 ? <span className="sm-faint">(현재 {roasFmt(liveCampaignRoas)})</span> : null}</> : null}.</div>
                <div><Badge color="#f76707">③ 본 캠페인 진입 (CBO)</Badge> 우수소재는 <b>기존 본 캠페인에 새 광고세트로 추가</b>. 세트 이름은 <code>yyyy-mm-dd 주요 메시지</code>.</div>
                <div><Badge color="#e03131">④ 증액</Badge> 부여 예산·효율 좋으면 <b>주 1회 +{th.scalePct}%</b>씩 증액 (ROAS ≥ {th.scaleRoas}).</div>
                <div style={{ borderTop: "1px dashed var(--sm-border)", paddingTop: 10 }}><NameHelper today={today} /></div>
              </div>
            )}
          </div>

          {/* KPI */}
          <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", marginBottom: 12 }}>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">지출</div><div className="b2b-stat-card-value b2b-money">{won(totals.spend)}원</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">구매수</div><div className="b2b-stat-card-value b2b-money">{won(totals.purch)}</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">매출</div><div className="b2b-stat-card-value b2b-money">{won(totals.val)}원</div></div>
            <div className="b2b-stat-card"><div className="b2b-stat-card-label">ROAS</div><div className="b2b-stat-card-value b2b-money" style={{ color: "var(--sm-orange)" }}>{roasFmt(blendRoas)}</div></div>
          </div>

          {/* 탭 + 필터 */}
          <div className="sm-row" style={{ gap: 6, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Chip on={tab === "adset"} onClick={() => { setTab("adset"); setStageFilter(null); }}>소재테스트(세트) {visN(ov?.adsets)}</Chip>
            <Chip on={tab === "campaign"} onClick={() => { setTab("campaign"); setStageFilter(null); }}>본 캠페인 {visN(ov?.campaigns)}</Chip>
            <Chip on={tab === "ad"} onClick={() => { setTab("ad"); setStageFilter(null); }}>소재 {visN(ov?.ads)}</Chip>
            <div style={{ flex: 1 }} />
            <label className="sm-row" style={{ gap: 5, fontSize: 12, cursor: "pointer", fontWeight: 600, color: "var(--sm-text-mid)" }}>
              <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} />라이브만 (게재 중)
            </label>
            <label className="sm-row" style={{ gap: 5, fontSize: 12, cursor: "pointer", fontWeight: 600, color: "var(--sm-text-mid)" }}>
              <input type="checkbox" checked={resultsOnly} onChange={(e) => setResultsOnly(e.target.checked)} />결과 있는 것만 (지출&gt;0)
            </label>
          </div>

          {/* 단계 필터 */}
          {stageGroups.length > 0 && (
            <div className="sm-row" style={{ gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)", marginRight: 2 }}>단계</span>
              <Chip on={stageFilter === null} onClick={() => setStageFilter(null)}>전체 {filtered.length}</Chip>
              {stageGroups.map((g) => <Chip key={g.key} on={stageFilter === g.key} onClick={() => setStageFilter(g.key)}>{STAGE_SHORT[g.key] || g.key} {g.n}</Chip>)}
            </div>
          )}

          {loading ? <div className="b2b-loading">불러오는 중...</div> : (
            <div className="b2b-table-wrap">
              <table className="b2b-table" style={{ fontSize: 12.5 }}>
                <thead><tr>
                  <th>ON</th><th>{tab === "campaign" ? "본 캠페인" : tab === "adset" ? "광고세트(소재테스트)" : "소재"}</th>
                  <th style={{ minWidth: 200 }}>단계 · 다음 행동</th>
                  <th className="num">지출</th><th className="num">구매</th><th className="num">매출</th><th className="num">ROAS</th><th className="num">CPA</th><th className="num">CTR</th>
                  {tab !== "ad" && <th className="num">예산</th>}
                </tr></thead>
                <tbody>
                  {shown.map((r) => {
                    const s = r.stat; const budget = "daily_budget" in r ? (r.daily_budget || r.lifetime_budget) : undefined;
                    const stage = classify(r);
                    const roasColor = s.spend >= (th?.minSpend ?? 0) && s.purchases > 0 ? (s.roas >= (th?.scaleRoas ?? 99) ? "var(--sm-success)" : s.roas < (th?.declineRoas ?? 0) ? "#e03131" : undefined) : undefined;
                    return (
                      <tr key={r.id} style={r.effective_status !== "ACTIVE" && r.status !== "ACTIVE" ? { opacity: 0.55 } : undefined}>
                        <td><Switch id={r.id} st={r.status} name={r.name} /></td>
                        <td style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}
                          {tab === "campaign" && adsetByCampaign[r.id] ? <span className="sm-faint" style={{ fontSize: 10 }}> · 세트 {adsetByCampaign[r.id]}</span> : null}</td>
                        <td style={{ minWidth: 200, maxWidth: 320 }}>
                          {stage ? <Badge color={stage.color}>{stage.label}</Badge> : null}
                          {stage?.action ? <div style={{ fontSize: 10.5, color: "var(--sm-text-mid)", marginTop: 3, lineHeight: 1.4, whiteSpace: "normal" }}>{stage.action}</div> : null}
                        </td>
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
            · ON 스위치는 <b>실제 메타 광고</b>를 켜고/끕니다(확인창 있음). · ‘다음 행동’은 <Link href="/meta-ad/settings">설정</Link>의 기준값으로 계산됩니다. · 예산 증액·세트 추가는 메타에서 직접 실행하세요(원클릭은 추후).
          </p>
        </>
      )}
    </div>
  );
}
