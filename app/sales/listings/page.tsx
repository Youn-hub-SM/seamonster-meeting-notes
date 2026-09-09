"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@/app/b2b/orders/Combobox";

type Prod = { id: string; sku: string | null; name: string; spec: string | null; active?: boolean; is_bundle?: boolean; attrs?: string | null };
type Listing = {
  channel: string;
  product_name: string;
  option_name: string;
  sku_code: string;
  qty_7: number;
  qty_30: number;
  qty_window: number;
  last_sale: string | null;
  via_bundle: boolean;
  companions?: { name: string; share: number }[]; // 어미상품 추정(같은 주문 동반율 높은 상품)
};
type CatalogItem = {
  channel: string;
  item_key: string;
  origin_no: string;
  listing_name: string;
  item_kind: string;
  item_name: string | null;
  sku_code: string;
  sale_status: string | null;
  stock_qty: number | null;
  synced_at?: string;
  via_bundle: boolean;
};
type ChannelCommand = {
  id: number; channel: string; item_key: string; qty: number;
  status: string; error: string | null; created_at: string; executed_at: string | null;
};
type Result = {
  ok: boolean;
  error?: string;
  target?: { id: string; sku: string | null; name: string; spec: string | null };
  bundles?: { sku: string | null; name: string }[];
  listings?: Listing[];
  catalog?: CatalogItem[];
  catalog_synced_at?: string | null;
};

// 네이버 판매상태 원문 → 한글 (모르는 값은 원문 그대로)
const SALE_STATUS_KO: Record<string, string> = {
  SALE: "판매중", OUTOFSTOCK: "품절", SUSPENSION: "판매중지", WAIT: "판매대기",
  UNADMISSION: "승인대기", REJECTION: "승인거부", CLOSE: "판매종료", PROHIBITION: "판매금지", UNUSABLE: "사용안함",
};
const KIND_KO: Record<string, string> = { product: "단일", option: "옵션", supplement: "추가상품" };
// 카탈로그 카드 제목 — 채널 값(매출 판매처 표기)을 사용자에게 익숙한 이름으로
const CATALOG_TITLE: Record<string, string> = { "스마트스토어": "네이버", "쿠팡": "쿠팡", "카페24": "공식몰(카페24)" };
// 기본 숨김인 '비판매' 상태 — 품절(OUTOFSTOCK)은 조치 대상이라 항상 표시
const HIDDEN_SALE_STATUSES = new Set(["SUSPENSION", "CLOSE", "PROHIBITION", "REJECTION", "UNUSABLE", "판매안함", "진열안함"]);

const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
// UTC 저장값 → KST 'MM-DD HH:mm' 표시
const kstStamp = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
// 최근 90일 판매가 없으면 '오래된 리스팅'으로 접는다
const staleCut = () => new Date(Date.now() + 9 * 3600_000 - 90 * 86400_000).toISOString().slice(0, 10);

