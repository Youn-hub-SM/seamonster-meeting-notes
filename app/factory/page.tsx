"use client";

// 파도소리 재고 — 로트 단위 원장(주간 재고장 엑셀의 한 행 = 로트 1개).
//  현재수량은 저장하지 않고 거래 합계로 나온다 → 주 단위 파일 이월이 없다.
//  히스토리·생산요청은 별도 메뉴(app/factory/history·requests).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  OUT_TYPES, TAPE_COLORS, ORIGINS, SITE_DEST, lotLabel, toKg,
  type LotStock, type TxnType, type Warehouse,
} from "@/app/lib/factory";
import { matchKoQuery } from "@/app/lib/hangul";
import { today, daysAgo, n0 } from "./util";

type Suggest = { item_names: string[]; specs: string[]; suppliers: string[]; notes: string[]; dests: string[] };

// 씨몬스터 재고 목록(/inventory)과 같은 구성 — 통계카드 → 필터줄(창고탭·기간탭·날짜지정 | 검색) → 정렬 표.
const PERIODS = [["7일", 7], ["14일", 14], ["30일", 30], ["지정", 0]] as const;
type PMode = (typeof PERIODS)[number][0];

type SortKey = "item_name" | "warehouse" | "qty" | "box_kg" | "period_in" | "period_out" | "first_in_date";

