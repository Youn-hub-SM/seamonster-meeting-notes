"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { Order, OrderItem } from "@/app/lib/b2b-orders";
import type { Company } from "@/app/lib/b2b-types";

// 거래명세표 — 발주 1건당 1장, A4 인쇄/PDF(window.print).
//  공급자(우리 회사)·직인은 설정(/b2b/settings 거래명세표 섹션, b2b_settings KV)에서.
//  라인 세액: 과세=공급가액×10%(마지막 과세 라인이 반올림 오차 흡수 → 합계가 orders.vat 와 일치), 면세=0.

type Supplier = { name: string; biz_no: string; ceo: string; addr: string; biz_type: string; biz_item: string; phone: string };
type FullOrder = Order & { items: OrderItem[]; company: Company | null };

const won = (n: number) => Math.round(n).toLocaleString();

export default function StatementPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [order, setOrder] = useState<FullOrder | null>(null);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [stamp, setStamp] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true); setError("");
      try {
        const [oj, sj] = await Promise.all([
          (await fetch(`/api/b2b/orders/${id}`, { cache: "no-store" })).json(),
          (await fetch("/api/b2b/settings/statement", { cache: "no-store" })).json(),
        ]);
        if (!oj.ok) throw new Error(oj.error || "발주 조회 실패");
        setOrder(oj.order as FullOrder);
        if (sj.ok) { setSupplier(sj.supplier as Supplier); setStamp(sj.stamp || ""); }
      } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
      setLoading(false);
    })();
  }, [id]);

  // 라인별 세액 — 과세만 10%, 마지막 과세 라인이 반올림 오차를 흡수해 합이 orders.vat 와 정확히 일치.
  const lines = useMemo(() => {
    if (!order) return [];
    const items = order.items || [];
    const raw = items.map((it) => {
      const supply = Number(it.line_total) || Number(it.qty) * Number(it.unit_price) || 0;
      const vat = it.tax_type === "exempt" ? 0 : Math.round(supply * 0.1);
      return { it, supply, vat };
    });
    const vatSum = raw.reduce((s, r) => s + r.vat, 0);
    const diff = (Number(order.vat) || 0) - vatSum;
    if (diff !== 0) {
      for (let i = raw.length - 1; i >= 0; i--) {
        if (raw[i].it.tax_type !== "exempt") { raw[i].vat += diff; break; }
      }
    }
    return raw;
  }, [order]);

  const supplierMissing = !supplier || !supplier.name;
  const c = order?.company;

  return (
    <div className="b2b-container">
      <header className="b2b-page-head no-print">
        <div>
          <h1 className="b2b-page-title">거래명세표</h1>
          <p className="b2b-page-subtitle">인쇄하거나 PDF 로 저장해 거래처에 전달하세요. 공급자 정보·직인은 설정에서 관리합니다.</p>
        </div>
        <div className="b2b-page-actions">
          <Link href="/b2b/orders" className="b2b-btn-secondary">발주 목록</Link>
          <Link href="/b2b/settings" className="b2b-btn-secondary">공급자 정보 설정</Link>
          <button className="b2b-btn-primary" onClick={() => window.print()} disabled={loading || !order}>인쇄 / PDF</button>
        </div>
      </header>

      {error && <div className="b2b-error no-print">{error}</div>}
      {supplierMissing && !loading && (
        <div className="b2b-error no-print">공급자(우리 회사) 정보가 비어 있습니다. <Link href="/b2b/settings" style={{ textDecoration: "underline" }}>설정 › 거래명세표</Link>에서 상호·사업자번호 등을 입력하면 명세표에 채워집니다.</div>
      )}

      {loading ? (
        <div className="b2b-loading">불러오는 중...</div>
      ) : !order ? (
        <div className="b2b-empty">발주를 찾을 수 없습니다.</div>
      ) : (
        <section className="voc-print" style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "30px 34px", maxWidth: 860, boxShadow: "var(--sm-shadow-card)" }}>
          {/* 제목 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 10, marginBottom: 14 }}>
            <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: 10 }}>거래명세표</h2>
            <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>
              <div>(공급받는자 보관용)</div>
              <div style={{ marginTop: 4 }}>거래일자 <strong style={{ color: "var(--sm-black)" }}>{order.order_date}</strong> · No. <strong style={{ color: "var(--sm-black)" }}>{order.order_no}</strong></div>
            </div>
          </div>

          {/* 공급자 / 공급받는자 2단 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
            <div style={{ border: "1px solid var(--sm-border)", borderRadius: 8, padding: "10px 12px", position: "relative" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sm-text-mid)", marginBottom: 6 }}>공급자</div>
              <InfoRow label="등록번호" value={supplier?.biz_no} strong />
              <InfoRow label="상호" value={supplier?.name} extraLabel="성명" extra={supplier?.ceo ? `${supplier.ceo} (인)` : ""} />
              <InfoRow label="사업장" value={supplier?.addr} />
              <InfoRow label="업태" value={supplier?.biz_type} extraLabel="종목" extra={supplier?.biz_item} />
              <InfoRow label="전화" value={supplier?.phone} />
              {stamp && (
                <img src={stamp} alt="직인" style={{ position: "absolute", right: 14, top: 30, width: 58, height: 58, objectFit: "contain", mixBlendMode: "multiply", opacity: 0.9 }} />
              )}
            </div>
            <div style={{ border: "1px solid var(--sm-border)", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sm-text-mid)", marginBottom: 6 }}>공급받는자</div>
              <InfoRow label="등록번호" value={c?.biz_no} strong />
              <InfoRow label="상호" value={c?.name} extraLabel="성명" extra={c?.ceo_name ?? ""} />
              <InfoRow label="주소" value={c?.address} />
              <InfoRow label="연락처" value={c?.contact_phone} extraLabel="담당" extra={c?.contact_name ?? ""} />
            </div>
          </div>

          {/* 품목 */}
          <table className="b2b-table">
            <thead>
              <tr><th style={{ width: 34 }}>No</th><th>품목</th><th>규격</th><th className="num">수량</th><th className="num">단가</th><th className="num">공급가액</th><th className="num">세액</th><th style={{ width: 52 }}>비고</th></tr>
            </thead>
            <tbody>
              {lines.map(({ it, supply, vat }, i) => (
                <tr key={it.id ?? i}>
                  <td style={{ textAlign: "center", color: "var(--sm-text-mid)" }}>{i + 1}</td>
                  <td>{it.product_name}{it.option_label ? ` (${it.option_label})` : ""}</td>
                  <td>{it.spec || "-"}</td>
                  <td className="num b2b-money">{Number(it.qty).toLocaleString()}</td>
                  <td className="num b2b-money">{won(Number(it.unit_price))}</td>
                  <td className="num b2b-money">{won(supply)}</td>
                  <td className="num b2b-money">{vat > 0 ? won(vat) : "-"}</td>
                  <td style={{ textAlign: "center", fontSize: 12, color: "var(--sm-text-mid)" }}>{it.tax_type === "exempt" ? "면세" : ""}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 800, background: "var(--sm-bg-subtle)" }}>
                <td colSpan={5}>합계</td>
                <td className="num b2b-money">{won(Number(order.subtotal) || 0)}</td>
                <td className="num b2b-money">{won(Number(order.vat) || 0)}</td>
                <td />
              </tr>
            </tbody>
          </table>

          {/* 합계금액 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "2px solid var(--sm-black)", borderRadius: 8, padding: "12px 16px", marginTop: 14 }}>
            <strong style={{ fontSize: 15 }}>합계금액 (공급가액 + 세액)</strong>
            <strong style={{ fontSize: 22 }}>{won(Number(order.total) || 0)}원</strong>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, fontSize: 12, color: "var(--sm-text-mid)" }}>
            <span>위와 같이 거래하였음을 확인합니다.</span>
            <span>인수자 : ____________________ (인)</span>
          </div>
        </section>
      )}
    </div>
  );
}

function InfoRow({ label, value, strong, extraLabel, extra }: { label: string; value?: string | null; strong?: boolean; extraLabel?: string; extra?: string | null }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "3px 0", borderTop: "1px solid var(--sm-border-light)" }}>
      <span style={{ width: 52, flex: "0 0 auto", color: "var(--sm-text-mid)", fontSize: 12 }}>{label}</span>
      <span style={{ fontWeight: strong ? 700 : 500, flex: 1 }}>{value || "-"}</span>
      {extraLabel ? (
        <>
          <span style={{ color: "var(--sm-text-mid)", fontSize: 12, flex: "0 0 auto" }}>{extraLabel}</span>
          <span style={{ fontWeight: 500, flex: "0 0 auto" }}>{extra || "-"}</span>
        </>
      ) : null}
    </div>
  );
}
