"use client";

import type { QuoteItem, QuoteSummary } from "@/app/lib/inventory-quote";

const won = (n: number) => Math.round(n || 0).toLocaleString();

// 매입 결산서 본문 — 현재 재계산(live)과 확정본(stamp 있음)이 같은 양식으로 그려진다.
//  확정본은 확정 당시 저장한 요약·품목표 그대로라, 이후 원장이 바뀌어도 이 표는 바뀌지 않는다.
//  printable=false 면 인쇄에서 빠진다(화면에 결산서가 둘일 때 하나만 인쇄되게).
export default function QuoteSheet({ ym, s, items, stamp, printable = true }: {
  ym: string;
  s: QuoteSummary;
  items: QuoteItem[];
  stamp?: string;
  printable?: boolean;
}) {
  const [y, mm] = ym.split("-");
  const totalReturnQty = s.totalReturnQty ?? 0;
  const noPriceQty = s.noPriceQty ?? 0;
  // 반품 단가도 마스터 매입단가도 없어 0원으로 계산된 교차월 반품 — 차감 누락을 알린다
  const zeroReturnItems = items.filter((i) => i.qty === 0 && (i.return_qty ?? 0) > 0 && (i.return_amount ?? 0) === 0);

  return (
    <section className={`${printable ? "voc-print" : "no-print"} inv-quote-print`} style={{ background: "var(--sm-white)", border: "1px solid var(--sm-border)", borderRadius: 12, padding: "28px 30px", maxWidth: 900, boxShadow: "var(--sm-shadow-card)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid var(--sm-black)", paddingBottom: 12, marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 15, color: "var(--sm-text-mid)", fontWeight: 700 }}>씨몬스터</div>
          <h2 style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{y}년 {mm}월 매입 결산</h2>
          {stamp && <div style={{ fontSize: 12, color: "var(--sm-text-mid)", marginTop: 4 }}>{stamp}</div>}
        </div>
        <div style={{ textAlign: "right", fontSize: 12, color: "var(--sm-text-mid)" }}>총 입금액<div style={{ fontSize: 24, fontWeight: 800, color: "var(--sm-black)", marginTop: 2 }}>{won(s.deposit)}원</div></div>
      </div>

      {/* 요약 블록 */}
      <div className="b2b-table-wrap" style={{ marginBottom: 22 }}>
        <table className="b2b-table">
          <thead><tr><th>구분</th><th className="num">공급가액</th><th className="num">세액 / 기타</th><th className="num">총액</th></tr></thead>
          <tbody>
            <tr><td style={{ fontWeight: 700 }}>임대료</td><td className="num b2b-money">{won(s.rentSupply)}</td><td className="num b2b-money">{won(s.rentVat)}</td><td className="num b2b-money" style={{ fontWeight: 700 }}>{won(s.rentTotal)}</td></tr>
            <tr><td style={{ fontWeight: 700 }}>면세품목</td><td className="num b2b-money">{won(s.exemptSupply)}</td><td className="num b2b-money">{won(s.exemptEtc)}</td><td className="num b2b-money" style={{ fontWeight: 700 }}>{won(s.exemptTotal)}</td></tr>
            <tr><td style={{ fontWeight: 700 }}>과세품목</td><td className="num b2b-money">{won(s.taxableSupply)}</td><td className="num b2b-money">{won(s.taxableVat)}</td><td className="num b2b-money" style={{ fontWeight: 700 }}>{won(s.taxableTotal)}</td></tr>
            <tr style={{ background: "var(--sm-bg-subtle)" }}><td style={{ fontWeight: 800 }}>총 입금액</td><td className="num" /><td className="num" /><td className="num b2b-money" style={{ fontWeight: 800, fontSize: 15 }}>{won(s.deposit)}</td></tr>
          </tbody>
        </table>
      </div>

      {/* SKU 표 */}
      <div className="sm-between" style={{ marginBottom: 6 }}>
        <strong style={{ fontSize: 15 }}>품목별 매입 ({(s.itemCount ?? 0).toLocaleString()}종 · {(s.totalQty ?? 0).toLocaleString()}개)</strong>
        {totalReturnQty > 0 && (
          <span className="sm-faint" style={{ fontSize: 12 }}>반품 {totalReturnQty.toLocaleString()}개 · {won(s.returnAmount)}원 차감</span>
        )}
      </div>
      {noPriceQty > 0 && (
        <div className="sm-warn" style={{ marginBottom: 10 }}>
          단가를 적지 않은 입고가 <strong>{noPriceQty.toLocaleString()}개</strong> 있습니다(매입가 * 표시) — 그만큼 0원으로 계산돼 매입가가 실제보다 낮게 나옵니다.
        </div>
      )}
      {zeroReturnItems.length > 0 && (
        <div className="sm-warn" style={{ marginBottom: 10 }}>
          반품 단가도 마스터 매입단가도 없어 <strong>0원으로 계산된 반품</strong>이 있습니다:{" "}
          {zeroReturnItems.map((i) => i.name).join(", ")}
        </div>
      )}
      <div className="b2b-table-wrap">
        <table className="b2b-table">
          <thead><tr><th>코드명</th><th>품목명</th><th>규격(g)</th><th>원산지</th><th className="num">매입가</th><th className="num">매입수량</th><th className="num">반품수량</th><th className="num">총 매입금액</th><th>구분</th></tr></thead>
          <tbody>
            {items.map((it) => {
              const rq = it.return_qty ?? 0;
              const np = it.no_price_qty ?? 0;
              return (
                <tr key={it.product_id}>
                  <td style={{ fontFamily: "var(--sm-mono)", fontSize: 12 }}>{it.sku || "-"}</td>
                  <td>{it.name}</td>
                  <td>{it.spec || "-"}</td>
                  <td>{it.origin || "-"}</td>
                  <td className="num b2b-money" title={np > 0 ? `단가 미입력 ${np.toLocaleString()}개가 0원으로 섞여 평균이 낮습니다` : undefined}>
                    {(it.unit_price ?? 0).toLocaleString()}{np > 0 && <span style={{ color: "var(--sm-danger)", fontWeight: 800 }}>*</span>}
                  </td>
                  <td className="num b2b-money">{(it.qty ?? 0).toLocaleString()}</td>
                  <td className="num b2b-money" style={{ color: rq > 0 ? "var(--sm-danger)" : "var(--sm-text-light)", fontWeight: rq > 0 ? 700 : 400 }}>
                    {rq > 0 ? rq.toLocaleString() : "-"}
                  </td>
                  <td className="num b2b-money" style={{ fontWeight: 700 }}
                    title={[
                      rq > 0 ? `정산수량 ${(it.net_qty ?? 0).toLocaleString()} (반품 ${rq.toLocaleString()} 제외)` : "",
                      it.tax_type === "taxable" ? `공급가액 기준 — 부가세 포함 시 ${won((it.amount ?? 0) * 1.1)}원` : "",
                    ].filter(Boolean).join(" · ")}>{(it.total ?? 0).toLocaleString()}</td>
                  <td><span className="sm-faint" style={{ fontSize: 12 }}>{it.tax_type === "exempt" ? "면세" : "과세"}</span></td>
                </tr>
              );
            })}
            <tr style={{ fontWeight: 800, background: "var(--sm-bg-subtle)" }}>
              <td colSpan={4}>합계</td>
              <td className="num" />
              <td className="num">{(s.totalQty ?? 0).toLocaleString()}</td>
              <td className="num" style={{ color: totalReturnQty > 0 ? "var(--sm-danger)" : undefined }}>{totalReturnQty > 0 ? totalReturnQty.toLocaleString() : "-"}</td>
              <td className="num">{(s.totalAmount ?? 0).toLocaleString()}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="sm-faint" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
        ※ 결산 기준: 그 달 소매 입고 완료분(재고 이동·'대기' 입고·도매 입고 제외) · 금액은 <strong>공급가액(부가세 미포함)</strong><br />
        ※ 매입가 = 가중평균 매입단가(반올림, *는 단가 미입력 포함) · 총 매입금액 = 실제 매입액 − 반품수량 × 반품 단가(없으면 매입가)
      </p>
    </section>
  );
}
