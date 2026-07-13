"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ComboBarLine } from "@/app/components/charts";

type Campaign = { nccCampaignId: string; name: string; campaignTp: string };
type DayStat = { date: string; impCnt: number; clkCnt: number; salesAmt: number; ctr?: number; cpc?: number; ccnt: number; convAmt: number; ror?: number };
type Adgroup = { nccAdgroupId: string; nccCampaignId: string; name: string; bidAmt?: number };
type Stat = { impCnt?: number; clkCnt?: number; salesAmt?: number; cpc?: number; ctr?: number; avgRnk?: number; ccnt?: number; crto?: number; convAmt?: number; ror?: number; cpConv?: number };
type ApiKeyword = { nccKeywordId: string; nccAdgroupId: string; keyword: string; bidAmt: number; useGroupBidAmt: boolean; adRelevanceScore?: number; expectedClickScore?: number; userLock?: boolean; stat?: Stat | null };
type ApiAdgroupStat = Adgroup & { userLock?: boolean; stat?: Stat | null };
// 키워드/광고그룹을 한 표로 다루는 통합 행
type Row = { id: string; name: string; group: string; bidAmt: number; useGroupBidAmt?: boolean; adRel?: number; expClick?: number; userLock?: boolean; stat?: Stat | null; kind: "keyword" | "adgroup" };
type Draft = { bidAmt: number; useGroupBidAmt?: boolean };
type SearchKw = { keyword: string; impCnt: number; clkCnt: number; salesAmt: number; drtCrto?: number };

const PRESETS = [
  { key: "today", label: "오늘" }, { key: "yesterday", label: "어제" },
  { key: "last7days", label: "최근 7일" }, { key: "last30days", label: "최근 30일" },
];
const TYPE_LABEL: Record<string, string> = {
  WEB_SITE: "파워링크", POWER_CONTENTS: "파워컨텐츠", SHOPPING: "쇼핑검색", BRAND_SEARCH: "브랜드검색", PLACE: "플레이스",
};
const TYPE_ORDER = ["WEB_SITE", "POWER_CONTENTS", "SHOPPING", "BRAND_SEARCH", "PLACE"];
const KEYWORD_TYPES = new Set(["WEB_SITE", "POWER_CONTENTS", "PLACE"]); // 키워드 입찰(나머지는 광고그룹 단위)
const won = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());
const num = (n?: number) => (n == null ? "-" : Math.round(n).toLocaleString());
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// 프리셋 → 실제 날짜(네이버: 최근 N일 = 어제까지 N일, 오늘 제외).
function presetRange(key: string): { since: string; until: string } {
  const now = new Date();
  const back = (n: number) => { const x = new Date(now); x.setDate(x.getDate() - n); return ymd(x); };
  if (key === "today") return { since: back(0), until: back(0) };
  if (key === "yesterday") return { since: back(1), until: back(1) };
  if (key === "last30days") return { since: back(30), until: back(1) };
  return { since: back(7), until: back(1) }; // last7days
}
const rangeLabel = (key: string) => { const r = presetRange(key); return r.since === r.until ? r.since : `${r.since} ~ ${r.until}`; };
// 리포트 주별 버킷: 그 날짜가 속한 주의 월요일(로컬)
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()));
  return ymd(d);
}

