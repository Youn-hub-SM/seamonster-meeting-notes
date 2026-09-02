"use client";

import { useEscClose } from "@/app/lib/use-esc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";

// 제조사 반품 입력 — 재고목록의 '입출조정' 창과 같은 짜임(직접 입력 / 엑셀 업로드 탭 + 미리보기).
//  반품은 재고를 건드리지 않는다. 매입 결산에서 매입수량을 깎는 기록일 뿐이다.

type Product = { id: string; name: string; sku: string | null; spec: string | null; qty: number };
type ReturnRow = { id: string; product_id: string; name: string; sku: string | null; return_date: string; qty: number; unit_amount: number | null; partner: string | null; memo: string | null };
type PreviewRow = { product_id: string; name: string; sku: string | null; qty: number; unit_amount: number | null; memo: string | null };
type Preview = { rows: PreviewRow[]; errors: { line: number; msg: string }[]; valid: number; errCount: number; skipped: number; merged: number };

const won = (n: number) => Math.round(n).toLocaleString();
// 그 달의 마지막 날 — 반품일은 결산 대상 월 안에 있어야 그 달 결산에 잡힌다.
//  Date.UTC 기준이어야 브라우저(KST)에서 말일이 하루 밀리지 않는다.
function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function defaultDate(ym: string): string {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return today.slice(0, 7) === ym ? today : monthEnd(ym);
}