export default function FactoryStockPage() {
  const [error, setError] = useState("");
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [suggest, setSuggest] = useState<Suggest>({ item_names: [], specs: [], suppliers: [], notes: [], dests: [] });

  const [lots, setLots] = useState<LotStock[]>([]);
  const [whSel, setWhSel] = useState<Set<string>>(new Set()); // 체크된 창고 id — 비어 있으면 전체
  const [whOpen, setWhOpen] = useState(false);
  const [kw, setKw] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pmode, setPmode] = useState<PMode>("7일");
  const [cfrom, setCfrom] = useState(daysAgo(6));
  const [cto, setCto] = useState(today());
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "item_name", dir: "asc" });

  const [lotForm, setLotForm] = useState<LotStock | "new" | null>(null);
  const [txnFor, setTxnFor] = useState<LotStock | null>(null);
  const [moveFor, setMoveFor] = useState<LotStock | null>(null);
  const [openLot, setOpenLot] = useState<string | null>(null); // 모바일 목록에서 펼친 줄

  const range = useMemo(() => {
    if (pmode === "지정") return { from: cfrom, to: cto };
    const days = (PERIODS.find((p) => p[0] === pmode)?.[1] as number) || 7;
    return { from: daysAgo(days - 1), to: today() };
  }, [pmode, cfrom, cto]);

  // 서버 조회는 기간·소진 여부가 바뀔 때만. 창고 탭·검색은 클라이언트 필터(315로트 수준 — 왕복 없음).
  const loadLots = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (showEmpty) p.set("empty", "1");
      const j = await (await fetch(`/api/factory/lots?${p}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setLots(j.rows || []);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [showEmpty, range.from, range.to]);
  useEffect(() => { loadLots(); }, [loadLots]);

  useEffect(() => {
    fetch("/api/factory/warehouses", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.ok) setWarehouses(j.rows || []); }).catch(() => {});
    fetch("/api/factory/suggest", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.ok) setSuggest(j); }).catch(() => {});
  }, []);

  const shown = useMemo(() => {
    const q = kw.trim();
    const f = lots.filter((l) => {
      if (whSel.size > 0 && !whSel.has(l.warehouse_id)) return false;
      // 초성·다단어 검색(재고 목록과 동일한 matchKoQuery) — "ㄱㅇㄹ 국" → 가오리+국산
      if (q && !matchKoQuery(`${l.item_name} ${l.spec || ""} ${l.supplier || ""} ${l.note || ""} ${l.origin || ""} ${l.warehouse}`, q)) return false;
      return true;
    });
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    const val = (l: LotStock): string | number => {
      switch (key) {
        case "item_name": return l.item_name;
        case "warehouse": return l.warehouse;
        case "first_in_date": return l.first_in_date || "";
        case "box_kg": return l.box_kg ?? -1;
        case "period_in": return n0(l.period_in);
        case "period_out": return n0(l.period_out);
        default: return n0(l.qty);
      }
    };
    return [...f].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === "string" || typeof vb === "string") {
        const c = String(va).localeCompare(String(vb), "ko") * mul;
        // 같은 품명끼리는 입고일 오름차순 유지(주간 재고장의 정렬 관행)
        return c !== 0 ? c : String(a.first_in_date || "").localeCompare(String(b.first_in_date || ""));
      }
      return (va - vb) * mul;
    });
  }, [lots, whSel, kw, sort]);

  const toggleWh = (id: string) => setWhSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const whLabel = useMemo(() => {
    if (whSel.size === 0) return "창고: 전체";
    const names = warehouses.filter((w) => whSel.has(w.id)).map((w) => w.name);
    return names.length === 1 ? `창고: ${names[0]}` : `창고: ${names[0]} 외 ${names.length - 1}`;
  }, [whSel, warehouses]);

  const totals = useMemo(() => ({
    lots: shown.length,
    boxes: shown.reduce((s, l) => s + n0(l.qty), 0),
    kg: shown.reduce((s, l) => s + (toKg(n0(l.qty), l.box_kg) ?? 0), 0),
    pin: shown.reduce((s, l) => s + n0(l.period_in), 0),
    pout: shown.reduce((s, l) => s + n0(l.period_out), 0),
  }), [shown]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key
      ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key, dir: key === "item_name" || key === "warehouse" ? "asc" : "desc" }));
  }
  const Th = ({ k, label, num }: { k: SortKey; label: string; num?: boolean }) => (
    <th className={num ? "num" : undefined} onClick={() => toggleSort(k)}
      style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" }} title="클릭하여 정렬">
      {label}
      <span style={{ marginLeft: 3, color: sort.key === k ? "var(--sm-orange)" : "var(--sm-text-light)", fontSize: 10 }}>
        {sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </th>
  );

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">재고</h1></div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={loadLots} disabled={loading}>새로고침</button>
          <button className="b2b-btn-primary" onClick={() => setLotForm("new")}>+ 입고 등록</button>
        </div>
      </header>

      {error && (
        <div className="b2b-error">
          {error}
          {/schema|relation|lot_stock|factory|permission/i.test(error)
            ? " — supabase/migrations/factory/001_factory_init.sql 적용과 Exposed schemas 에 factory 추가가 필요합니다."
            : ""}
        </div>
      )}

      {/* 모바일 전용 검색 — 목록 위 상단 고정(데스크톱에선 숨김, 필터줄 우측 검색이 대신) */}
      <input className="b2b-input fac-search-mobile" placeholder="제품 검색 — 초성 가능 (예: ㄱㅇㄹ 국)" value={kw}
        onChange={(e) => setKw(e.target.value)} />

      {/* 데이터박스 — 창고탭·검색을 따라간다(보이는 로트 기준) */}
      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">로트</div><div className="b2b-stat-card-value">{totals.lots}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">총 재고(박스)</div><div className="b2b-stat-card-value b2b-money">{totals.boxes.toLocaleString()}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">총 중량(kg)</div><div className="b2b-stat-card-value b2b-money">{Math.round(totals.kg).toLocaleString()}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">기간 입고</div><div className="b2b-stat-card-value b2b-money" style={{ color: "var(--sm-success)" }}>{totals.pin.toLocaleString()}</div></div>
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">기간 출고</div><div className="b2b-stat-card-value b2b-money" style={{ color: "var(--sm-info)" }}>{totals.pout.toLocaleString()}</div></div>
      </div>

      <div className="sm-between fac-stock-bar" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {/* 창고 필터 — 드롭다운 + 체크박스 다중 선택(비면 전체) */}
          <div className="fac-wh-dd">
            <button type="button" className="b2b-input fac-wh-btn" onClick={() => setWhOpen((v) => !v)} aria-expanded={whOpen}>
              {whLabel} <span className="fac-wh-caret">▼</span>
            </button>
            {whOpen && (
              <>
                <div className="fac-dd-backdrop" onClick={() => setWhOpen(false)} />
                <div className="fac-wh-panel">
                  <button type="button" className="fac-wh-reset" onClick={() => { setWhSel(new Set()); setWhOpen(false); }}>전체 창고 보기</button>
                  {warehouses.map((w) => (
                    <label key={w.id} className="fac-wh-opt">
                      <input type="checkbox" className="b2b-checkbox" checked={whSel.has(w.id)} onChange={() => toggleWh(w.id)} />
                      {w.name}{w.is_own ? " (내부)" : ""}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="sm-tabs fac-stock-periods" style={{ margin: 0 }}>
            {PERIODS.map(([k]) => (
              <button key={k} className={`sm-tab ${pmode === k ? "is-active" : ""}`} onClick={() => setPmode(k)}>{k === "지정" ? "날짜 지정" : k}</button>
            ))}
          </div>
          {pmode === "지정" && (
            <span className="sm-row fac-stock-periods" style={{ gap: 6 }}>
              <input type="date" className="b2b-input" value={cfrom} max={cto} onChange={(e) => setCfrom(e.target.value)} style={{ width: "auto" }} />
              <span className="sm-faint">~</span>
              <input type="date" className="b2b-input" value={cto} min={cfrom} max={today()} onChange={(e) => setCto(e.target.value)} style={{ width: "auto" }} />
            </span>
          )}
          {/* .b2b-checkbox 는 input 전용 클래스(18px 정사각) — label 에 붙이면 라벨 폭이 18px 가 돼 글자가 세로로 쏟아진다 */}
          <label className="sm-row" style={{ gap: 6, alignItems: "center", cursor: "pointer", fontSize: 13, color: "var(--sm-text-mid)" }}>
            <input type="checkbox" className="b2b-checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
            소진 로트 포함
          </label>
        </div>
        <input className="b2b-input fac-search-desktop" placeholder="품명·규격·매입처 — 초성 가능 (예: ㄱㅇㄹ 국)" value={kw}
          onChange={(e) => setKw(e.target.value)} style={{ width: 300, maxWidth: "100%" }} />
      </div>

      <p className="sm-faint fac-stock-meta" style={{ fontSize: 12, marginBottom: 8 }}>기간 {range.from} ~ {range.to} · 기간 입고·출고 = 이 범위 거래의 합(이동 포함)</p>

      {loading ? <div className="b2b-loading">불러오는 중...</div> : shown.length === 0 ? (
        <div className="b2b-empty">재고가 없습니다.</div>
      ) : (
        <>
        {/* 모바일(≤900px) 목록 — 이름/수량 + 작은 특징줄. 줄을 누르면 출고·이동·수정이 펼쳐진다 */}
        <div className="fac-list">
          {shown.map((l) => (
            <div key={l.id} className="fac-item">
              <div className="fac-item-row" onClick={() => setOpenLot(openLot === l.id ? null : l.id)}>
                <div className="fac-item-main">
                  <div className="fac-item-name">
                    {l.item_name}
                    {l.supplier ? <span className="fac-item-supplier">{l.supplier}</span> : null}
                  </div>
                  <div className="fac-item-sub">
                    {[l.spec, l.tape_color, l.origin, l.warehouse, (l.first_in_date || "").slice(2, 10).replace(/-/g, ".")].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className={`fac-item-qty ${n0(l.qty) <= 0 ? "is-zero" : ""}`}>
                  {n0(l.qty).toLocaleString()}<small>{l.unit}</small>
                </div>
              </div>
              {openLot === l.id && (
                <div className="fac-item-actions">
                  <button onClick={() => setTxnFor(l)}>출고</button>
                  <button onClick={() => setMoveFor(l)}>이동</button>
                  <button onClick={() => setLotForm(l)}>수정</button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="b2b-table-wrap fac-stock-table">
          <table className="b2b-table">
            <thead><tr>
              <Th k="item_name" label="품명" />
              <th>규격</th><th>테잎색</th><th>원산지</th>
              <Th k="warehouse" label="창고" />
              <Th k="qty" label="현재수량" num />
              <Th k="box_kg" label="중량" num />
              <Th k="period_in" label="기간입고" num />
              <Th k="period_out" label="기간출고" num />
              <Th k="first_in_date" label="최초입고일" />
              <th></th>
            </tr></thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id}>
                  <td data-label="품명"><strong>{l.item_name}</strong>{l.supplier ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 11 }}>{l.supplier}</span> : null}</td>
                  <td data-label="규격" className="sm-faint">{l.spec || "-"}</td>
                  <td data-label="테잎색">{l.tape_color || "-"}</td>
                  <td data-label="원산지">{l.origin || "-"}</td>
                  <td data-label="창고">{l.warehouse}</td>
                  <td data-label="현재수량" className="num b2b-money" style={{ fontWeight: 700 }}>
                    {n0(l.qty).toLocaleString()}{l.unit}
                  </td>
                  <td data-label="중량" className="num b2b-money sm-faint">{l.box_kg ? `${l.box_kg}kg` : "-"}</td>
                  <td data-label="기간입고" className={`num b2b-money ${n0(l.period_in) === 0 ? "sm-faint" : ""}`}>{n0(l.period_in).toLocaleString()}</td>
                  <td data-label="기간출고" className={`num b2b-money ${n0(l.period_out) === 0 ? "sm-faint" : ""}`}>{n0(l.period_out).toLocaleString()}</td>
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
        </>
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
