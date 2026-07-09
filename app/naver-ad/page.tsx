"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Campaign = { nccCampaignId: string; name: string; campaignTp: string };
type Adgroup = { nccAdgroupId: string; name: string; bidAmt?: number };
type Stat = { impCnt?: number; clkCnt?: number; salesAmt?: number; cpc?: number; ctr?: number; avgRnk?: number; ccnt?: number };
type Keyword = {
  nccKeywordId: string; keyword: string; bidAmt: number; useGroupBidAmt: boolean;
  adRelevanceScore?: number; expectedClickScore?: number; userLock?: boolean; stat?: Stat | null;
};
type Draft = { bidAmt: number; useGroupBidAmt: boolean };

const PRESETS = [
  { key: "last7days", label: "최근 7일" },
  { key: "last30days", label: "최근 30일" },
  { key: "yesterday", label: "어제" },
  { key: "today", label: "오늘" },
];
const won = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());
const num = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());

export default function NaverAdPage() {
  const [status, setStatus] = useState<{ configured: boolean; connected?: boolean; error?: string } | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [adgroups, setAdgroups] = useState<Adgroup[]>([]);
  const [adgroupId, setAdgroupId] = useState("");
  const [preset, setPreset] = useState("last7days");
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");

  // 상태 + 캠페인
  useEffect(() => {
    (async () => {
      try {
        const s = await (await fetch("/api/naver-ad/status", { cache: "no-store" })).json();
        setStatus({ configured: !!s.configured, connected: s.connected, error: s.error });
        if (s.configured && s.connected) {
          const c = await (await fetch("/api/naver-ad/campaigns", { cache: "no-store" })).json();
          if (c.ok) setCampaigns(c.campaigns || []);
        }
      } catch (e) { setError(e instanceof Error ? e.message : "상태 조회 오류"); }
    })();
  }, []);

  useEffect(() => {
    if (!campaignId) { setAdgroups([]); setAdgroupId(""); return; }
    (async () => {
      const j = await (await fetch(`/api/naver-ad/adgroups?campaignId=${encodeURIComponent(campaignId)}`, { cache: "no-store" })).json();
      if (j.ok) { setAdgroups(j.adgroups || []); setAdgroupId(""); setKeywords([]); }
      else setError(j.error || "광고그룹 조회 실패");
    })();
  }, [campaignId]);

  const loadKeywords = useCallback(async () => {
    if (!adgroupId) return;
    setLoading(true); setError(""); setSavedMsg(""); setDraft({});
    try {
      const j = await (await fetch(`/api/naver-ad/keywords?adgroupId=${encodeURIComponent(adgroupId)}&datePreset=${preset}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "키워드 조회 실패");
      setKeywords(j.keywords || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [adgroupId, preset]);
  useEffect(() => { if (adgroupId) loadKeywords(); }, [adgroupId, preset, loadKeywords]);

  function setBid(k: Keyword, bidAmt: number) {
    setDraft((d) => ({ ...d, [k.nccKeywordId]: { bidAmt, useGroupBidAmt: false } }));
    setSavedMsg("");
  }
  function bump(k: Keyword, pct: number) {
    const cur = draft[k.nccKeywordId]?.bidAmt ?? k.bidAmt;
    setBid(k, Math.max(70, Math.round((cur * (1 + pct / 100)) / 10) * 10)); // 10원 단위, 최소 70원
  }
  function toggleGroup(k: Keyword, on: boolean) {
    setDraft((d) => ({ ...d, [k.nccKeywordId]: { bidAmt: d[k.nccKeywordId]?.bidAmt ?? k.bidAmt, useGroupBidAmt: on } }));
    setSavedMsg("");
  }

  const changes = useMemo(() =>
    keywords.filter((k) => {
      const d = draft[k.nccKeywordId];
      return d && (d.bidAmt !== k.bidAmt || d.useGroupBidAmt !== k.useGroupBidAmt);
    }), [keywords, draft]);

  async function save() {
    if (changes.length === 0) return;
    setSaving(true); setError(""); setSavedMsg("");
    try {
      const updates = changes.map((k) => {
        const d = draft[k.nccKeywordId];
        return { nccKeywordId: k.nccKeywordId, bidAmt: d.bidAmt, useGroupBidAmt: d.useGroupBidAmt };
      });
      const r = await fetch("/api/naver-ad/keywords", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ updates }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "입찰가 변경 실패");
      setSavedMsg(`✅ 입찰가 ${j.updated}개 변경 완료`);
      loadKeywords();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 오류"); }
    setSaving(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">네이버 광고</h1>
          <p className="b2b-page-subtitle">파워링크 검색광고 키워드 입찰가를 조회·조정해 효율을 관리합니다.</p>
        </div>
        {changes.length > 0 && (
          <div className="b2b-page-actions sm-row" style={{ gap: 8, alignItems: "center" }}>
            {savedMsg && <span style={{ fontSize: 12, color: "var(--sm-success)" }}>{savedMsg}</span>}
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : `입찰가 저장 (${changes.length})`}</button>
          </div>
        )}
      </header>

      {/* 자격/연결 상태 */}
      {status && !status.configured && (
        <div className="b2b-error" style={{ background: "var(--sm-warning-bg)", color: "var(--sm-warning)", border: "1px solid #f0d9a8" }}>
          <strong>네이버 광고 API 자격이 아직 없습니다.</strong><br />
          검색광고 &gt; 도구 &gt; API 사용 관리에서 발급 후 <code>NAVER_AD_API_KEY</code> · <code>NAVER_AD_SECRET</code> · <code>NAVER_AD_CUSTOMER_ID</code> 를 Vercel 환경변수에 넣고 재배포하세요.
        </div>
      )}
      {status?.configured && status.connected === false && (
        <div className="b2b-error"><strong>연결 실패</strong> — {status.error || "자격을 확인하세요."}</div>
      )}
      {error && <div className="b2b-error">{error}</div>}

      {status?.connected && (
        <>
          <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
            <select className="b2b-select" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} style={{ width: "auto", minWidth: 200 }}>
              <option value="">캠페인 선택…</option>
              {campaigns.map((c) => <option key={c.nccCampaignId} value={c.nccCampaignId}>{c.name}</option>)}
            </select>
            <select className="b2b-select" value={adgroupId} onChange={(e) => setAdgroupId(e.target.value)} style={{ width: "auto", minWidth: 200 }} disabled={!adgroups.length}>
              <option value="">광고그룹 선택…</option>
              {adgroups.map((g) => <option key={g.nccAdgroupId} value={g.nccAdgroupId}>{g.name}{g.bidAmt ? ` (그룹입찰 ${won(g.bidAmt)}원)` : ""}</option>)}
            </select>
            <div style={{ flex: 1 }} />
            <select className="b2b-select" value={preset} onChange={(e) => setPreset(e.target.value)} style={{ width: "auto" }}>
              {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label} 성과</option>)}
            </select>
            <button className="b2b-btn-secondary" onClick={loadKeywords} disabled={loading || !adgroupId}>{loading ? "..." : "새로고침"}</button>
          </div>

          {!adgroupId ? (
            <div className="b2b-empty"><div className="b2b-empty-icon">🔎</div>캠페인·광고그룹을 선택하면 키워드가 나옵니다.</div>
          ) : loading ? (
            <div className="b2b-loading">불러오는 중...</div>
          ) : keywords.length === 0 ? (
            <div className="b2b-empty">이 그룹에 키워드가 없습니다.</div>
          ) : (
            <div className="b2b-table-wrap">
              <table className="b2b-table">
                <thead>
                  <tr>
                    <th>키워드</th>
                    <th className="num">노출</th><th className="num">클릭</th><th className="num">CTR</th>
                    <th className="num">CPC</th><th className="num">비용</th><th className="num">평균순위</th><th className="num">전환</th>
                    <th className="num">연관/클릭지수</th>
                    <th>입찰가</th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.map((k) => {
                    const d = draft[k.nccKeywordId];
                    const curBid = d?.bidAmt ?? k.bidAmt;
                    const useGroup = d?.useGroupBidAmt ?? k.useGroupBidAmt;
                    const changed = d && (d.bidAmt !== k.bidAmt || d.useGroupBidAmt !== k.useGroupBidAmt);
                    const st = k.stat;
                    return (
                      <tr key={k.nccKeywordId} style={changed ? { background: "var(--sm-orange-light)" } : undefined}>
                        <td><strong>{k.keyword}</strong>{k.userLock ? <span className="sm-faint" style={{ fontSize: 11 }}> · OFF</span> : null}</td>
                        <td className="num b2b-money">{num(st?.impCnt)}</td>
                        <td className="num b2b-money">{num(st?.clkCnt)}</td>
                        <td className="num">{st?.ctr != null ? `${st.ctr.toFixed(2)}%` : "-"}</td>
                        <td className="num b2b-money">{won(st?.cpc)}</td>
                        <td className="num b2b-money">{won(st?.salesAmt)}</td>
                        <td className="num">{st?.avgRnk != null ? st.avgRnk.toFixed(1) : "-"}</td>
                        <td className="num b2b-money">{num(st?.ccnt)}</td>
                        <td className="num" style={{ fontSize: 11, color: "var(--sm-text-mid)" }}>{k.adRelevanceScore ?? "-"} / {k.expectedClickScore ?? "-"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <div className="sm-row" style={{ gap: 4, alignItems: "center" }}>
                            <button className="b2b-btn-secondary" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => bump(k, -10)} disabled={useGroup} title="-10%">−</button>
                            <input type="number" className="b2b-input b2b-money" value={useGroup ? "" : curBid} disabled={useGroup}
                              onChange={(e) => setBid(k, Math.max(0, Number(e.target.value) || 0))} style={{ width: 84, textAlign: "right" }} placeholder={useGroup ? "그룹" : ""} />
                            <button className="b2b-btn-secondary" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => bump(k, 10)} disabled={useGroup} title="+10%">+</button>
                            <label className="sm-row" style={{ gap: 3, fontSize: 11, cursor: "pointer" }} title="그룹 기본입찰가 사용">
                              <input type="checkbox" checked={useGroup} onChange={(e) => toggleGroup(k, e.target.checked)} />그룹
                            </label>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