export default function ReturnModal({ month, onClose, onSaved }: { month: string; onClose: () => void; onSaved: () => void }) {
  useEscClose(onClose);
  const [mode, setMode] = useState<"직접" | "엑셀">("직접");
  const [products, setProducts] = useState<Product[]>([]);
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [listLoading, setListLoading] = useState(true);

  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [unitAmount, setUnitAmount] = useState("");
  const [date, setDate] = useState(defaultDate(month));
  const [partner, setPartner] = useState("");
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const reqSeq = useRef(0);

  const [y, mm] = month.split("-");

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const j = await (await fetch(`/api/inventory/returns?month=${month}`, { cache: "no-store" })).json();
      if (j?.ok) { setRows(j.rows || []); setProducts(j.products || []); }
      else setError(j?.error || "반품 내역 조회 실패");
    } catch { setError("반품 내역 조회 실패"); }
    setListLoading(false);
  }, [month]);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { setDate(defaultDate(month)); }, [month]);

  const productOptions = useMemo<ComboOption[]>(
    () => products.map((p) => ({ id: p.id, label: p.spec ? `${p.name} ${p.spec}` : p.name, sub: p.sku || undefined })),
    [products]
  );
  const product = products.find((p) => p.id === productId);
  const productLabel = product ? `${product.spec ? `${product.name} ${product.spec}` : product.name}${product.sku ? ` (${product.sku})` : ""}` : "";
  // 이 달에 매입한 수량 — 그보다 많이 반품하면 초과분이 음수로 차감되므로 미리 알린다.
  const alreadyReturned = rows.filter((r) => r.product_id === productId).reduce((a, r) => a + r.qty, 0);
  const overReturn = !!product && product.qty > 0 && Number(qty) > 0 && alreadyReturned + Number(qty) > product.qty;

  async function save() {
    if (!productId) { setError("품목을 선택하세요."); return; }
    if (!(Number(qty) > 0)) { setError("반품수량을 입력하세요."); return; }
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/inventory/returns", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: productId, qty: Number(qty), unit_amount: unitAmount, return_date: date, partner, memo }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      setQty(""); setUnitAmount(""); setMemo("");
      await loadList();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  async function remove(id: string) {
    if (!window.confirm("이 반품 기록을 지울까요?")) return;
    setError("");
    try {
      const res = await fetch(`/api/inventory/returns/${id}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "삭제 실패");
      await loadList();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
  }

  async function handleFile(file: File) {
    const seq = ++reqSeq.current;
    setImporting(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("return_date", date);
      fd.append("partner", partner);
      const res = await fetch("/api/inventory/returns/import", { method: "POST", body: fd });
      const j = await res.json();
      if (seq !== reqSeq.current) return;
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setPreview({
        rows: j.rows || [], errors: j.errors || [],
        valid: Number(j.summary?.valid) || 0, errCount: Number(j.summary?.errors) || 0,
        skipped: Number(j.summary?.skipped) || 0, merged: Number(j.summary?.merged) || 0,
      });
    } catch (e) { if (seq === reqSeq.current) setError(e instanceof Error ? e.message : "분석 실패"); }
    if (seq === reqSeq.current) setImporting(false);
  }

  async function applyImport() {
    if (!preview) return;
    setApplying(true); setError("");
    try {
      const res = await fetch("/api/inventory/returns/import/apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: preview.rows, return_date: date, partner }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "반영 실패");
      setPreview(null);
      await loadList();
      setMode("직접");
    } catch (e) { setError(e instanceof Error ? e.message : "반영 실패"); }
    setApplying(false);
  }

  function switchMode(m: "직접" | "엑셀") { reqSeq.current++; setMode(m); setPreview(null); setError(""); setImporting(false); }

  const totalQty = rows.reduce((a, r) => a + r.qty, 0);

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: preview ? 760 : 520 }}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">제조사 반품 · {y}년 {mm}월</span>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <div className="sm-tabs" style={{ marginBottom: 12 }}>
            <button className={`sm-tab ${mode === "직접" ? "is-active" : ""}`} onClick={() => switchMode("직접")}>직접 입력</button>
            <button className={`sm-tab ${mode === "엑셀" ? "is-active" : ""}`} onClick={() => switchMode("엑셀")}>엑셀 업로드</button>
          </div>

          {mode === "엑셀" ? (
            preview ? (
              <div>
                <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                  <span>반영 가능 <strong style={{ color: "var(--sm-danger)" }}>{preview.valid.toLocaleString()}</strong>건</span>
                  {!!preview.merged && <span className="sm-faint">중복 SKU {preview.merged}건 합산됨</span>}
                  {!!preview.skipped && <span className="sm-faint">미입력 {preview.skipped.toLocaleString()}행 건너뜀</span>}
                  {preview.errCount > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.errCount}건(제외)</span>}
                </div>
                {preview.rows.length === 0 ? (
                  <div className="b2b-empty" style={{ padding: 20 }}>매칭된 품목이 없습니다. 양식을 확인하세요.</div>
                ) : (
                  <div className="b2b-table-wrap" style={{ maxHeight: 320, overflow: "auto", marginBottom: 12 }}>
                    <table className="b2b-table" style={{ fontSize: 15 }}>
                      <thead><tr><th>품목</th><th>SKU</th><th className="num">반품수량</th><th className="num">단가</th><th>메모</th></tr></thead>
                      <tbody>
                        {preview.rows.slice(0, 300).map((r, i) => (
                          <tr key={i}>
                            <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</td>
                            <td className="sm-faint">{r.sku || "-"}</td>
                            <td className="num b2b-money" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>{r.qty.toLocaleString()}</td>
                            <td className="num b2b-money">{r.unit_amount ? r.unit_amount.toLocaleString() : "매입가"}</td>
                            <td className="sm-faint">{r.memo || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
            ) : (
              <div>
                <div className="b2b-field-row">
                  <label className="b2b-field"><span className="b2b-field-label">반품일 <span className="sm-faint" style={{ fontWeight: 400 }}>· 파일 전체</span></span>
                    <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
                  <label className="b2b-field"><span className="b2b-field-label">제조사 <span className="sm-faint" style={{ fontWeight: 400 }}>· 선택</span></span>
                    <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="선택" /></label>
                </div>
                <p className="sm-faint" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.6 }}>
                  양식에는 <strong>{y}년 {mm}월에 매입한 품목</strong>의 SKU·품목명·매입수량이 채워져 있습니다 —
                  {" "}<strong>반품수량</strong> 칸만 적으면 되고, 비워 둔 줄은 건너뜁니다.
                  단가를 비우면 그 달 매입가로 계산합니다.
                  그 달 매입이 없는 품목도 SKU 를 적은 행을 추가하면 반품됩니다(결산에 행이 추가돼 차감).
                  <br />반품은 <strong>재고를 건드리지 않습니다</strong> — 매입 결산의 매입수량만 깎습니다.
                  {" · "}<a href={`/api/inventory/returns/template?month=${month}`} className="sm-link">양식 다운로드</a>
                </p>
                <p className="sm-faint" style={{ fontSize: 12, marginTop: 4 }}>준비되면 아래 <strong>‘엑셀 파일 선택’</strong>을 누르세요.</p>
              </div>
            )
          ) : (
            <>
              <div className="b2b-field"><span className="b2b-field-label">품목</span>
                <Combobox
                  value={productLabel}
                  options={productOptions}
                  onSelect={(opt) => setProductId(opt.id)}
                  placeholder="품목명 · SKU 검색 (초성도 됩니다)"
                  ariaLabel="품목 검색"
                  emptyText="일치하는 품목이 없습니다"
                />
              </div>
              {product && (
                <p className="sm-faint" style={{ fontSize: 12, margin: "2px 0 8px" }}>
                  {product.qty > 0 ? <>{mm}월 매입 <strong>{product.qty.toLocaleString()}</strong></>
                    : <>{mm}월 매입 없음 — 반품하면 결산 품목표에 행이 추가돼 차감됩니다(교차월 반품)</>}
                  {alreadyReturned > 0 && <> · 이미 반품 <strong style={{ color: "var(--sm-danger)" }}>{alreadyReturned.toLocaleString()}</strong></>}
                </p>
              )}

              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">반품수량</span>
                  <input className="b2b-input" type="number" step={0.01} min={0} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" /></label>
                <label className="b2b-field"><span className="b2b-field-label">반품일</span>
                  <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">반품 단가(원)</span>
                  <input className="b2b-input" type="number" min={0} value={unitAmount} onChange={(e) => setUnitAmount(e.target.value)} placeholder="비우면 매입가" /></label>
                <label className="b2b-field"><span className="b2b-field-label">제조사</span>
                  <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="선택" /></label>
              </div>
              <label className="b2b-field"><span className="b2b-field-label">메모</span>
                <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="반품 사유" /></label>

              {overReturn && (
                <div className="sm-warn" style={{ marginTop: 8 }}>
                  {mm}월 매입수량({product?.qty.toLocaleString()})보다 반품이 많습니다 — 초과분도 결산에서 그대로(음수로) 차감됩니다.
                </div>
              )}

              {/* 이 달에 이미 넣은 반품 — 잘못 넣은 건을 여기서 바로 지운다 */}
              <div style={{ marginTop: 16, borderTop: "1px solid var(--sm-border)", paddingTop: 12 }}>
                <div className="sm-between" style={{ marginBottom: 6 }}>
                  <strong style={{ fontSize: 15 }}>{mm}월 반품 내역</strong>
                  {rows.length > 0 && <span className="sm-faint" style={{ fontSize: 12 }}>{rows.length}건 · {totalQty.toLocaleString()}개</span>}
                </div>
                {listLoading ? <div className="b2b-loading">불러오는 중...</div>
                  : rows.length === 0 ? <p className="sm-faint" style={{ fontSize: 12 }}>아직 없습니다.</p>
                  : (
                    <div className="b2b-table-wrap" style={{ maxHeight: 200, overflow: "auto" }}>
                      <table className="b2b-table" style={{ fontSize: 12 }}>
                        <thead><tr><th>날짜</th><th>품목</th><th className="num">수량</th><th className="num">단가</th><th /></tr></thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.id}>
                              <td style={{ whiteSpace: "nowrap" }}>{r.return_date.slice(5)}</td>
                              <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.memo || ""}>{r.name}</td>
                              <td className="num b2b-money" style={{ color: "var(--sm-danger)", fontWeight: 700 }}>{r.qty.toLocaleString()}</td>
                              <td className="num b2b-money">{r.unit_amount ? won(r.unit_amount) : <span className="sm-faint">매입가</span>}</td>
                              <td style={{ textAlign: "right" }}>
                                <button type="button" className="b2b-icon-btn is-danger" aria-label="삭제" onClick={() => remove(r.id)}>✕</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
              </div>
            </>
          )}

          {error && <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div>}
        </div>
        <div className="b2b-modal-foot">
          {mode === "엑셀" && preview
            ? <button className="b2b-btn-secondary" onClick={() => { setPreview(null); setError(""); }} disabled={applying}>← 다시 선택</button>
            : <span />}
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onSaved} disabled={saving || applying || importing}>닫기</button>
            {mode === "엑셀" ? (
              preview ? (
                <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.valid === 0}>
                  {applying ? "반영 중..." : `${preview.valid.toLocaleString()}건 반영`}
                </button>
              ) : (
                <label className="b2b-btn-primary" style={{ cursor: importing ? "default" : "pointer" }}>
                  {importing ? "분석 중..." : "엑셀 파일 선택"}
                  <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
                </label>
              )
            ) : (
              <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : "반품 기록"}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
