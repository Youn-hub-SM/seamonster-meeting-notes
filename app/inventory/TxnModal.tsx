"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { INV_TXN_TYPES, INV_TYPE_COLOR, type InvTxnType, type InvChannel, type InvChannelFilter } from "@/app/lib/inventory";
import { ChannelPicker } from "./ChannelTabs";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

type Product = { id: string; name: string; sku: string | null; unit: string };

// 엑셀 미리보기 — 입고/출고와 조정은 서버 응답 모양이 달라 종류로 구분해 담는다.
type IoRow = { type: "입고" | "출고"; qty: number; product_id: string; product_name: string; unit_amount: number | null; txn_date: string; partner: string | null; memo: string | null };
type AdjRow = { product_id: string; sku: string | null; name: string; spec: string | null; unit: string; current: number; target: number; delta: number; memo: string | null };
type Preview = {
  kind: "입출" | "조정";
  // 이 미리보기를 만든 시점의 유형·채널. 화면도 반영도 이 값을 쓴다 —
  //  분석 중에 탭을 바꿔도 표와 실제 기록이 어긋나지 않게(조정은 채널이 바뀌면 델타가 통째로 달라진다).
  reqType: InvTxnType;
  reqChannel: InvChannel;
  rows: IoRow[] | AdjRow[];
  errors: { line: number; msg: string }[];
  count: number;    // 실제 반영될 건수(입출=valid, 조정=현재고와 다른 행)
  valid: number;    // 매칭된 행 수
  errCount: number;
  merged: number;   // 입출고에서 합산된 중복 행 수
  skipped: number;  // 수량을 안 적어 건너뛴 행(채워진 양식에서는 정상)
};

