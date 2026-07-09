"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type Campaign = { nccCampaignId: string; name: string; campaignTp: string };
type Adgroup = { nccAdgroupId: string; nccCampaignId: string; name: string; bidAmt?: number };
type Stat = { impCnt?: number; clkCnt?: number; salesAmt?: number; cpc?: number; ctr?: number; avgRnk?: number; ccnt?: number };
type Keyword = {
  nccKeywordId: string; nccAdgroupId: string; keyword: string; bidAmt: number; useGroupBidAmt: boolean;
  adRelevanceScore?: number; expectedClickScore?: number; userLock?: boolean; stat?: Stat | null;
};
type Draft = { bidAmt: number; useGroupBidAmt: boolean };

const PRESETS = [
  { key: "last7days", label: "최근 7일" }, { key: "last30days", label: "최근 30일" },
  { key: "yesterday", label: "어제" }, { key: "today", label: "오늘" },
];
const TYPE_LABEL: Record<string, string> = {
  WEB_SITE: "파워링크", POWER_CONTENTS: "파워컨텐츠", SHOPPING: "쇼핑검색", BRAND_SEARCH: "브랜드검색", PLACE: "플레이스",
};
const KEYWORD_TYPES = new Set(["WEB_SITE", "POWER_CONTENTS", "PLACE"]); // 키워드 입찰 가능 유형
const won = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());
const num = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());

function Chip({ on, onClick, children, muted, title }: { on: boolean; onClick: () => void; children: React.ReactNode; muted?: boolean; title?: string }) {
  const style: CSSProperties = {
    fontSize: 12, padding: "5px 12px", borderRadius: 999, cursor: "pointer",
    border: on ? "1px solid var(--sm-orange)" : "1px solid var(--sm-border)",
    background: on ? "var(--sm-orange-light)" : "var(--sm-white)",
    color: on ? "var(--sm-orange-hover)" : muted ? "var(--sm-text-light)" : "var(--sm-text-mid)",
    fontWeight: on ? 700 : 500, whiteSpace: "nowrap",
  };
  return <button type="button" onClick={onClick} title={title} style={style}>{children}</button>;
}

