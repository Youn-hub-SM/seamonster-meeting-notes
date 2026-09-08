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
};
type Result = {
  ok: boolean;
  error?: string;
  target?: { id: string; sku: string | null; name: string; spec: string | null };
  bundles?: { sku: string | null; name: string }[];
  listings?: Listing[];
};

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

  // 묶음 SKU 도 직접 검색 대상 — 구성품이든 묶음이든 고르면 그 SKU 기준으로 찾는다
  const options = useMemo(() => products
    .filter((p) => p.active !== false && (p.sku || "").trim())
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

  // 채널별 그룹 + 채널 내 30일 판매량 내림차순, 채널은 30일 합 내림차순
  const groups = useMemo(() => {
    const rows = res?.listings ?? [];
    const cut = staleCut();
    const byCh = new Map<string, { fresh: Listing[]; stale: Listing[]; qty30: number }>();
    for (const l of rows) {
      const ch = l.channel || "(판매처 미상)";
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

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">SKU 리스팅 찾기</h1>
          <p className="b2b-page-subtitle">최근 1년 매출 기준 — 판매 이력이 없는 리스팅은 나오지 않습니다</p>
        </div>
      </header>

      {err && <div className="b2b-error">{err}</div>}

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
      ) : !res ? null : total === 0 ? (
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
              <td data-label="상품명"><strong>{l.product_name || "(상품명 없음)"}</strong></td>
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
