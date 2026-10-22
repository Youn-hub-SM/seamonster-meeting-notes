"use client";

// 파도소리 재고 목록 — 씨몬스터 재고 목록 '전체' 탭과 같은 틀(2026-10-20 대표 지시).
//  요약 카드(품목 수·현재 재고·재고 자산·기간 총출고) → 기간 탭·검색 → 표. 계산식 안내줄은 뺐다(대표: 불필요한 요소 최소화).
//  표: SKU | 품목(누르면 히스토리) | 현재고 | 하루 출고 | 예상소진 | 총입고 | 총출고 | 재고자산 | 기록.
//  씨몬스터에만 있는 것(입고 예정·권장생산·생산 요청·AI 조언·프로모션)은 파도소리에 해당이 없어 뺐다.
//  재고 부족 판정은 대표가 추후 정한다(그때 카드·'부족만 보기'·경고색을 붙인다).
//  파도소리 고유: 행을 누르면 로트(제조일자 × 박스 중량)가 펼쳐지고, 현재고 아래 중량별 박스가 보인다.
//  PC = 표, 모바일(≤900px) = 목록 + 하단 입고·출고·조정 버튼.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchKoQuery, hangulInputValue } from "@/app/lib/hangul";
import { useEscClose } from "@/app/lib/use-esc";
import { HIST_COLOR, boxStr, kgStr, lotLabel, weightBreakdown, type StockRow, type TxnType } from "@/app/lib/factory";
import TxnForm from "./TxnForm";
import { today, daysAgo } from "./util";

const PERIODS = [["일일", 1], ["7일", 7], ["14일", 14], ["30일", 30], ["지정", 0]] as const;
type PMode = (typeof PERIODS)[number][0];

type SortKey = "name" | "boxes" | "daily_out" | "depletion_days" | "period_in" | "period_out" | "value";
const won = (n: number | null) => (n == null ? "-" : `${n.toLocaleString("ko-KR")}원`);
const num = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

