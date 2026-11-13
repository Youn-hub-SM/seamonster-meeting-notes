"use client";

// 오디언스 추출 — 정기배송 고객 조건(상태·상품·회차·다음 결제 예정일·마지막 결제일·해지일).
//  상태는 세는 기준을 먼저 고른다 — 사람 기준(하나라도 이용중이면 이용중, 이용중 없이 일시정지가 있으면 일시정지, 전부 해지면 해지) / 품목 기준(품목마다).
//  카페24는 일시정지를 신청 전체가 아니라 품목에만 표시한다(app/lib/audience-sub.ts 머리말).
//  정기배송 상태는 전날 밤 카페24에서 가져온 값이다. 전화번호는 결제 주문번호로 매출 주문을 찾아 잇는다 — 못 이은 신청 수를 결과에 보인다.
//  검색·추출 기록과 엑셀 받기는 부모(page.tsx)와 같은 길을 쓴다(cond.mode = "sub").
import { useMemo, useRef, useState } from "react";
import { useConfirm } from "@/app/components/Feedback";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";
import { qty } from "@/app/lib/format";

const BASES = [{ key: "person", label: "사람 기준" }, { key: "item", label: "품목 기준" }] as const;
type Basis = (typeof BASES)[number]["key"];
const STATES = [{ key: "U", label: "이용중" }, { key: "P", label: "일시정지" }, { key: "C", label: "해지" }] as const;
type StateKey = (typeof STATES)[number]["key"];
type Cond = { basis: Basis; states: StateKey[]; products: string[]; minRound: string; maxRound: string; payFrom: string; payTo: string; lastPaidFrom: string; lastPaidTo: string; termFrom: string; termTo: string };
const EMPTY: Cond = { basis: "person", states: [], products: [], minRound: "", maxRound: "", payFrom: "", payTo: "", lastPaidFrom: "", lastPaidTo: "", termFrom: "", termTo: "" };
const toPayload = (c: Cond) => ({ mode: "sub", ...c }); // 기준은 상태를 골랐을 때만 서버가 남긴다
type Preview = { name: string; phone: string; person: string; states: string; round: number | null; next_pay: string | null; last_paid: string | null; terminated: string | null; items: string };
type Result = { count: number; excluded: number; unlinked: number; subs: number; capped: boolean; max: number; summary: string; preview: Preview[]; cond: Cond };
type ProductOption = { name: string; subs: number };
const digits = (s: string) => s.replace(/[^0-9]/g, "");

