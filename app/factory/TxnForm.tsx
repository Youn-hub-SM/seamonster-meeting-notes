"use client";

// 입고·출고·조정 한 번에 여러 품목 — 씨몬스터 입고/출고(PurchaseForm)와 같은 흐름에 제조일자·박스 중량을 더했다.
//  입고: 품목마다 [제조일자 · 박스 중량 · 박스 수] 줄(여러 줄 가능)
//  출고: 품목의 로트(제조일자 × 중량)마다 박스 수 — 오래된 입고부터 보인다
//  조정: 로트마다 실사 박스 수(비우면 그대로) + 새 로트. 서버가 현재 수량과의 차이만 기록한다.

import { useEffect, useMemo, useRef, useState } from "react";
import { matchKoQuery } from "@/app/lib/hangul";
import { useEscClose } from "@/app/lib/use-esc";
import { boxStr, kgStr, kgNum, lotLabel, type StockRow, type TxnType } from "@/app/lib/factory";
import { today } from "./util";

type Line = { key: string; lot: boolean; mfg_date: string; box_kg: string; qty: string; have: number; in_date: string | null };
type Block = { key: string; product_id: string; lines: Line[] };

let seq = 0;
const k = () => `k${++seq}`;
const knownKgs = (p: StockRow) => [...new Set(p.lots.slice().sort((a, b) => b.boxes - a.boxes).map((l) => l.box_kg))].slice(0, 4);

function makeLines(p: StockRow, type: TxnType): Line[] {
  if (type === "입고") {
    const kg = knownKgs(p)[0];
    return [{ key: k(), lot: false, mfg_date: "", box_kg: kg ? String(kg) : "", qty: "", have: 0, in_date: null }];
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
    setBlocks((bs) => bs.map((b) => { const p = byId.get(b.product_id); return p ? { ...b, lines: makeLines(p, t) } : b; }));
  }

  const matches = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    const added = new Set(blocks.map((b) => b.product_id));
    return rows
      .filter((p) => !added.has(p.id))
      .filter((p) => type !== "출고" || p.boxes > 0)
      .filter((p) => matchKoQuery(`${p.name} ${p.sku} ${p.origin || ""} ${p.note || ""}`, q))
      .slice(0, 12);
  }, [rows, search, blocks, type]);
  useEffect(() => { suggestRef.current?.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" }); }, [active]);

  function addProduct(p: StockRow) {
    setBlocks((bs) => [...bs, { key: k(), product_id: p.id, lines: makeLines(p, type) }]);
    setSearch(""); setActive(-1); setError("");
  }
  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!matches.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const m = active >= 0 ? matches[active] : matches.length === 1 ? matches[0] : null; if (m) addProduct(m); }
  }

  const setLine = (bk: string, lk: string, patch: Partial<Line>) =>
    setBlocks((bs) => bs.map((b) => (b.key !== bk ? b : { ...b, lines: b.lines.map((l) => (l.key === lk ? { ...l, ...patch } : l)) })));
  const addLine = (bk: string) =>
    setBlocks((bs) => bs.map((b) => {
      if (b.key !== bk) return b;
      const p = byId.get(b.product_id);
      const kg = p ? knownKgs(p)[0] : undefined;
      return { ...b, lines: [...b.lines, { key: k(), lot: false, mfg_date: "", box_kg: type === "입고" && kg ? String(kg) : "", qty: "", have: 0, in_date: null }] };
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
    for (const { b, l } of filled) {
      const name = byId.get(b.product_id)?.name || "품목";
      const n = Number(l.qty);
      if (!Number.isInteger(n) || n < (type === "조정" ? 0 : 1)) { setError(`${name}: 박스 수는 ${type === "조정" ? "0" : "1"} 이상 정수로 입력하세요.`); return; }
      if (!(Number(l.box_kg) > 0)) { setError(`${name}: 박스 중량(kg)을 입력하세요.`); return; }
      if (type === "출고" && n > l.have) { setError(`${name} (${lotLabel({ mfg_date: l.mfg_date || null, box_kg: Number(l.box_kg) })}): 재고 ${boxStr(l.have)}보다 많습니다.`); return; }
    }
    // 같은 로트를 두 줄에 적으면(입고 새 줄끼리·조정 새 로트가 기존 로트와 겹침) 합계가 헷갈린다 — 막는다
    const seen = new Set<string>();
    for (const { b, l } of filled) {
      const key = `${b.product_id}|${l.mfg_date}|${kgNum(Number(l.box_kg))}`;
      if (seen.has(key)) { setError(`${byId.get(b.product_id)?.name || "품목"}: 같은 제조일자·중량이 두 줄에 있습니다 — 한 줄로 합치세요.`); return; }
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
      const lines = filled.map(({ b, l }) => ({
        product_id: b.product_id, mfg_date: l.mfg_date || null, box_kg: Number(l.box_kg),
        ...(type === "조정" ? { target: Number(l.qty) } : { boxes: Number(l.qty) }),
      }));
      const res = await fetch("/api/factory/txns", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, txn_date: type === "조정" ? today() : date, partner: type === "조정" ? "" : partner, memo, lines, batch_id: batch }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      onSaved(j.duplicate ? "이미 저장된 입력입니다." : `${type} ${j.count}건을 저장했습니다.`);
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
              placeholder="품목 추가 — 이름·SKU·초성" />
            {matches.length > 0 && (
              <div className="fac-suggest" ref={suggestRef}>
                {matches.map((p, i) => (
                  <button key={p.id} type="button" className={`fac-suggest-item ${i === active ? "is-active" : ""}`} onClick={() => addProduct(p)} onMouseEnter={() => setActive(i)}>
                    <span><strong>{p.name}</strong> <span className="fac-sub">{[p.sku, p.origin].filter(Boolean).join(" · ")}</span></span>
                    <span className="fac-sub">{boxStr(p.boxes)}</span>
                  </button>
                ))}
              </div>
            )}
            {search.trim() && matches.length === 0 && (
              <div className="fac-suggest"><div className="fac-suggest-none">{type === "출고" ? "재고 있는 품목 중 일치하는 것이 없습니다." : "일치하는 품목이 없습니다."}</div></div>
            )}
          </div>

          {blocks.length === 0 && <div className="b2b-empty">추가한 품목이 없습니다.</div>}

          {blocks.map((b) => {
            const p = byId.get(b.product_id);
            if (!p) return null;
            const kgs = knownKgs(p);
            return (
              <section key={b.key} className="fac-blk">
                <div className="fac-blk-head">
                  <div className="fac-blk-name">
                    <strong>{p.name}</strong>
                    <span className="fac-sub">{[p.sku, p.origin, `재고 ${boxStr(p.boxes)}`].filter(Boolean).join(" · ")}</span>
                  </div>
                  <button type="button" className="b2b-link-btn fac-x" onClick={() => removeBlock(b.key)} aria-label="품목 빼기">✕</button>
                </div>

                {b.lines.length === 0 && type !== "입고" && (
                  <div className="fac-sub fac-blk-empty">{type === "출고" ? "출고할 재고가 없습니다." : "로트가 없습니다."}</div>
                )}

                {b.lines.map((l) => l.lot ? (
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
                  // 새 줄 — 입고 / 조정 새 로트
                  <div key={l.key} className="fac-line">
                    <label className="fac-f">
                      <span>제조일자</span>
                      <input className="b2b-input" type="date" value={l.mfg_date} onChange={(e) => setLine(b.key, l.key, { mfg_date: e.target.value })} />
                    </label>
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
                    {(b.lines.filter((x) => !x.lot).length > 1 || type === "조정") && (
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
