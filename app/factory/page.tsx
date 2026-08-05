"use client";

// 파도소리 재고 — 로트 단위 원장(주간 재고장 엑셀의 한 행 = 로트 1개).
//  현재수량은 저장하지 않고 거래 합계로 나온다 → 주 단위 파일 이월이 없다.
//  히스토리·생산요청은 별도 메뉴(app/factory/history·requests).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  OUT_TYPES, TAPE_COLORS, ORIGINS, SITE_DEST, lotLabel, toKg,
  type LotStock, type TxnType, type Warehouse,
} from "@/app/lib/factory";
import { today, n0 } from "./util";

type Suggest = { item_names: string[]; specs: string[]; suppliers: string[]; notes: string[]; dests: string[] };

export default function FactoryStockPage() {
  const [error, setError] = useState("");
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [suggest, setSuggest] = useState<Suggest>({ item_names: [], specs: [], suppliers: [], notes: [], dests: [] });

  const [lots, setLots] = useState<LotStock[]>([]);
  const [wh, setWh] = useState("");          // "" 전체 · "own" 내부 · "ext" 외부 · warehouse_id
  const [kw, setKw] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [loading, setLoading] = useState(true);

  const [lotForm, setLotForm] = useState<LotStock | "new" | null>(null);
  const [txnFor, setTxnFor] = useState<LotStock | null>(null);
  const [moveFor, setMoveFor] = useState<LotStock | null>(null);

  const loadLots = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = new URLSearchParams();
      if (wh === "own") p.set("own", "1");
      else if (wh === "ext") p.set("own", "0");
      else if (wh) p.set("warehouse_id", wh);
      if (kw.trim()) p.set("q", kw.trim());
      if (showEmpty) p.set("empty", "1");
      const j = await (await fetch(`/api/factory/lots?${p}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setLots(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [wh, kw, showEmpty]);
  useEffect(() => { loadLots(); }, [loadLots]);

  useEffect(() => {
    fetch("/api/factory/warehouses", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.ok) setWarehouses(j.rows || []); }).catch(() => {});
    fetch("/api/factory/suggest", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.ok) setSuggest(j); }).catch(() => {});
  }, []);

  const totals = useMemo(() => {
    const boxes = lots.reduce((s, l) => s + n0(l.qty), 0);
    const kg = lots.reduce((s, l) => s + (toKg(n0(l.qty), l.box_kg) ?? 0), 0);
    return { boxes, kg };
  }, [lots]);

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">재고</h1></div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-primary" onClick={() => setLotForm("new")}>입고 등록</button>
        </div>
      </header>

      {error && (
        <div className="b2b-error">
          {error}
          {/schema|relation|lot_stock|factory/i.test(error)
            ? " — supabase/migrations/factory/001_factory_init.sql 적용과 Exposed schemas 에 factory 추가가 필요합니다."
            : ""}
        </div>
      )}

      <div className="sm-tabbar">
        <button className={`sm-tab ${wh === "" ? "is-active" : ""}`} onClick={() => setWh("")}>전체</button>
        <button className={`sm-tab ${wh === "own" ? "is-active" : ""}`} onClick={() => setWh("own")}>구평(내부)</button>
        <button className={`sm-tab ${wh === "ext" ? "is-active" : ""}`} onClick={() => setWh("ext")}>외부창고</button>
        {warehouses.filter((w) => !w.is_own).map((w) => (
          <button key={w.id} className={`sm-tab ${wh === w.id ? "is-active" : ""}`} onClick={() => setWh(w.id)}>{w.name}</button>
        ))}
        <input className="b2b-input sm-tab-search" placeholder="품명·규격·매입처 검색" value={kw}
          onChange={(e) => setKw(e.target.value)} />
      </div>

      <div className="sm-row sm-gap-3" style={{ margin: "8px 0", alignItems: "center" }}>
        <label className="b2b-checkbox">
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
          소진 로트 포함
        </label>
        <span className="sm-faint">{lots.length}로트 · {totals.boxes.toLocaleString()}박스{totals.kg > 0 ? ` · ${Math.round(totals.kg).toLocaleString()}kg` : ""}</span>
      </div>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : lots.length === 0 ? (
        <div className="b2b-empty">재고가 없습니다.</div>
      ) : (
        <div className="b2b-table-wrap">
          <table className="b2b-table">
            <thead><tr>
              <th>품명</th><th>규격</th><th>테잎색</th><th>원산지</th><th>창고</th>
              <th className="num">최초입고</th><th className="num">중량</th><th className="num">현재수량</th>
              <th>최초입고일</th><th></th>
            </tr></thead>
            <tbody>
              {lots.map((l) => (
                <tr key={l.id}>
                  <td data-label="품명"><strong>{l.item_name}</strong>{l.supplier ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{l.supplier}</span> : null}</td>
                  <td data-label="규격" className="sm-faint">{l.spec || "-"}</td>
                  <td data-label="테잎색">{l.tape_color || "-"}</td>
                  <td data-label="원산지">{l.origin || "-"}</td>
                  <td data-label="창고">{l.warehouse}</td>
                  <td data-label="최초입고" className="num b2b-money sm-faint">{n0(l.first_qty).toLocaleString()}</td>
                  <td data-label="중량" className="num b2b-money sm-faint">{l.box_kg ? `${l.box_kg}kg` : "-"}</td>
                  <td data-label="현재수량" className="num b2b-money" style={{ fontWeight: 700 }}>
                    {n0(l.qty).toLocaleString()}{l.unit}
                  </td>
                  <td data-label="최초입고일" style={{ whiteSpace: "nowrap" }}>{(l.first_in_date || "").slice(0, 10) || "-"}</td>
                  <td>
                    <button className="b2b-link-btn" onClick={() => setTxnFor(l)}>출고</button>
                    <button className="b2b-link-btn" onClick={() => setMoveFor(l)}>이동</button>
                    <button className="b2b-link-btn" onClick={() => setLotForm(l)}>수정</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lotForm && (
        <LotModal lot={lotForm === "new" ? null : lotForm} warehouses={warehouses}
          onClose={() => setLotForm(null)} onDone={() => { setLotForm(null); loadLots(); }} onError={setError} />
      )}
      {txnFor && (
        <TxnModal lot={txnFor}
          onClose={() => setTxnFor(null)} onDone={() => { setTxnFor(null); loadLots(); }} onError={setError} />
      )}
      {moveFor && (
        <MoveModal lot={moveFor} warehouses={warehouses}
          onClose={() => setMoveFor(null)} onDone={() => { setMoveFor(null); loadLots(); }} onError={setError} />
      )}

      <datalist id="fac-items">{suggest.item_names.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="fac-specs">{suggest.specs.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="fac-suppliers">{suggest.suppliers.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="fac-notes">{suggest.notes.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="fac-dests">{suggest.dests.map((v) => <option key={v} value={v} />)}</datalist>
    </div>
  );
}

// ── 입고 등록 / 로트 수정 ───────────────────────────────────────────
function LotModal({ lot, warehouses, onClose, onDone, onError }: {
  lot: LotStock | null; warehouses: Warehouse[];
  onClose: () => void; onDone: () => void; onError: (m: string) => void;
}) {
  const editing = !!lot;
  const [f, setF] = useState({
    warehouse_id: lot?.warehouse_id || warehouses.find((w) => w.is_own)?.id || "",
    item_name: lot?.item_name || "",
    spec: lot?.spec || "",
    tape_color: lot?.tape_color || "",
    origin: lot?.origin || "",
    note: lot?.note || "",
    supplier: lot?.supplier || "",
    box_kg: lot?.box_kg === null || lot?.box_kg === undefined ? "" : String(lot.box_kg),
    first_in_date: (lot?.first_in_date || today()).slice(0, 10),
    prod_date: (lot?.prod_date || "").slice(0, 10),
    memo: lot?.memo || "",
    qty: "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    setSaving(true);
    const body: Record<string, unknown> = { ...f, box_kg: f.box_kg === "" ? null : Number(f.box_kg) };
    if (editing) delete body.qty; else body.qty = Number(f.qty);
    const url = editing ? `/api/factory/lots/${lot!.id}` : "/api/factory/lots";
    const j = await (await fetch(url, {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json();
    setSaving(false);
    if (!j.ok) onError(j.error || "저장 실패"); else onDone();
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">{editing ? "로트 수정" : "입고 등록"}</span>
          <button className="b2b-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="b2b-modal-body">
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">창고</span>
              <select className="b2b-input" value={f.warehouse_id} onChange={(e) => set("warehouse_id", e.target.value)}>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select></label>
            <label className="b2b-field"><span className="b2b-field-label">품명</span>
              <input className="b2b-input" list="fac-items" value={f.item_name} onChange={(e) => set("item_name", e.target.value)} /></label>
            <label className="b2b-field"><span className="b2b-field-label">규격</span>
              <input className="b2b-input" list="fac-specs" value={f.spec} onChange={(e) => set("spec", e.target.value)} /></label>
          </div>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">테잎색</span>
              <select className="b2b-input" value={f.tape_color} onChange={(e) => set("tape_color", e.target.value)}>
                <option value="">-</option>
                {TAPE_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select></label>
            <label className="b2b-field"><span className="b2b-field-label">원산지</span>
              <select className="b2b-input" value={f.origin} onChange={(e) => set("origin", e.target.value)}>
                <option value="">-</option>
                {ORIGINS.map((c) => <option key={c} value={c}>{c}</option>)}
                {f.origin && !ORIGINS.includes(f.origin as (typeof ORIGINS)[number]) && <option value={f.origin}>{f.origin}</option>}
              </select></label>
            <label className="b2b-field"><span className="b2b-field-label">매입처</span>
              <input className="b2b-input" list="fac-suppliers" value={f.supplier} onChange={(e) => set("supplier", e.target.value)} /></label>
            <label className="b2b-field"><span className="b2b-field-label">박스중량(kg)</span>
              <input type="number" step="any" className="b2b-input" value={f.box_kg} onChange={(e) => set("box_kg", e.target.value)} /></label>
          </div>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">적요</span>
              <input className="b2b-input" list="fac-notes" value={f.note} onChange={(e) => set("note", e.target.value)} /></label>
            <label className="b2b-field"><span className="b2b-field-label">최초입고일</span>
              <input type="date" className="b2b-input" value={f.first_in_date} onChange={(e) => set("first_in_date", e.target.value)} /></label>
            <label className="b2b-field"><span className="b2b-field-label">생산일</span>
              <input type="date" className="b2b-input" value={f.prod_date} onChange={(e) => set("prod_date", e.target.value)} /></label>
            {!editing && (
              <label className="b2b-field"><span className="b2b-field-label">입고수량(박스)</span>
                <input type="number" step="any" className="b2b-input" value={f.qty} onChange={(e) => set("qty", e.target.value)} /></label>
            )}
          </div>
          <div className="b2b-field-row">
            <label className="b2b-field" style={{ flex: 1 }}><span className="b2b-field-label">메모</span>
              <input className="b2b-input" value={f.memo} onChange={(e) => set("memo", e.target.value)} /></label>
          </div>
          {editing && <p className="sm-faint" style={{ fontSize: 12 }}>수량은 여기서 바꾸지 않습니다 — 출고·조정으로 움직입니다.</p>}
        </div>
        <div className="b2b-modal-foot b2b-modal-foot-right">
          <button className="b2b-btn-secondary" onClick={onClose}>닫기</button>
          <button className="b2b-btn-primary" onClick={save} disabled={saving}>{editing ? "수정" : "등록"}</button>
        </div>
      </div>
    </div>
  );
}

// ── 출고 / 생산투입 / 조정 ──────────────────────────────────────────
function TxnModal({ lot, onClose, onDone, onError }: {
  lot: LotStock; onClose: () => void; onDone: () => void; onError: (m: string) => void;
}) {
  const [type, setType] = useState<TxnType>("출고");
  const [qty, setQty] = useState("");
  const [dest, setDest] = useState("");
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const j = await (await fetch("/api/factory/txns", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lot_id: lot.id, type, qty: Number(qty), dest, txn_date: date, memo }),
    })).json();
    setSaving(false);
    if (!j.ok) onError(j.error || "저장 실패"); else onDone();
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">출고 · 생산투입</span>
          <button className="b2b-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="b2b-modal-body">
          <p style={{ marginBottom: 12 }}>
            <strong>{lotLabel(lot)}</strong>
            <span className="sm-faint" style={{ marginLeft: 8 }}>{lot.warehouse} · 현재 {n0(lot.qty).toLocaleString()}{lot.unit}</span>
          </p>
          <div className="sm-tabs" style={{ marginBottom: 12 }}>
            {OUT_TYPES.map((t) => (
              <button key={t} className={`sm-tab ${type === t ? "is-active" : ""}`} onClick={() => setType(t)}>{t}</button>
            ))}
          </div>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">날짜</span>
              <input type="date" className="b2b-input" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="b2b-field">
              <span className="b2b-field-label">{type === "조정" ? "조정수량(±)" : "수량(박스)"}</span>
              <input type="number" step="any" className="b2b-input" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            {type === "출고" && (
              <label className="b2b-field"><span className="b2b-field-label">행선지</span>
                <input className="b2b-input" list="fac-dests" value={dest} onChange={(e) => setDest(e.target.value)} /></label>
            )}
          </div>
          {type === "생산투입" && <p className="sm-faint" style={{ fontSize: 12 }}>행선지는 {SITE_DEST}으로 기록됩니다.</p>}
          {type === "조정" && <p className="sm-faint" style={{ fontSize: 12 }}>실물과 장부가 다를 때만 씁니다. 줄이려면 음수로 넣습니다.</p>}
          <div className="b2b-field-row">
            <label className="b2b-field" style={{ flex: 1 }}><span className="b2b-field-label">메모</span>
              <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
          </div>
        </div>
        <div className="b2b-modal-foot b2b-modal-foot-right">
          <button className="b2b-btn-secondary" onClick={onClose}>닫기</button>
          <button className="b2b-btn-primary" onClick={save} disabled={saving}>기록</button>
        </div>
      </div>
    </div>
  );
}

// ── 창고 이동 ───────────────────────────────────────────────────────
function MoveModal({ lot, warehouses, onClose, onDone, onError }: {
  lot: LotStock; warehouses: Warehouse[]; onClose: () => void; onDone: () => void; onError: (m: string) => void;
}) {
  const targets = warehouses.filter((w) => w.id !== lot.warehouse_id);
  const [toId, setToId] = useState(targets.find((w) => w.is_own)?.id || targets[0]?.id || "");
  const [qty, setQty] = useState("");
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const j = await (await fetch("/api/factory/move", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lot_id: lot.id, to_warehouse_id: toId, qty: Number(qty), txn_date: date, memo }),
    })).json();
    setSaving(false);
    if (!j.ok) onError(j.error || "이동 실패"); else onDone();
  }

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">창고 이동</span>
          <button className="b2b-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="b2b-modal-body">
          <p style={{ marginBottom: 12 }}>
            <strong>{lotLabel(lot)}</strong>
            <span className="sm-faint" style={{ marginLeft: 8 }}>{lot.warehouse} · 현재 {n0(lot.qty).toLocaleString()}{lot.unit}</span>
          </p>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">받을 창고</span>
              <select className="b2b-input" value={toId} onChange={(e) => setToId(e.target.value)}>
                {targets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select></label>
            <label className="b2b-field"><span className="b2b-field-label">날짜</span>
              <input type="date" className="b2b-input" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="b2b-field"><span className="b2b-field-label">수량(박스)</span>
              <input type="number" step="any" className="b2b-input" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
          </div>
          <div className="b2b-field-row">
            <label className="b2b-field" style={{ flex: 1 }}><span className="b2b-field-label">메모</span>
              <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
          </div>
          <p className="sm-faint" style={{ fontSize: 12 }}>보내는 창고에서 줄고 받는 창고에서 늘어납니다. 전체 재고 총량은 변하지 않습니다.</p>
        </div>
        <div className="b2b-modal-foot b2b-modal-foot-right">
          <button className="b2b-btn-secondary" onClick={onClose}>닫기</button>
          <button className="b2b-btn-primary" onClick={save} disabled={saving}>이동</button>
        </div>
      </div>
    </div>
  );
}