export default function SkuListingsPage() {
  const [products, setProducts] = useState<Prod[]>([]);
  const [plabel, setPlabel] = useState("");
  const [pid, setPid] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [openStale, setOpenStale] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(""); // 행 고유 키 — 같은 상품명이 여러 채널에 있어도 누른 행만 표시
  const seqRef = useRef(0); // 빠른 재선택 시 늦게 도착한 이전 요청이 화면을 덮지 않게

  useEffect(() => {
    fetch("/api/products", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) setProducts(j.products || []); }).catch(() => {});
  }, []);

  // 채널별 마지막 카탈로그 동기화 시각 — 검색 전에도 화면 상단에 표시
  const [lastSynced, setLastSynced] = useState<Record<string, string | null>>({});
  const fetchLastSynced = () => {
    fetch("/api/sales/listings?meta=1", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.ok) setLastSynced(j.synced || {}); }).catch(() => {});
  };
  useEffect(() => { fetchLastSynced(); }, []);

  // 검색 대상은 단품 SKU 만 — 묶음상품은 목록에서 빼고, 결과에 '그 구성품이 든 묶음 리스팅'으로만 나온다(대표 결정).
  const options = useMemo(() => products
    .filter((p) => !p.is_bundle && p.active !== false && (p.sku || "").trim())
    .map((p) => ({ id: p.id, label: p.spec ? `${p.name} | ${p.spec}` : p.name, sub: p.sku || "", extra: p.attrs || "" })), [products]);

  async function load(id: string) {
    const seq = ++seqRef.current;
    setBusy(true); setErr(""); setRes(null); setOpenStale({});
    try {
      const r = await fetch(`/api/sales/listings?product_id=${id}`, { cache: "no-store" });
      const j: Result = await r.json();
      if (seq !== seqRef.current) return; // 그 사이 다른 상품을 골랐다 — 이 응답은 버린다
      if (!j.ok) setErr(j.error || "조회 실패");
      else setRes(j);
    } catch (e) { if (seq === seqRef.current) setErr((e as Error).message); }
    finally { if (seq === seqRef.current) setBusy(false); }
  }

  async function copyName(name: string, rowKey: string) {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(rowKey);
      setTimeout(() => setCopied(""), 1500);
    } catch { /* 클립보드 미지원 브라우저 — 조용히 무시 */ }
  }

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [exporting, setExporting] = useState(false);

  // 검색 결과 엑셀 다운로드 — 화면과 1:1(대표 확정): 카탈로그 시트는 화면 표의 정렬·숨김 상태 그대로
  //  (판매안함은 펼쳐서 보이는 중일 때만 포함), 매출 리스팅 시트는 카탈로그에 없는 채널만.
  async function exportXlsx() {
    if (!res?.target) return;
    setExporting(true);
    try {
      const catRows = [...catalogRows.visible, ...(showHidden ? catalogRows.hidden : [])].map(({ c, idx }) => ({
        ...c,
        q7: catalogQty.get(idx)?.q7 ?? null,
        q30: catalogQty.get(idx)?.q30 ?? null,
      }));
      const saleRows = groups.flatMap((g) => [...g.fresh, ...g.stale]);
      if (catRows.length === 0 && saleRows.length === 0) {
        // 카탈로그가 전부 '판매안함' 숨김이면 보낼 게 없다 — 서버 400 대신 상황에 맞는 안내
        throw new Error("화면에 보이는 목록이 없습니다. [판매안함 보기]를 펼친 뒤 다시 받아 주세요.");
      }
      const r = await fetch("/api/sales/listings/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: res.target, catalog: catRows, listings: saleRows }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error || "다운로드 실패");
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = r.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^";]+)"?/);
      a.download = m ? m[1] : "sku_listings.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setErr((e as Error).message); }
    finally { setExporting(false); }
  }
  // 카탈로그 동기화 — 채널 API 가 IP 제한이라 서버가 직접 못 부르고, 명령 큐에 넣으면
  //  중계 서버가 10초 안에 가져가 채널별 동기화를 실행한다(채널당 1~2분 소요).
  async function syncCatalogs() {
    setSyncing(true); setSyncMsg("");
    try {
      const failed: string[] = [];
      for (const ch of ["스마트스토어", "쿠팡", "카페24"]) {
        const r = await fetch("/api/channel-commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: ch, command: "sync_catalog" }),
        });
        const j = await r.json();
        if (!j.ok) failed.push(`${CATALOG_TITLE[ch] || ch}: ${j.error || "실패"}`);
      }
      if (failed.length > 0) {
        setSyncMsg(`동기화 요청 실패 — ${failed.join(" / ")}`);
      } else {
        setSyncMsg("동기화 요청 완료 — 몇 분 뒤 검색하면 최신 카탈로그와 동기화 날짜가 반영됩니다.");
        fetchCommands();
      }
    } catch (e) { setSyncMsg(`동기화 요청 실패: ${(e as Error).message}`); }
    finally { setSyncing(false); }
  }

  // [새로고침] — 검색어는 그대로 두고 동기화 시각·명령 상태·검색 결과를 다시 불러온다
  function refreshAll() {
    fetchLastSynced();
    fetchCommands();
    if (pid) load(pid);
  }

  // 카탈로그가 있는 채널 집합 — 그 채널은 매출 카드에서 뺀다(카탈로그 카드가 전체·정확이라 중복 — 대표 결정)
  const catalogChannels = useMemo(() => new Set((res?.catalog ?? []).map((c) => c.channel)), [res]);

  // 채널별 그룹 + 채널 내 30일 판매량 내림차순, 채널은 30일 합 내림차순.
  const groups = useMemo(() => {
    const rows = res?.listings ?? [];
    const cut = staleCut();
    const byCh = new Map<string, { fresh: Listing[]; stale: Listing[]; qty30: number }>();
    for (const l of rows) {
      const ch = l.channel || "(판매처 미상)";
      if (catalogChannels.has(ch)) continue;
      const g = byCh.get(ch) ?? { fresh: [], stale: [], qty30: 0 };
      const isStale = l.qty_30 === 0 && (!l.last_sale || l.last_sale < cut);
      (isStale ? g.stale : g.fresh).push(l);
      g.qty30 += l.qty_30;
      byCh.set(ch, g);
    }
    const cmp = (a: Listing, b: Listing) => b.qty_30 - a.qty_30 || b.qty_window - a.qty_window;
    return [...byCh.entries()]
      .map(([ch, g]) => ({ channel: ch, fresh: g.fresh.sort(cmp), stale: g.stale.sort(cmp), qty30: g.qty30 }))
      .sort((a, b) => b.qty30 - a.qty30);
  }, [res, catalogChannels]);

  const total = res?.listings?.length ?? 0;

  // 카탈로그 단일 표 — 채널 고정 순서(네이버-쿠팡-공식몰) → 등록 상품명 정렬. 원본 idx 는 catalogQty 매칭용.
  //  비판매 상태(판매안함·진열안함·판매중지 등)는 기본 숨김 — 품절은 조치 대상이라 항상 표시.
  const catalogRows = useMemo(() => {
    const ORDER = ["스마트스토어", "쿠팡", "카페24"];
    const orderOf = (ch: string) => { const i = ORDER.indexOf(ch); return i < 0 ? 99 : i; };
    const all = (res?.catalog ?? [])
      .map((c, idx) => ({ c, idx }))
      .sort((a, b) =>
        orderOf(a.c.channel) - orderOf(b.c.channel) ||
        a.c.listing_name.localeCompare(b.c.listing_name) ||
        a.idx - b.idx
      );
    const isHidden = ({ c }: { c: CatalogItem }) => !!c.sale_status && HIDDEN_SALE_STATUSES.has(c.sale_status);
    return { visible: all.filter((r) => !isHidden(r)), hidden: all.filter(isHidden) };
  }, [res]);

  // 채널별 마지막 동기화 시각(검색 결과 기준) — 캡션 표시 + '동기화 이전에 끝난 명령 상태' 숨김 판정에 사용
  const syncedByChannel = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of res?.catalog ?? []) {
      const prev = m.get(c.channel);
      if (c.synced_at && (!prev || c.synced_at > prev)) m.set(c.channel, c.synced_at);
    }
    return m;
  }, [res]);
  const syncedSummary = useMemo(() =>
    [...syncedByChannel.entries()].map(([ch, d]) => `${CATALOG_TITLE[ch] || ch} ${kstStamp(d)}`).join(" · "),
  [syncedByChannel]);

  // ── 채널 재고 명령(수량 적용, 0 = 품절) — 중계 서버 데몬이 10초 폴링으로 실행 ──
  const [cmdQty, setCmdQty] = useState<Record<string, string>>({});
  const [cmdMap, setCmdMap] = useState<Record<string, ChannelCommand>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [applying, setApplying] = useState("");
  const cmdKey = (ch: string, ik: string) => `${ch}|${ik}`;

  async function fetchCommands() {
    try {
      const r = await fetch("/api/channel-commands?recent=1", { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) return;
      const m: Record<string, ChannelCommand> = {};
      for (const c of (j.commands ?? []) as ChannelCommand[]) {
        const k = cmdKey(c.channel, c.item_key);
        if (!m[k]) m[k] = c; // 최신순 응답이라 첫 항목이 최신
      }
      setCmdMap(m);
    } catch { /* 조회 실패는 조용히 — 표시만 빠진다 */ }
  }
  useEffect(() => { fetchCommands(); }, []);
  const hasPendingCmd = useMemo(() => Object.values(cmdMap).some((c) => c.status === "대기" || c.status === "실행중"), [cmdMap]);
  useEffect(() => {
    if (!hasPendingCmd) return;
    const t = setInterval(fetchCommands, 15_000);
    return () => clearInterval(t);
  }, [hasPendingCmd]);

  async function applyQty(c: CatalogItem) {
    const raw = (cmdQty[c.item_key] ?? "").trim();
    const qty = Number(raw);
    if (raw === "" || !Number.isInteger(qty) || qty < 0) {
      setErr("수량은 0 이상의 정수로 입력하세요 (0 = 품절).");
      return;
    }
    const label = `${CATALOG_TITLE[c.channel] || c.channel} · ${c.listing_name}${c.item_name ? ` / ${c.item_name}` : ""}`;
    if (!window.confirm(`${label}\n채널 재고를 ${qty}개로 변경합니다${qty === 0 ? " (품절 처리)" : ""}. 진행할까요?`)) return;
    setApplying(c.item_key); setErr("");
    try {
      const r = await fetch("/api/channel-commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: c.channel, item_key: c.item_key, origin_no: c.origin_no,
          listing_name: c.listing_name, item_name: c.item_name, sku_code: c.sku_code, qty,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "명령 등록 실패");
      await fetchCommands();
    } catch (e) { setErr((e as Error).message); }
    finally { setApplying(""); }
  }

  // 카탈로그 행에 같은 채널 매출 판매량(7일/30일) 병합 — (채널|상품명|옵션명) 문자열 매칭.
  //  추가상품은 매출에 자기 이름으로 찍히므로 이름 후보 여러 개로 시도, 못 찾으면 null(화면 '-').
  const catalogQty = useMemo(() => {
    const bySale = new Map<string, { q7: number; q30: number }>();
    for (const l of res?.listings ?? []) {
      if (!catalogChannels.has(l.channel)) continue;
      const key = `${l.channel}|${l.product_name}|${l.option_name}`;
      const cur = bySale.get(key) ?? { q7: 0, q30: 0 };
      cur.q7 += l.qty_7; cur.q30 += l.qty_30;
      bySale.set(key, cur);
    }
    const out = new Map<number, { q7: number; q30: number }>();
    (res?.catalog ?? []).forEach((c, i) => {
      const nm = c.item_name ?? "";
      const suppName = nm.includes(" - ") ? nm.slice(nm.indexOf(" - ") + 3) : nm; // 'group - name' 의 name
      const candidates = [
        `${c.channel}|${c.listing_name}|${nm}`,   // 옵션: 상품명|옵션명
        `${c.channel}|${c.listing_name}|`,        // 단일 상품
        `${c.channel}|${nm}|`,                     // 추가상품이 자기 이름으로 찍힌 경우
        `${c.channel}|${suppName}|`,
      ];
      for (const k of candidates) {
        const hit = bySale.get(k);
        if (hit) { out.set(i, hit); break; }
      }
    });
    return out;
  }, [res, catalogChannels]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">SKU로 재고 조정</h1>
          <p className="b2b-page-subtitle">매출 기준(최근 1년) + 네이버·쿠팡·공식몰은 API 등록 카탈로그로 전체 확인</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={refreshAll} disabled={busy}
            title="검색어는 그대로 두고 카탈로그·판매량·명령 상태를 다시 불러옵니다">
            새로고침
          </button>
          <button className="b2b-btn-secondary" onClick={syncCatalogs} disabled={syncing}>
            {syncing ? "요청 중..." : "카탈로그 동기화"}
          </button>
          <button className="b2b-btn-primary" onClick={exportXlsx}
            disabled={exporting || !res || ((res.catalog?.length ?? 0) === 0 && (res.listings?.length ?? 0) === 0)}
            title={!res ? "먼저 상품을 검색하세요" : "화면 목록 그대로 내려받습니다 (접어 둔 90일 무판매 리스팅은 포함)"}>
            {exporting ? "생성 중..." : "엑셀 다운로드"}
          </button>
        </div>
      </header>

      {Object.values(lastSynced).some(Boolean) && (
        <p className="sm-faint" style={{ margin: "-6px 0 12px", fontSize: 12, textAlign: "right" }}>
          마지막 동기화: {["스마트스토어", "쿠팡", "카페24"]
            .map((ch) => `${CATALOG_TITLE[ch]} ${lastSynced[ch] ? kstStamp(lastSynced[ch]!) : "-"}`)
            .join(" · ")}
        </p>
      )}

      {err && <div className="b2b-error">{err}</div>}
      {syncMsg && <div className={syncMsg.includes("실패") ? "b2b-error" : "sm-success"}>{syncMsg}</div>}

      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-field">
          <label className="b2b-field-label">상품</label>
          <Combobox value={plabel} options={options}
            onSelect={(o) => { setPid(o.id); setPlabel(o.label); load(o.id); }}
            placeholder="상품 검색 — 이름 또는 SKU" ariaLabel="상품" />
        </div>
        {res?.target && (res.bundles?.length ?? 0) > 0 && (
          <p className="sm-faint" style={{ margin: "8px 0 0", fontSize: 13 }}>
            이 상품이 들어간 묶음 {res.bundles!.map((b) => b.sku).join(", ")} 의 리스팅도 함께 나옵니다
          </p>
        )}
      </section>

      {busy ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : !res ? null : (
        <>
        {(catalogRows.visible.length > 0 || catalogRows.hidden.length > 0) && (
          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head">
              <span className="b2b-card-title">채널 등록 카탈로그</span>
              <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>
                {catalogRows.visible.length}건{syncedSummary ? ` · 동기화 ${syncedSummary}` : ""}
              </span>
            </div>
            <p className="sm-faint" style={{ margin: "0 0 8px", fontSize: 12 }}>
              수량 적용(0 = 품절)은 보통 10초 안에 채널에 반영됩니다 (카탈로그 동기화와 겹치면 수 분 걸릴 수 있음)
            </p>
            <div className="b2b-table-wrap">
              <table className="b2b-table is-responsive" style={{ tableLayout: "fixed", width: "100%" }}>
                <colgroup>
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "19%" }} />
                  <col style={{ width: "6%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "9%" }} />
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "6%" }} />
                  <col style={{ width: "5.5%" }} />
                  <col style={{ width: "5.5%" }} />
                  <col style={{ width: "19%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>채널</th>
                    <th>등록 상품명(어미상품)</th>
                    <th>구분</th>
                    <th>옵션·추가상품명</th>
                    <th>관리코드</th>
                    <th>판매상태</th>
                    <th className="num">재고</th>
                    <th className="num">7일</th>
                    <th className="num">30일</th>
                    <th>수량 적용</th>
                  </tr>
                </thead>
                <tbody>
                  {[...catalogRows.visible, ...(showHidden ? catalogRows.hidden : [])].map(({ c, idx }) => {
                    const rowKey = `cat|${c.channel}|${c.item_key}|${idx}`;
                    const q = catalogQty.get(idx);
                    const cmd = cmdMap[cmdKey(c.channel, c.item_key)];
                    // 완료·실패 표시는 그 이후 카탈로그 동기화가 돌기 전까지만 — 표 재고에 반영된 뒤엔 소음(대표 요청)
                    const chSynced = syncedByChannel.get(c.channel);
                    const cmdStale = !!cmd && (cmd.status === "완료" || cmd.status === "실패") &&
                      !!cmd.executed_at && !!chSynced && cmd.executed_at < chSynced;
                    // 네이버 추가상품은 재고만 바꾸는 API 가 없다(전체 수정뿐 — 위험) — 입력 대신 안내
                    const noApply = c.channel === "스마트스토어" && c.item_kind === "supplement";
                    return (
                      <tr key={rowKey}>
                        <td data-label="채널">{CATALOG_TITLE[c.channel] || c.channel}</td>
                        <td data-label="등록 상품명" style={{ overflowWrap: "break-word" }}><strong>{c.listing_name}</strong></td>
                        <td data-label="구분">{KIND_KO[c.item_kind] || c.item_kind}</td>
                        <td data-label="옵션·추가상품명" style={{ overflowWrap: "break-word" }}>{c.item_name || "-"}</td>
                        <td data-label="관리코드" style={{ overflowWrap: "break-word" }}>
                          {c.sku_code || "-"}
                          {c.via_bundle && <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>묶음</span>}
                        </td>
                        <td data-label="판매상태">{c.sale_status ? (SALE_STATUS_KO[c.sale_status] || c.sale_status) : "-"}</td>
                        <td className="num" data-label="재고">{c.stock_qty != null ? c.stock_qty.toLocaleString() : "-"}</td>
                        <td className="num" data-label="7일">{q ? q.q7.toLocaleString() : "-"}</td>
                        <td className="num" data-label="30일">{q ? q.q30.toLocaleString() : "-"}</td>
                        <td className="actions" data-label="수량 적용">
                          <span className="sm-row" style={{ gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                            {noApply ? (
                              <span className="sm-faint" style={{ fontSize: 12 }}
                                title="네이버 API 가 추가상품 재고의 단독 수정을 지원하지 않습니다">
                                센터에서 수정
                              </span>
                            ) : (
                              <>
                                <input className="b2b-input" type="number" min={0} value={cmdQty[c.item_key] ?? ""}
                                  onChange={(e) => setCmdQty((p) => ({ ...p, [c.item_key]: e.target.value }))}
                                  placeholder="수량" aria-label="적용할 수량"
                                  style={{ width: 60, padding: "3px 6px", fontSize: 13 }} />
                                <button type="button" className="b2b-btn-secondary" disabled={applying === c.item_key}
                                  onClick={() => applyQty(c)} style={{ padding: "3px 8px", fontSize: 12 }}>
                                  적용
                                </button>
                              </>
                            )}
                            <button type="button" className="b2b-link-btn" onClick={() => copyName(c.listing_name, rowKey)}
                              title="채널 관리자 검색창에 붙여넣기용" style={{ fontSize: 12 }}>
                              {copied === rowKey ? "복사됨" : "복사"}
                            </button>
                          </span>
                          {cmd && !cmdStale && (
                            <div className="sm-faint" title={cmd.error || undefined}
                              style={{ fontSize: 11, marginTop: 2, whiteSpace: "normal", overflowWrap: "break-word", color: cmd.status === "실패" ? "var(--sm-danger)" : undefined }}>
                              {cmd.status === "대기" ? `${cmd.qty}개 적용 대기중` :
                               cmd.status === "실행중" ? `${cmd.qty}개 적용 중...` :
                               cmd.status === "완료" ? `${cmd.qty}개 적용 완료${cmd.executed_at ? ` (${kstStamp(cmd.executed_at)})` : ""}` :
                               `실패: ${cmd.error || "오류"}`}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {catalogRows.hidden.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="b2b-link-btn" onClick={() => setShowHidden((v) => !v)}>
                  {showHidden ? "판매안함 접기" : `판매안함 ${catalogRows.hidden.length}개 보기`}
                </button>
              </div>
            )}
          </section>
        )}
        {total === 0 ? (
          <div className="b2b-empty">최근 1년 매출에서 이 SKU 가 팔린 리스팅이 없습니다.</div>
        ) : (
        groups.map((g) => (
          <section key={g.channel} className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head">
              <span className="b2b-card-title">{g.channel}</span>
              <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>
                리스팅 {g.fresh.length + g.stale.length}개 · 30일 {g.qty30.toLocaleString()}개 판매
              </span>
            </div>
            <ListingTable rows={g.fresh} copied={copied} onCopy={copyName} />
            {g.stale.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="b2b-link-btn"
                  onClick={() => setOpenStale((p) => ({ ...p, [g.channel]: !p[g.channel] }))}>
                  {openStale[g.channel] ? "오래된 리스팅 접기" : `90일 이상 판매 없는 리스팅 ${g.stale.length}개 보기`}
                </button>
                {openStale[g.channel] && (
                  <div style={{ marginTop: 8 }}>
                    <ListingTable rows={g.stale} copied={copied} onCopy={copyName} />
                  </div>
                )}
              </div>
            )}
          </section>
        ))
        )}
        </>
      )}
    </div>
  );
}

function ListingTable({ rows, copied, onCopy }: { rows: Listing[]; copied: string; onCopy: (name: string, rowKey: string) => void }) {
  if (rows.length === 0) return null;
  const today = kstToday();
  return (
    <div className="b2b-table-wrap">
      <table className="b2b-table is-responsive">
        <thead>
          <tr>
            <th>상품명</th>
            <th>옵션</th>
            <th>관리코드</th>
            <th className="num">7일</th>
            <th className="num">30일</th>
            <th>마지막 판매</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => {
            const rowKey = `${l.channel}|${l.product_name}|${l.option_name}|${l.sku_code}|${i}`;
            return (
            <tr key={rowKey}>
              <td data-label="상품명">
                <strong>{l.product_name || "(상품명 없음)"}</strong>
                {/* 네이버 추가상품 등 — 매출의 거의 모든 주문에 함께 찍힌 상품 = 이 리스팅이 붙어 있는 본상품 */}
                {(l.companions?.length ?? 0) > 0 && (
                  <div className="sm-faint" style={{ fontSize: 12, marginTop: 2 }}>
                    어미상품 추정: {l.companions!.map((c) => `${c.name} (함께 주문 ${c.share}%)`).join(" · ")}
                  </div>
                )}
              </td>
              <td data-label="옵션">{l.option_name || "-"}</td>
              <td data-label="관리코드">
                {l.sku_code}
                {l.via_bundle && <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>묶음</span>}
              </td>
              <td className="num" data-label="7일">{l.qty_7.toLocaleString()}</td>
              <td className="num" data-label="30일">{l.qty_30.toLocaleString()}</td>
              <td data-label="마지막 판매" style={{ whiteSpace: "nowrap" }}>
                {l.last_sale ? (l.last_sale === today ? "오늘" : l.last_sale) : "-"}
              </td>
              <td className="actions">
                <button type="button" className="b2b-link-btn" onClick={() => onCopy(l.product_name, rowKey)}
                  title="채널 관리자 검색창에 붙여넣기용">
                  {copied === rowKey ? "복사됨" : "상품명 복사"}
                </button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