export default function SubAudience({ download, onLogged, exporting }: { download: (payload: unknown) => Promise<void>; onLogged: () => void; exporting: boolean }) {
  const confirm = useConfirm();
  const [cond, setCond] = useState<Cond>(EMPTY);
  const [result, setResult] = useState<Result | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [products, setProducts] = useState<ProductOption[] | null>(null); // 상품 칸을 처음 누를 때 한 번 읽는다
  const [productsError, setProductsError] = useState("");
  const asked = useRef(false);

  const set = <K extends keyof Cond>(k: K, v: Cond[K]) => setCond((c) => ({ ...c, [k]: v }));
  const toggleState = (s: StateKey) => setCond((c) => ({ ...c, states: c.states.includes(s) ? c.states.filter((x) => x !== s) : [...c.states, s] }));
  const isEmpty = JSON.stringify(cond) === JSON.stringify({ ...EMPTY, basis: cond.basis }); // 기준만 바꾼 것은 조건이 아니다
  const busy = searching || exporting;

  const loadProducts = () => {
    if (asked.current) return;
    asked.current = true;
    fetch("/api/audience?subproducts=1", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!j.ok) throw new Error(j.error);
      setProducts(j.products || []);
    }).catch((e) => { asked.current = false; setProductsError(e instanceof Error ? e.message : "정기배송 상품 목록을 불러오지 못했습니다."); });
  };
  const options: ComboOption[] = useMemo(() => (products || []).filter((p) => !cond.products.includes(p.name))
    .map((p) => ({ id: p.name, label: p.name, sub: `신청 ${qty(p.subs)}건` })), [products, cond.products]);

  const search = async () => {
    setError("");
    if (isEmpty) { setError("조건을 하나 이상 입력하세요."); return; }
    setSearching(true);
    try {
      const j = await (await fetch("/api/audience", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "search", cond: toPayload(cond) }) })).json();
      if (!j.ok) throw new Error(j.error);
      setResult({ ...j, cond });
      onLogged();
    } catch (e) { setResult(null); setError(e instanceof Error ? e.message : "고객을 찾지 못했습니다."); }
    finally { setSearching(false); }
  };
  const exportXlsx = async () => {
    if (!result) return;
    if (!(await confirm({ title: "엑셀 내려받기", body: `${qty(result.count)}명의 이름과 전화번호가 든 엑셀을 내려받습니다. 추출 기록에 남습니다.`, action: "엑셀 내려받기", danger: false }))) return;
    await download(toPayload(result.cond));
  };

  return (
    <>
      <section className="b2b-form-section">
        {error && <div className="b2b-error" style={{ marginBottom: "var(--sm-space-4)" }}>{error}</div>}
        <div className="aud-form">
          <div className="b2b-field aud-wide">
            <span className="b2b-field-label">상태</span>
            <div className="sm-tabs" role="group" aria-label="상태를 세는 기준">
              {BASES.map((b) => (
                <button key={b.key} type="button" className={`sm-tab ${cond.basis === b.key ? "is-active" : ""}`} aria-pressed={cond.basis === b.key} onClick={() => set("basis", b.key)}>{b.label}</button>
              ))}
            </div>
            <div className="sm-tabs" role="group" aria-label="정기배송 상태">
              {STATES.map((s) => (
                <button key={s.key} type="button" className={`sm-tab ${cond.states.includes(s.key) ? "is-active" : ""}`} aria-pressed={cond.states.includes(s.key)} onClick={() => toggleState(s.key)}>{s.label}</button>
              ))}
            </div>
          </div>
          <div className="b2b-field">
            <span className="b2b-field-label">마지막 결제일</span>
            <div className="aud-range">
              <input type="date" className="b2b-input" value={cond.lastPaidFrom} onChange={(e) => set("lastPaidFrom", e.target.value)} aria-label="마지막 결제일 시작" />
              <span>~</span>
              <input type="date" className="b2b-input" value={cond.lastPaidTo} onChange={(e) => set("lastPaidTo", e.target.value)} aria-label="마지막 결제일 끝" />
            </div>
          </div>
          <div className="b2b-field">
            <span className="b2b-field-label">다음 결제 예정일</span>
            <div className="aud-range">
              <input type="date" className="b2b-input" value={cond.payFrom} onChange={(e) => set("payFrom", e.target.value)} aria-label="다음 결제 예정일 시작" />
              <span>~</span>
              <input type="date" className="b2b-input" value={cond.payTo} onChange={(e) => set("payTo", e.target.value)} aria-label="다음 결제 예정일 끝" />
            </div>
          </div>
          <div className="b2b-field">
            <span className="b2b-field-label">해지일</span>
            <div className="aud-range">
              <input type="date" className="b2b-input" value={cond.termFrom} onChange={(e) => set("termFrom", e.target.value)} aria-label="해지일 시작" />
              <span>~</span>
              <input type="date" className="b2b-input" value={cond.termTo} onChange={(e) => set("termTo", e.target.value)} aria-label="해지일 끝" />
            </div>
          </div>
          <div className="b2b-field">
            <span className="b2b-field-label">회차</span>
            <div className="aud-range">
              <input className="b2b-input aud-num" inputMode="numeric" value={cond.minRound} onChange={(e) => set("minRound", digits(e.target.value))} placeholder="예: 3" aria-label="회차 최소" />
              <span>~</span>
              <input className="b2b-input aud-num" inputMode="numeric" value={cond.maxRound} onChange={(e) => set("maxRound", digits(e.target.value))} placeholder="예: 6" aria-label="회차 최대" />
              <span>회차</span>
            </div>
          </div>
          <div className="b2b-field aud-wide" onFocusCapture={loadProducts} onPointerDownCapture={loadProducts}>
            <span className="b2b-field-label">정기배송 상품</span>
            {productsError && <div className="b2b-error">{productsError}</div>}
            <Combobox value="" options={options} onSelect={(o) => setCond((c) => (c.products.includes(o.id) ? c : { ...c, products: [...c.products, o.id] }))}
              ariaLabel="정기배송 상품 검색" placeholder="상품명 검색" emptyText={products ? "일치하는 상품이 없습니다" : "상품을 불러오는 중..."} />
            {cond.products.length > 0 && (
              <div className="aud-chips">
                {cond.products.map((n) => (
                  <button key={n} type="button" className="aud-chip" aria-label={`${n} 빼기`} onClick={() => setCond((c) => ({ ...c, products: c.products.filter((x) => x !== n) }))}>
                    {n}<span aria-hidden="true">✕</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="aud-actions aud-wide">
            <button type="button" className="b2b-btn-primary" onClick={search} disabled={busy}>{searching ? "찾는 중" : "고객 찾기"}</button>
            <button type="button" className="b2b-btn-secondary" onClick={() => { setCond({ ...EMPTY, basis: cond.basis }); setResult(null); setError(""); }} disabled={busy || (isEmpty && !result)}>조건 지우기</button>
          </div>
        </div>
      </section>

      {result && (
        <section className="b2b-form-section" style={{ marginTop: "var(--sm-space-4)" }}>
          <div className="aud-result-head">
            <span className="aud-count">{qty(result.count)}명</span>
            <span className="aud-count-sub">조건에 맞는 신청 {qty(result.subs)}건 · 번호를 못 찾은 신청 {qty(result.unlinked)}건 · 안심번호(050)·번호 없는 고객 {qty(result.excluded)}명 제외</span>
            <button type="button" className="b2b-btn-secondary aud-export" onClick={exportXlsx} disabled={busy || result.count === 0}>{exporting ? "만드는 중" : "엑셀 내려받기"}</button>
          </div>
          <div className="aud-cond">{result.summary}</div>
          {result.capped && <div className="sm-warn" style={{ marginBottom: "var(--sm-space-3)" }}>신청이 {qty(result.max)}건을 넘어 앞에서부터 {qty(result.max)}건만 다룹니다. 조건을 좁히세요.</div>}
          {result.count === 0 ? <div className="b2b-empty">조건에 맞는 고객이 없습니다.</div> : (
            <div className="b2b-table-wrap">
              <table className="b2b-table aud-table">
                <thead><tr><th>이름</th><th>전화번호</th><th>사람 기준 상태</th><th>품목 상태</th><th className="num">회차</th><th>다음 결제 예정일</th><th>마지막 결제일</th><th>해지일</th><th>상품명</th></tr></thead>
                <tbody>
                  {result.preview.map((p, i) => (
                    <tr key={i}>
                      <td>{p.name}</td><td className="sm-nowrap">{p.phone}</td><td className="sm-nowrap">{p.person || "-"}</td><td className="sm-nowrap">{p.states}</td>
                      <td className="num">{p.round == null ? "-" : `${qty(p.round)}회차`}</td>
                      <td className="sm-nowrap">{p.next_pay || "-"}</td><td className="sm-nowrap">{p.last_paid || "-"}</td><td className="sm-nowrap">{p.terminated || "-"}</td>
                      <td className="aud-items">{p.items}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
