"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type Campaign = { nccCampaignId: string; name: string; campaignTp: string };
type Adgroup = { nccAdgroupId: string; nccCampaignId: string; name: string; bidAmt?: number };
type Stat = { impCnt?: number; clkCnt?: number; salesAmt?: number; cpc?: number; ctr?: number; avgRnk?: number; ccnt?: number; crto?: number; convAmt?: number; ror?: number; cpConv?: number };
type Keyword = {
  nccKeywordId: string; nccAdgroupId: string; keyword: string; bidAmt: number; useGroupBidAmt: boolean;
  adRelevanceScore?: number; expectedClickScore?: number; userLock?: boolean; stat?: Stat | null;
};
type Draft = { bidAmt: number; useGroupBidAmt: boolean };

const PRESETS = [
  { key: "today", label: "오늘" }, { key: "yesterday", label: "어제" },
  { key: "last7days", label: "최근 7일" }, { key: "last30days", label: "최근 30일" },
];
const TYPE_LABEL: Record<string, string> = {
  WEB_SITE: "파워링크", POWER_CONTENTS: "파워컨텐츠", SHOPPING: "쇼핑검색", BRAND_SEARCH: "브랜드검색", PLACE: "플레이스",
};
const KEYWORD_TYPES = new Set(["WEB_SITE", "POWER_CONTENTS", "PLACE"]); // 키워드 입찰 가능 유형
const won = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());
const num = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 정렬 키 → 값 추출 (없으면 -1 로 뒤로)
type SortField = "impCnt" | "clkCnt" | "ctr" | "salesAmt" | "cpc" | "ccnt" | "convAmt" | "ror" | "avgRnk" | "bidAmt";
const SORT_VAL: Record<SortField, (k: Keyword) => number> = {
  impCnt: (k) => k.stat?.impCnt ?? -1, clkCnt: (k) => k.stat?.clkCnt ?? -1, ctr: (k) => k.stat?.ctr ?? -1,
  salesAmt: (k) => k.stat?.salesAmt ?? -1, cpc: (k) => k.stat?.cpc ?? -1, ccnt: (k) => k.stat?.ccnt ?? -1,
  convAmt: (k) => k.stat?.convAmt ?? -1, ror: (k) => k.stat?.ror ?? -1, avgRnk: (k) => k.stat?.avgRnk ?? 9999, bidAmt: (k) => k.bidAmt,
};

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
  const [customMode, setCustomMode] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [loadingGrp, setLoadingGrp] = useState(false);
  const [loadingKw, setLoadingKw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [search, setSearch] = useState("");
  const [costOnly, setCostOnly] = useState(true);
  const [sortField, setSortField] = useState<SortField>("salesAmt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

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

  // 기간 쿼리 (직접설정+양끝 있으면 timeRange, 아니면 preset)
  const useCustom = customMode && !!since && !!until;
  const rangeKey = useCustom ? `c:${since}:${until}` : `p:${preset}`;

  // 선택 그룹 → 키워드
  const selGrpKey = selGrp.join(",");
  const loadKeywords = useCallback(async () => {
    if (!selGrp.length) { setKeywords([]); return; }
    setLoadingKw(true); setError(""); setSavedMsg(""); setDraft({});
    try {
      const p = new URLSearchParams({ adgroupIds: selGrpKey });
      if (useCustom) { p.set("since", since); p.set("until", until); } else { p.set("datePreset", preset); }
      const j = await (await fetch(`/api/naver-ad/keywords?${p}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "키워드 조회 실패");
      setKeywords(j.keywords || []);
    } catch (e) { setError(e instanceof Error ? e.message : "키워드 조회 오류"); }
    setLoadingKw(false);
  }, [selGrpKey, rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadKeywords(); }, [selGrpKey, rangeKey, loadKeywords]);

  const toggle = (arr: string[], set: (v: string[]) => void, id: string) =>
    set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  function sortBy(f: SortField) {
    if (sortField === f) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortField(f); setSortDir(f === "avgRnk" ? "asc" : "desc"); }
  }

  const shownKeywords = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = keywords;
    if (q) list = list.filter((k) => k.keyword.toLowerCase().includes(q));
    if (costOnly) list = list.filter((k) => (k.stat?.salesAmt ?? 0) > 0);
    const get = SORT_VAL[sortField];
    const dir = sortDir === "desc" ? -1 : 1;
    return [...list].sort((a, b) => (get(a) - get(b)) * dir);
  }, [keywords, search, costOnly, sortField, sortDir]);

  // 합계 (표시된 키워드 기준)
  const totals = useMemo(() => {
    const t = shownKeywords.reduce((a, k) => {
      const s = k.stat; if (!s) return a;
      a.imp += s.impCnt ?? 0; a.clk += s.clkCnt ?? 0; a.cost += s.salesAmt ?? 0; a.conv += s.ccnt ?? 0; a.convAmt += s.convAmt ?? 0;
      return a;
    }, { imp: 0, clk: 0, cost: 0, conv: 0, convAmt: 0 });
    return { ...t, ctr: t.imp ? (t.clk / t.imp) * 100 : 0, cpc: t.clk ? t.cost / t.clk : 0, roas: t.cost ? (t.convAmt / t.cost) * 100 : 0 };
  }, [shownKeywords]);

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

  function enterCustom() {
    setCustomMode(true);
    if (!since || !until) { const now = new Date(); const from = new Date(now.getTime() - 13 * 864e5); setUntil(ymd(now)); setSince(ymd(from)); }
  }

  // 정렬 가능한 숫자 헤더
  const Th = ({ f, children }: { f: SortField; children: React.ReactNode }) => (
    <th className="num" style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" }} onClick={() => sortBy(f)}
      title="클릭하여 정렬">
      {children}{sortField === f ? <span style={{ color: "var(--sm-orange)" }}>{sortDir === "desc" ? " ▾" : " ▴"}</span> : <span style={{ opacity: 0.25 }}> ⇅</span>}
    </th>
  );

  const roasColor = (s?: Stat | null): CSSProperties | undefined => {
    if (!s || (s.salesAmt ?? 0) === 0) return undefined;
    if ((s.ccnt ?? 0) === 0) return { color: "var(--sm-danger, #d64545)" }; // 지출했는데 전환 0
    if ((s.ror ?? 0) >= 300) return { color: "var(--sm-success)", fontWeight: 700 };
    return undefined;
  };

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">네이버 광고</h1>
          <p className="b2b-page-subtitle">파워링크 키워드의 기간별 광고비·ROAS·CPC·CTR을 보고 입찰가를 조정합니다. 기본은 <b>광고비가 나간 키워드</b>만, <b>비용 높은 순</b>으로 표시돼요.</p>
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

          {/* 기간 */}
          <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)", marginRight: 2 }}>기간</span>
            {PRESETS.map((p) => <Chip key={p.key} on={!customMode && preset === p.key} onClick={() => { setCustomMode(false); setPreset(p.key); }}>{p.label}</Chip>)}
            <Chip on={customMode} onClick={enterCustom}>직접 설정</Chip>
            {customMode && (
              <>
                <input type="date" className="b2b-input" value={since} max={until || undefined} onChange={(e) => setSince(e.target.value)} style={{ width: 150 }} />
                <span className="sm-faint">~</span>
                <input type="date" className="b2b-input" value={until} min={since || undefined} onChange={(e) => setUntil(e.target.value)} style={{ width: 150 }} />
              </>
            )}
          </div>

          {/* 필터·검색 */}
          <div className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <label className="sm-row" style={{ gap: 5, fontSize: 12, cursor: "pointer", fontWeight: 600, color: "var(--sm-text-mid)" }}>
              <input type="checkbox" checked={costOnly} onChange={(e) => setCostOnly(e.target.checked)} />광고비 지출 키워드만
            </label>
            <input className="b2b-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="키워드 검색" style={{ width: 180 }} />
            <div style={{ flex: 1 }} />
            <button className="b2b-btn-secondary" onClick={loadKeywords} disabled={loadingKw || !selGrp.length}>{loadingKw ? "..." : "새로고침"}</button>
          </div>

          {!selGrp.length ? (
            <div className="b2b-empty"><div className="b2b-empty-icon">🔎</div>캠페인 → 광고그룹을 선택하면 키워드가 나옵니다. (여러 그룹을 선택하면 합쳐서 표시)</div>
          ) : loadingKw ? <div className="b2b-loading">불러오는 중...</div> :
            shownKeywords.length === 0 ? (
              <div className="b2b-empty">
                {costOnly && keywords.length > 0
                  ? <>이 기간에 <b>광고비가 나간 키워드</b>가 없습니다. <button className="b2b-link-btn" onClick={() => setCostOnly(false)}>전체 보기</button> 또는 기간을 넓혀보세요.</>
                  : "키워드가 없습니다. (파워링크/파워컨텐츠 그룹인지 확인)"}
              </div>
            ) : (
              <>
                <div className="sm-row" style={{ justifyContent: "space-between", fontSize: 12, color: "var(--sm-text-light)", marginBottom: 6 }}>
                  <span>{shownKeywords.length}개 키워드{costOnly ? " (지출>0)" : ""} · 비용순 정렬 시 상위가 최적화 우선순위</span>
                </div>
                <div className="b2b-table-wrap">
                  <table className="b2b-table">
                    <thead><tr>
                      <th>키워드</th><th>그룹</th>
                      <Th f="impCnt">노출</Th><Th f="clkCnt">클릭</Th><Th f="ctr">CTR</Th>
                      <Th f="salesAmt">광고비</Th><Th f="cpc">CPC</Th>
                      <Th f="ccnt">전환</Th><Th f="convAmt">전환매출</Th><Th f="ror">ROAS</Th>
                      <Th f="avgRnk">평균순위</Th>
                      <th className="num">연관/클릭</th><Th f="bidAmt">입찰가</Th>
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
                            <td className="num b2b-money" style={{ fontWeight: 600 }}>{won(st?.salesAmt)}</td>
                            <td className="num b2b-money">{won(st?.cpc)}</td>
                            <td className="num b2b-money">{num(st?.ccnt)}</td>
                            <td className="num b2b-money">{won(st?.convAmt)}</td>
                            <td className="num" style={roasColor(st)}>{st?.ror != null && (st?.salesAmt ?? 0) > 0 ? `${Math.round(st.ror)}%` : "-"}</td>
                            <td className="num">{st?.avgRnk != null ? st.avgRnk.toFixed(1) : "-"}</td>
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
                    <tfoot>
                      <tr style={{ borderTop: "2px solid var(--sm-border)", fontWeight: 700, background: "var(--sm-bg-soft, #fafafa)" }}>
                        <td>합계</td><td style={{ fontSize: 11, color: "var(--sm-text-light)" }}>{shownKeywords.length}개</td>
                        <td className="num b2b-money">{num(totals.imp)}</td>
                        <td className="num b2b-money">{num(totals.clk)}</td>
                        <td className="num">{totals.ctr.toFixed(2)}%</td>
                        <td className="num b2b-money">{won(totals.cost)}</td>
                        <td className="num b2b-money">{won(totals.cpc)}</td>
                        <td className="num b2b-money">{num(totals.conv)}</td>
                        <td className="num b2b-money">{won(totals.convAmt)}</td>
                        <td className="num" style={totals.roas >= 300 ? { color: "var(--sm-success)" } : undefined}>{totals.cost ? `${Math.round(totals.roas)}%` : "-"}</td>
                        <td className="num">-</td><td className="num">-</td><td>-</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="sm-faint" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
                  · <b>광고비</b>=기간 내 총 지출(VAT포함), <b>ROAS</b>=전환매출÷광고비. <span style={{ color: "var(--sm-danger, #d64545)" }}>빨간 ROAS</span>=지출했지만 전환 0(입찰가↓ 검토), <span style={{ color: "var(--sm-success)" }}>초록</span>=ROAS 300%↑(여력 있으면 입찰가↑).<br />
                  · 전환·전환매출·ROAS는 <b>네이버 프리미엄 로그분석(전환추적)</b>이 연동돼야 값이 나옵니다. 0으로만 나오면 전환추적 미연동 상태예요.
                </p>
              </>
            )}
        </>
      )}
    </div>
  );
}
