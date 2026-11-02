"use client";

// 월간 VOC 리포트 — 완성 리포트 생성(Fable) + (월, 수신 제조사) 단위 자동 저장(086·159) + 손해 청구 섹션.
//  · 2026-11-02 업그레이드(기획안 docs/voc-monthly-report-plan.md): 숫자는 코드 집계(facts — 판매·배송 대비 VOC율·어종·채널·유형·귀책·문의),
//    글은 AI 가 facts 안에서만 쓴다. KPI 띠·차트(charts.tsx)는 facts 로 그리고, 저장된 facts 로 다시 열 때 재계산 없이 그대로 보인다.
//  · 생성/편집하면 자동 저장되고, 화면을 다시 열면 저장본을 바로 불러온다(재생성 불필요). 편집 칸은 유지(대표 결정 4).
//  · Word: 화면의 SVG 차트를 브라우저에서 PNG 로 바꿔 본문·표와 함께 보낸다(서버 이미지 라이브러리 없음). 인쇄/PDF 는 화면 그대로.
//  · 제조사명을 넣으면 개선요청서와 같은 기준(제조사 귀책·설문 제외)의 손해 청구 정리가 문서 끝에 붙는다(Word 에도 표로).

import { useEffect, useMemo, useRef, useState } from "react";
import { buildManufacturerReport } from "@/app/lib/voc-manufacturer";
import type { Voc } from "@/app/lib/voc";
import type { VocMonthlyFacts } from "@/app/lib/voc-monthly-facts";
import { won, qty, dateTime } from "@/app/lib/format";
import { ComboBarLine, StackedBar, BarList, Donut, PIE_COLORS } from "@/app/components/charts";

const THIS_MONTH = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7); // KST
const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

type Counts = { claims: number; surveys: number; inquiries?: number | null }; // inquiries = 스마트스토어 문의(137), null = 137 미적용
type SavedReport = { recipient: string; draft: string; counts: Counts | null; facts?: VocMonthlyFacts | null; generated_at?: string | null; updated_at: string };

// 섹션 뒤에 끼우는 차트·표 — 화면은 React 로 그리고, Word 는 같은 자리에 "[[chart:키]]"/"[[table:키]]" 줄을 넣어 보낸다(docx 라우트가 치환).
//  키 번호 = 섹션 번호("1." 뒤 → trend …). 리포트 헤딩이 바뀌어도(옛 저장본) 번호가 없으면 끼우지 않는다.
const SECTION_EXTRAS: Record<number, { charts: string[]; tables: string[] }> = {
  1: { charts: ["trend"], tables: [] },
  2: { charts: ["species", "channel", "category_trend"], tables: ["species", "channel", "category_trend"] },
};
const CHART_TITLE: Record<string, string> = {
  trend: "최근 6개월 VOC 건수와 판매 1,000개당 VOC율",
  species: "어종별 VOC율(판매 1,000개당)",
  channel: "채널별 VOC율(택배 1,000건당)",
  category_trend: "유형별 VOC 건수 6개월",
  fault: "손해 귀책",
};
const CATS = ["배송", "품질", "포장", "누락", "오배송", "가시", "이물", "기타"];
const ymLabel = (ym: string) => `${Number(ym.slice(5, 7))}월`;
const rate = (v: number | null | undefined) => (v == null ? "-" : v.toFixed(1));
const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);

// SVG 차트 → PNG(data URL). CSS 변수 색·글꼴은 계산된 값으로 인라인해야 캔버스에서 살아난다.
async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<{ png: string; width: number; height: number }> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...Array.from(svg.querySelectorAll("*"))], dst = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "font-family", "font-size", "font-weight", "opacity", "text-anchor"];
  src.forEach((s, i) => { const cs = getComputedStyle(s); const d = dst[i] as HTMLElement | SVGElement; for (const p of PROPS) { const v = cs.getPropertyValue(p); if (v) (d as HTMLElement).style.setProperty(p, v); } });
  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
  clone.setAttribute("width", String(width)); clone.setAttribute("height", String(height)); clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("차트 그림 변환 실패")); img.src = url; });
  const canvas = document.createElement("canvas"); canvas.width = width * scale; canvas.height = height * scale;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("캔버스를 쓸 수 없습니다");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, width, height);
  return { png: canvas.toDataURL("image/png"), width, height };
}

