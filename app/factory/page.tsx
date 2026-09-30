"use client";

// 파도소리 재고장 — SKU | 품목 | 원산지 | 최신 입고일 | 최고령 입고일 | 총 입고 | 총 출고 | 현재 수량.
//  수량은 박스, 중량은 [제조일자 × 박스 중량] 로트별 박스 수 × 박스 중량. 현재 수량은 기록 합계라 직접 고치지 않는다(조정).
//  PC = 표(행을 누르면 로트가 펼쳐진다), 모바일(≤900px) = 목록 + 하단 입고·출고·조정 버튼.

import { useCallback, useEffect, useMemo, useState } from "react";
import { matchKoQuery } from "@/app/lib/hangul";
import { useEscClose } from "@/app/lib/use-esc";
import { boxStr, kgStr, lotLabel, weightBreakdown, type StockRow, type TxnType } from "@/app/lib/factory";
import TxnForm from "./TxnForm";

type SortKey = "sku" | "name" | "origin" | "last_in_date" | "oldest_in_date" | "in_boxes" | "out_boxes" | "boxes";
const COLS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: "sku", label: "SKU" }, { key: "name", label: "품목" }, { key: "origin", label: "원산지" },
  { key: "last_in_date", label: "최신 입고일" }, { key: "oldest_in_date", label: "최고령 입고일" },
  { key: "in_boxes", label: "총 입고", num: true }, { key: "out_boxes", label: "총 출고", num: true },
  { key: "boxes", label: "현재 수량", num: true },
];
const won = (n: number | null) => (n == null ? "-" : `${n.toLocaleString("ko-KR")}원`);

