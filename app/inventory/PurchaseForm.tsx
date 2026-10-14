"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MOVE_ONLY_CHANNELS, signedQty, type InvTxnType, type InvChannel } from "@/app/lib/inventory";
import { matchKoQuery } from "@/app/lib/hangul";
import type { LinkResultLite } from "@/app/lib/link-result";
import { ChannelPicker } from "./ChannelTabs";
import { LOST_MSG, linkMessage, confirmUnlinkedInbound } from "./TxnModal";
import { useConfirm, useToast } from "@/app/components/Feedback";

type OpenReq = { id: string; req_no: string | null; title: string | null; prod_start: string; due_date: string | null; in_window: boolean; full?: boolean };
// 요청서 목록 조회 결과 → 입고 화면 경고 문구(없으면 ""). 조회 실패·이행률 판독 실패 모두 사람이 직접 골라야 한다.
const reqWarnOf = (j: { ok?: boolean; full_ok?: boolean } | null) =>
  !j?.ok ? "요청서 목록을 불러오지 못했습니다 — 새로고침 후 다시 시도하세요. 이대로 저장하면 요청서에 연결되지 않습니다."
  : j.full_ok === false ? "이행률을 읽지 못해 기본 요청서를 고르지 않았습니다 — 연결할 요청서를 직접 고르세요." : "";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const DAYS_AGO = (n: number) => new Date(Date.now() + 9 * 3600_000 - n * 86400_000).toISOString().slice(0, 10);
// 제출 키(131) — 이 폼 한 번 = 키 하나. 응답이 끊겨 다시 눌러도 서버가 같은 키를 알아보고 한 번만 기록한다.
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

export type PickProduct = { id: string; name: string; sku: string | null; spec: string | null; unit: string; cost_price: number; purchase_price: number; origin: string | null; attrs: string | null; qty: number; is_bundle?: boolean };
type Line = { key: string; product_id: string; name: string; sub: string; unit: string; qty: string; price: string };