export default function TxnModal({
  products, qtyOf, defaultType = "입고", defaultProductId = "", defaultChannel = "소매", qtySource, lockProduct = false, onClose, onSaved,
}: {
  products: Product[];
  qtyOf: (id: string) => number;
  defaultType?: InvTxnType;
  defaultProductId?: string;
  defaultChannel?: InvChannel;
  /** qtyOf 가 어느 채널 기준인지. 부모 목록이 '전체'(도매+소매 합산)면 반드시 넘길 것 —
   *  합산 재고를 특정 채널의 현재고로 착각하면 조정 델타가 통째로 틀어진다. 기본값은 defaultChannel. */
  qtySource?: InvChannelFilter;
  lockProduct?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<InvTxnType>(defaultType);
  // 입고는 도매를 못 고른다 — 도매 재고는 소매 입고 후 [소매↔도매] 이동으로만 들어간다(실수 방지).
  //  도매 탭에서 열면 기본 채널이 도매로 오므로 입고 기본형이면 소매로 돌려놓는다.
  const [channel, setChannel] = useState<InvChannel>(defaultType === "입고" && defaultChannel === "도매" ? "소매" : defaultChannel);
  const [productId, setProductId] = useState(defaultProductId);
  const [qty, setQty] = useState("");
  const [adjMode, setAdjMode] = useState<"target" | "delta">("target");
  const [unitAmount, setUnitAmount] = useState("");
  const [date, setDate] = useState(TODAY());
  const [partner, setPartner] = useState("");
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const product = useMemo(() => products.find((p) => p.id === productId), [products, productId]);
  const isAdjust = type === "조정";

  // ── 엑셀 일괄 모드 — 양식 다운로드 → 첨부 → 미리보기 → 반영 ──
  //  파서·반영 API 는 기존 것을 그대로 쓴다: 입고/출고 = /api/inventory/txns/import(+/apply),
  //  조정 = /api/inventory/adjust/import(+/apply, 실사수량 기준이라 반영 시점에 서버가 델타 재계산).
  const [mode, setMode] = useState<"직접" | "엑셀">("직접");
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [ioDone, setIoDone] = useState(true); // 입고/출고 즉시처리(해제 시 '대기')
  const [preview, setPreview] = useState<Preview | null>(null);
  // 양식은 전 품목의 SKU·품목명·현재고를 채워서 받는다(fill=1) — 수량 칸만 채우면 되게.
  const templateHref = isAdjust
    ? `/api/inventory/adjust/template?fill=1&channel=${encodeURIComponent(channel)}`
    : `/api/inventory/txns/template?type=${type}&fill=1&channel=${encodeURIComponent(channel)}`;

  // 분석 요청 순번 — 응답이 늦게 온 옛 요청은 버린다(유형·채널을 바꾼 뒤 도착한 결과가 반대 표에 그려지면 화면이 죽는다).
  const reqSeq = useRef(0);
  function dropInflight() { reqSeq.current++; }

  async function handleFile(file: File) {
    const seq = ++reqSeq.current;
    const reqType = type, reqChannel = channel, adj = reqType === "조정"; // 이 요청의 조건을 고정
    setImporting(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (adj) fd.append("channel", reqChannel);
      else { fd.append("type", reqType); fd.append("txn_date", date); fd.append("partner", partner); }
      const res = await fetch(adj ? "/api/inventory/adjust/import" : "/api/inventory/txns/import", { method: "POST", body: fd });
      const j = await res.json();
      if (seq !== reqSeq.current) return; // 그 사이 조건이 바뀜 → 폐기
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      const base = { reqType, reqChannel, rows: j.rows || [], errors: j.errors || [], valid: Number(j.summary?.valid) || 0, errCount: Number(j.summary?.errors) || 0, skipped: Number(j.summary?.skipped) || 0 };
      setPreview(adj
        ? { ...base, kind: "조정", count: Number(j.summary?.changed) || 0, merged: 0 }
        : { ...base, kind: "입출", count: Number(j.summary?.valid) || 0, merged: Number(j.summary?.merged) || 0 });
    } catch (e) { if (seq === reqSeq.current) setError(e instanceof Error ? e.message : "분석 실패"); }
    if (seq === reqSeq.current) setImporting(false);
  }

  async function applyImport() {
    if (!preview) return;
    // 채널·유형은 미리보기를 만든 값으로 보낸다 — 화면에서 확인한 숫자와 실제 기록이 같은 채널이어야 한다.
    const ch = preview.reqChannel;
    setApplying(true); setError("");
    try {
      const [url, body] = preview.kind === "조정"
        ? ["/api/inventory/adjust/import/apply", { channel: ch, rows: (preview.rows as AdjRow[]).map((r) => ({ product_id: r.product_id, target: r.target, memo: r.memo })) }]
        : ["/api/inventory/txns/import/apply", { rows: preview.rows, done: ioDone, channel: ch }];
      const res = await fetch(url as string, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "반영 실패");
      onSaved(); // 부모가 목록을 다시 읽고 이 창을 닫는다
    } catch (e) { setError(e instanceof Error ? e.message : "반영 실패"); }
    setApplying(false);
  }

  function switchMode(m: "직접" | "엑셀") { dropInflight(); setMode(m); setPreview(null); setError(""); setImporting(false); }

  // 품목 검색 콤보박스: 이름·SKU 로 필터(다른 상품 검색 UI 와 동일). 목록에서만 선택.
  const productOptions = useMemo<ComboOption[]>(() => products.map((p) => ({ id: p.id, label: p.name, sub: p.sku || undefined })), [products]);
  const productLabel = product ? `${product.name}${product.sku ? ` (${product.sku})` : ""}` : "";

  // 현재고는 '선택한 채널' 기준. 부모가 넘긴 qtyOf 가 그 채널 기준일 때만 그대로 쓰고,
  //  아니면(다른 채널이거나 부모 목록이 '전체' 합산이면) 그 채널을 따로 조회해 캐시한다.
  //  합산 재고를 한 채널의 현재고로 쓰면 조정(목표−현재) 델타가 통째로 틀어진다.
  const qtyBase: InvChannelFilter = qtySource ?? defaultChannel;
  const [chanQty, setChanQty] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!productId || channel === qtyBase) return;
    const key = `${channel} ${productId}`;
    if (key in chanQty) return;
    let alive = true;
    fetch(`/api/inventory?channel=${encodeURIComponent(channel)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive && j?.ok) { const row = (j.rows || []).find((x: { product_id: string; qty: number }) => x.product_id === productId); setChanQty((m) => ({ ...m, [key]: row ? Number(row.qty) || 0 : 0 })); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [channel, productId, qtyBase, chanQty]);
  const chanKnown = channel === qtyBase || (channel + " " + productId) in chanQty; // 조회 전에는 현재고를 모른다
  const current = !productId ? 0 : channel === qtyBase ? qtyOf(productId) : (chanQty[`${channel} ${productId}`] ?? 0);

  // 미리보기: 이 거래 후 재고
  const after = useMemo(() => {
    const n = Number(qty) || 0;
    if (type === "입고") return current + Math.abs(n);
    if (type === "출고") return current - Math.abs(n);
    return adjMode === "target" ? n : current + n; // 조정
  }, [type, qty, current, adjMode]);

  async function save() {
    if (!productId) { setError("품목을 선택하세요."); return; }
    if (qty.trim() === "") { setError("수량을 입력하세요."); return; }
    // 목표(실사) 조정은 현재고를 빼서 델타를 만든다 → 그 채널 현재고를 모르면 계산 자체가 틀린다.
    if (type === "조정" && adjMode === "target" && !chanKnown) { setError(`${channel} 현재고를 불러오는 중입니다. 잠시 후 다시 시도하세요.`); return; }
    let sendQty = Number(qty) || 0;
    if (type === "조정" && adjMode === "target") sendQty = (Number(qty) || 0) - current; // 목표−현재 = 델타
    if (sendQty === 0) { setError(type === "조정" ? "현재고와 동일합니다 (변동 없음)." : "수량을 입력하세요."); return; }
    if (type === "출고" && after < 0 && !window.confirm(`현재고(${current.toLocaleString()})보다 많은 출고입니다. 재고가 ${after.toLocaleString()} 가 됩니다. 진행할까요?`)) return;
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/inventory/txn", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: productId, type, channel, qty: sendQty, unit_amount: isAdjust ? null : unitAmount, txn_date: date, partner: isAdjust ? "" : partner, memo }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "기록 실패");
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "기록 실패"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: preview ? 760 : 460 }}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">입고 · 출고 · 조정</span>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          {/* 한 품목만 기록하는 창(행에서 열었을 때)에는 엑셀 일괄이 맞지 않아 숨긴다 */}
          {!lockProduct && (
            <div className="sm-tabs" style={{ marginBottom: 12 }}>
              <button className={`sm-tab ${mode === "직접" ? "is-active" : ""}`} onClick={() => switchMode("직접")}>직접 입력</button>
              <button className={`sm-tab ${mode === "엑셀" ? "is-active" : ""}`} onClick={() => switchMode("엑셀")}>엑셀 업로드</button>
            </div>
          )}

          <div className="sm-tabs" style={{ marginBottom: 12 }}>
            {INV_TXN_TYPES.map((t) => (
              <button key={t} className={`sm-tab ${type === t ? "is-active" : ""}`} disabled={importing || applying}
                onClick={() => { dropInflight(); setType(t); if (t === "입고" && channel === "도매") setChannel("소매"); setPreview(null); setError(""); setImporting(false); }}>{t}</button>
            ))}
          </div>

          <div className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 12 }}>
            <span className="b2b-field-label" style={{ margin: 0 }}>채널</span>
            <ChannelPicker value={channel} onChange={(c) => { dropInflight(); setChannel(c); setPreview(null); setError(""); setImporting(false); }}
              disabledChannels={type === "입고" ? ["도매"] : []}
              disabledHint="도매 재고는 소매로 입고한 뒤 [소매↔도매]에서 옮깁니다 — 바로 도매 입고는 막았습니다" />
            <span className="sm-faint" style={{ fontSize: 12 }}>
              {type === "입고" ? "입고는 소매로만 — 도매는 [소매↔도매]에서 옮깁니다" : `${channel} 재고에 기록`}
            </span>
          </div>

          {mode === "엑셀" ? (
            /* 미리보기가 있으면 그 미리보기를 만든 유형·채널로 그린다(늦게 온 응답이 반대 표에 그려지지 않게) */
            <ExcelPane
              type={preview ? preview.reqType : type}
              isAdjust={preview ? preview.kind === "조정" : isAdjust}
              channel={preview ? preview.reqChannel : channel}
              templateHref={templateHref}
              date={date} setDate={setDate} partner={partner} setPartner={setPartner}
              ioDone={ioDone} setIoDone={setIoDone}
              importing={importing} preview={preview}
            />
          ) : (
          <>
          <div className="b2b-field"><span className="b2b-field-label">품목</span>
            {lockProduct ? (
              <input className="b2b-input" value={productLabel} disabled readOnly />
            ) : (
              <Combobox
                value={productLabel}
                options={productOptions}
                onSelect={(opt) => setProductId(opt.id)}
                placeholder="품목명 · SKU 검색"
                ariaLabel="품목 검색"
                emptyText="일치하는 품목이 없습니다"
              />
            )}
          </div>
          {product && (chanKnown
            ? <p className="sm-faint" style={{ fontSize: 12, margin: "2px 0 8px" }}>{channel} 현재고 <strong>{current.toLocaleString()}</strong>{product.unit} → 거래 후 <strong style={{ color: after < 0 ? "var(--sm-danger)" : "var(--sm-black)" }}>{after.toLocaleString()}</strong>{product.unit}</p>
            : <p className="sm-faint" style={{ fontSize: 12, margin: "2px 0 8px" }}>{channel} 현재고 불러오는 중…</p>)}

          {isAdjust && (
            <div className="sm-tabs" style={{ marginBottom: 8 }}>
              <button className={`sm-tab ${adjMode === "target" ? "is-active" : ""}`} onClick={() => setAdjMode("target")}>실사 수량(목표)</button>
              <button className={`sm-tab ${adjMode === "delta" ? "is-active" : ""}`} onClick={() => setAdjMode("delta")}>증감(±)</button>
            </div>
          )}

          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">{isAdjust ? (adjMode === "target" ? "실사 수량" : "증감(±)") : "수량"}</span>
              <input className="b2b-input" type="number" step={0.01} value={qty} onChange={(e) => setQty(e.target.value)} placeholder={isAdjust && adjMode === "delta" ? "예: -3" : "0"} /></label>
            <label className="b2b-field"><span className="b2b-field-label">거래일</span>
              <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          </div>

          {!isAdjust && (
            <div className="b2b-field-row">
              <label className="b2b-field"><span className="b2b-field-label">{type === "입고" ? "매입 단가(원)" : "판매 단가(원)"}</span>
                <input className="b2b-input" type="number" min={0} value={unitAmount} onChange={(e) => setUnitAmount(e.target.value)} placeholder="선택" /></label>
              <label className="b2b-field"><span className="b2b-field-label">{type === "입고" ? "매입처" : "판매처"}</span>
                <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="선택" /></label>
            </div>
          )}
          <label className="b2b-field"><span className="b2b-field-label">메모</span>
            <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={isAdjust ? "조정 사유" : "선택"} /></label>
          </>
          )}

          {error && <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          {/* 미리보기에서 파일·설정을 다시 고를 수 있는 유일한 경로 */}
          {mode === "엑셀" && preview
            ? <button className="b2b-btn-secondary" onClick={() => { setPreview(null); setError(""); }} disabled={applying}>← 다시 선택</button>
            : <span />}
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving || applying || importing}>취소</button>
            {mode === "엑셀" ? (
              preview ? (
                <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.count === 0}>
                  {applying ? "반영 중…" : `${preview.count.toLocaleString()}건 ${preview.kind === "조정" ? "조정" : "반영"}`}
                </button>
              ) : (
                <label className="b2b-btn-primary" style={{ cursor: importing ? "default" : "pointer" }}>
                  {importing ? "분석 중…" : "엑셀 파일 선택"}
                  <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
                </label>
              )
            ) : (
              <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중…" : "기록"}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 엑셀 일괄 패널 — 양식 안내·다운로드 + (입출고면) 파일 전체에 적용할 거래일·거래처·즉시처리 + 미리보기.
//  파일 첨부 버튼은 모달 푸터에 있다(다른 업로드 화면과 같은 위치).
function ExcelPane({ type, isAdjust, channel, templateHref, date, setDate, partner, setPartner, ioDone, setIoDone, importing, preview }: {
  type: InvTxnType; isAdjust: boolean; channel: InvChannel; templateHref: string;
  date: string; setDate: (v: string) => void;
  partner: string; setPartner: (v: string) => void;
  ioDone: boolean; setIoDone: (v: boolean) => void;
  importing: boolean; preview: Preview | null;
}) {
  if (preview) {
    return (
      <div>
        <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
          {isAdjust ? (
            <>
              <span>실제 변경 <strong style={{ color: "var(--sm-orange)" }}>{preview.count.toLocaleString()}</strong>건</span>
              <span className="sm-faint">일치 {preview.valid.toLocaleString()}건 중</span>
            </>
          ) : (
            <span>반영 가능 <strong style={{ color: "var(--sm-success)" }}>{preview.count.toLocaleString()}</strong>건</span>
          )}
          {!!preview.merged && <span className="sm-faint">중복 SKU {preview.merged}건 합산됨</span>}
          {!!preview.skipped && <span className="sm-faint">미입력 {preview.skipped.toLocaleString()}행 건너뜀</span>}
          {preview.errCount > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.errCount}건(제외)</span>}
        </div>

        {preview.rows.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 20 }}>매칭된 품목이 없습니다. 양식을 확인하세요.</div>
        ) : (
          <div className="b2b-table-wrap" style={{ maxHeight: 320, overflow: "auto", marginBottom: 12 }}>
            {isAdjust ? (
              <table className="b2b-table" style={{ fontSize: 15 }}>
                <thead><tr><th>품목</th><th>SKU</th><th className="num">현재고</th><th className="num">실사</th><th className="num">조정</th><th>메모</th></tr></thead>
                <tbody>
                  {(preview.rows as AdjRow[]).slice(0, 300).map((r, i) => (
                    <tr key={i} style={{ color: r.delta === 0 ? "var(--sm-text-light)" : undefined }}>
                      <td>{r.name}{r.spec ? <span className="sm-faint" style={{ marginLeft: 5, fontSize: 12 }}>{r.spec}</span> : null}</td>
                      <td className="sm-faint">{r.sku || "-"}</td>
                      <td className="num b2b-money">{r.current.toLocaleString()}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700 }}>{r.target.toLocaleString()}</td>
                      <td className="num b2b-money" style={{ fontWeight: 700, color: r.delta > 0 ? "var(--sm-success)" : r.delta < 0 ? "var(--sm-danger)" : "var(--sm-text-light)" }}>{r.delta > 0 ? "+" : ""}{r.delta.toLocaleString()}</td>
                      <td className="sm-faint">{r.memo || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="b2b-table" style={{ fontSize: 15 }}>
                <thead><tr><th>날짜</th><th>유형</th><th>품목</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th></tr></thead>
                <tbody>
                  {(preview.rows as IoRow[]).slice(0, 300).map((r, i) => {
                    // 색은 행의 실제 유형으로 — '유형' 열이 있는 파일은 한 파일에 입고·출고가 섞일 수 있다
                    const rc = INV_TYPE_COLOR[r.type] || INV_TYPE_COLOR["입고"];
                    return (
                    <tr key={i}>
                      <td style={{ whiteSpace: "nowrap" }}>{r.txn_date?.slice(5)}</td>
                      <td><span className="b2b-status-pill" style={{ background: rc.bg, color: rc.fg }}>{r.type}</span></td>
                      <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.product_name}</td>
                      <td className="num b2b-money" style={{ color: rc.fg, fontWeight: 700 }}>{r.qty > 0 ? "+" : ""}{r.qty.toLocaleString()}</td>
                      <td className="num b2b-money">{r.unit_amount ? r.unit_amount.toLocaleString() : "-"}</td>
                      <td>{r.partner || "-"}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {preview.rows.length > 300 && <p className="sm-faint" style={{ fontSize: 12, padding: "6px 2px" }}>…외 {preview.rows.length - 300}건(전체 반영됩니다)</p>}
          </div>
        )}

        {preview.errors.length > 0 && (
          <section>
            <div className="b2b-field-label" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>오류 ({preview.errors.length}) — 해당 행은 제외</div>
            <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--sm-danger)", maxHeight: 130, overflow: "auto" }}>
              {preview.errors.map((e, i) => <li key={i}>{e.line}행: {e.msg}</li>)}
            </ul>
          </section>
        )}
      </div>
    );
  }

  return (
    <div>
      {!isAdjust && (
        <>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">거래일 <span className="sm-faint" style={{ fontWeight: 400 }}>· 파일 전체</span></span>
              <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="b2b-field"><span className="b2b-field-label">{type === "입고" ? "매입처" : "판매처"} <span className="sm-faint" style={{ fontWeight: 400 }}>· 선택</span></span>
              <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="선택" /></label>
          </div>
          <label className="sm-row" style={{ gap: 7, marginTop: 4, fontSize: 15, cursor: "pointer" }}>
            <input type="checkbox" checked={ioDone} onChange={(e) => setIoDone(e.target.checked)} /> 즉시 {type}처리 <span className="sm-faint" style={{ fontSize: 12 }}>(해제 시 ‘대기’)</span>
          </label>
        </>
      )}

      <p className="sm-faint" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.6 }}>
        양식에는 <strong>SKU · 품목명 · 현재고({channel})</strong>가 이미 채워져 있습니다 — <strong>{isAdjust ? "실사수량" : "수량"}</strong> 칸만 적으면 되고, 비워 둔 줄은 건너뜁니다.
        {isAdjust
          ? <> 현재고가 실사수량이 되도록 조정하며, 거래일은 오늘로 기록됩니다.</>
          : <> 단가는 선택입니다.{type === "출고" ? " 외부 출고 파일(수량·(무시)·SKU)도 그대로 올릴 수 있습니다." : ""}</>}
        <br />{channel} 재고에 기록됩니다. 묶음(세트)과 <strong>SKU 가 없는 품목</strong>은 양식에서 빠집니다 — 빠진 품목은 양식 맨 아래에 적혀 있습니다.
        {" · "}<a href={templateHref} className="sm-link">양식 다운로드</a>
      </p>

      <p className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>준비되면 아래 <strong>‘엑셀 파일 선택’</strong>을 누르세요.</p>
    </div>
  );
}