type SortField = "impCnt" | "clkCnt" | "ctr" | "salesAmt" | "cpc" | "ccnt" | "convAmt" | "ror" | "avgRnk" | "bidAmt";
const SORT_VAL: Record<SortField, (r: Row) => number> = {
  impCnt: (r) => r.stat?.impCnt ?? -1, clkCnt: (r) => r.stat?.clkCnt ?? -1, ctr: (r) => r.stat?.ctr ?? -1,
  salesAmt: (r) => r.stat?.salesAmt ?? -1, cpc: (r) => r.stat?.cpc ?? -1, ccnt: (r) => r.stat?.ccnt ?? -1,
  convAmt: (r) => r.stat?.convAmt ?? -1, ror: (r) => r.stat?.ror ?? -1, avgRnk: (r) => r.stat?.avgRnk ?? 9999, bidAmt: (r) => r.bidAmt,
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
  const [adType, setAdType] = useState("WEB_SITE");
  const [selCamp, setSelCamp] = useState<string[]>([]);
  const [adgroups, setAdgroups] = useState<Adgroup[]>([]); // 키워드 모드에서 그룹 선택용
  const [selGrp, setSelGrp] = useState<string[]>([]);
  const [preset, setPreset] = useState("last7days");
  const [customMode, setCustomMode] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [loadingGrp, setLoadingGrp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [search, setSearch] = useState("");
  const [costOnly, setCostOnly] = useState(true);
  const [sortField, setSortField] = useState<SortField>("salesAmt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [skGroup, setSkGroup] = useState<{ id: string; name: string } | null>(null); // 검색어 드릴다운 대상
  const [skRows, setSkRows] = useState<SearchKw[]>([]);
  const [skLoading, setSkLoading] = useState(false);
  const [skErr, setSkErr] = useState("");
  const [skCostOnly, setSkCostOnly] = useState(true);
  const [convBasis, setConvBasis] = useState<"all" | "purchase">("all"); // 전환 기준: 전체 or 구매
  const [purchaseMap, setPurchaseMap] = useState<Record<string, { conv: number; sales: number }>>({});
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseInfo, setPurchaseInfo] = useState<{ effectiveUntil?: string; cached?: boolean; days?: number } | null>(null);
  // 성과 리포트(선택 대상 일/주/월 시계열)
  const [rpt, setRpt] = useState<{ id: string; name: string; kind: "keyword" | "adgroup" } | null>(null);
  const [rptDays, setRptDays] = useState<DayStat[]>([]);
  const [rptGran, setRptGran] = useState<"day" | "week" | "month">("week");
  const [rptBack, setRptBack] = useState(90);
  const [rptConv, setRptConv] = useState<"all" | "purchase">("all");
  const [rptCapped, setRptCapped] = useState(false);
  const [rptLoading, setRptLoading] = useState(false);
  const [rptErr, setRptErr] = useState("");

  const mode: "keyword" | "adgroup" = KEYWORD_TYPES.has(adType) ? "keyword" : "adgroup";

  useEffect(() => {
    (async () => {
      try {
        const s = await (await fetch("/api/naver-ad/status", { cache: "no-store" })).json();
        setStatus({ configured: !!s.configured, connected: s.connected, error: s.error });
        if (s.configured && s.connected) {
          const c = await (await fetch("/api/naver-ad/campaigns", { cache: "no-store" })).json();
          if (c.ok) {
            const list = (c.campaigns || []) as Campaign[];
            list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
            setCampaigns(list);
            // 기본 광고유형: WEB_SITE 없으면 존재하는 첫 유형
            const present = TYPE_ORDER.filter((t) => list.some((c2) => c2.campaignTp === t));
            if (present.length && !present.includes("WEB_SITE")) setAdType(present[0]);
          }
        }
      } catch (e) { setError(e instanceof Error ? e.message : "상태 조회 오류"); }
    })();
  }, []);

  const presentTypes = useMemo(() => {
    const cnt: Record<string, number> = {};
    campaigns.forEach((c) => { cnt[c.campaignTp] = (cnt[c.campaignTp] || 0) + 1; });
    return TYPE_ORDER.filter((t) => cnt[t]).map((t) => ({ t, n: cnt[t] }));
  }, [campaigns]);
  const campsOfType = useMemo(() => campaigns.filter((c) => c.campaignTp === adType), [campaigns, adType]);
  const campName = useMemo(() => Object.fromEntries(campaigns.map((c) => [c.nccCampaignId, c.name])), [campaigns]);
  const grpName = useMemo(() => Object.fromEntries(adgroups.map((g) => [g.nccAdgroupId, g.name])), [adgroups]);

  function changeType(t: string) { setAdType(t); setSelCamp([]); setSelGrp([]); setAdgroups([]); setRows([]); setDraft({}); setError(""); }

  const selCampKey = selCamp.join(",");
  const selGrpKey = selGrp.join(",");
  const useCustom = customMode && !!since && !!until;
  const rangeKey = useCustom ? `c:${since}:${until}` : `p:${preset}`;
  const applyRange = (p: URLSearchParams) => { if (useCustom) { p.set("since", since); p.set("until", until); } else { p.set("datePreset", preset); } };

  // 키워드 모드: 선택 캠페인 → 광고그룹(선택용)
  useEffect(() => {
    if (mode !== "keyword" || !selCamp.length) { setAdgroups([]); setSelGrp([]); return; }
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
  }, [mode, selCampKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 데이터 로드 (키워드 모드=그룹별 키워드 / 광고그룹 모드=캠페인별 그룹+성과)
  const loadData = useCallback(async () => {
    setError(""); setSavedMsg(""); setDraft({});
    try {
      if (mode === "keyword") {
        if (!selGrp.length) { setRows([]); return; }
        setLoading(true);
        const p = new URLSearchParams({ adgroupIds: selGrpKey }); applyRange(p);
        const j = await (await fetch(`/api/naver-ad/keywords?${p}`, { cache: "no-store" })).json();
        if (!j.ok) throw new Error(j.error || "키워드 조회 실패");
        setRows((j.keywords || []).map((k: ApiKeyword): Row => ({
          id: k.nccKeywordId, name: k.keyword, group: grpName[k.nccAdgroupId] || "-", bidAmt: k.bidAmt, useGroupBidAmt: k.useGroupBidAmt,
          adRel: k.adRelevanceScore, expClick: k.expectedClickScore, userLock: k.userLock, stat: k.stat, kind: "keyword",
        })));
      } else {
        if (!selCamp.length) { setRows([]); return; }
        setLoading(true);
        const p = new URLSearchParams({ campaignIds: selCampKey }); applyRange(p);
        const j = await (await fetch(`/api/naver-ad/adgroup-stats?${p}`, { cache: "no-store" })).json();
        if (!j.ok) throw new Error(j.error || "광고그룹 성과 조회 실패");
        setRows((j.adgroups || []).map((g: ApiAdgroupStat): Row => ({
          id: g.nccAdgroupId, name: g.name, group: campName[g.nccCampaignId] || "-", bidAmt: g.bidAmt ?? 0,
          userLock: g.userLock, stat: g.stat, kind: "adgroup",
        })));
      }
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [mode, selGrpKey, selCampKey, rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadData(); }, [loadData]);

  const hasSelection = mode === "keyword" ? selGrp.length > 0 : selCamp.length > 0;

  // 구매 전환 기준: 기간 내 '구매' 전환/매출 별도 조회(어제까지). 명시적 기간(useCustom)에서만.
  useEffect(() => {
    if (convBasis !== "purchase" || !hasSelection || !useCustom) return;
    let cancelled = false;
    (async () => {
      setPurchaseLoading(true);
      try {
        const p = new URLSearchParams({ type: mode, since, until });
        const j = await (await fetch(`/api/naver-ad/purchase-conv?${p}`, { cache: "no-store" })).json();
        if (cancelled) return;
        if (!j.ok) throw new Error(j.error || "구매 전환 조회 실패");
        setPurchaseMap(j.map || {});
        setPurchaseInfo({ effectiveUntil: j.effectiveUntil, cached: j.cached, days: j.daysFetched });
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "구매 전환 오류"); }
      if (!cancelled) setPurchaseLoading(false);
    })();
    return () => { cancelled = true; };
  }, [convBasis, mode, selGrpKey, selCampKey, since, until, useCustom, hasSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  // 전환 지표(기준에 따라 전체/구매). roas: 전체=네이버 ror, 구매=구매매출/광고비.
  const metric = useCallback((r: Row) => {
    if (convBasis === "purchase") {
      const pm = purchaseMap[r.id]; const sales = pm?.sales ?? 0; const cost = r.stat?.salesAmt ?? 0;
      return { conv: pm?.conv ?? 0, convAmt: sales, roas: cost ? (sales / cost) * 100 : 0 };
    }
    const s = r.stat; return { conv: s?.ccnt ?? 0, convAmt: s?.convAmt ?? 0, roas: s?.ror ?? 0 };
  }, [convBasis, purchaseMap]);

  const toggle = (arr: string[], set: (v: string[]) => void, id: string) =>
    set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  function sortBy(f: SortField) {
    if (sortField === f) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortField(f); setSortDir(f === "avgRnk" ? "asc" : "desc"); }
  }

  const shownRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q));
    if (costOnly) list = list.filter((r) => (r.stat?.salesAmt ?? 0) > 0);
    const getVal = (r: Row) => {
      if (sortField === "ccnt") return metric(r).conv;
      if (sortField === "convAmt") return metric(r).convAmt;
      if (sortField === "ror") return metric(r).roas;
      return SORT_VAL[sortField](r);
    };
    const dir = sortDir === "desc" ? -1 : 1;
    return [...list].sort((a, b) => (getVal(a) - getVal(b)) * dir);
  }, [rows, search, costOnly, sortField, sortDir, metric]);

  const totals = useMemo(() => {
    const t = shownRows.reduce((a, r) => {
      const s = r.stat; if (!s) return a;
      const m = metric(r);
      a.imp += s.impCnt ?? 0; a.clk += s.clkCnt ?? 0; a.cost += s.salesAmt ?? 0; a.conv += m.conv; a.convAmt += m.convAmt;
      return a;
    }, { imp: 0, clk: 0, cost: 0, conv: 0, convAmt: 0 });
    return { ...t, ctr: t.imp ? (t.clk / t.imp) * 100 : 0, cpc: t.clk ? t.cost / t.clk : 0, roas: t.cost ? (t.convAmt / t.cost) * 100 : 0 };
  }, [shownRows, metric]);

  function setBid(r: Row, bidAmt: number) { setDraft((d) => ({ ...d, [r.id]: { bidAmt, useGroupBidAmt: false } })); setSavedMsg(""); }
  function bump(r: Row, pct: number) {
    const cur = draft[r.id]?.bidAmt ?? r.bidAmt;
    const floor = r.kind === "keyword" ? 70 : 50;
    setBid(r, Math.max(floor, Math.round((cur * (1 + pct / 100)) / 10) * 10));
  }
  function toggleGroupBid(r: Row, on: boolean) { setDraft((d) => ({ ...d, [r.id]: { bidAmt: d[r.id]?.bidAmt ?? r.bidAmt, useGroupBidAmt: on } })); setSavedMsg(""); }

  const changes = useMemo(() => rows.filter((r) => {
    const d = draft[r.id]; if (!d) return false;
    return d.bidAmt !== r.bidAmt || (r.kind === "keyword" && (d.useGroupBidAmt ?? false) !== (r.useGroupBidAmt ?? false));
  }), [rows, draft]);

  async function save() {
    if (!changes.length) return;
    setSaving(true); setError(""); setSavedMsg("");
    try {
      let r: Response, j: { ok?: boolean; error?: string; updated?: number; failed?: number };
      if (mode === "keyword") {
        const updates = changes.map((row) => { const d = draft[row.id]; return { nccKeywordId: row.id, bidAmt: d.bidAmt, useGroupBidAmt: d.useGroupBidAmt ?? false }; });
        r = await fetch("/api/naver-ad/keywords", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ updates }) });
      } else {
        const updates = changes.map((row) => ({ nccAdgroupId: row.id, bidAmt: draft[row.id].bidAmt }));
        r = await fetch("/api/naver-ad/adgroup-stats", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ updates }) });
      }
      j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "입찰가 변경 실패");
      setSavedMsg(`✅ 입찰가 ${j.updated}개 변경${j.failed ? ` (${j.failed}개 실패: ${j.error || ""})` : ""}`);
      loadData();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 오류"); }
    setSaving(false);
  }

  function enterCustom() {
    setCustomMode(true);
    if (!since || !until) { const now = new Date(); const from = new Date(now.getTime() - 13 * 864e5); setUntil(ymd(now)); setSince(ymd(from)); }
  }

  // 프리셋 클릭: 구매 기준일 땐 명시적 기간(어제까지)으로 변환해 /stats·구매 정렬을 맞춤
  const PRESET_SPAN: Record<string, number> = { today: 1, yesterday: 1, last7days: 7, last30days: 30 };
  function onPreset(key: string) {
    setPreset(key);
    if (convBasis === "purchase") {
      const now = new Date(); const y = ymd(new Date(now.getTime() - 864e5));
      setCustomMode(true); setSince(ymd(new Date(now.getTime() - (PRESET_SPAN[key] ?? 7) * 864e5))); setUntil(y);
    } else setCustomMode(false);
  }
  function setBasis(b: "all" | "purchase") {
    setConvBasis(b);
    if (b === "purchase") {
      // 명시적 기간(어제까지) 강제 — /stats 광고비와 구매 매출 기간을 일치
      const now = new Date(); const y = ymd(new Date(now.getTime() - 864e5));
      setCustomMode(true);
      if (customMode && since && until) { if (until > y) setUntil(y); }
      else { setSince(ymd(new Date(now.getTime() - (PRESET_SPAN[preset] ?? 7) * 864e5))); setUntil(y); }
    } else { setPurchaseMap({}); setPurchaseInfo(null); }
  }

  async function openSearchKeywords(r: Row) {
    setSkGroup({ id: r.id, name: r.name }); setSkRows([]); setSkErr(""); setSkLoading(true); setSkCostOnly(true);
    try {
      const j = await (await fetch(`/api/naver-ad/search-keywords?id=${encodeURIComponent(r.id)}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "검색어 조회 실패");
      setSkRows(j.keywords || []);
    } catch (e) { setSkErr(e instanceof Error ? e.message : "검색어 조회 오류"); }
    setSkLoading(false);
  }
  const skShown = useMemo(() => {
    let list = skCostOnly ? skRows.filter((k) => k.salesAmt > 0) : skRows;
    return [...list].sort((a, b) => b.salesAmt - a.salesAmt);
  }, [skRows, skCostOnly]);
  const skTot = useMemo(() => skShown.reduce((a, k) => ({ imp: a.imp + k.impCnt, clk: a.clk + k.clkCnt, cost: a.cost + k.salesAmt }), { imp: 0, clk: 0, cost: 0 }), [skShown]);

  // 리포트: 대상·기간(rptBack) 변경 시 일자별 성과 조회
  useEffect(() => {
    if (!rpt) return;
    let cancelled = false;
    (async () => {
      setRptLoading(true); setRptErr(""); setRptDays([]); setRptCapped(false);
      try {
        const now = new Date();
        const until = ymd(new Date(now.getTime() - 864e5)); // 어제
        const sinceD = ymd(new Date(now.getTime() - rptBack * 864e5));
        const p = new URLSearchParams({ id: rpt.id, since: sinceD, until, type: rpt.kind, conv: rptConv });
        const j = await (await fetch(`/api/naver-ad/report?${p}`, { cache: "no-store" })).json();
        if (cancelled) return;
        if (!j.ok) throw new Error(j.error || "리포트 조회 실패");
        setRptDays(j.days || []);
        setRptCapped(!!j.capped);
      } catch (e) { if (!cancelled) setRptErr(e instanceof Error ? e.message : "리포트 오류"); }
      if (!cancelled) setRptLoading(false);
    })();
    return () => { cancelled = true; };
  }, [rpt, rptBack, rptConv]);

  // 일자별 → 일/주/월 버킷 집계(합계 후 비율지표 재계산)
  const rptAgg = useMemo(() => {
    const key = (date: string) => rptGran === "day" ? date : rptGran === "month" ? date.slice(0, 7) : mondayOf(date);
    const label = (k: string) => {
      if (rptGran === "day") return k.slice(5);
      if (rptGran === "month") return k.slice(2);
      const [, m, d] = k.split("-"); return `${Number(m)}/${Number(d)}`;
    };
    const map = new Map<string, { imp: number; clk: number; cost: number; conv: number; convAmt: number }>();
    for (const dd of rptDays) {
      const k = key(dd.date);
      const b = map.get(k) || { imp: 0, clk: 0, cost: 0, conv: 0, convAmt: 0 };
      b.imp += dd.impCnt; b.clk += dd.clkCnt; b.cost += dd.salesAmt; b.conv += dd.ccnt; b.convAmt += dd.convAmt;
      map.set(k, b);
    }
    const keys = [...map.keys()].sort();
    const rows = keys.map((k) => {
      const b = map.get(k)!;
      return { key: k, label: label(k), ...b, ctr: b.imp ? (b.clk / b.imp) * 100 : 0, cpc: b.clk ? b.cost / b.clk : 0, roas: b.cost ? (b.convAmt / b.cost) * 100 : 0 };
    });
    const t = rows.reduce((a, r) => ({ imp: a.imp + r.imp, clk: a.clk + r.clk, cost: a.cost + r.cost, conv: a.conv + r.conv, convAmt: a.convAmt + r.convAmt }), { imp: 0, clk: 0, cost: 0, conv: 0, convAmt: 0 });
    return {
      rows, periods: rows.map((r) => r.label), costs: rows.map((r) => Math.round(r.cost)), roas: rows.map((r) => Math.round(r.roas)),
      tot: { ...t, ctr: t.imp ? (t.clk / t.imp) * 100 : 0, cpc: t.clk ? t.cost / t.clk : 0, roas: t.cost ? (t.convAmt / t.cost) * 100 : 0 },
    };
  }, [rptDays, rptGran]);

  const Th = ({ f, children }: { f: SortField; children: React.ReactNode }) => (
    <th className="num" style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" }} onClick={() => sortBy(f)} title="클릭하여 정렬">
      {children}{sortField === f ? <span style={{ color: "var(--sm-orange)" }}>{sortDir === "desc" ? " ▾" : " ▴"}</span> : <span style={{ opacity: 0.25 }}> ⇅</span>}
    </th>
  );
  const roasColor = (r: Row): CSSProperties | undefined => {
    const s = r.stat; if (!s || (s.salesAmt ?? 0) === 0) return undefined;
    const m = metric(r);
    if (m.conv === 0) return { color: "var(--sm-danger, #d64545)" };
    if (m.roas >= 300) return { color: "var(--sm-success)", fontWeight: 700 };
    return undefined;
  };
  const convLabel = convBasis === "purchase" ? "구매전환" : "전환";
  const convAmtLabel = convBasis === "purchase" ? "구매매출" : "전환매출";
  const roasLabel = convBasis === "purchase" ? "구매ROAS" : "ROAS";

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">네이버 광고</h1>
          <p className="b2b-page-subtitle">광고유형을 먼저 고르고, 기간별 광고비·ROAS·CPC·CTR로 입찰가를 조정합니다. 기본은 <b>광고비가 나간 것</b>만 <b>비용 높은 순</b>.</p>
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
          {/* ① 광고유형 필터 (상단) */}
          <div style={{ border: "1px solid var(--sm-border)", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)", marginBottom: 8 }}>광고유형</div>
            <div className="sm-row" style={{ gap: 6, flexWrap: "wrap" }}>
              {presentTypes.map(({ t, n }) => (
                <Chip key={t} on={adType === t} onClick={() => changeType(t)}>
                  {TYPE_LABEL[t] || t} <span style={{ fontSize: 10, opacity: 0.6 }}>{n}</span>
                </Chip>
              ))}
            </div>
            <div className="sm-faint" style={{ fontSize: 11, marginTop: 7 }}>
              {mode === "keyword"
                ? "파워링크·파워컨텐츠는 키워드 단위로 입찰합니다. 캠페인 → 광고그룹을 골라 키워드를 봅니다."
                : "쇼핑검색·브랜드검색은 키워드가 없고 상품(광고그룹) 단위로 입찰합니다. 캠페인을 고르면 그룹별 성과·입찰가가 나옵니다."}
            </div>
          </div>

          {/* ② 캠페인 필터(다중) */}
          <div style={{ border: "1px solid var(--sm-border)", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
            <div className="sm-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)" }}>{TYPE_LABEL[adType] || adType} 캠페인 <span className="sm-faint" style={{ fontWeight: 400 }}>(여러 개 선택 가능)</span></span>
              {selCamp.length > 0 && <button className="b2b-link-btn" style={{ fontSize: 11 }} onClick={() => setSelCamp([])}>선택 해제</button>}
            </div>
            {campsOfType.length === 0 ? <span className="sm-faint" style={{ fontSize: 12 }}>이 유형의 캠페인이 없습니다.</span> : (
              <div className="sm-row" style={{ gap: 6, flexWrap: "wrap" }}>
                {campsOfType.map((c) => <Chip key={c.nccCampaignId} on={selCamp.includes(c.nccCampaignId)} onClick={() => toggle(selCamp, setSelCamp, c.nccCampaignId)}>{c.name}</Chip>)}
              </div>
            )}
          </div>

          {/* ③ 광고그룹 필터(키워드 모드에서만, 다중) */}
          {mode === "keyword" && selCamp.length > 0 && (
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
                  {adgroups.map((g) => <Chip key={g.nccAdgroupId} on={selGrp.includes(g.nccAdgroupId)} onClick={() => toggle(selGrp, setSelGrp, g.nccAdgroupId)} title={campName[g.nccCampaignId] || ""}>{g.name}</Chip>)}
                </div>
              )}
            </div>
          )}

          {/* 기간 */}
          <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)", marginRight: 2 }}>기간</span>
            {PRESETS.map((p) => <Chip key={p.key} on={preset === p.key && (convBasis === "purchase" ? customMode : !customMode)} onClick={() => onPreset(p.key)}>{p.label}</Chip>)}
            <Chip on={customMode && !PRESETS.some((p) => p.key === preset && convBasis === "purchase")} onClick={enterCustom}>직접 설정</Chip>
            {!customMode && <span className="sm-faint" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{rangeLabel(preset)}</span>}
            {customMode && (
              <>
                <input type="date" className="b2b-input" value={since} max={until || undefined} onChange={(e) => setSince(e.target.value)} style={{ width: 150 }} />
                <span className="sm-faint">~</span>
                <input type="date" className="b2b-input" value={until} min={since || undefined} onChange={(e) => setUntil(e.target.value)} style={{ width: 150 }} />
              </>
            )}
          </div>

          {/* 전환 기준 (전체 vs 구매) */}
          <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)", marginRight: 2 }}>전환 기준</span>
            <Chip on={convBasis === "all"} onClick={() => setBasis("all")}>전체 전환</Chip>
            <Chip on={convBasis === "purchase"} onClick={() => setBasis("purchase")}>구매 전환만</Chip>
            {convBasis === "purchase" && (
              <span className="sm-faint" style={{ fontSize: 11 }}>
                {purchaseLoading ? "구매 전환 불러오는 중… (최초엔 다소 걸릴 수 있어요)"
                  : purchaseInfo ? `장바구니 제외·구매만 · ~${purchaseInfo.effectiveUntil}까지${purchaseInfo.cached === false ? " · 캐시 미적용(느림, 064 마이그레이션 권장)" : ""}` : "장바구니 제외, 구매 전환만 집계"}
              </span>
            )}
          </div>

          {/* 필터·검색 */}
          <div className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <label className="sm-row" style={{ gap: 5, fontSize: 12, cursor: "pointer", fontWeight: 600, color: "var(--sm-text-mid)" }}>
              <input type="checkbox" checked={costOnly} onChange={(e) => setCostOnly(e.target.checked)} />광고비 지출만
            </label>
            <input className="b2b-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={mode === "keyword" ? "키워드 검색" : "광고그룹 검색"} style={{ width: 180 }} />
            <div style={{ flex: 1 }} />
            <button className="b2b-btn-secondary" onClick={loadData} disabled={loading || !hasSelection}>{loading ? "..." : "새로고침"}</button>
          </div>

          {!hasSelection ? (
            <div className="b2b-empty"><div className="b2b-empty-icon">🔎</div>
              {mode === "keyword" ? "캠페인 → 광고그룹을 선택하면 키워드가 나옵니다." : "캠페인을 선택하면 광고그룹별 성과·입찰가가 나옵니다."}
            </div>
          ) : loading ? <div className="b2b-loading">불러오는 중...</div> :
            shownRows.length === 0 ? (
              <div className="b2b-empty">
                {costOnly && rows.length > 0
                  ? <>이 기간에 <b>광고비가 나간 {mode === "keyword" ? "키워드" : "광고그룹"}</b>이 없습니다. <button className="b2b-link-btn" onClick={() => setCostOnly(false)}>전체 보기</button> 또는 기간을 넓혀보세요.</>
                  : mode === "keyword" ? "키워드가 없습니다." : "광고그룹이 없습니다."}
              </div>
            ) : (
              <>
                <div className="sm-row" style={{ justifyContent: "space-between", fontSize: 12, color: "var(--sm-text-light)", marginBottom: 6 }}>
                  <span>{shownRows.length}개 {mode === "keyword" ? "키워드" : "광고그룹"}{costOnly ? " (지출>0)" : ""} · 비용순 상위가 최적화 우선순위</span>
                </div>
                <div className="b2b-table-wrap">
                  <table className="b2b-table">
                    <thead><tr>
                      <th>{mode === "keyword" ? "키워드" : "광고그룹"}</th><th>{mode === "keyword" ? "그룹" : "캠페인"}</th>
                      <Th f="impCnt">노출</Th><Th f="clkCnt">클릭</Th><Th f="ctr">CTR</Th>
                      <Th f="salesAmt">광고비</Th><Th f="cpc">CPC</Th>
                      <Th f="ccnt">{convLabel}</Th><Th f="convAmt">{convAmtLabel}</Th><Th f="ror">{roasLabel}</Th>
                      <Th f="avgRnk">평균순위</Th>
                      {mode === "keyword" && <th className="num">연관/클릭</th>}
                      <Th f="bidAmt">입찰가</Th>
                    </tr></thead>
                    <tbody>
                      {shownRows.map((r) => {
                        const d = draft[r.id];
                        const curBid = d?.bidAmt ?? r.bidAmt;
                        const useGroup = r.kind === "keyword" ? (d?.useGroupBidAmt ?? r.useGroupBidAmt ?? false) : false;
                        const changed = d && (d.bidAmt !== r.bidAmt || (r.kind === "keyword" && (d.useGroupBidAmt ?? false) !== (r.useGroupBidAmt ?? false)));
                        const st = r.stat;
                        return (
                          <tr key={r.id} style={changed ? { background: "var(--sm-orange-light)" } : undefined}>
                            <td>
                              <strong>{r.name}</strong>{r.userLock ? <span className="sm-faint" style={{ fontSize: 11 }}> · OFF</span> : null}
                              <button className="b2b-link-btn" style={{ marginLeft: 6, fontSize: 11 }} onClick={() => { setRpt({ id: r.id, name: r.name, kind: r.kind }); setRptGran("week"); setRptBack(90); setRptConv("all"); }} title="이 대상의 주/월/일별 성과 리포트">📊 리포트</button>
                              {r.kind === "adgroup" && <button className="b2b-link-btn" style={{ marginLeft: 6, fontSize: 11 }} onClick={() => openSearchKeywords(r)} title="이 그룹으로 유입된 검색어별 비용">🔍 검색어</button>}
                            </td>
                            <td style={{ fontSize: 11, color: "var(--sm-text-light)", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.group}</td>
                            <td className="num b2b-money">{num(st?.impCnt)}</td>
                            <td className="num b2b-money">{num(st?.clkCnt)}</td>
                            <td className="num">{st?.ctr != null ? `${st.ctr.toFixed(2)}%` : "-"}</td>
                            <td className="num b2b-money" style={{ fontWeight: 600 }}>{won(st?.salesAmt)}</td>
                            <td className="num b2b-money">{won(st?.cpc)}</td>
                            {(() => { const m = metric(r); const loadingP = convBasis === "purchase" && purchaseLoading; return (<>
                              <td className="num b2b-money">{loadingP ? "…" : num(m.conv)}</td>
                              <td className="num b2b-money">{loadingP ? "…" : won(m.convAmt)}</td>
                              <td className="num" style={roasColor(r)}>{loadingP ? "…" : ((st?.salesAmt ?? 0) > 0 ? `${Math.round(m.roas)}%` : "-")}</td>
                            </>); })()}
                            <td className="num">{st?.avgRnk != null ? st.avgRnk.toFixed(1) : "-"}</td>
                            {mode === "keyword" && <td className="num" style={{ fontSize: 11, color: "var(--sm-text-mid)" }}>{r.adRel ?? "-"}/{r.expClick ?? "-"}</td>}
                            <td style={{ whiteSpace: "nowrap" }}>
                              <div className="sm-row" style={{ gap: 4, alignItems: "center" }}>
                                <button className="b2b-btn-secondary" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => bump(r, -10)} disabled={useGroup} title="-10%">−</button>
                                <input type="number" className="b2b-input b2b-money" value={useGroup ? "" : curBid} disabled={useGroup}
                                  onChange={(e) => setBid(r, Math.max(0, Number(e.target.value) || 0))} style={{ width: 80, textAlign: "right" }} placeholder={useGroup ? "그룹" : ""} />
                                <button className="b2b-btn-secondary" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => bump(r, 10)} disabled={useGroup} title="+10%">+</button>
                                {r.kind === "keyword" && (
                                  <label className="sm-row" style={{ gap: 3, fontSize: 11, cursor: "pointer" }} title="그룹 기본입찰가 사용">
                                    <input type="checkbox" checked={useGroup} onChange={(e) => toggleGroupBid(r, e.target.checked)} />그룹
                                  </label>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: "2px solid var(--sm-border)", fontWeight: 700, background: "var(--sm-bg-soft, #fafafa)" }}>
                        <td>합계</td><td style={{ fontSize: 11, color: "var(--sm-text-light)" }}>{shownRows.length}개</td>
                        <td className="num b2b-money">{num(totals.imp)}</td>
                        <td className="num b2b-money">{num(totals.clk)}</td>
                        <td className="num">{totals.ctr.toFixed(2)}%</td>
                        <td className="num b2b-money">{won(totals.cost)}</td>
                        <td className="num b2b-money">{won(totals.cpc)}</td>
                        <td className="num b2b-money">{num(totals.conv)}</td>
                        <td className="num b2b-money">{won(totals.convAmt)}</td>
                        <td className="num" style={totals.roas >= 300 ? { color: "var(--sm-success)" } : undefined}>{totals.cost ? `${Math.round(totals.roas)}%` : "-"}</td>
                        <td className="num">-</td>
                        {mode === "keyword" && <td className="num">-</td>}
                        <td>-</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="sm-faint" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
                  · <b>광고비</b>=기간 내 총 지출(VAT포함), <b>{roasLabel}</b>={convAmtLabel}÷광고비. <span style={{ color: "var(--sm-danger, #d64545)" }}>빨강</span>=지출했지만 {convLabel} 0(입찰가↓ 검토), <span style={{ color: "var(--sm-success)" }}>초록</span>={roasLabel} 300%↑(여력 있으면 입찰가↑).<br />
                  {convBasis === "purchase"
                    ? <>· <b>구매 전환만</b> 집계(장바구니 등 제외) — AD_CONVERSION_DETAIL 리포트 기반, <b>오늘 제외 어제까지</b>. 광고비 기간도 자동으로 어제까지 맞춰집니다.{mode === "adgroup" ? " 쇼핑검색은 광고그룹 단위." : ""}</>
                    : <>· 전환·전환매출·ROAS는 <b>모든 전환유형 합</b>(구매+장바구니 등). ‘구매 전환만’으로 바꾸면 구매 기준으로 다시 계산됩니다.{mode === "adgroup" ? " 쇼핑검색은 광고그룹 단위 입찰가를 조정합니다." : ""}</>}
                </p>
              </>
            )}
        </>
      )}

      {/* 쇼핑검색 세부 검색어 드릴다운 모달 */}
      {skGroup && (
        <div onClick={() => setSkGroup(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 12px", overflow: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--sm-white)", borderRadius: 12, width: "min(760px, 100%)", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 10px 40px rgba(0,0,0,0.2)" }}>
            <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid var(--sm-border)" }}>
              <div>
                <div style={{ fontWeight: 700, color: "var(--sm-dark)" }}>🔍 검색어별 비용 — {skGroup.name}</div>
                <div className="sm-faint" style={{ fontSize: 11 }}>최근 30일 · 이 광고그룹으로 유입된 실제 검색어(네이버 제공)</div>
              </div>
              <button className="b2b-btn-secondary" style={{ padding: "4px 10px" }} onClick={() => setSkGroup(null)}>닫기</button>
            </div>
            <div style={{ padding: "10px 16px", overflow: "auto" }}>
              {skErr && <div className="b2b-error">{skErr}</div>}
              {skLoading ? <div className="b2b-loading">불러오는 중...</div> : (
                <>
                  <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                    <label className="sm-row" style={{ gap: 5, fontSize: 12, cursor: "pointer", fontWeight: 600, color: "var(--sm-text-mid)" }}>
                      <input type="checkbox" checked={skCostOnly} onChange={(e) => setSkCostOnly(e.target.checked)} />광고비 지출만
                    </label>
                    <span className="sm-faint" style={{ fontSize: 12 }}>{skShown.length}개 검색어 · 광고비 {won(skTot.cost)}원</span>
                  </div>
                  {skShown.length === 0 ? <div className="b2b-empty">표시할 검색어가 없습니다.</div> : (
                    <div className="b2b-table-wrap">
                      <table className="b2b-table">
                        <thead><tr>
                          <th>검색어</th><th className="num">노출</th><th className="num">클릭</th><th className="num">CTR</th><th className="num">광고비</th><th className="num">CPC</th><th className="num">직접전환율</th>
                        </tr></thead>
                        <tbody>
                          {skShown.slice(0, 300).map((k, i) => {
                            const ctr = k.impCnt ? (k.clkCnt / k.impCnt) * 100 : 0;
                            const cpc = k.clkCnt ? k.salesAmt / k.clkCnt : 0;
                            return (
                              <tr key={i}>
                                <td><strong>{k.keyword || "(기타)"}</strong></td>
                                <td className="num b2b-money">{num(k.impCnt)}</td>
                                <td className="num b2b-money">{num(k.clkCnt)}</td>
                                <td className="num">{ctr ? `${ctr.toFixed(2)}%` : "-"}</td>
                                <td className="num b2b-money" style={{ fontWeight: 600 }}>{won(k.salesAmt)}</td>
                                <td className="num b2b-money">{k.clkCnt ? won(cpc) : "-"}</td>
                                <td className="num">{k.drtCrto != null ? `${k.drtCrto.toFixed(1)}%` : "-"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot><tr style={{ borderTop: "2px solid var(--sm-border)", fontWeight: 700, background: "var(--sm-bg-soft, #fafafa)" }}>
                          <td>합계 ({skShown.length})</td><td className="num b2b-money">{num(skTot.imp)}</td><td className="num b2b-money">{num(skTot.clk)}</td>
                          <td className="num">{skTot.imp ? `${(skTot.clk / skTot.imp * 100).toFixed(2)}%` : "-"}</td>
                          <td className="num b2b-money">{won(skTot.cost)}</td><td className="num b2b-money">{skTot.clk ? won(skTot.cost / skTot.clk) : "-"}</td><td className="num">-</td>
                        </tr></tfoot>
                      </table>
                    </div>
                  )}
                  {skShown.length > 300 && <p className="sm-faint" style={{ fontSize: 11, marginTop: 6 }}>상위 300개만 표시했습니다(광고비순).</p>}
                  <p className="sm-faint" style={{ fontSize: 11, marginTop: 6 }}>· 이 리포트는 전환수·ROAS가 없고 <b>직접전환율</b>만 제공됩니다(네이버 NPLA_SCH_KEYWORD). 전환/ROAS는 그룹 단위 표에서 확인하세요.</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 성과 리포트 모달 (선택 대상 일/주/월별) */}
      {rpt && (
        <div onClick={() => setRpt(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 12px", overflow: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--sm-white)", borderRadius: 12, width: "min(880px, 100%)", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 10px 40px rgba(0,0,0,0.2)" }}>
            <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid var(--sm-border)" }}>
              <div>
                <div style={{ fontWeight: 700, color: "var(--sm-dark)" }}>📊 성과 리포트 — {rpt.name}</div>
                <div className="sm-faint" style={{ fontSize: 11 }}>일/주/월별 추이 · 전체 전환 기준(네이버) · 어제까지 반영</div>
              </div>
              <button className="b2b-btn-secondary" style={{ padding: "4px 10px" }} onClick={() => setRpt(null)}>닫기</button>
            </div>
            <div style={{ padding: "12px 16px", overflow: "auto" }}>
              <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)", marginRight: 2 }}>단위</span>
                {(([["day", "일별"], ["week", "주별"], ["month", "월별"]]) as [("day" | "week" | "month"), string][]).map(([g, l]) => <Chip key={g} on={rptGran === g} onClick={() => setRptGran(g)}>{l}</Chip>)}
                <span style={{ width: 10 }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)", marginRight: 2 }}>조회</span>
                {[[30, "30일"], [90, "90일"], [180, "6개월"], [365, "1년"]].map(([b, l]) => <Chip key={b} on={rptBack === b} onClick={() => setRptBack(b as number)}>{l}</Chip>)}
              </div>
              <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-dark)", marginRight: 2 }}>전환기준</span>
                <Chip on={rptConv === "all"} onClick={() => setRptConv("all")}>전체 전환</Chip>
                <Chip on={rptConv === "purchase"} onClick={() => setRptConv("purchase")}>구매전환만</Chip>
                <span className="sm-faint" style={{ fontSize: 11, marginLeft: 4 }}>{rptConv === "purchase" ? "실제 구매만 집계 (최근 62일)" : "네이버 제공 전체 전환"}</span>
              </div>
              {rptErr && <div className="b2b-error">{rptErr}</div>}
              {rptConv === "purchase" && rptCapped && !rptLoading && <div className="b2b-empty" style={{ padding: "8px 10px", marginBottom: 10, fontSize: 12 }}>구매전환 기준은 리포트 부하로 <b>최근 62일</b>까지만 표시됩니다. 더 긴 기간은 전체 전환 기준을 이용하세요.</div>}
              {rptLoading ? <div className="b2b-loading">불러오는 중...</div> : rptAgg.rows.length === 0 ? (
                <div className="b2b-empty">이 기간에 성과 데이터가 없습니다. 조회 기간을 넓혀보세요.</div>
              ) : (
                <>
                  <ComboBarLine periods={rptAgg.periods} barSeries={[{ key: "광고비", values: rptAgg.costs }]} barColors={["var(--sm-info)"]} lineValues={rptAgg.roas} lineLabel="ROAS" lineFmt={(n) => `${n}%`} lineColor="var(--sm-orange)" barUnit="원" />
                  <div className="sm-row" style={{ gap: 14, marginTop: 6, marginBottom: 12, fontSize: 12 }}>
                    <span className="sm-row" style={{ gap: 5, alignItems: "center" }}><span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--sm-info)" }} />광고비 (막대)</span>
                    <span className="sm-row" style={{ gap: 5, alignItems: "center" }}><span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--sm-orange)" }} />ROAS (선){rptConv === "purchase" ? " · 구매기준" : ""}</span>
                  </div>
                  <div className="b2b-table-wrap">
                    <table className="b2b-table" style={{ fontSize: 12.5 }}>
                      <thead><tr>
                        <th>{rptGran === "day" ? "날짜" : rptGran === "week" ? "주(월요일)" : "월"}</th>
                        <th className="num">노출</th><th className="num">클릭</th><th className="num">CTR</th><th className="num">광고비</th><th className="num">CPC</th><th className="num">전환</th><th className="num">전환매출</th><th className="num">ROAS</th>
                      </tr></thead>
                      <tbody>
                        {[...rptAgg.rows].reverse().map((r) => (
                          <tr key={r.key}>
                            <td><strong>{r.label}</strong></td>
                            <td className="num b2b-money">{num(r.imp)}</td>
                            <td className="num b2b-money">{num(r.clk)}</td>
                            <td className="num">{r.imp ? `${r.ctr.toFixed(2)}%` : "-"}</td>
                            <td className="num b2b-money" style={{ fontWeight: 600 }}>{won(r.cost)}</td>
                            <td className="num b2b-money">{r.clk ? won(r.cpc) : "-"}</td>
                            <td className="num b2b-money">{num(r.conv)}</td>
                            <td className="num b2b-money">{won(r.convAmt)}</td>
                            <td className="num" style={r.cost && r.roas >= 300 ? { color: "var(--sm-success)", fontWeight: 700 } : r.cost && r.conv === 0 ? { color: "var(--sm-danger, #d64545)" } : undefined}>{r.cost ? `${Math.round(r.roas)}%` : "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr style={{ borderTop: "2px solid var(--sm-border)", fontWeight: 700, background: "var(--sm-bg-soft,#fafafa)" }}>
                        <td>합계 {rptAgg.rows.length}</td>
                        <td className="num b2b-money">{num(rptAgg.tot.imp)}</td><td className="num b2b-money">{num(rptAgg.tot.clk)}</td>
                        <td className="num">{rptAgg.tot.imp ? `${rptAgg.tot.ctr.toFixed(2)}%` : "-"}</td>
                        <td className="num b2b-money">{won(rptAgg.tot.cost)}</td><td className="num b2b-money">{rptAgg.tot.clk ? won(rptAgg.tot.cpc) : "-"}</td>
                        <td className="num b2b-money">{num(rptAgg.tot.conv)}</td><td className="num b2b-money">{won(rptAgg.tot.convAmt)}</td>
                        <td className="num">{rptAgg.tot.cost ? `${Math.round(rptAgg.tot.roas)}%` : "-"}</td>
                      </tr></tfoot>
                    </table>
                  </div>
                  <p className="sm-faint" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>· 막대=광고비, 선=ROAS. 전환은 {rptConv === "purchase" ? <><b>구매 전환 기준</b>(실제 구매만, 최근 62일)</> : <><b>전체 전환 기준</b>(구매+장바구니 등, 네이버 제공)</>}입니다. 그래프에 마우스를 올리면 기간별 수치가 나와요.</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