// BoxHero 구매창 스타일 — 전체 페이지 폼. 여러 제품을 담아 입고/출고를 한 번에. 제품 검색은 초성·다중단어 지원.
export default function PurchaseForm({ products, defaultType = "입고", onSaved, onCancel }: {
  products: PickProduct[];
  defaultType?: InvTxnType;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [type, setType] = useState<InvTxnType>(defaultType);
  const [channel, setChannel] = useState<InvChannel>("소매");
  const [date, setDate] = useState(TODAY());
  const [partner, setPartner] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [done, setDone] = useState(true); // 즉시 입고/출고처리(기본 체크) — 해제 시 '대기'
  // 지정 매칭 — 입고를 연결할 제조사 요청서를 사람이 고른다. 거래일이 생산기간에 드는 요청서가 기본값.
  const [reqs, setReqs] = useState<OpenReq[]>([]);
  const [reqId, setReqId] = useState("");
  const [reqTouched, setReqTouched] = useState(false);
  const [reqWarn, setReqWarn] = useState("");
  useEffect(() => {
    if (type !== "입고") return;
    let alive = true;
    fetch(`/api/production/requests/open?date=${date}`, { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!alive) return;
      setReqWarn(reqWarnOf(j));
      if (!j?.ok) { setReqId(""); setReqs([]); return; } // 경고('연결되지 않습니다')와 실제 저장이 맞게 — 옛 선택·옛 목록(다른 거래일 기준)을 남기지 않는다
      setReqs(j.requests || []);
      if (!reqTouched) setReqId(j.default_id || "");
    }).catch(() => { if (alive) { setReqWarn(reqWarnOf(null)); setReqId(""); setReqs([]); } });
    return () => { alive = false; };
  }, [type, date, reqTouched]);
  const [reason, setReason] = useState("판매"); // 출고 사유 — '판매' 외에는 대사(구매·판매·재고 확인)에서 분리 집계(099)
  const [inReason, setInReason] = useState(""); // 입고 사유 — '' = 매입·생산, '고객 반품'(D4b) = 요청서 연결·단가 없음
  const customerReturn = type === "입고" && inReason === "고객 반품";
  const submitKey = useRef(newKey());
  const [search, setSearch] = useState("");
  const [excludeBundles, setExcludeBundles] = useState(true); // 묶음(세트) 제외 — 기본 켜짐(세트는 자체 재고 없음)
  const [active, setActive] = useState(-1); // 키보드 하이라이트 인덱스
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const suggestRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    // 이미 담은 품목은 다시 띄우지 않는다 — 같은 상품이 여러 줄로 중복 추가되던 것 방지(수량은 줄에서 고친다).
    const added = new Set(lines.map((l) => l.product_id));
    return products
      .filter((p) => !added.has(p.id))
      .filter((p) => !excludeBundles || !p.is_bundle)
      .filter((p) => matchKoQuery(`${p.name} ${p.sku || ""} ${p.spec || ""} ${p.origin || ""} ${p.attrs || ""} ${p.unit}`, q))
      .slice(0, 12);
  }, [products, search, excludeBundles, lines]);

  // 활성 항목을 보이게 스크롤
  useEffect(() => { suggestRef.current?.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" }); }, [active]);

  function addLine(p: PickProduct) {
    const sub = [p.spec, p.origin, p.attrs, p.sku, `재고 ${p.qty.toLocaleString()}${p.unit}`].filter(Boolean).join(" · ");
    // 입고 = 상품 마스터의 '매입단가' 기준(미설정이면 빈칸 — 원가로 채우지 않음). 출고 = 원가 참고가.
    const base = type === "입고" ? p.purchase_price : p.cost_price;
    setLines((ls) => [...ls, { key: `${p.id}-${ls.length}-${Date.now()}`, product_id: p.id, name: p.name, sub, unit: p.unit, qty: "1", price: base ? String(base) : "" }]);
    setSearch(""); setActive(-1);
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!matches.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (active >= 0 && matches[active]) addLine(matches[active]); else if (matches.length === 1) addLine(matches[0]); }
    else if (e.key === "Escape") { setSearch(""); setActive(-1); }
  }
  const setLine = (key: string, k: "qty" | "price", v: string) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v } : l)));
  const removeLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));

  const amountOf = (l: Line) => (Number(l.qty) || 0) * (Number(l.price) || 0);
  const totals = useMemo(() => ({
    items: lines.length,
    qty: lines.reduce((s, l) => s + (Number(l.qty) || 0), 0),
    amount: lines.reduce((s, l) => s + amountOf(l), 0),
  }), [lines]);

  async function save() {
    const valid = lines.filter((l) => (Number(l.qty) || 0) > 0);
    if (valid.length === 0) { setError("제품과 수량을 입력하세요."); return; }
    // 미래 날짜 '완료'는 서버도 막는다(S6) — 예정 건은 즉시 처리를 해제해 대기로
    if (done && date > TODAY()) { setError("미래 날짜는 '즉시 처리'를 해제해 대기로 저장하세요."); return; }
    if (date < DAYS_AGO(7) && !(await confirm({ title: "7일 이상 전 날짜로 기록", body: `거래일이 ${date} 입니다.`, action: `${date} 로 기록`, danger: false }))) return;
    setSaving(true); setError("");
    // 제조사 입고를 '연결 안 함'으로 저장 — 열린 요청서 잔여가 있는 품목이면 확인(S9)
    if (type === "입고" && done && !customerReturn && !reqId && !(await confirmUnlinkedInbound(date, valid.map((l) => ({ product_id: l.product_id, name: l.name })), confirm))) { setSaving(false); return; }
    try {
      const rows = valid.map((l) => ({
        type, qty: signedQty(type, Number(l.qty) || 0), product_id: l.product_id, product_name: l.name,
        unit_amount: !customerReturn && Number(l.price) > 0 ? Math.round(Number(l.price)) : null, txn_date: date, partner: partner.trim() || null, memo: memo.trim() || null,
        reason: type === "출고" && reason !== "판매" ? reason : customerReturn ? inReason : null,
      }));
      let res: Response;
      let j: { ok?: boolean; error?: string; code?: string; replay?: boolean; link?: LinkResultLite } | null = null;
      const lost = LOST_MSG;
      try {
        res = await fetch("/api/inventory/txns/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, done, channel, request_key: submitKey.current, request_id: type === "입고" && done && !customerReturn ? (reqId || null) : null }) });
        j = await res.json().catch(() => null);
      } catch { throw new Error(lost); }
      if (!j) throw new Error(lost);
      if (j.code === "request_key_conflict") submitKey.current = newKey(); // 다음 누름은 새 기록
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      if (j.replay) toast.success("이미 저장돼 있던 요청입니다 — 다시 기록하지 않았습니다.");
      if (j.link) {
        const m = linkMessage(j.link, (pid) => valid.find((l) => l.product_id === pid)?.name || "품목");
        if (j.link.ok && !j.link.failed?.length) toast.success(m); else toast.error(m);
      }
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  return (
    <>
      <div className="sm-row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div className="sm-tabs">
          <button className={`sm-tab ${type === "입고" ? "is-active" : ""}`} onClick={() => { setType("입고"); setReason("판매"); if (channel !== "소매") setChannel("소매"); }}>구매(입고)</button>
          <button className={`sm-tab ${type === "출고" ? "is-active" : ""}`} onClick={() => { setType("출고"); setInReason(""); }}>판매(출고)</button>
        </div>
        <ChannelPicker value={channel} onChange={setChannel}
          disabledChannels={type === "입고" ? [...MOVE_ONLY_CHANNELS] : []}
          disabledHint="도매·프로모션·도매 대량은 소매로 입고한 뒤 [재고 이동]에서 옮깁니다" />
        <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>거래일
          <input className="b2b-input" type="date" value={date} max={done ? TODAY() : undefined} onChange={(e) => setDate(e.target.value)} style={{ width: "auto" }} /></label>
        {type === "입고" && (
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>사유
            <select className="b2b-input" value={inReason} onChange={(e) => setInReason(e.target.value)} style={{ width: "auto" }}
              title="고객 반품·교환으로 돌아온 물건은 '고객 반품' — 요청서 연결·매입 단가 없이 기록됩니다">
              <option value="">입고(매입·생산)</option>
              <option value="고객 반품">고객 반품·교환 회수</option>
            </select>
          </label>
        )}
        {type === "입고" && (
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>요청서
            <select className="b2b-input" value={done && !customerReturn ? reqId : ""} disabled={!done || customerReturn} onChange={(e) => { setReqId(e.target.value); setReqTouched(true); }} style={{ width: "auto", maxWidth: 340 }}
              title={customerReturn ? "고객 반품은 요청서에 연결되지 않습니다" : done ? "이 입고를 연결할 제조사 요청서" : "대기 저장은 요청서에 연결되지 않습니다"}>
              <option value="">연결 안 함</option>
              {reqs.map((r) => <option key={r.id} value={r.id}>{r.req_no || "요청서"}{r.title ? ` · ${r.title}` : ""} · 생산 {r.prod_start.slice(5)}~{(r.due_date || "").slice(5)}{r.in_window ? "" : " (기간 밖)"}{r.full ? " (이행 100%)" : ""}</option>)}
            </select>
          </label>
        )}
        {type === "입고" && !customerReturn && reqWarn && <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-danger)", flexBasis: "100%" }}>{reqWarn}</span>}
        {type === "출고" && (
          <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>사유
            <select className="b2b-input" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "auto" }}
              title="판매가 아닌 출고(협찬·폐기 등)는 사유를 남겨야 '재고 대사'에서 판매와 분리됩니다">
              <option value="판매">판매</option>
              <option value="협찬">협찬·증정</option>
              <option value="폐기">폐기</option>
              <option value="제조사 반품">제조사 반품</option>
              <option value="기타">기타</option>
            </select>
          </label>
        )}
        <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)" }}>{type === "입고" ? (customerReturn ? "고객" : "매입처") : type === "출고" && reason !== "판매" ? "전달처" : "판매처"}
          <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} style={{ width: 170 }} /></label>
        <label className="sm-row" style={{ gap: 6, fontSize: 15, color: "var(--sm-text-mid)", flex: 1, minWidth: 200 }}>메모
          <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} style={{ flex: 1, minWidth: 160 }} /></label>
      </div>

      <section className="b2b-card">
        <div className="b2b-card-head" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <span className="b2b-card-title">제품 선택</span>
          <label className="sm-row" style={{ gap: 6, fontSize: 12, color: "var(--sm-text-mid)", cursor: "pointer" }}>
            <input type="checkbox" className="b2b-checkbox" checked={excludeBundles} onChange={(e) => setExcludeBundles(e.target.checked)} />
            묶음(세트) 제외
          </label>
        </div>

        {/* 큰 검색창 — 이름·옵션·SKU·초성·여러 단어("광어 100 1kg") */}
        <div style={{ position: "relative", marginBottom: 12 }}>
          <input className="b2b-input" value={search} onChange={(e) => { setSearch(e.target.value); setActive(-1); }} onKeyDown={onSearchKey} autoComplete="off"
            placeholder="품목·SKU 검색" aria-label="제품 검색"
            style={{ fontSize: 15, padding: "13px 16px" }} />
          <div className="b2b-field-hint is-below">이름·옵션·SKU·초성(ㄱㅇ)·여러 단어(광어 100 1kg) · ↓↑ 이동, Enter 추가</div>
          {matches.length > 0 && (
            <div className="inv-buy-suggest" ref={suggestRef}>
              {matches.map((p, i) => (
                <button key={p.id} className={`inv-buy-suggest-item ${i === active ? "is-active" : ""}`} onClick={() => addLine(p)} onMouseEnter={() => setActive(i)}>
                  <span><strong>{p.name}</strong> <span className="sm-faint" style={{ fontSize: 12 }}>{[p.spec, p.origin, p.attrs, p.sku].filter(Boolean).join(" · ")}</span></span>
                  <span className="sm-faint" style={{ fontSize: 12 }}>재고 {p.qty.toLocaleString()}{p.unit}</span>
                </button>
              ))}
            </div>
          )}
          {search.trim() && matches.length === 0 && <div className="inv-buy-suggest"><div className="sm-faint" style={{ padding: "10px 14px", fontSize: 15 }}>일치하는 제품 없음</div></div>}
        </div>

        <div className="b2b-table-wrap">
          <table className="b2b-table inv-buy-table">
            <thead><tr><th>제품</th><th className="num" style={{ width: 100 }}>수량</th><th className="num" style={{ width: 140 }}>단가</th><th className="num" style={{ width: 130 }}>금액</th><th style={{ width: 40 }}></th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><strong>{l.name}</strong>{l.sub && <div className="sm-faint" style={{ fontSize: 12 }}>{l.sub}</div>}</td>
                  <td className="num"><input className="b2b-input" type="number" min={0.01} step={0.01} value={l.qty} onChange={(e) => setLine(l.key, "qty", e.target.value)} style={{ width: 80, textAlign: "right", padding: "6px 8px" }} /></td>
                  <td className="num"><input className="b2b-input" type="number" min={0} value={l.price} onChange={(e) => setLine(l.key, "price", e.target.value)} style={{ width: 120, textAlign: "right", padding: "6px 8px" }} /></td>
                  <td className="num b2b-money" style={{ fontWeight: 700 }}>{amountOf(l).toLocaleString()}</td>
                  <td><button className="b2b-link-btn" onClick={() => removeLine(l.key)} style={{ color: "var(--sm-text-light)" }} aria-label="삭제">✕</button></td>
                </tr>
              ))}
              {lines.length === 0 && <tr><td colSpan={5} className="sm-faint" style={{ padding: "16px 4px" }}>추가한 제품이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="sm-between" style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--sm-border)", flexWrap: "wrap", gap: 12 }}>
          <span className="sm-faint" style={{ fontSize: 15 }}>{totals.items}개 품목 · 총 {totals.qty.toLocaleString()}개</span>
          <span style={{ fontSize: 19, fontWeight: 800 }}>총액 {totals.amount.toLocaleString()}</span>
        </div>
      </section>

      {error && <div className="b2b-error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="sm-between" style={{ marginTop: 16, gap: 10, flexWrap: "wrap" }}>
        <label className="sm-row" style={{ gap: 7, fontSize: 15, cursor: "pointer" }}>
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} /> 즉시 {type === "입고" ? "입고" : "출고"}처리
          <span className="sm-faint" style={{ fontSize: 12 }}>(미래 날짜는 해제해 대기로)</span>
        </label>
        <div className="sm-row" style={{ gap: 10 }}>
          <button className="b2b-btn-secondary" onClick={onCancel} disabled={saving}>그만두기</button>
          <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : (done ? `${type === "입고" ? "구매" : "판매"} 저장` : "대기로 저장")}</button>
        </div>
      </div>
    </>
  );
}
