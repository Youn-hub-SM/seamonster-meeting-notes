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
  listing_name: string;
  item_kind: string;
  item_name: string | null;
  sku_code: string;
  sale_status: string | null;
  stock_qty: number | null;
  via_bundle: boolean;
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

const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
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

  // 검색 결과(카탈로그+채널 리스팅) 엑셀 다운로드 — 화면에 보이는 데이터 그대로
  async function exportXlsx() {
    if (!res?.target) return;
    setExporting(true);
    try {
      const r = await fetch("/api/sales/listings/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: res.target, catalog: res.catalog ?? [], listings: res.listings ?? [] }),
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
  // 네이버 카탈로그 동기화 — 상품이 많으면 시간 예산으로 나눠 처리되므로 remaining 이 0이 될 때까지 반복 안내
  async function syncNaver() {
    setSyncing(true); setSyncMsg("");
    try {
      const r = await fetch("/api/naver/catalog/sync", { method: "POST" });
      const j = await r.json();
      if (!j.ok) { setSyncMsg(`동기화 실패: ${j.error || "알 수 없는 오류"}`); return; }
      setSyncMsg(
        `동기화 완료 — 원상품 ${j.products}개 중 ${j.updated}개 갱신` +
        (j.remaining > 0 ? `, 남은 ${j.remaining}개는 버튼을 다시 눌러 이어서 처리` : "") +
        (j.first_error ? ` (일부 실패: ${j.first_error})` : "")
      );
      if (pid) load(pid); // 화면 갱신
    } catch (e) { setSyncMsg(`동기화 실패: ${(e as Error).message}`); }
    finally { setSyncing(false); }
  }

  // 채널별 그룹 + 채널 내 30일 판매량 내림차순, 채널은 30일 합 내림차순.
  //  스마트스토어는 등록 카탈로그 카드(API, 전체·정확)가 있으면 매출 카드에서 뺀다(중복 — 대표 결정).
  const groups = useMemo(() => {
    const rows = res?.listings ?? [];
    const hasCatalog = (res?.catalog?.length ?? 0) > 0;
    const cut = staleCut();
    const byCh = new Map<string, { fresh: Listing[]; stale: Listing[]; qty30: number }>();
    for (const l of rows) {
      const ch = l.channel || "(판매처 미상)";
      if (hasCatalog && ch === "스마트스토어") continue;
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
  }, [res]);

  const total = res?.listings?.length ?? 0;

  // 카탈로그 행에 스마트스토어 매출 판매량(7일/30일) 병합 — (상품명|옵션명) 문자열 매칭.
  //  추가상품은 매출에 자기 이름으로 찍히므로 이름 후보 여러 개로 시도, 못 찾으면 null(화면 '-').
  const catalogQty = useMemo(() => {
    const bySale = new Map<string, { q7: number; q30: number }>();
    for (const l of res?.listings ?? []) {
      if (l.channel !== "스마트스토어") continue;
      const key = `${l.product_name}|${l.option_name}`;
      const cur = bySale.get(key) ?? { q7: 0, q30: 0 };
      cur.q7 += l.qty_7; cur.q30 += l.qty_30;
      bySale.set(key, cur);
    }
    const out = new Map<number, { q7: number; q30: number }>();
    (res?.catalog ?? []).forEach((c, i) => {
      const nm = c.item_name ?? "";
      const suppName = nm.includes(" - ") ? nm.slice(nm.indexOf(" - ") + 3) : nm; // 'group - name' 의 name
      const candidates = [
        `${c.listing_name}|${nm}`,          // 옵션: 상품명|옵션명
        `${c.listing_name}|`,               // 단일 상품
        `${nm}|`,                            // 추가상품이 자기 이름으로 찍힌 경우
        `${suppName}|`,
      ];
      for (const k of candidates) {
        const hit = bySale.get(k);
        if (hit) { out.set(i, hit); break; }
      }
    });
    return out;
  }, [res]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">SKU 리스팅 찾기</h1>
          <p className="b2b-page-subtitle">매출 기준(최근 1년) + 네이버는 API 등록 카탈로그로 전체 확인</p>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={syncNaver} disabled={syncing}>
            {syncing ? "동기화 중..." : "네이버 카탈로그 동기화"}
          </button>
          <button className="b2b-btn-primary" onClick={exportXlsx}
            disabled={exporting || !res || ((res.catalog?.length ?? 0) === 0 && (res.listings?.length ?? 0) === 0)}
            title={!res ? "먼저 상품을 검색하세요" : ""}>
            {exporting ? "생성 중..." : "엑셀 다운로드"}
          </button>
        </div>
      </header>

      {err && <div className="b2b-error">{err}</div>}
      {syncMsg && <div className={syncMsg.startsWith("동기화 실패") ? "b2b-error" : "sm-success"}>{syncMsg}</div>}

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
        {(res.catalog?.length ?? 0) > 0 && (
          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head">
              <span className="b2b-card-title">네이버 등록 카탈로그</span>
              <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>
                {res.catalog!.length}건{res.catalog_synced_at ? ` · 동기화 ${res.catalog_synced_at.slice(0, 10)}` : ""}
              </span>
            </div>
            <div className="b2b-table-wrap">
              <table className="b2b-table is-responsive">
                <thead>
                  <tr>
                    <th>등록 상품명(어미상품)</th>
                    <th>구분</th>
                    <th>옵션·추가상품명</th>
                    <th>관리코드</th>
                    <th>판매상태</th>
                    <th className="num">재고</th>
                    <th className="num">7일</th>
                    <th className="num">30일</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {res.catalog!.map((c, i) => {
                    const rowKey = `cat|${c.listing_name}|${c.item_kind}|${c.item_name ?? ""}|${i}`;
                    const q = catalogQty.get(i);
                    return (
                      <tr key={rowKey}>
                        <td data-label="등록 상품명"><strong>{c.listing_name}</strong></td>
                        <td data-label="구분">{KIND_KO[c.item_kind] || c.item_kind}</td>
                        <td data-label="옵션·추가상품명">{c.item_name || "-"}</td>
                        <td data-label="관리코드">
                          {c.sku_code || "-"}
                          {c.via_bundle && <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>묶음</span>}
                        </td>
                        <td data-label="판매상태">{c.sale_status ? (SALE_STATUS_KO[c.sale_status] || c.sale_status) : "-"}</td>
                        <td className="num" data-label="재고">{c.stock_qty != null ? c.stock_qty.toLocaleString() : "-"}</td>
                        <td className="num" data-label="7일">{q ? q.q7.toLocaleString() : "-"}</td>
                        <td className="num" data-label="30일">{q ? q.q30.toLocaleString() : "-"}</td>
                        <td className="actions">
                          <button type="button" className="b2b-link-btn" onClick={() => copyName(c.listing_name, rowKey)}
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