export default function NaverAdPage() {
  const [status, setStatus] = useState<{ configured: boolean; connected?: boolean; error?: string } | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selCamp, setSelCamp] = useState<string[]>([]);
  const [adgroups, setAdgroups] = useState<Adgroup[]>([]);
  const [selGrp, setSelGrp] = useState<string[]>([]);
  const [preset, setPreset] = useState("last7days");
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [loadingGrp, setLoadingGrp] = useState(false);
  const [loadingKw, setLoadingKw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const s = await (await fetch("/api/naver-ad/status", { cache: "no-store" })).json();
        setStatus({ configured: !!s.configured, connected: s.connected, error: s.error });
        if (s.configured && s.connected) {
          const c = await (await fetch("/api/naver-ad/campaigns", { cache: "no-store" })).json();
          if (c.ok) {
            const list = (c.campaigns || []) as Campaign[];
            list.sort((a, b) => (KEYWORD_TYPES.has(b.campaignTp) ? 1 : 0) - (KEYWORD_TYPES.has(a.campaignTp) ? 1 : 0) || a.name.localeCompare(b.name, "ko"));
            setCampaigns(list);
          }
        }
      } catch (e) { setError(e instanceof Error ? e.message : "상태 조회 오류"); }
    })();
  }, []);

  const campName = useMemo(() => Object.fromEntries(campaigns.map((c) => [c.nccCampaignId, c.name])), [campaigns]);
  const grpName = useMemo(() => Object.fromEntries(adgroups.map((g) => [g.nccAdgroupId, g.name])), [adgroups]);

  // 선택 캠페인 → 광고그룹
  const selCampKey = selCamp.join(",");
  useEffect(() => {
    if (!selCamp.length) { setAdgroups([]); setSelGrp([]); setKeywords([]); return; }
    (async () => {
      setLoadingGrp(true); setError("");
      try {
        const j = await (await fetch(`/api/naver-ad/adgroups?campaignIds=${encodeURIComponent(selCampKey)}`, { cache: "no-store" })).json();
        if (!j.ok) throw new Error(j.error || "광고그룹 조회 실패");
        setAdgroups(j.adgroups || []);
        setSelGrp((prev) => prev.filter((id) => (j.adgroups || []).some((g: Adgroup) => g.nccAdgroupId === id)));
      } catch (e) { setError(e instanceof Error ? e.message : "그룹 조회 오류"); }
      setLoadingGrp(false);
    })();
  }, [selCampKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 선택 그룹 → 키워드
  const selGrpKey = selGrp.join(",");
  const loadKeywords = useCallback(async () => {
    if (!selGrp.length) { setKeywords([]); return; }
    setLoadingKw(true); setError(""); setSavedMsg(""); setDraft({});
    try {
      const j = await (await fetch(`/api/naver-ad/keywords?adgroupIds=${encodeURIComponent(selGrpKey)}&datePreset=${preset}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "키워드 조회 실패");
      setKeywords(j.keywords || []);
    } catch (e) { setError(e instanceof Error ? e.message : "키워드 조회 오류"); }
    setLoadingKw(false);
  }, [selGrpKey, preset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadKeywords(); }, [selGrpKey, preset, loadKeywords]);

  const toggle = (arr: string[], set: (v: string[]) => void, id: string) =>
    set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  const shownKeywords = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? keywords.filter((k) => k.keyword.toLowerCase().includes(q)) : keywords;
  }, [keywords, search]);

  function setBid(k: Keyword, bidAmt: number) { setDraft((d) => ({ ...d, [k.nccKeywordId]: { bidAmt, useGroupBidAmt: false } })); setSavedMsg(""); }
  function bump(k: Keyword, pct: number) {
    const cur = draft[k.nccKeywordId]?.bidAmt ?? k.bidAmt;
    setBid(k, Math.max(70, Math.round((cur * (1 + pct / 100)) / 10) * 10));
  }
  function toggleGroupBid(k: Keyword, on: boolean) { setDraft((d) => ({ ...d, [k.nccKeywordId]: { bidAmt: d[k.nccKeywordId]?.bidAmt ?? k.bidAmt, useGroupBidAmt: on } })); setSavedMsg(""); }

  const changes = useMemo(() => keywords.filter((k) => {
    const d = draft[k.nccKeywordId]; return d && (d.bidAmt !== k.bidAmt || d.useGroupBidAmt !== k.useGroupBidAmt);
  }), [keywords, draft]);

  async function save() {
    if (!changes.length) return;
    setSaving(true); setError(""); setSavedMsg("");
    try {
      const updates = changes.map((k) => { const d = draft[k.nccKeywordId]; return { nccKeywordId: k.nccKeywordId, bidAmt: d.bidAmt, useGroupBidAmt: d.useGroupBidAmt }; });
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
          <p className="b2b-page-subtitle">파워링크 키워드 입찰가를 조회·조정해 효율을 관리합니다. 캠페인·그룹을 여러 개 선택해 한 번에 볼 수 있어요.</p>
        </div>
        {changes.length > 0 && (
          <div className="b2b-page-actions sm-row" style={{ gap: 8, alignItems: "center" }}>
            {savedMsg && <span style={{ fontSize: 12, color: "var(--sm-success)" }}>{savedMsg}</span>}
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : `입찰가 저장 (${changes.length})`}</button>
          </div>
        )}
      </header>

      {status && !status.configured && (
        <div className="b2b-error" style={{ background: "var(--sm-warning-bg)", color: "var(--sm-warning)", border: "1px solid #f0d9a8" }}>
          <strong>네이버 광고 API 자격이 아직 없습니다.</strong> <code>NAVER_AD_API_KEY</code>·<code>NAVER_AD_SECRET</code>·<code>NAVER_AD_CUSTOMER_ID</code> 를 넣고 재배포하세요.
        </div>
      )}
      {status?.configured && status.connected === false && <div className="b2b-error"><strong>연결 실패</strong> — {status.error || "자격 확인"}</div>}
      {error && <div className="b2b-error">{error}</div>}

      {status?.connected && (
        <>
          {/* 캠페인 필터(다중) */}
          <div style={{ border: "1px solid var(--sm-border)", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
            <div className="sm-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)" }}>캠페인 <span className="sm-faint" style={{ fontWeight: 400 }}>(여러 개 선택 가능 · 키워드는 파워링크/파워컨텐츠에만 있음)</span></span>
              {selCamp.length > 0 && <button className="b2b-link-btn" style={{ fontSize: 11 }} onClick={() => setSelCamp([])}>선택 해제</button>}
            </div>
            <div className="sm-row" style={{ gap: 6, flexWrap: "wrap" }}>
              {campaigns.map((c) => {
                const kw = KEYWORD_TYPES.has(c.campaignTp);
                return <Chip key={c.nccCampaignId} on={selCamp.includes(c.nccCampaignId)} muted={!kw}
                  onClick={() => toggle(selCamp, setSelCamp, c.nccCampaignId)}
                  title={kw ? "" : "키워드 입찰 없음(쇼핑=상품단위)"}>
                  {c.name} <span style={{ fontSize: 10, opacity: 0.7 }}>· {TYPE_LABEL[c.campaignTp] || c.campaignTp}</span>
                </Chip>;
              })}
            </div>
          </div>

          {/* 광고그룹 필터(다중) */}
          {selCamp.length > 0 && (
            <div style={{ border: "1px solid var(--sm-border)", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
              <div className="sm-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)" }}>광고그룹 {loadingGrp ? "…" : `(${adgroups.length})`}</span>
                <div className="sm-row" style={{ gap: 10 }}>
                  <button className="b2b-link-btn" style={{ fontSize: 11 }} onClick={() => setSelGrp(adgroups.map((g) => g.nccAdgroupId))}>전체 선택</button>
                  {selGrp.length > 0 && <button className="b2b-link-btn" style={{ fontSize: 11 }} onClick={() => setSelGrp([])}>해제</button>}
                </div>
              </div>
              {adgroups.length === 0 ? <span className="sm-faint" style={{ fontSize: 12 }}>{loadingGrp ? "불러오는 중..." : "그룹이 없습니다."}</span> : (
                <div className="sm-row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {adgroups.map((g) => <Chip key={g.nccAdgroupId} on={selGrp.includes(g.nccAdgroupId)} onClick={() => toggle(selGrp, setSelGrp, g.nccAdgroupId)}
                    title={campName[g.nccCampaignId] || ""}>{g.name}</Chip>)}
                </div>
              )}
            </div>
          )}

          {/* 기간·검색 */}
          <div className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 12 }}>
            <select className="b2b-select" value={preset} onChange={(e) => setPreset(e.target.value)} style={{ width: "auto" }}>
              {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label} 성과</option>)}
            </select>
            <input className="b2b-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="키워드 검색" style={{ width: 180 }} />
            <div style={{ flex: 1 }} />
            <button className="b2b-btn-secondary" onClick={loadKeywords} disabled={loadingKw || !selGrp.length}>{loadingKw ? "..." : "새로고침"}</button>
          </div>

          {!selGrp.length ? (
            <div className="b2b-empty"><div className="b2b-empty-icon">🔎</div>캠페인 → 광고그룹을 선택하면 키워드가 나옵니다. (여러 그룹을 선택하면 합쳐서 표시)</div>
          ) : loadingKw ? <div className="b2b-loading">불러오는 중...</div> :
            shownKeywords.length === 0 ? <div className="b2b-empty">키워드가 없습니다. (파워링크/파워컨텐츠 그룹인지 확인)</div> : (
              <div className="b2b-table-wrap">
                <table className="b2b-table">
                  <thead><tr>
                    <th>키워드</th><th>그룹</th>
                    <th className="num">노출</th><th className="num">클릭</th><th className="num">CTR</th>
                    <th className="num">CPC</th><th className="num">비용</th><th className="num">평균순위</th><th className="num">전환</th>
                    <th className="num">연관/클릭</th><th>입찰가</th>
                  </tr></thead>
                  <tbody>
                    {shownKeywords.map((k) => {
                      const d = draft[k.nccKeywordId];
                      const curBid = d?.bidAmt ?? k.bidAmt;
                      const useGroup = d?.useGroupBidAmt ?? k.useGroupBidAmt;
                      const changed = d && (d.bidAmt !== k.bidAmt || d.useGroupBidAmt !== k.useGroupBidAmt);
                      const st = k.stat;
                      return (
                        <tr key={k.nccKeywordId} style={changed ? { background: "var(--sm-orange-light)" } : undefined}>
                          <td><strong>{k.keyword}</strong>{k.userLock ? <span className="sm-faint" style={{ fontSize: 11 }}> · OFF</span> : null}</td>
                          <td style={{ fontSize: 11, color: "var(--sm-text-light)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{grpName[k.nccAdgroupId] || "-"}</td>
                          <td className="num b2b-money">{num(st?.impCnt)}</td>
                          <td className="num b2b-money">{num(st?.clkCnt)}</td>
                          <td className="num">{st?.ctr != null ? `${st.ctr.toFixed(2)}%` : "-"}</td>
                          <td className="num b2b-money">{won(st?.cpc)}</td>
                          <td className="num b2b-money">{won(st?.salesAmt)}</td>
                          <td className="num">{st?.avgRnk != null ? st.avgRnk.toFixed(1) : "-"}</td>
                          <td className="num b2b-money">{num(st?.ccnt)}</td>
                          <td className="num" style={{ fontSize: 11, color: "var(--sm-text-mid)" }}>{k.adRelevanceScore ?? "-"}/{k.expectedClickScore ?? "-"}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <div className="sm-row" style={{ gap: 4, alignItems: "center" }}>
                              <button className="b2b-btn-secondary" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => bump(k, -10)} disabled={useGroup} title="-10%">−</button>
                              <input type="number" className="b2b-input b2b-money" value={useGroup ? "" : curBid} disabled={useGroup}
                                onChange={(e) => setBid(k, Math.max(0, Number(e.target.value) || 0))} style={{ width: 80, textAlign: "right" }} placeholder={useGroup ? "그룹" : ""} />
                              <button className="b2b-btn-secondary" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => bump(k, 10)} disabled={useGroup} title="+10%">+</button>
                              <label className="sm-row" style={{ gap: 3, fontSize: 11, cursor: "pointer" }} title="그룹 기본입찰가 사용">
                                <input type="checkbox" checked={useGroup} onChange={(e) => toggleGroupBid(k, e.target.checked)} />그룹
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