export default function VocManufacturerPage() {
  const [month, setMonth] = useState(THIS_MONTH());
  const [recipient, setRecipient] = useState("");
  const [draft, setDraft] = useState("");
  const [counts, setCounts] = useState<Counts | null>(null);
  const [facts, setFacts] = useState<VocMonthlyFacts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // 저장/불러오기 상태
  const [savedReports, setSavedReports] = useState<SavedReport[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [claims, setClaims] = useState<Voc[]>([]);
  const [needsMigration, setNeedsMigration] = useState(false);
  const [factsCol, setFactsCol] = useState(true);
  const [saveNote, setSaveNote] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedKey = useRef(""); // "month|recipient" — 자동 저장은 저장본을 불러왔거나 생성한 뒤에만
  const printRef = useRef<HTMLElement | null>(null);

  function applySaved(pick: SavedReport | undefined) {
    if (pick) {
      setDraft(pick.draft); setCounts(pick.counts || null); setFacts(pick.facts || null);
      loadedKey.current = `${month}|${pick.recipient}`;
      setSaveNote(`저장본 불러옴 (${dateTime(pick.updated_at)})`);
    } else { setDraft(""); setCounts(null); setFacts(null); loadedKey.current = ""; }
  }

  // 월이 바뀌면: 그 달의 저장 리포트·클레임을 불러오고, 저장본이 있으면 리포트를 바로 채운다.
  useEffect(() => {
    let alive = true;
    (async () => {
      setError(""); setSaveNote("");
      try {
        const res = await fetch(`/api/voc/manufacturer/reports?month=${month}`, { cache: "no-store" });
        const j = await res.json();
        if (!alive || !j?.ok) return;
        setSavedReports(j.reports || []);
        setRecipients(j.recipients || []);
        setClaims(j.claims || []);
        setNeedsMigration(!!j.needsMigration);
        setFactsCol(j.factsCol !== false);
        const list = (j.reports || []) as SavedReport[];
        // 현재 수신처와 일치하는 저장본 우선, 없으면 가장 최근 저장본
        const pick = list.find((r) => r.recipient === recipient) || list[0];
        applySaved(pick);
        if (pick?.recipient && !recipient) setRecipient(pick.recipient);
      } catch { /* 저장 기능 없이도 생성은 가능 */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  // 수신처를 바꿨을 때 그 수신처의 저장본이 있으면 전환해서 보여준다(편집 중이던 다른 수신처 본문은 이미 자동 저장됨).
  function onRecipientChange(v: string) {
    setRecipient(v);
    const pick = savedReports.find((r) => r.recipient === v);
    if (pick) applySaved(pick);
    else if (loadedKey.current) loadedKey.current = `${month}|${v}`; // 수신처만 바뀐 새 문서 취급 — 기존 본문 유지(같은 달 다른 제조사로 보낼 때 복제해 편집하는 흐름)
  }

  async function persist(text: string, rcpt: string, cts: Counts | null, fx?: VocMonthlyFacts | null) {
    try {
      const res = await fetch("/api/voc/manufacturer/reports", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, recipient: rcpt, draft: text, counts: cts, ...(fx ? { facts: fx } : {}) }),
      });
      const j = await res.json().catch(() => null);
      if (j?.needsMigration) { setNeedsMigration(true); setSaveNote(""); return; }
      if (!res.ok || !j?.ok) throw new Error(j?.error || "리포트를 자동 저장하지 못했습니다");
      if (fx && j.factsSaved === false) setFactsCol(false);
      setSaveNote(`자동 저장됨 ${new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16)}`);
      setSavedReports((prev) => {
        const rest = prev.filter((r) => r.recipient !== rcpt);
        const old = prev.find((r) => r.recipient === rcpt);
        return [{ recipient: rcpt, draft: text, counts: cts, facts: fx ?? old?.facts ?? null, updated_at: new Date().toISOString() }, ...rest];
      });
      if (rcpt && !recipients.includes(rcpt)) setRecipients((p) => [...p, rcpt].sort((a, b) => a.localeCompare(b, "ko")));
    } catch (e) { setSaveNote(`자동 저장하지 못했습니다 — ${e instanceof Error ? e.message : ""}. [다시 생성]을 누르면 다시 저장합니다`); }
  }

  // 편집 자동 저장(1.5초 디바운스) — 생성했거나 저장본을 불러온 문서만
  function onDraftChange(text: string) {
    setDraft(text);
    if (!loadedKey.current || needsMigration) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { if (text.trim()) persist(text, recipient, counts); }, 1500);
  }

  async function generate() {
    setLoading(true); setError(""); setCopied(false);
    try {
      const res = await fetch("/api/voc/manufacturer/digest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month }) });
      // 함수가 시간 초과 등으로 끊기면 Vercel 이 JSON 아닌 텍스트("An error occurred...")를 내려보낸다
      //  → 무조건 res.json() 하면 "Unexpected token 'A'..." 파싱 오류만 보였다. 텍스트로 받고 직접 판별.
      const raw = await res.text();
      let j: { ok?: boolean; draft?: string; facts?: VocMonthlyFacts; counts?: Counts; error?: string } | null = null;
      try { j = JSON.parse(raw); } catch { /* 플랫폼 오류 텍스트 */ }
      if (!j) throw new Error(`리포트를 생성하지 못했습니다 (HTTP ${res.status}). 데이터가 많은 달은 제한시간을 넘깁니다 — [리포트 생성]을 다시 누르세요`);
      if (!res.ok || !j.ok) throw new Error(j.error || "리포트를 생성하지 못했습니다. [리포트 생성]을 다시 누르세요");
      const text = j.draft || "";
      setDraft(text);
      setCounts(j.counts || null);
      setFacts(j.facts || null);
      loadedKey.current = `${month}|${recipient}`;
      if (!needsMigration && text.trim()) persist(text, recipient, j.counts || null, j.facts || null); // 생성 즉시 자동 저장(facts 포함)
    } catch (e) { setError(e instanceof Error ? e.message : "리포트를 생성하지 못했습니다. [리포트 생성]을 다시 누르세요"); }
    setLoading(false);
  }

  async function copy() {
    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setError("복사하지 못했습니다 — 텍스트를 직접 선택해 복사하세요"); }
  }

  // ── 손해 청구 섹션 (개선요청서와 동일 기준: 제조사 귀책 · 설문 제외 · 해당 월) ──
  //  제조사가 현재 한 곳뿐이라 제조사명 입력과 무관하게 항상 포함한다(이름은 수신 표기용).
  const mfg = useMemo(() => buildManufacturerReport(claims, month), [claims, month]);
  const showClaim = !!draft;

  // 리포트를 섹션으로 나눈다 — 헤딩("N. ") 줄 기준. 제목 줄은 뺀다. 손해 청구 번호 = 마지막 섹션 번호 + 1.
  const body = useMemo(() => draft.replace(/^\s*\d{4}년\s*\d{1,2}월\s*고객\s*반응\s*\n?/, ""), [draft]);
  const sections = useMemo(() => {
    const out: { no: number | null; lines: string[] }[] = [];
    let cur: { no: number | null; lines: string[] } = { no: null, lines: [] };
    for (const line of body.split("\n")) {
      const h = /^\s*(\d+)\.\s/.exec(line);
      if (h) { if (cur.lines.length) out.push(cur); cur = { no: Number(h[1]), lines: [line] }; }
      else cur.lines.push(line);
    }
    if (cur.lines.length) out.push(cur);
    return out;
  }, [body]);
  const claimNo = String(Math.max(0, ...sections.map((s) => s.no ?? 0)) + 1 || 5);

  // Word 용 텍스트 섹션 — 리포트와 같은 구조("숫자. / 가. / - 불릿")라 docx 변환기가 그대로 서식화한다. 표는 [[table:claims]] 로.
  const claimText = useMemo(() => {
    if (!showClaim) return "";
    const L: string[] = ["", `${claimNo}. 손해 청구 (제조사 귀책)`];
    if (!mfg.summary.count) { L.push("- 해당 없음"); return L.join("\n"); }
    L.push(`- 총 ${mfg.summary.count}건 · 청구 손해액 ${won(mfg.summary.claimable)}원 · 대상 제품 ${mfg.summary.productCount}종`);
    if (facts?.by_fault?.length) L.push("[[chart:fault]]");
    L.push("가. 제품별", "[[table:claims_product]]", "나. 접수 상세", "[[table:claims_detail]]");
    return L.join("\n");
  }, [showClaim, mfg, claimNo, facts]);

  // Word 표 — facts·손해 청구에서 만든다(숫자는 화면과 같은 값)
  const wordTables = useMemo(() => {
    const T: { key: string; title?: string; head: string[]; rows: string[][]; numCols?: number[] }[] = [];
    if (facts) {
      const sp = facts.by_species.filter((s) => s.voc || (s.sold_qty || 0) > 0);
      if (sp.length) T.push({ key: "species", title: CHART_TITLE.species, head: ["어종", "판매 수량", "VOC 건수", "VOC율(1,000개당)", "전월 율", "주요 유형", "제조사 귀책", "손해액(원)"],
        rows: sp.map((s) => [s.name, s.sold_qty == null ? "-" : qty(s.sold_qty), String(s.voc), rate(s.rate), rate(s.prev_rate), s.top_category || "-", String(s.mfg), won(s.loss)]), numCols: [1, 2, 3, 4, 6, 7] });
      const ch = facts.by_channel;
      const chRows = ch.map((c) => [c.channel, c.parcels == null ? "-" : qty(c.parcels), String(c.voc), rate(c.rate), rate(c.prev_rate), c.top_category || "-"]);
      if (facts.wholesale) chRows.push(["도매(B2B)", facts.wholesale.shipments == null ? "-" : qty(facts.wholesale.shipments), String(facts.wholesale.voc), facts.wholesale.rate_qty == null ? "-" : `${rate(facts.wholesale.rate_qty)} (수량 1,000개당)`, "-", "-"]);
      if (chRows.length) T.push({ key: "channel", title: CHART_TITLE.channel, head: ["채널", "배송 건수", "VOC 건수", "VOC율(1,000건당)", "전월 율", "주요 유형"], rows: chRows, numCols: [1, 2, 3, 4] });
      T.push({ key: "category_trend", title: CHART_TITLE.category_trend, head: ["월", ...CATS, "합계"],
        rows: facts.by_category_trend.map((m) => [ymLabel(m.ym), ...CATS.map((c) => String(m.counts[c] || 0)), String(Object.values(m.counts).reduce((a, b) => a + b, 0))]), numCols: CATS.map((_, i) => i + 1).concat(CATS.length + 1) });
    }
    if (mfg.summary.count) {
      T.push({ key: "claims_product", head: ["제품", "건수", "주요 유형", "청구 손해액(원)"], rows: [...mfg.byProduct.map((p) => [p.product, String(p.count), p.categories.map(([c, n]) => `${c} ${n}`).join(" · "), won(p.claimable)]), ["합계", String(mfg.summary.count), "", won(mfg.summary.claimable)]], numCols: [1, 3] });
      T.push({ key: "claims_detail", head: ["접수일", "제품", "유형", "내용", "손해(원)"], rows: mfg.items.map((r) => [(r.received_at || "").slice(5), r.product || "-", r.category, String(r.content || "").replace(/\s*\n+\s*/g, " "), won(r.loss_amount || 0)]), numCols: [4] });
    }
    return T;
  }, [facts, mfg]);

  // Word 본문 — 섹션 뒤에 자리표시 줄을 끼운 텍스트 + 손해 청구
  function composeWordText(): string {
    const title = draft.match(/^\s*\d{4}년\s*\d{1,2}월\s*고객\s*반응/)?.[0]?.trim() || `${y}년 ${Number(mm)}월 고객 반응`;
    const parts: string[] = [title, ""];
    for (const s of sections) {
      parts.push(...s.lines);
      const ex = s.no != null && facts ? SECTION_EXTRAS[s.no] : undefined;
      if (ex) {
        for (const k of ex.charts) if (k === "trend" || k === "category_trend") parts.push(`[[chart:${k}]]`); // 그림은 SVG 차트만(막대 목록은 표로)
        for (const k of ex.tables) parts.push(`[[table:${k}]]`);
      }
    }
    return parts.join("\n").trimEnd() + (claimText ? `\n${claimText}` : "");
  }

  async function downloadDocx() {
    setError("");
    try {
      const images: { key: string; png: string; width: number; height: number }[] = [];
      const nodes = printRef.current?.querySelectorAll<HTMLElement>("[data-chart]") || [];
      for (const n of Array.from(nodes)) {
        const svg = n.querySelector("svg"); const key = n.dataset.chart || "";
        if (!svg || !key) continue;
        try { images.push({ key, ...(await svgToPng(svg as SVGSVGElement)) }); } catch { /* 그 차트만 생략 */ }
      }
      const body = { month, recipient, draft: composeWordText(), images, tables: wordTables };
      const res = await fetch("/api/voc/manufacturer/docx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j as { error?: string }).error || "Word 파일을 만들지 못했습니다. 리포트를 다시 생성하세요"); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `씨몬스터_고객반응_${month}.docx`; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : "Word 파일을 만들지 못했습니다. 리포트를 다시 생성하세요"); }
  }

  const [y, mm] = month.split("-");
  const exportUrl = `/api/voc/manufacturer/export?month=${month}${recipient ? `&recipient=${encodeURIComponent(recipient)}` : ""}`;
  const cellTh: React.CSSProperties = { textAlign: "left", padding: "7px 8px", borderBottom: "2px solid var(--sm-black)", fontSize: 12, whiteSpace: "nowrap" };
  const cellTd: React.CSSProperties = { padding: "7px 8px", borderBottom: "1px solid var(--sm-border)", fontSize: 13, verticalAlign: "top" };
  const num: React.CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

  // ── 차트(facts) ──
  const charts = useMemo(() => {
    if (!facts) return null;
    const periods = facts.trend.map((t) => ymLabel(t.ym));
    const trend = <ComboBarLine periods={periods} barSeries={[{ key: "VOC", values: facts.trend.map((t) => t.voc) }]} barColors={[PIE_COLORS[0]]}
      lineValues={facts.trend.map((t) => t.rate_qty)} lineLabel="판매 1,000개당" lineFmt={(n) => n.toFixed(1)} lineUnit="건" barUnit="건" />;
    const catTrend = <StackedBar periods={periods} series={CATS.map((c) => ({ key: c, values: facts.by_category_trend.map((m) => m.counts[c] || 0) }))} colors={PIE_COLORS} unit="건" />;
    const species = <BarList title="" data={facts.by_species.filter((s) => s.rate != null).map((s) => [s.name, s.rate as number] as [string, number])} fmt={(n) => `${n.toFixed(1)}건`} accent={PIE_COLORS[1]}
      sub={(label) => { const s = facts.by_species.find((x) => x.name === label); return s ? `VOC ${s.voc}건 · 판매 ${qty(s.sold_qty || 0)}${s.top_category ? ` · ${s.top_category}` : ""}${s.prev_rate != null ? ` · 전월 ${rate(s.prev_rate)}` : ""}` : null; }}
      empty="율을 낼 판매 자료가 없습니다" />;
    const channel = <BarList title="" data={facts.by_channel.filter((c) => c.rate != null).map((c) => [c.channel, c.rate as number] as [string, number])} fmt={(n) => `${n.toFixed(1)}건`} accent={PIE_COLORS[2]}
      sub={(label) => { const c = facts.by_channel.find((x) => x.channel === label); return c ? `VOC ${c.voc}건 · 배송 ${qty(c.parcels || 0)}건${c.top_category ? ` · ${c.top_category}` : ""}` : null; }}
      empty="율을 낼 배송 자료가 없습니다" />;
    const fault = facts.by_fault.length ? <Donut data={facts.by_fault.map((f) => [f.fault, f.count] as [string, number])} colors={PIE_COLORS} center={String(facts.summary.voc_total)} centerSub="VOC" /> : null;
    return { trend, category_trend: catTrend, species, channel, fault } as Record<string, React.ReactNode>;
  }, [facts]);

  const ChartCard = ({ k }: { k: string }) => charts?.[k] ? (
    <div data-chart={k} style={{ marginTop: 12, padding: "10px 12px", border: "1px solid var(--sm-border)", borderRadius: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-text-mid)", marginBottom: 6 }}>{CHART_TITLE[k]}</div>
      {charts[k]}
    </div>
  ) : null;

  // KPI 띠 — 숫자는 facts 그대로, 증감은 전월 대비
  const kpi = facts ? [
    { label: "VOC율 (판매 1,000개당)", value: facts.summary.rate_qty == null ? "-" : `${rate(facts.summary.rate_qty)}건`, hint: facts.summary.prev.rate_qty != null && facts.summary.rate_qty != null ? `전월 ${rate(facts.summary.prev.rate_qty)}건` : facts.summary.sold_qty == null ? "매출 원장 없음" : `판매 ${qty(facts.summary.sold_qty)}개` },
    { label: "VOC 건수", value: `${facts.summary.voc_total}건`, hint: `전월 ${facts.summary.prev.voc_total}건${pct(facts.summary.voc_total, facts.summary.prev.voc_total) != null ? ` (${(pct(facts.summary.voc_total, facts.summary.prev.voc_total) as number) >= 0 ? "+" : ""}${pct(facts.summary.voc_total, facts.summary.prev.voc_total)}%)` : ""}${facts.summary.yoy ? ` · 작년 ${facts.summary.yoy.voc_total}건` : ""}` },
    { label: "제조사 귀책 손해액", value: `${won(facts.summary.loss_total)}원`, hint: `귀책 ${facts.summary.voc_mfg}건 · 전월 ${won(facts.summary.prev.loss_total)}원` },
    { label: "스마트스토어 문의", value: facts.inquiries.ok ? `${facts.inquiries.total}건` : "-", hint: facts.inquiries.ok ? `미답변 ${facts.inquiries.unanswered}${facts.inquiries.rate_parcel != null ? ` · 택배 1,000건당 ${rate(facts.inquiries.rate_parcel)}` : ""}${facts.inquiries.avg_answer_h != null ? ` · 답변 평균 ${facts.inquiries.avg_answer_h}시간` : ""}` : facts.inquiries.note || "" },
  ] : [];

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div>
          <h1 className="b2b-page-title">월간 VOC 리포트</h1>
        </div>
        <div className="b2b-page-actions">
          <a className="b2b-btn-secondary" href={exportUrl} title="제조사 귀책 건수·청구 손해액(정산용)">정산 엑셀 내려받기</a>
          <button className="b2b-btn-secondary" onClick={downloadDocx} disabled={!draft}>Word 내려받기</button>
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={!draft}>인쇄 / PDF 저장</button>
          {!draft && !loading && <span className="b2b-btn-why">리포트를 생성하면 켜집니다</span>}
        </div>
      </header>

      {error && <div className="b2b-error no-print">{error}</div>}
      {needsMigration && <div className="sm-warn no-print" style={{ marginBottom: 12 }}>자동 저장을 쓰려면 마이그레이션 086(voc_monthly_reports)을 적용하세요. 적용 전에도 생성·인쇄는 됩니다.</div>}
      {!needsMigration && !factsCol && <div className="sm-warn no-print" style={{ marginBottom: 12 }}>숫자 집계(KPI·차트)를 저장하려면 마이그레이션 159(facts·매출 집계 함수)를 적용하세요. 적용 전엔 생성 직후에만 보이고, 율은 없이 건수만 나옵니다.</div>}

      <section className="b2b-card no-print" style={{ marginBottom: 16 }}>
        <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>대상 월
            <input className="b2b-input" type="month" value={month} max={THIS_MONTH()} onChange={(e) => setMonth(e.target.value)} style={{ width: "auto" }} /></label>
          <label className="sm-row" style={{ gap: 6, fontSize: 13, color: "var(--sm-text-mid)" }}>수신(선택)
            <input className="b2b-input" list="voc-mfg-recipients" value={recipient} onChange={(e) => onRecipientChange(e.target.value)} placeholder="예: 바다식품" style={{ width: 200 }} /></label>
          <datalist id="voc-mfg-recipients">{recipients.map((r) => <option key={r} value={r} />)}</datalist>
          <button className="b2b-btn-primary" onClick={generate} disabled={loading}>{loading ? "작성 중..." : draft ? "다시 생성" : "리포트 생성"}</button>
          {counts && <span className="sm-faint" style={{ fontSize: 12 }}>클레임 {counts.claims}건(설문 소스 제외){counts.inquiries != null ? ` · 스마트스토어 문의 ${counts.inquiries}건` : ""} · 설문 {counts.surveys}건 반영{facts?.sales_as_of ? ` · 매출 반영 ~${facts.sales_as_of}` : ""}</span>}
          {saveNote && <span className="sm-faint" style={{ fontSize: 12, color: saveNote.startsWith("자동 저장하지") ? "var(--sm-danger)" : undefined }}>{saveNote}</span>}
        </div>
        {loading && <p className="sm-faint" style={{ fontSize: 12, marginTop: 8 }}>매출·배송 원장과 VOC·문의·설문을 집계한 뒤 리포트를 씁니다 — 1~3분 걸립니다.</p>}
      </section>

      {/* 편집 (화면 전용) — 고치는 대로 자동 저장. 숫자는 facts 가 기준이라 본문 숫자를 고쳐도 KPI·차트는 바뀌지 않는다 */}
      {draft && (
        <section className="b2b-card no-print" style={{ marginBottom: 16 }}>
          <div className="b2b-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="b2b-card-title">리포트 편집</span>
            <button className="b2b-btn-secondary" onClick={copy} style={{ padding: "4px 12px", fontSize: 13 }}>{copied ? "✓ 복사됨" : "텍스트 복사"}</button>
          </div>
          <textarea className="b2b-textarea" value={draft} onChange={(e) => onDraftChange(e.target.value)} rows={22}
            style={{ width: "100%", fontSize: 13, lineHeight: 1.7, fontFamily: "inherit" }} />
        </section>
      )}

      {/* 출력 미리보기 (인쇄 대상) */}
      {draft ? (
        <section ref={printRef} className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "32px 34px", maxWidth: 860, boxShadow: "var(--sm-shadow-card)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 18 }}>
            <div><div style={{ fontSize: 13, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div><h2 style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{y}년 {Number(mm)}월 고객 반응</h2></div>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>작성일 {TODAY()}{recipient && <div>수신 {recipient}</div>}</div>
          </div>

          {/* KPI 띠 — facts(코드 집계). 옛 저장본(facts 없음)은 띠 없이 본문만 */}
          {kpi.length > 0 && (
            <div className="b2b-dash-grid" style={{ marginBottom: 18 }}>
              {kpi.map((t) => (
                <div key={t.label} className="b2b-stat-card">
                  <div className="b2b-stat-card-label">{t.label}</div>
                  <div className="b2b-stat-card-value b2b-money">{t.value}</div>
                  {t.hint && <div className="b2b-stat-card-hint">{t.hint}</div>}
                </div>
              ))}
            </div>
          )}

          {/* 줄 단위 서식 — 제목(1./2.)·소제목(가./나.)·분류 라벨을 크게·볼드로(2026-08-28 대표 지시, 가독성). 섹션 뒤에 차트 */}
          <div style={{ fontSize: 13, lineHeight: 1.75 }}>
            {sections.map((s, si) => (
              <div key={si}>
                {s.lines.map((line, i) => {
                  const t = line.trim();
                  if (!t) return <div key={i} style={{ height: 8 }} />;
                  if (/^\d+\.\s/.test(t)) return <div key={i} style={{ fontSize: 16, fontWeight: 800, marginTop: si === 0 && i === 0 ? 0 : 18, marginBottom: 4, borderBottom: "1px solid var(--sm-border)", paddingBottom: 4 }}>{t}</div>;
                  if (/^[가-힣]\.\s/.test(t)) return <div key={i} style={{ fontSize: 14, fontWeight: 700, marginTop: 10, marginBottom: 2 }}>{t}</div>;
                  const m = t.match(/^-\s*([^:：]{1,24})\s*[:：]\s*(.*)$/);
                  if (m) return <div key={i} style={{ whiteSpace: "pre-wrap", paddingLeft: line.startsWith("  ") ? 18 : 0 }}>- <strong>{m[1].trim()}</strong> : {m[2]}</div>;
                  return <div key={i} style={{ whiteSpace: "pre-wrap", paddingLeft: line.startsWith("  ") ? 18 : 0 }}>{line.trimEnd()}</div>;
                })}
                {s.no != null && SECTION_EXTRAS[s.no]?.charts.map((k) => <ChartCard key={k} k={k} />)}
              </div>
            ))}
          </div>

          {/* 손해 청구 (제조사 귀책) — 개선요청서와 동일 기준 */}
          {showClaim && (
            <div style={{ marginTop: 26 }}>
              <h3 style={{ fontSize: 16, fontWeight: 800, borderTop: "2px solid var(--sm-black)", paddingTop: 14 }}>{claimNo}. 손해 청구 (제조사 귀책)</h3>
              {mfg.summary.count === 0 ? (
                <p style={{ fontSize: 13, marginTop: 8 }}>- 해당 없음</p>
              ) : (
                <>
                  <p style={{ fontSize: 13, marginTop: 8 }}>
                    {y}년 {Number(mm)}월 제조사 귀책 클레임은 총 <strong>{mfg.summary.count}건</strong>이며,
                    청구 손해액은 <strong style={{ color: "var(--sm-danger)" }}>{won(mfg.summary.claimable)}원</strong>입니다 (대상 제품 {mfg.summary.productCount}종).
                  </p>
                  <ChartCard k="fault" />
                  <div className="b2b-table-wrap">
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
                    <thead><tr><th style={cellTh}>제품</th><th style={{ ...cellTh, ...num }}>건수</th><th style={cellTh}>주요 유형</th><th style={{ ...cellTh, ...num }}>청구 손해액(원)</th></tr></thead>
                    <tbody>
                      {mfg.byProduct.map((p) => (
                        <tr key={p.product}>
                          <td style={cellTd}>{p.product}</td>
                          <td style={{ ...cellTd, ...num }}>{p.count}</td>
                          <td style={cellTd}>{p.categories.map(([c, n]) => `${c} ${n}`).join(" · ")}</td>
                          <td style={{ ...cellTd, ...num }}>{won(p.claimable)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ ...cellTd, fontWeight: 800 }}>합계</td>
                        <td style={{ ...cellTd, ...num, fontWeight: 800 }}>{mfg.summary.count}</td>
                        <td style={cellTd}></td>
                        <td style={{ ...cellTd, ...num, fontWeight: 800 }}>{won(mfg.summary.claimable)}</td>
                      </tr>
                    </tbody>
                  </table>
                  </div>
                  <div className="b2b-table-wrap">
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
                    <thead><tr><th style={cellTh}>접수일</th><th style={cellTh}>제품</th><th style={cellTh}>유형</th><th style={cellTh}>내용</th><th style={{ ...cellTh, ...num }}>손해(원)</th></tr></thead>
                    <tbody>
                      {mfg.items.map((r) => (
                        <tr key={r.id}>
                          <td style={{ ...cellTd, whiteSpace: "nowrap" }}>{(r.received_at || "").slice(5)}</td>
                          <td style={cellTd}>{r.product || "-"}</td>
                          <td style={{ ...cellTd, whiteSpace: "nowrap" }}>{r.category}</td>
                          <td style={cellTd}>{String(r.content || "")}</td>
                          <td style={{ ...cellTd, ...num }}>{won(r.loss_amount || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </>
              )}
            </div>
          )}
          {facts?.notes?.length ? <p className="sm-faint" style={{ fontSize: 12, marginTop: 18 }}>집계 참고: {facts.notes.join(" · ")}</p> : null}
        </section>
      ) : (
        !loading && <div className="b2b-empty no-print">생성된 리포트가 없습니다.</div>
      )}
    </div>
  );
}