export default function FactoryStockPage() {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kw, setKw] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [pmode, setPmode] = useState<PMode>("30일");
  const [cfrom, setCfrom] = useState(daysAgo(6));
  const [cto, setCto] = useState(today());
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "depletion_days", dir: "asc" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<{ type: TxnType; productId?: string } | null>(null);
  const [priceFor, setPriceFor] = useState<StockRow | null>(null);
  const [historyFor, setHistoryFor] = useState<StockRow | null>(null);

  const range = useMemo(() => {
    if (pmode === "지정") return { from: cfrom, to: cto };
    const days = PERIODS.find((p) => p[0] === pmode)?.[1] || 30;
    return { from: daysAgo(days - 1), to: today() };
  }, [pmode, cfrom, cto]);

  // 마지막 요청의 응답만 반영 — 기간을 빠르게 바꾸면 늦게 온 이전 응답이 표를 덮어쓴다(씨몬스터 재고 목록과 같은 처리)
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true); setError("");
    try {
      const sp = new URLSearchParams({ from: range.from, to: range.to });
      const j = await (await fetch(`/api/factory/stock?${sp}`, { cache: "no-store" })).json();
      if (seq !== loadSeq.current) return;
      if (!j.ok) throw new Error(j.error || "재고를 불러오지 못했습니다. 새로고침하세요.");
      setRows(j.rows || []);
    } catch (e) { if (seq === loadSeq.current) setError(e instanceof Error ? e.message : "재고를 불러오지 못했습니다. 새로고침하세요."); }
    if (seq === loadSeq.current) setLoading(false);
  }, [range.from, range.to]);
  useEffect(() => { load(); }, [load]);

  // 재고 없는 품목은 기본으로 숨기되, 기간 안에 움직임이 있었으면 보인다(이번 기간에 다 나간 품목)
  const scoped = useMemo(
    () => rows.filter((r) => showEmpty || r.boxes !== 0 || r.period_in > 0 || r.period_out > 0),
    [rows, showEmpty],
  );

  const totals = useMemo(() => ({
    items: scoped.length,
    boxes: scoped.reduce((s, r) => s + r.boxes, 0),
    kg: scoped.reduce((s, r) => s + r.kg, 0),
    value: scoped.reduce((s, r) => s + (r.value ?? 0), 0),
    noCost: scoped.filter((r) => r.value == null && r.boxes > 0).length,
    out: scoped.reduce((s, r) => s + r.period_out, 0),
    outKg: scoped.reduce((s, r) => s + r.period_out_kg, 0),
  }), [scoped]);

  const shown = useMemo(() => {
    const q = kw.trim();
    const f = scoped.filter((r) => !q || matchKoQuery(`${r.name} ${r.spec || ""} ${r.sku} ${r.origin || ""} ${r.note || ""}`, q));
    const mul = sort.dir === "asc" ? 1 : -1;
    const val = (r: StockRow): number | string =>
      sort.key === "name" ? r.name
        : sort.key === "depletion_days" ? (r.depletion_days ?? Number.POSITIVE_INFINITY)
        : sort.key === "value" ? (r.value ?? -1)
        : r[sort.key];
    return [...f].sort((a, b) => {
      const x = val(a), y = val(b);
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "ko") * mul;
      if (x === y) return a.name.localeCompare(b.name, "ko");
      if (x === Number.POSITIVE_INFINITY) return 1;   // 예상소진 계산 불가는 방향과 관계없이 맨 뒤
      if (y === Number.POSITIVE_INFINITY) return -1;
      return (x - y) * mul;
    });
  }, [scoped, kw, sort]);

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "depletion_days" ? "asc" : "desc" }));
  const openForm = (type: TxnType, productId?: string) => { setNotice(""); setForm({ type, productId }); };

  const Th = ({ k, label, numeric }: { k: SortKey; label: string; numeric?: boolean }) => (
    <th className={`fac-th-sort ${numeric ? "num" : ""}`} onClick={() => toggleSort(k)} title="눌러서 정렬">
      {label}
      <span className={`fac-sort-mark ${sort.key === k ? "is-on" : ""}`}>{sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </th>
  );

  // 로트·가격·버튼 — PC 펼침 행과 모바일 펼침이 같이 쓴다
  const detail = (r: StockRow) => (
    <div className="fac-detail">
      <div className="fac-sub">
        최신 입고 {r.last_in_date || "-"} · 최고령 입고 {r.oldest_in_date || "-"} · 누적 입고 {boxStr(r.in_boxes)} · 누적 출고 {boxStr(r.out_boxes)}
      </div>
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
          원가 {r.cost == null ? "-" : `${won(r.cost)}/kg`} · 판매가 {won(r.price)}{r.note ? ` · ${r.note}` : ""}
        </span>
        <div className="fac-detail-btns">
          <button type="button" className="b2b-btn-secondary" onClick={() => openForm("입고", r.id)}>입고</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => openForm("출고", r.id)} disabled={r.boxes <= 0}>출고</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => openForm("조정", r.id)}>조정</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => setPriceFor(r)}>가격 수정</button>
          <button type="button" className="b2b-btn-secondary" onClick={() => setHistoryFor(r)}>히스토리</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="b2b-container fac-stock">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">재고 목록</h1></div>
        <div className="b2b-page-actions fac-head-actions">
          <button className="b2b-btn-primary" onClick={() => openForm("입고")}>입고</button>
          <button className="b2b-btn-secondary" onClick={() => openForm("출고")}>출고</button>
          <button className="b2b-btn-secondary" onClick={() => openForm("조정")}>조정</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {notice && <div className="sm-success">{notice}</div>}

      {/* 요약 카드 — 표에 보이는 범위(재고 없는 품목 포함 여부)와 같은 범위로 센다. 검색은 무시 */}
      <div className="b2b-dash-grid fac-cards">
        <div className="b2b-stat-card"><div className="b2b-stat-card-label">품목 수</div><div className="b2b-stat-card-value">{totals.items.toLocaleString()}</div></div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">현재 재고</div>
          <div className="b2b-stat-card-value">{boxStr(totals.boxes)}</div>
          <div className="b2b-stat-card-hint">{kgStr(totals.kg)}</div>
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">재고 자산(원가)</div>
          <div className="b2b-stat-card-value b2b-money">{won(totals.value)}</div>
          {totals.noCost > 0 && <div className="b2b-stat-card-hint">원가 미입력 {totals.noCost}종 제외</div>}
        </div>
        <div className="b2b-stat-card">
          <div className="b2b-stat-card-label">기간 총출고</div>
          <div className="b2b-stat-card-value">{boxStr(totals.out)}</div>
          <div className="b2b-stat-card-hint">{kgStr(totals.outKg)}</div>
        </div>
      </div>

      <div className="fac-toolbar">
        <div className="sm-tabs" style={{ margin: 0 }}>
          {PERIODS.map(([k]) => (
            <button key={k} className={`sm-tab ${pmode === k ? "is-active" : ""}`} onClick={() => setPmode(k)}>{k === "지정" ? "날짜 지정" : k}</button>
          ))}
        </div>
        {pmode === "지정" && (
          <span className="fac-range">
            <input type="date" className="b2b-input" value={cfrom} max={cto} onChange={(e) => setCfrom(e.target.value)} />
            <span className="fac-sub">~</span>
            <input type="date" className="b2b-input" value={cto} min={cfrom} max={today()} onChange={(e) => setCto(e.target.value)} />
          </span>
        )}
        <label className="fac-check">
          <input type="checkbox" className="b2b-checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
          재고 없는 품목 포함
        </label>
        <input className="b2b-input fac-search" value={kw} onChange={(e) => setKw(hangulInputValue(e))} placeholder="품목·SKU 검색" aria-label="품목·SKU·원산지 검색(초성 가능)" />
      </div>

      {loading && rows.length === 0 ? <div className="b2b-loading">불러오는 중...</div> : shown.length === 0 ? (
        <div className="b2b-empty">{rows.length === 0 ? "등록된 품목이 없습니다." : "조건에 맞는 품목이 없습니다."}</div>
      ) : (
        <>
          {/* PC 표 */}
          <div className="b2b-table-wrap fac-stock-table">
            <table className="b2b-table is-clickable">
              <thead><tr>
                <th>SKU</th>
                <Th k="name" label="품목" />
                <Th k="boxes" label="현재고" numeric />
                <Th k="daily_out" label="하루 출고" numeric />
                <Th k="depletion_days" label="예상소진" numeric />
                <Th k="period_in" label="총입고" numeric />
                <Th k="period_out" label="총출고" numeric />
                <Th k="value" label="재고자산" numeric />
                <th></th>
              </tr></thead>
              <tbody>
                {shown.map((r) => (
                  <StockTableRow key={r.id} r={r} opened={open.has(r.id)} onToggle={() => toggle(r.id)} detail={detail}
                    onHistory={() => setHistoryFor(r)} onRecord={() => openForm(r.boxes > 0 ? "출고" : "입고", r.id)} />
                ))}
              </tbody>
            </table>
          </div>

          {/* 모바일 목록 */}
          <div className="fac-list">
            {shown.map((r) => (
              <div key={r.id} className={`fac-item ${open.has(r.id) ? "is-open" : ""}`}>
                <div className="fac-item-row" onClick={() => toggle(r.id)}>
                  <div className="fac-item-main">
                    <div className="fac-item-name">{r.name}{r.spec && <span className="fac-spec"> {r.spec}</span>}</div>
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
                      <span>하루 출고 <b>{r.daily_out ? `${num(r.daily_out)}박스` : "-"}</b></span>
                      <span>예상소진 <b>{r.depletion_days == null ? "-" : `${r.depletion_days}일`}</b></span>
                      <span>기간 입고 <b>{boxStr(r.period_in)}</b></span>
                      <span>기간 출고 <b>{boxStr(r.period_out)}</b></span>
                      <span>재고자산 <b>{won(r.value)}</b></span>
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
      {historyFor && <HistoryModal product={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function StockTableRow({ r, opened, onToggle, detail, onHistory, onRecord }: {
  r: StockRow; opened: boolean; onToggle: () => void; detail: (r: StockRow) => React.ReactNode;
  onHistory: () => void; onRecord: () => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <>
      <tr className={`fac-row ${opened ? "is-open" : ""}`} onClick={onToggle}>
        <td className="fac-sku">{r.sku}</td>
        <td onClick={stop}>
          {/* 품목명 = 히스토리, 줄의 다른 곳 = 로트 펼침 */}
          <button type="button" className="fac-name-btn" onClick={onHistory} title="누르면 이 품목의 기록 히스토리">
            <strong>{r.name}</strong>
            {r.spec && <span className="fac-spec"> {r.spec}</span>}
            {r.origin && <span className="fac-sub"> {r.origin}</span>}
          </button>
        </td>
        <td className="num">
          <strong className={r.boxes === 0 ? "fac-zero" : ""}>{boxStr(r.boxes)}</strong>
          {r.boxes !== 0 && <div className="fac-sub">{weightBreakdown(r.lots)}</div>}
        </td>
        <td className={`num ${r.daily_out ? "" : "fac-zero"}`}>{r.daily_out ? num(r.daily_out) : "-"}</td>
        <td className={`num ${r.depletion_days == null ? "fac-zero" : ""}`}>{r.depletion_days == null ? "-" : `${r.depletion_days}일`}</td>
        <td className="num">
          {r.period_in ? <span style={{ color: HIST_COLOR.입고.fg }}>{r.period_in.toLocaleString()}</span> : <span className="fac-zero">-</span>}
          {r.period_in > 0 && <div className="fac-sub">{kgStr(r.period_in_kg)}</div>}
        </td>
        <td className="num">
          {r.period_out ? <span style={{ color: HIST_COLOR.출고.fg }}>{r.period_out.toLocaleString()}</span> : <span className="fac-zero">-</span>}
          {r.period_out > 0 && <div className="fac-sub">{kgStr(r.period_out_kg)}</div>}
        </td>
        <td className="num b2b-money" title={r.cost == null ? "제품원가 미입력" : `${kgStr(Math.max(0, r.kg))} × ${r.cost.toLocaleString()}원/kg`}>
          {r.value == null ? <span className="fac-zero">-</span> : r.value.toLocaleString()}
        </td>
        <td onClick={stop}>
          <button type="button" className="b2b-btn-secondary fac-rec-btn" onClick={onRecord}>입·출·조정</button>
        </td>
      </tr>
      {opened && (
        <tr className="fac-row-detail"><td colSpan={9}>{detail(r)}</td></tr>
      )}
    </>
  );
}

// 품목 히스토리(관측 전용) — 그 품목의 기록을 최신순으로, 각 기록 전후의 품목 전체 재고(박스)와 함께.
//  전후 재고는 전체 이력의 누적합이라 한도(1000건)에 닿으면 생략한다 — 잘린 이력으로 계산하면 숫자가 틀어진다.
//  취소된 기록은 흐리게 두고 누적에서 뺀다. 취소·되돌리기는 왼쪽 '히스토리' 메뉴에서.
type HistTxn = {
  id: string; txn_date: string; type: TxnType; mfg_date: string | null; box_kg: number; boxes: number;
  partner: string | null; memo: string | null; created_by: string | null; cancelled_at: string | null;
};
function HistoryModal({ product, onClose }: { product: StockRow; onClose: () => void }) {
  const [rows, setRows] = useState<HistTxn[]>([]);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEscClose(onClose, false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const j = await (await fetch(`/api/factory/txns?product_id=${encodeURIComponent(product.id)}`, { cache: "no-store" })).json();
        if (!j.ok) throw new Error(j.error || "기록을 불러오지 못했습니다. 창을 닫았다 다시 여세요.");
        if (alive) { setRows(j.rows || []); setCapped(!!j.capped); }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "기록을 불러오지 못했습니다. 창을 닫았다 다시 여세요."); }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [product.id]);

  const withBalance = useMemo(() => {
    let bal = 0;
    return [...rows].reverse().map((t) => {
      const before = bal;
      if (!t.cancelled_at) bal += Number(t.boxes) || 0;
      return { ...t, before, after: bal };
    }).reverse();
  }, [rows]);

  return (
    <div className="b2b-modal-backdrop" onClick={onClose}>
      <div className="b2b-modal fac-hist-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">
            히스토리 — {product.name}{product.spec ? ` ${product.spec}` : ""}
            <span className="fac-sub" style={{ marginLeft: 10 }}>현재고 {boxStr(product.boxes)} · {kgStr(product.kg)}</span>
          </span>
          <button className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {loading ? <div className="b2b-loading">불러오는 중...</div>
            : error ? <div className="b2b-error">{error}</div>
            : rows.length === 0 ? <div className="b2b-empty">기록이 없습니다.</div>
            : (
              <div className="b2b-table-wrap fac-hist-scroll">
                <table className="b2b-table">
                  <thead><tr><th>거래일</th><th>유형</th><th>로트</th><th className="num">수량</th><th className="num">재고</th><th>거래처</th><th>메모</th><th>담당</th></tr></thead>
                  <tbody>
                    {withBalance.map((t) => {
                      const c = HIST_COLOR[t.type];
                      return (
                        <tr key={t.id} className={t.cancelled_at ? "fac-row-cancelled" : undefined}>
                          <td className="sm-nowrap">{t.txn_date}</td>
                          <td className="sm-nowrap">
                            <span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{t.type}</span>
                            {t.cancelled_at && <span className="b2b-status-pill" style={{ marginLeft: 4, background: HIST_COLOR.취소.bg, color: HIST_COLOR.취소.fg }}>취소</span>}
                          </td>
                          <td className="sm-nowrap">{lotLabel(t)}</td>
                          <td className="num fac-num" style={{ color: t.cancelled_at ? undefined : c.fg, fontWeight: 700 }}>{t.boxes > 0 ? "+" : ""}{t.boxes.toLocaleString()}</td>
                          <td className="num sm-nowrap">
                            {capped || t.cancelled_at ? <span className="fac-zero">-</span>
                              : <><span className="fac-sub">{t.before.toLocaleString()}</span> → <strong>{t.after.toLocaleString()}</strong></>}
                          </td>
                          <td>{t.partner || "-"}</td>
                          <td className="fac-hist-memo" title={t.memo || ""}>{t.memo || "-"}</td>
                          <td className="fac-sub sm-nowrap">{t.created_by || "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {capped && <p className="fac-sub" style={{ padding: "6px 2px" }}>기록이 1,000건 이상이라 재고 전후 표시는 생략했습니다.</p>}
              </div>
            )}
        </div>
        <div className="b2b-modal-foot">
          <span />
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose}>닫기</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 제품원가(kg당)·판매가 — 모든 계정이 바꿀 수 있고 히스토리에 남는다
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
          <span className="b2b-modal-title">가격 수정 · {product.name}{product.spec ? ` ${product.spec}` : ""}</span>
          <button className="b2b-modal-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="b2b-modal-body">
          <label className="b2b-field">
            <span className="b2b-field-label">제품원가(원/kg)</span>
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