export default function FactoryStockPage() {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kw, setKw] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<{ type: TxnType; productId?: string } | null>(null);
  const [priceFor, setPriceFor] = useState<StockRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const j = await (await fetch("/api/factory/stock", { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setRows(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => {
    const q = kw.trim();
    const out = rows
      .filter((r) => showEmpty || r.boxes !== 0)
      .filter((r) => !q || matchKoQuery(`${r.name} ${r.sku} ${r.origin || ""} ${r.note || ""}`, q));
    const v = (r: StockRow) => r[sort.key];
    return out.sort((a, b) => {
      const x = v(a), y = v(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" ? x - (y as number) : String(x).localeCompare(String(y), "ko")) * sort.dir;
    });
  }, [rows, kw, showEmpty, sort]);

  const total = useMemo(() => {
    return { boxes: rows.reduce((s, r) => s + r.boxes, 0), kg: rows.reduce((s, r) => s + r.kg, 0) };
  }, [rows]);

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));
  const openForm = (type: TxnType, productId?: string) => { setNotice(""); setForm({ type, productId }); };

  // 로트·가격·버튼 — PC 펼침 행과 모바일 펼침이 같이 쓴다
  const detail = (r: StockRow) => (
    <div className="fac-detail">
      {r.lots.length === 0 ? <div className="fac-sub">기록이 없습니다.</div> : (
        <div className="fac-lots">
          {r.lots.filter((l) => l.boxes !== 0 || open.has(`${r.id}:all`)).map((l) => (
            <div key={`${l.mfg_date}|${l.box_kg}`} className={`fac-lot ${l.boxes === 0 ? "is-zero" : ""}`}>
              <span className="fac-lot-name">{lotLabel(l)}</span>
              <span className="fac-sub">{l.in_date ? `입고 ${l.in_date}` : ""}{l.adj_boxes ? ` · 조정 ${l.adj_boxes > 0 ? "+" : ""}${l.adj_boxes}` : ""}</span>
              <span className="fac-lot-qty">{boxStr(l.boxes)}<small>{kgStr(l.boxes * l.box_kg)}</small></span>
            </div>
          ))}
          {r.lots.some((l) => l.boxes === 0) && (
            <button type="button" className="b2b-link-btn fac-lot-more" onClick={() => toggle(`${r.id}:all`)}>
              {open.has(`${r.id}:all`) ? "소진 로트 접기" : `소진 로트 ${r.lots.filter((l) => l.boxes === 0).length}개 보기`}
            </button>
          )}
        </div>
      )}
      <div className="fac-detail-foot">
        <span className="fac-sub">
          원가 {won(r.cost)} · 판매가 {won(r.price)}{r.note ? ` · ${r.note}` : ""}
        </span>
        <div className="fac-detail-btns">
          <button type="button" className="b2b-btn-secondary" onClick={() => openForm("입고", r.id)}>입고</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => openForm("출고", r.id)} disabled={r.boxes <= 0}>출고</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => openForm("조정", r.id)}>조정</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => setPriceFor(r)}>가격 수정</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="b2b-container fac-stock">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고</h1>
          <p className="b2b-page-subtitle">총 {boxStr(total.boxes)} · {kgStr(total.kg)}</p>
        </div>
        <div className="b2b-page-actions fac-head-actions">
          <button className="b2b-btn-primary" onClick={() => openForm("입고")}>입고</button>
          <button className="b2b-btn-secondary" onClick={() => openForm("출고")}>출고</button>
          <button className="b2b-btn-secondary" onClick={() => openForm("조정")}>조정</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {notice && <div className="sm-success">{notice}</div>}

      <div className="fac-toolbar">
        <input className="b2b-input fac-search" value={kw} onChange={(e) => setKw(e.target.value)} placeholder="품목·SKU·원산지 검색 (초성 가능)" />
        <label className="fac-check">
          <input type="checkbox" className="b2b-checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
          재고 없는 품목 포함
        </label>
      </div>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : list.length === 0 ? (
        <div className="b2b-empty">{rows.length === 0 ? "등록된 품목이 없습니다." : "조건에 맞는 품목이 없습니다."}</div>
      ) : (
        <>
          {/* PC 표 */}
          <div className="b2b-table-wrap fac-stock-table">
            <table className="b2b-table">
              <thead><tr>
                {COLS.map((c) => (
                  <th key={c.key} className={`fac-th-sort ${c.num ? "num" : ""}`} onClick={() => sortBy(c.key)}>
                    {c.label}{sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {list.map((r) => (
                  <FragmentRow key={r.id} r={r} opened={open.has(r.id)} onToggle={() => toggle(r.id)} detail={detail} />
                ))}
              </tbody>
            </table>
          </div>

          {/* 모바일 목록 */}
          <div className="fac-list">
            {list.map((r) => (
              <div key={r.id} className={`fac-item ${open.has(r.id) ? "is-open" : ""}`}>
                <div className="fac-item-row" onClick={() => toggle(r.id)}>
                  <div className="fac-item-main">
                    <div className="fac-item-name">{r.name}</div>
                    <div className="fac-item-sub">{[r.sku, r.origin].filter(Boolean).join(" · ")}</div>
                    {r.boxes !== 0 && <div className="fac-item-weights">{weightBreakdown(r.lots)}</div>}
                  </div>
                  <div className={`fac-item-qty ${r.boxes === 0 ? "is-zero" : ""}`}>
                    {r.boxes.toLocaleString()}<small>박스</small>
                  </div>
                </div>
                {open.has(r.id) && (
                  <div className="fac-item-more">
                    <div className="fac-item-facts">
                      <span>최신 입고 <b>{r.last_in_date || "-"}</b></span>
                      <span>최고령 입고 <b>{r.oldest_in_date || "-"}</b></span>
                      <span>총 입고 <b>{boxStr(r.in_boxes)}</b></span>
                      <span>총 출고 <b>{boxStr(r.out_boxes)}</b></span>
                    </div>
                    {detail(r)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* 모바일 하단 고정 버튼 */}
      <div className="fac-actbar">
        <button className="b2b-btn-primary" onClick={() => openForm("입고")}>입고</button>
        <button className="b2b-btn-secondary" onClick={() => openForm("출고")}>출고</button>
        <button className="b2b-btn-secondary" onClick={() => openForm("조정")}>조정</button>
      </div>

      {form && (
        <TxnForm rows={rows} initialType={form.type} initialProductId={form.productId}
          onClose={() => setForm(null)}
          onSaved={(msg) => { setForm(null); setNotice(msg); load(); }} />
      )}
      {priceFor && (
        <PriceModal product={priceFor} onClose={() => setPriceFor(null)}
          onSaved={() => { setPriceFor(null); setNotice("가격을 바꿨습니다."); load(); }} />
      )}
    </div>
  );
}

function FragmentRow({ r, opened, onToggle, detail }: { r: StockRow; opened: boolean; onToggle: () => void; detail: (r: StockRow) => React.ReactNode }) {
  return (
    <>
      <tr className={`fac-row ${opened ? "is-open" : ""}`} onClick={onToggle}>
        <td className="fac-sku">{r.sku}</td>
        <td><strong>{r.name}</strong></td>
        <td>{r.origin || "-"}</td>
        <td className="sm-nowrap">{r.last_in_date || "-"}</td>
        <td className="sm-nowrap">{r.oldest_in_date || "-"}</td>
        <td className="num">{boxStr(r.in_boxes)}<div className="fac-sub">{kgStr(r.in_kg)}</div></td>
        <td className="num">{boxStr(r.out_boxes)}<div className="fac-sub">{kgStr(r.out_kg)}</div></td>
        <td className="num">
          <strong className={r.boxes === 0 ? "fac-zero" : ""}>{boxStr(r.boxes)}</strong>
          {r.boxes !== 0 && <div className="fac-sub">{weightBreakdown(r.lots)}</div>}
        </td>
      </tr>
      {opened && (
        <tr className="fac-row-detail"><td colSpan={8}>{detail(r)}</td></tr>
      )}
    </>
  );
}

// 제품원가·판매가 — 모든 계정이 바꿀 수 있고 히스토리에 남는다
function PriceModal({ product, onClose, onSaved }: { product: StockRow; onClose: () => void; onSaved: () => void }) {
  const [cost, setCost] = useState(product.cost == null ? "" : String(product.cost));
  const [price, setPrice] = useState(product.price == null ? "" : String(product.price));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEscClose(onClose, saving);
  async function save() {
    setSaving(true); setError("");
    try {
      const res = await fetch(`/api/factory/products/${product.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cost, price }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }
  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">가격 수정 · {product.name}</span>
          <button className="b2b-modal-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="b2b-modal-body">
          <label className="b2b-field">
            <span className="b2b-field-label">제품원가(원)</span>
            <input className="b2b-input" type="number" inputMode="numeric" min={0} value={cost} onChange={(e) => setCost(e.target.value)} />
          </label>
          <label className="b2b-field">
            <span className="b2b-field-label">판매가(원)</span>
            <input className="b2b-input" type="number" inputMode="numeric" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <div className="fac-sub">변경 내용은 히스토리에 남습니다.</div>
          {error && <div className="b2b-error">{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving}>닫기</button>
            <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : "저장"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
