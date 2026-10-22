"use client";

// 입고·출고·조정 한 번에 여러 품목 — 씨몬스터 입고/출고(PurchaseForm)와 같은 흐름에 제조일자·박스 중량을 더했다.
//  입고: 품목마다 [제조일자 · 박스 중량 · 박스 수] 줄(여러 줄 가능)
//  출고: 품목의 로트(제조일자 × 중량)마다 박스 수 — 오래된 입고부터 보인다
//  조정: 로트마다 실사 박스 수(비우면 그대로) + 새 로트. 서버가 현재 수량과의 차이만 기록한다.
//  새 품목(입고만, 2026-10-20): 검색해서 없으면 '+ 새 품목으로 입고' → 품목명·규격·원산지만 적는다.
//   칸 배치(2026-10-22 대표 지시): 품목 · 규격 · 중량 · 박스 수 / 원산지(선택) · 제조일자(기본 오늘) — 첫 줄의 중량·박스·제조일자는
//   첫 로트 줄(lines[0])의 값이다. 줄을 더하면 아래에 보통 줄로 붙는다.
//   품목은 [입고 저장] 때 /api/factory/products/quick 으로 먼저 등록하고(같은 이름·원산지면 기존 품목) 그 id 로 입고한다.
//   창을 닫으면 아무것도 남지 않는다.

import { useEffect, useMemo, useRef, useState } from "react";
import { matchKoQuery } from "@/app/lib/hangul";
import { useEscClose } from "@/app/lib/use-esc";
import { ORIGINS, boxStr, kgStr, kgNum, lotLabel, type StockRow, type TxnType } from "@/app/lib/factory";
import { today } from "./util";

type Line = { key: string; lot: boolean; mfg_date: string; box_kg: string; qty: string; have: number; in_date: string | null };
// draft = 아직 등록 전인 새 품목(입고 저장 때 등록). product_id 는 그때까지 비어 있다.
type Block = { key: string; product_id: string; lines: Line[]; draft?: { name: string; spec: string; origin: string } };
const normName = (s: string) => s.trim().replace(/\s+/g, " ");

let seq = 0;
const k = () => `k${++seq}`;
const knownKgs = (p: StockRow) => [...new Set(p.lots.slice().sort((a, b) => b.boxes - a.boxes).map((l) => l.box_kg))].slice(0, 4);

function makeLines(p: StockRow, type: TxnType): Line[] {
  if (type === "입고") {
    const kg = knownKgs(p)[0];
    return [{ key: k(), lot: false, mfg_date: today(), box_kg: kg ? String(kg) : "", qty: "", have: 0, in_date: null }];
  }
  const lots = p.lots.filter((l) => (type === "출고" ? l.boxes > 0 : l.boxes !== 0));
  return lots.map((l) => ({ key: k(), lot: true, mfg_date: l.mfg_date || "", box_kg: String(l.box_kg), qty: "", have: l.boxes, in_date: l.in_date }));
}

const TITLE: Record<TxnType, string> = { 입고: "입고", 출고: "출고", 조정: "조정" };
// 입력 번호 — 창을 열 때 한 번 만들고 다시 눌러도 같은 번호(서버가 두 번 기록하지 않는다)
const newBatch = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : undefined);

export default function TxnForm({ rows, initialType, initialProductId, onClose, onSaved }: {
  rows: StockRow[];
  initialType: TxnType;
  initialProductId?: string;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const [type, setType] = useState<TxnType>(initialType);
  const [date, setDate] = useState(today());
  const [batch, setBatch] = useState<string | undefined>(newBatch);
  const [partner, setPartner] = useState("");
  const [memo, setMemo] = useState("");
  const [blocks, setBlocks] = useState<Block[]>(() => {
    const p = initialProductId ? rows.find((r) => r.id === initialProductId) : undefined;
    return p ? [{ key: k(), product_id: p.id, lines: makeLines(p, initialType) }] : [];
  });
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(-1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const suggestRef = useRef<HTMLDivElement>(null);
  useEscClose(onClose, saving);

  function switchType(t: TxnType) {
    if (t === type) return;
    setType(t); setError(""); setBatch(newBatch());
    if (t === "조정") setDate(today()); // 조정은 오늘 실사 기준
    // 새 품목은 입고에서만 — 다른 유형으로 바꾸면 뺀다(재고가 없으니 출고·조정할 게 없다)
    setBlocks((bs) => bs.filter((b) => t === "입고" || !b.draft).map((b) => { const p = byId.get(b.product_id); return p ? { ...b, lines: makeLines(p, t) } : b; }));
  }

  const matches = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    const added = new Set(blocks.map((b) => b.product_id));
    return rows
      .filter((p) => !added.has(p.id))
      .filter((p) => type !== "출고" || p.boxes > 0)
      .filter((p) => matchKoQuery(`${p.name} ${p.spec || ""} ${p.sku} ${p.origin || ""} ${p.note || ""}`, q))
      .slice(0, 12);
  }, [rows, search, blocks, type]);
  useEffect(() => { suggestRef.current?.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" }); }, [active]);

  // 입고에서 검색어가 있으면 '새 품목으로 입고'를 목록 끝에 띄운다 — 같은 이름이라도 규격이 다르면 다른 품목이라
  //  이름 일치로 막지 않는다(서버가 이름+규격+원산지가 같으면 기존 품목을 돌려준다). 이미 추가한 새 품목 이름만 제외.
  const newName = normName(search);
  const canCreate = type === "입고" && !!newName
    && !blocks.some((b) => b.draft && normName(b.draft.name).toLowerCase() === newName.toLowerCase());
  const optCount = matches.length + (canCreate ? 1 : 0);

  function addDraft() {
    if (!canCreate) return;
    setBlocks((bs) => [...bs, {
      key: k(), product_id: "", draft: { name: newName, spec: "", origin: "" },
      lines: [{ key: k(), lot: false, mfg_date: today(), box_kg: "", qty: "", have: 0, in_date: null }],
    }]);
    setSearch(""); setActive(-1); setError("");
  }
  const setDraft = (bk: string, patch: Partial<{ name: string; spec: string; origin: string }>) =>
    setBlocks((bs) => bs.map((b) => (b.key === bk && b.draft ? { ...b, draft: { ...b.draft, ...patch } } : b)));
  const blockName = (b: Block) => (b.draft ? normName(b.draft.name) || "새 품목" : byId.get(b.product_id)?.name || "품목");

  function addProduct(p: StockRow) {
    setBlocks((bs) => [...bs, { key: k(), product_id: p.id, lines: makeLines(p, type) }]);
    setSearch(""); setActive(-1); setError("");
  }
  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!optCount) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, optCount - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      // 활성 줄이 목록 끝(새 품목)이거나, 일치 품목 없이 새 품목만 있으면 새 품목
      if (canCreate && (active === matches.length || (active < 0 && matches.length === 0))) { addDraft(); return; }
      const m = active >= 0 ? matches[active] : matches.length === 1 ? matches[0] : null;
      if (m) addProduct(m);
    }
  }

  const setLine = (bk: string, lk: string, patch: Partial<Line>) =>
    setBlocks((bs) => bs.map((b) => (b.key !== bk ? b : { ...b, lines: b.lines.map((l) => (l.key === lk ? { ...l, ...patch } : l)) })));
  const addLine = (bk: string) =>
    setBlocks((bs) => bs.map((b) => {
      if (b.key !== bk) return b;
      const p = byId.get(b.product_id);
      const kg = p ? knownKgs(p)[0] : undefined;
      return { ...b, lines: [...b.lines, { key: k(), lot: false, mfg_date: today(), box_kg: type === "입고" && kg ? String(kg) : "", qty: "", have: 0, in_date: null }] };
    }));
  const removeLine = (bk: string, lk: string) =>
    setBlocks((bs) => bs.map((b) => (b.key !== bk ? b : { ...b, lines: b.lines.filter((l) => l.key !== lk) })));
  const removeBlock = (bk: string) => setBlocks((bs) => bs.filter((b) => b.key !== bk));

  // 입력된 줄만 — 입고·출고 = 박스 수 있는 줄, 조정 = 실사 수를 적었고 현재와 다른 줄(새 로트는 적으면 포함)
  const filled = useMemo(() => blocks.flatMap((b) => b.lines.filter((l) => {
    if (l.qty.trim() === "") return false;
    if (type === "조정" && l.lot) return Number(l.qty) !== l.have;
    return true;
  }).map((l) => ({ b, l }))), [blocks, type]);

  const totals = useMemo(() => {
    let boxes = 0, kg = 0;
    for (const { l } of filled) {
      const n = Number(l.qty) || 0;
      const d = type === "조정" ? n - (l.lot ? l.have : 0) : n;
      boxes += d; kg += d * (Number(l.box_kg) || 0);
    }
    return { lines: filled.length, boxes, kg: kgNum(kg) };
  }, [filled, type]);

  async function save() {
    setError("");
    if (filled.length === 0) { setError(type === "조정" ? "실사 박스 수를 입력하세요." : "박스 수를 입력하세요."); return; }
    for (const b of blocks) {
      if (b.draft && !normName(b.draft.name)) { setError("새 품목의 품목명을 입력하세요."); return; }
    }
    for (const { b, l } of filled) {
      const name = blockName(b);
      const n = Number(l.qty);
      if (!Number.isInteger(n) || n < (type === "조정" ? 0 : 1)) { setError(`${name}: 박스 수는 ${type === "조정" ? "0" : "1"} 이상 정수로 입력하세요.`); return; }
      if (!(Number(l.box_kg) > 0)) { setError(`${name}: 박스 중량(kg)을 입력하세요.`); return; }
      if (type === "출고" && n > l.have) { setError(`${name} (${lotLabel({ mfg_date: l.mfg_date || null, box_kg: Number(l.box_kg) })}): 재고 ${boxStr(l.have)}보다 많습니다.`); return; }
    }
    // 같은 로트를 두 줄에 적으면(입고 새 줄끼리·조정 새 로트가 기존 로트와 겹침) 합계가 헷갈린다 — 막는다
    const seen = new Set<string>();
    for (const { b, l } of filled) {
      const key = `${b.product_id || b.key}|${l.mfg_date}|${kgNum(Number(l.box_kg))}`;
      if (seen.has(key)) { setError(`${blockName(b)}: 같은 제조일자·중량이 두 줄에 있습니다 — 한 줄로 합치세요.`); return; }
      seen.add(key);
    }
    if (type === "조정") {
      for (const { b, l } of filled) {
        if (l.lot) continue;
        const p = byId.get(b.product_id);
        if (p?.lots.some((x) => (x.mfg_date || "") === l.mfg_date && kgNum(x.box_kg) === kgNum(Number(l.box_kg)) && x.boxes !== 0)) {
          setError(`${p.name}: 이미 있는 로트입니다 — 위 목록에서 실사 수를 적으세요.`); return;
        }
      }
    }
    setSaving(true);
    try {
      // 새 품목 먼저 등록 — 박스 수를 적은 새 품목만. 같은 이름·원산지가 이미 있으면 서버가 기존 품목을 돌려준다(다시 눌러도 한 번만 생김)
      const drafts = [...new Set(filled.filter(({ b }) => b.draft).map(({ b }) => b))];
      const idOf = new Map<string, string>();
      let specWarn = "";
      if (drafts.length) {
        const r = await fetch("/api/factory/products/quick", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: drafts.map((b) => ({ name: b.draft!.name, spec: b.draft!.spec, origin: b.draft!.origin })) }),
        });
        const pj = await r.json().catch(() => ({}));
        if (!r.ok || !pj.ok) throw new Error(pj.error || "새 품목 등록 실패");
        drafts.forEach((b, i) => idOf.set(b.key, pj.products[i].id));
        if (pj.warn) specWarn = ` ${pj.warn}`; // 규격 칸 DB 미적용(factory/006)
      }
      const lines = filled.map(({ b, l }) => ({
        product_id: b.draft ? idOf.get(b.key) : b.product_id, mfg_date: l.mfg_date || null, box_kg: Number(l.box_kg),
        ...(type === "조정" ? { target: Number(l.qty) } : { boxes: Number(l.qty) }),
      }));
      const res = await fetch("/api/factory/txns", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, txn_date: type === "조정" ? today() : date, partner: type === "조정" ? "" : partner, memo, lines, batch_id: batch }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      const created = drafts.length ? ` (새 품목 ${drafts.length}개 포함)` : "";
      onSaved(j.duplicate ? "이미 저장된 입력입니다." : `${type} ${j.count}건을 저장했습니다.${created}${specWarn}`);
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal fac-txn-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{TITLE[type]}</span>
          <button className="b2b-modal-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="b2b-modal-body">
          <div className="sm-tabs fac-txn-types">
            {(["입고", "출고", "조정"] as TxnType[]).map((t) => (
              <button key={t} type="button" className={`sm-tab ${type === t ? "is-active" : ""}`} onClick={() => switchType(t)}>{t}</button>
            ))}
          </div>

          <div className="fac-txn-meta">
            <label className="b2b-field">
              <span className="b2b-field-label">{type}일</span>
              <input className="b2b-input" type="date" value={type === "조정" ? today() : date} max={today()} disabled={type === "조정"} onChange={(e) => setDate(e.target.value)} />
            </label>
            {type !== "조정" && (
              <label className="b2b-field">
                <span className="b2b-field-label">{type === "입고" ? "입고처" : "출고처"}</span>
                <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="선택" />
              </label>
            )}
            <label className="b2b-field fac-txn-memo">
              <span className="b2b-field-label">메모</span>
              <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={type === "조정" ? "조정 사유" : "선택"} />
            </label>
          </div>

          <div className="fac-search-wrap">
            <input className="b2b-input fac-txn-search" value={search} autoComplete="off"
              onChange={(e) => { setSearch(e.target.value); setActive(-1); }} onKeyDown={onSearchKey}
              placeholder={type === "입고" ? "품목 추가 — 이름·SKU·초성 (없으면 새 품목)" : "품목 추가 — 이름·SKU·초성"} />
            {optCount > 0 && (
              <div className="fac-suggest" ref={suggestRef}>
                {matches.map((p, i) => (
                  <button key={p.id} type="button" className={`fac-suggest-item ${i === active ? "is-active" : ""}`} onClick={() => addProduct(p)} onMouseEnter={() => setActive(i)}>
                    <span><strong>{p.name}</strong>{p.spec && <span className="fac-spec"> {p.spec}</span>} <span className="fac-sub">{[p.sku, p.origin].filter(Boolean).join(" · ")}</span></span>
                    <span className="fac-sub">{boxStr(p.boxes)}</span>
                  </button>
                ))}
                {canCreate && (
                  <button type="button" className={`fac-suggest-item fac-suggest-new ${active === matches.length ? "is-active" : ""}`}
                    onClick={addDraft} onMouseEnter={() => setActive(matches.length)}>
                    <span>+ <strong>{newName}</strong> 새 품목으로 입고</span>
                    <span className="fac-sub">저장할 때 등록</span>
                  </button>
                )}
              </div>
            )}
            {search.trim() && optCount === 0 && (
              <div className="fac-suggest"><div className="fac-suggest-none">{type === "출고" ? "재고 있는 품목 중 일치하는 것이 없습니다." : "일치하는 품목이 없습니다."}</div></div>
            )}
          </div>

          {blocks.length === 0 && <div className="b2b-empty">추가한 품목이 없습니다.</div>}

          {blocks.map((b) => {
            const p = byId.get(b.product_id);
            if (!p && !b.draft) return null;
            const kgs = p ? knownKgs(p) : [];
            return (
              <section key={b.key} className={`fac-blk ${b.draft ? "is-new" : ""}`}>
                <div className="fac-blk-head">
                  {b.draft ? (() => {
                    const first = b.lines[0]; // 새 품목의 첫 로트 줄 — 머리에 같이 그린다
                    return (
                      <div className="fac-blk-new">
                        <span className="b2b-status-pill fac-new-pill">새 품목</span>
                        <div className="fac-new-row">
                          <label className="fac-f fac-f-name">
                            <span>품목</span>
                            <input className="b2b-input" value={b.draft.name} onChange={(e) => setDraft(b.key, { name: e.target.value })} />
                          </label>
                          <label className="fac-f fac-f-spec">
                            <span>규격</span>
                            <input className="b2b-input" value={b.draft.spec} placeholder="150/200" onChange={(e) => setDraft(b.key, { spec: e.target.value })} />
                          </label>
                          {first && (
                            <>
                              <label className="fac-f fac-f-kg">
                                <span>중량(kg)</span>
                                <input className="b2b-input" type="number" inputMode="decimal" min={0} step="0.1" value={first.box_kg}
                                  onChange={(e) => setLine(b.key, first.key, { box_kg: e.target.value })} />
                              </label>
                              <label className="fac-f fac-f-qty">
                                <span>박스 수</span>
                                <input className="b2b-input" type="number" inputMode="numeric" min={1} step={1} value={first.qty}
                                  onChange={(e) => setLine(b.key, first.key, { qty: e.target.value })} />
                              </label>
                            </>
                          )}
                        </div>
                        <div className="fac-new-row">
                          <label className="fac-f">
                            <span>원산지</span>
                            <select className="b2b-input" value={b.draft.origin} onChange={(e) => setDraft(b.key, { origin: e.target.value })}>
                              <option value="">선택</option>
                              {ORIGINS.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          </label>
                          {first && (
                            <label className="fac-f">
                              <span>제조일자</span>
                              <input className="b2b-input" type="date" value={first.mfg_date} onChange={(e) => setLine(b.key, first.key, { mfg_date: e.target.value })} />
                            </label>
                          )}
                        </div>
                      </div>
                    );
                  })() : p && (
                    <div className="fac-blk-name">
                      <strong>{p.name}{p.spec && <span className="fac-spec"> {p.spec}</span>}</strong>
                      <span className="fac-sub">{[p.sku, p.origin, `재고 ${boxStr(p.boxes)}`].filter(Boolean).join(" · ")}</span>
                    </div>
                  )}
                  <button type="button" className="b2b-link-btn fac-x" onClick={() => removeBlock(b.key)} aria-label="품목 빼기">✕</button>
                </div>

                {b.lines.length === 0 && type !== "입고" && (
                  <div className="fac-sub fac-blk-empty">{type === "출고" ? "출고할 재고가 없습니다." : "로트가 없습니다."}</div>
                )}

                {b.lines.filter((l, i) => !(b.draft && i === 0)).map((l) => l.lot ? (
                  // 기존 로트 — 출고 박스 수 / 조정 실사 수
                  <div key={l.key} className="fac-line is-lot">
                    <div className="fac-line-lot">
                      <span>{lotLabel({ mfg_date: l.mfg_date || null, box_kg: Number(l.box_kg) })}</span>
                      <span className="fac-sub">{l.in_date ? `입고 ${l.in_date} · ` : ""}재고 {boxStr(l.have)}</span>
                    </div>
                    <div className="fac-line-qty">
                      <input className="b2b-input" type="number" inputMode="numeric" min={0} step={1}
                        max={type === "출고" ? l.have : undefined} value={l.qty}
                        placeholder={type === "조정" ? String(l.have) : "0"}
                        onChange={(e) => setLine(b.key, l.key, { qty: e.target.value })}
                        aria-label={type === "조정" ? "실사 박스 수" : "출고 박스 수"} />
                      <span className="fac-unit">박스</span>
                      {type === "출고" && <button type="button" className="b2b-link-btn" onClick={() => setLine(b.key, l.key, { qty: String(l.have) })}>전량</button>}
                    </div>
                  </div>
                ) : (
                  // 새 줄 — 입고 / 조정 새 로트. 순서 = 중량 · 박스 수 · 제조일자(기본 오늘)
                  <div key={l.key} className="fac-line">
                    <label className="fac-f fac-f-kg">
                      <span>중량(kg)</span>
                      <input className="b2b-input" type="number" inputMode="decimal" min={0} step="0.1" value={l.box_kg}
                        onChange={(e) => setLine(b.key, l.key, { box_kg: e.target.value })} />
                    </label>
                    <label className="fac-f fac-f-qty">
                      <span>{type === "조정" ? "실사 박스" : "박스 수"}</span>
                      <input className="b2b-input" type="number" inputMode="numeric" min={type === "조정" ? 0 : 1} step={1} value={l.qty}
                        onChange={(e) => setLine(b.key, l.key, { qty: e.target.value })} />
                    </label>
                    <label className="fac-f">
                      <span>제조일자</span>
                      <input className="b2b-input" type="date" value={l.mfg_date} onChange={(e) => setLine(b.key, l.key, { mfg_date: e.target.value })} />
                    </label>
                    {(b.draft || b.lines.filter((x) => !x.lot).length > 1 || type === "조정") && (
                      <button type="button" className="b2b-link-btn fac-x" onClick={() => removeLine(b.key, l.key)} aria-label="줄 빼기">✕</button>
                    )}
                    {kgs.length > 0 && (
                      <div className="fac-kg-chips">
                        {kgs.map((kg) => (
                          <button key={kg} type="button" className={`fac-chip ${Number(l.box_kg) === kg ? "is-on" : ""}`}
                            onClick={() => setLine(b.key, l.key, { box_kg: String(kg) })}>{kgStr(kg)}</button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {type !== "출고" && (
                  <button type="button" className="b2b-link-btn fac-add-line" onClick={() => addLine(b.key)}>
                    + {type === "입고" ? "제조일자·중량 추가" : "새 로트"}
                  </button>
                )}
              </section>
            );
          })}

          {error && <div className="b2b-error">{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          <span className="fac-txn-total">
            {totals.lines}줄 · {type === "조정" ? `${totals.boxes > 0 ? "+" : ""}${boxStr(totals.boxes)} · ${totals.kg > 0 ? "+" : ""}${kgStr(totals.kg)}` : `${boxStr(totals.boxes)} · ${kgStr(totals.kg)}`}
          </span>
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>닫기</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving || totals.lines === 0}>{saving ? "저장 중..." : `${type} 저장`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
