"use client";

import { useEscClose } from "@/app/lib/use-esc";
import IconButton from "@/app/components/IconButton";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";
import { useConfirm } from "@/app/components/Feedback";

// 제조사 반품 입력 — 재고목록의 '입출조정' 창과 같은 짜임(직접 입력 / 엑셀 업로드 탭 + 미리보기).
//  반품 기록 자체는 재고를 건드리지 않는다(087) — 매입 결산에서 매입수량을 깎는 기록이다.
//  실물을 제조사로 보냈으면 저장 직후 뜨는 [재고에서도 빼기]가 같은 품목·수량·반품일로 소매 출고(사유 '제조사 반품')를
//  남긴다(2026-10-11 대표 결정 D4c). 반품 id 를 제출 키로 써서 다시 눌러도 출고는 한 번만 기록된다(엑셀 반영도 반품마다 따로).
//  반품을 지울 때 그 키로 남은 출고가 있으면 서버가 확인을 받고 출고까지 함께 취소한다 — 반품만 지우고 다시 넣어 또 빼면 이중 차감.
//  단, 그 출고 뒤에 실사가 있었으면 실사가 출고를 이미 반영했다 — 서버가 '반품만 지우고 출고는 둘까요?'를 묻는다(confirm_as keep).
//  반품일 뒤에 그 품목의 소매 실사(조정)가 있으면 실사가 이미 실물 감소를 반영했을 수 있어(이중 차감, S8) 그 품목은 기본 제외하고
//  [그래도 빼기]로만 남긴다. 실사 확인이 실패하면 출고를 남기지 않는다(S4).
//  [재고에서도 빼기]와 반품 삭제는 동시에 돌지 않는다(busy 잠금) — 기록 중에 지운 반품의 출고가 남거나, 지우는 중에 출고가 새로 남지 않게.
//  기록 중에는 저장·엑셀 반영·닫기도 막는다. 대기 목록은 pendingRef 가 원본 — 기다리는 사이 바뀐 목록을 덮어쓰지 않는다.
//  저장·삭제·반영을 한 번이라도 했으면 어떤 닫기(✕·Esc·닫기)로 닫아도 결산을 다시 계산한다(onSaved).

type Product = { id: string; name: string; sku: string | null; spec: string | null; qty: number };
type ReturnRow = { id: string; product_id: string; name: string; sku: string | null; return_date: string; qty: number; unit_amount: number | null; partner: string | null; memo: string | null };
type PreviewRow = { product_id: string; name: string; sku: string | null; qty: number; unit_amount: number | null; memo: string | null };
type Preview = { rows: PreviewRow[]; errors: { line: number; msg: string }[]; valid: number; errCount: number; skipped: number; merged: number };
// 방금 저장한 반품 — 재고 출고 제안 대상. key = 출고 제출 키(반품 id, 실사 뒤 묶음은 '<id>-held' — 제출 키 형식 [A-Za-z0-9-]), src = 반품 id
//  엑셀 반영도 반품 1건 = 항목 1개 — 목록에서 지운 반품이 src 로 빠지고, 반품 삭제가 키로 딸린 출고를 찾는다.
//  checked = 실사 확인을 마침(이후 같은 키로 다시 보내도 내용이 같게 — 재시도는 replay), held = 반품일 뒤 실사가 있어 기본 제외
type PendingOut = { key: string; src: string; partner: string | null; date: string; checked?: boolean; held?: boolean; rows: { product_id: string; name: string; qty: number; countDate?: string }[] };

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
  const confirm = useConfirm();
  // 반품을 저장·삭제·반영했으면 닫을 때 결산 재계산 — ✕·Esc 로 닫아도 반품 전 숫자가 화면·인쇄에 남지 않게
  const dirty = useRef(false);
  const close = useCallback(() => { if (dirty.current) onSaved(); else onClose(); }, [onSaved, onClose]);
  const [mode, setMode] = useState<"직접" | "엑셀">("직접");
  const [pending, setPendingState] = useState<PendingOut[]>([]); // 출고를 아직 안 남긴 반품(저장 순) — 여러 건 저장해도 쌓인다
  // 대기 목록의 원본 — 비동기 사이(실사 확인·출고 전송)에도 지금 목록을 바로 읽고, 바꿀 때는 항상 이전 값에서 고친다(통째로 덮어쓰지 않음)
  const pendingRef = useRef<PendingOut[]>([]);
  const setPending = useCallback((fn: (prev: PendingOut[]) => PendingOut[]) => {
    pendingRef.current = fn(pendingRef.current);
    setPendingState(pendingRef.current);
  }, []);
  // [재고에서도 빼기] ↔ 반품 삭제 상호 잠금 — 상태 반영 전 연타도 막도록 ref 로 먼저 잡는다
  const busyRef = useRef<"out" | "remove" | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [outBusy, setOutBusy] = useState(false);
  const [outDone, setOutDone] = useState("");
  const [warn, setWarn] = useState(""); // 반품 삭제 뒤 남은 확인 거리(키로 못 찾은 같은 날 출고 등)
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
  const [fieldErr, setFieldErr] = useState<{ product?: string; qty?: string }>({}); // 칸 아래 한 줄(E5)

  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const reqSeq = useRef(0);
  // 닫기(✕·Esc·닫기) 잠금 — 기록·삭제 중에 닫으면 남은 출고가 화면 밖에서 계속 기록되거나 결과(경고)를 못 본다
  const closeBlocked = saving || applying || importing || outBusy || !!removingId;
  useEscClose(close, closeBlocked);

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
    if (busyRef.current === "out") return; // 출고 기록 중 — 버튼도 막혀 있다
    const errs: { product?: string; qty?: string } = {};
    if (!productId) errs.product = "품목을 선택하세요";
    if (!(Number(qty) > 0)) errs.qty = "반품수량을 입력하세요";
    setFieldErr(errs);
    if (errs.product || errs.qty) { setError(errs.product && errs.qty ? "" : (errs.product || errs.qty || "")); return; }
    setSaving(true); setError(""); setOutDone("");
    try {
      const res = await fetch("/api/inventory/returns", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: productId, qty: Number(qty), unit_amount: unitAmount, return_date: date, partner, memo }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "저장 실패");
      dirty.current = true;
      const src = typeof j.id === "string" ? j.id : crypto.randomUUID();
      const entry: PendingOut = {
        key: src, src,
        partner: partner.trim() || null, date,
        rows: [{ product_id: productId, name: productLabel || "품목", qty: Math.round(Number(qty) * 100) / 100 }],
      };
      setPending((prev) => [...prev, entry]);
      setQty(""); setUnitAmount(""); setMemo("");
      await loadList();
    } catch (e) { setError(e instanceof Error ? e.message : "저장 실패"); }
    setSaving(false);
  }

  // 재고에서도 빼기 — 같은 품목·수량·반품일로 소매 출고(사유 '제조사 반품'). 제출 키 = 반품 id(일괄은 UUID) — 다시 눌러도 한 번만.
  //  처음 누를 때 실사 확인 — 반품일 뒤 실사가 있는 품목은 떼어 내 '실사 뒤' 묶음(held)으로 남긴다. held=true 면 그 묶음만 기록([그래도 빼기]).
  async function recordOutflow(held = false) {
    if (busyRef.current || !pendingRef.current.length) return; // 삭제 중이거나 이미 기록 중
    busyRef.current = "out";
    setOutBusy(true); setError(""); setOutDone("");
    let done = 0;
    try {
      const unchecked = pendingRef.current.filter((p) => !p.checked);
      if (!held && unchecked.length) {
        const fail = "실사 기록을 확인하지 못해 출고를 남기지 않았습니다 — 잠시 뒤 다시 누르세요.";
        const res = await fetch("/api/inventory/returns/count-check", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: unchecked.flatMap((p) => p.rows.map((r) => ({ product_id: r.product_id, date: p.date }))) }),
        }).catch(() => null);
        const j = res ? await res.json().catch(() => null) : null;
        if (!res || !res.ok || !j?.ok) throw new Error(j?.error ? `${fail} (${j.error})` : fail);
        const countAt = new Map(((j.held || []) as { product_id: string; date: string; count_date: string }[]).map((h) => [`${h.product_id}|${h.date}`, h.count_date]));
        // 확인한 항목만 key 로 갈라 끼운다 — 기다리는 사이 저장된 반품은 그대로 남고(확인 전), 지워진 반품은 되살아나지 않는다
        const split = new Map(unchecked.map((p): [string, PendingOut[]] => {
          const go = p.rows.filter((r) => !countAt.has(`${r.product_id}|${p.date}`));
          const hold = p.rows.filter((r) => countAt.has(`${r.product_id}|${p.date}`)).map((r) => ({ ...r, countDate: countAt.get(`${r.product_id}|${p.date}`) }));
          return [p.key, [
            ...(go.length ? [{ ...p, rows: go, checked: true }] : []),
            ...(hold.length ? [{ ...p, key: `${p.key}-held`, rows: hold, checked: true, held: true }] : []),
          ]];
        }));
        setPending((prev) => prev.flatMap((p) => (!p.checked && split.has(p.key) ? split.get(p.key)! : [p])));
      }
      for (const po of pendingRef.current.filter((p) => p.checked && !!p.held === held)) {
        if (!pendingRef.current.some((x) => x.key === po.key)) continue; // 그 사이 목록에서 빠짐(반품 삭제·건너뛰기) — 보내지 않는다
        const res = await fetch("/api/inventory/txns/import/apply", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: "소매", done: true, request_key: po.key,
            rows: po.rows.map((r) => ({
              type: "출고", qty: -Math.abs(r.qty), product_id: r.product_id, product_name: r.name, unit_amount: null,
              txn_date: po.date, partner: po.partner, memo: "제조사 반품", reason: "제조사 반품",
            })),
          }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) throw new Error(j?.error || "출고 기록 실패 — [입고 및 출고] 목록에서 기록됐는지 먼저 확인하세요.");
        done += po.rows.length;
        setPending((prev) => prev.filter((x) => x.key !== po.key));
      }
    } catch (e) { setError(e instanceof Error ? e.message : "출고 기록 실패"); }
    finally { busyRef.current = null; }
    if (done) setOutDone(`재고에서 뺐습니다 — 출고 ${done}건(사유 제조사 반품).`);
    setOutBusy(false);
  }

  // 반품 삭제 — 이 반품으로 재고에서 뺀 출고가 있으면 서버가 409 + 확인 문구 + confirm_as 를 준다. 확인하면 그 값으로 다시 보낸다
  //  (1 = 출고까지 함께 취소, keep = 반품만 — 출고 뒤 실사가 있거나 키로 못 찾는 같은 날 출고). 확인 사이에 상황이 바뀌면 서버가 다른 질문을 다시 준다.
  //  조회 실패면 서버가 지우지 않는다(S4). [재고에서도 빼기] 기록 중에는 지우지 않는다(busy 잠금).
  async function remove(id: string) {
    if (busyRef.current) return;
    if (!(await confirm({ title: "반품 기록 삭제", body: "이 반품 기록이 지워집니다. 재고에서 뺀 출고가 있으면 한 번 더 묻습니다.", action: "반품 삭제" }))) return;
    if (busyRef.current) return; // 확인 창을 띄운 사이 다른 동작이 시작됨
    busyRef.current = "remove"; setRemovingId(id);
    setError(""); setWarn(""); setOutDone("");
    try {
      let res = await fetch(`/api/inventory/returns/${id}`, { method: "DELETE" });
      let j = await res.json().catch(() => null);
      for (let n = 0; n < 3 && res.status === 409 && typeof j?.confirm === "string"; n++) {
        if (!(await confirm({ title: "반품 삭제 — 한 번 더 확인", body: j.confirm, action: j.confirm_as === "keep" ? "반품만 삭제" : "출고까지 함께 취소" }))) return;
        const as = j.confirm_as === "keep" ? "keep" : "1";
        res = await fetch(`/api/inventory/returns/${id}?confirm=${as}`, { method: "DELETE" });
        j = await res.json().catch(() => null);
      }
      if (res.status === 404) { setPending((prev) => prev.filter((x) => x.src !== id)); await loadList(); }
      if (!res.ok || !j?.ok) throw new Error(j?.error || "삭제 실패");
      dirty.current = true;
      setPending((prev) => prev.filter((x) => x.src !== id));
      if (j.canceled) setOutDone(`반품 기록과 출고(${j.canceled})를 함께 지웠습니다 — 재고가 원복됐습니다.`);
      else if (j.kept) setOutDone("반품 기록만 지웠습니다.");
      if (j.warning) setWarn(String(j.warning));
      await loadList();
    } catch (e) { setError(e instanceof Error ? e.message : "삭제 실패"); }
    finally { busyRef.current = null; setRemovingId(null); }
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
    if (!preview || busyRef.current === "out") return; // 출고 기록 중 — 버튼도 막혀 있다
    setApplying(true); setError("");
    try {
      const res = await fetch("/api/inventory/returns/import/apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: preview.rows, return_date: date, partner }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "반영 실패");
      dirty.current = true;
      setOutDone("");
      const nameOf = new Map(preview.rows.map((r) => [r.product_id, r.name]));
      const saved = (Array.isArray(j.rows) ? j.rows : []) as { id?: string; product_id: string; qty: number }[];
      // 반품 1건 = 출고 항목 1개(키 = 반품 id) — 목록에서 한 건을 지우면 그 항목만 빠지고, 반품 삭제가 키로 딸린 출고를 찾는다
      const who = partner.trim() || null;
      if (saved.length) setPending((prev) => [...prev, ...saved.map((r): PendingOut => {
        const src = typeof r.id === "string" && r.id ? r.id : crypto.randomUUID();
        return { key: src, src, partner: who, date, rows: [{ product_id: r.product_id, name: nameOf.get(r.product_id) || "품목", qty: Math.round((Number(r.qty) || 0) * 100) / 100 }] };
      })]);
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
          <button className="b2b-modal-close" aria-label="닫기" onClick={close} disabled={closeBlocked}>✕</button>
        </div>
        <div className="b2b-modal-body">
          <div className="sm-tabs" style={{ marginBottom: 12 }}>
            <button className={`sm-tab ${mode === "직접" ? "is-active" : ""}`} onClick={() => switchMode("직접")}>직접 입력</button>
            <button className={`sm-tab ${mode === "엑셀" ? "is-active" : ""}`} onClick={() => switchMode("엑셀")}>엑셀 업로드</button>
          </div>
          <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 10px" }}>반품 기록은 매입 결산만 깎습니다 — 실물을 제조사로 보냈으면 <strong>[재고에서도 빼기]</strong>로 출고를 남기세요.</p>

          {pending.some((p) => !p.held) && (() => {
            const rowsAll = pending.filter((p) => !p.held).flatMap((p) => p.rows);
            return (
            <div className="sm-warn" style={{ marginBottom: 10 }}>
              <div className="sm-between" style={{ gap: 8, flexWrap: "wrap" }}>
                <span>실물을 보냈으면 소매 재고에서 {rowsAll.length === 1 ? `${rowsAll[0].name} ${rowsAll[0].qty.toLocaleString()}` : `${rowsAll.length}품목`} 출고(사유 제조사 반품, 반품일)</span>
                <span className="sm-row" style={{ gap: 6 }}>
                  <button className="b2b-btn-secondary" onClick={() => setPending((prev) => prev.filter((p) => p.held))} disabled={outBusy}>건너뛰기</button>
                  <button className="b2b-btn-primary" onClick={() => recordOutflow(false)} disabled={outBusy || !!removingId}>{outBusy ? "기록 중..." : "재고에서도 빼기"}</button>
                </span>
              </div>
            </div>
            );
          })()}
          {pending.some((p) => p.held) && (() => {
            const heldRows = pending.filter((p) => p.held).flatMap((p) => p.rows);
            const list = heldRows.slice(0, 3).map((r) => `${r.name} ${r.qty.toLocaleString()}(실사 ${String(r.countDate || "").slice(5)})`).join(", ");
            return (
            <div className="sm-warn" style={{ marginBottom: 10 }}>
              <div className="sm-between" style={{ gap: 8, flexWrap: "wrap" }}>
                <span>반품일 뒤 실사가 있어 이미 재고에 반영됐을 수 있습니다 — [입고 및 출고]에서 확인하세요: {list}{heldRows.length > 3 ? ` 외 ${heldRows.length - 3}품목` : ""}</span>
                <span className="sm-row" style={{ gap: 6 }}>
                  <button className="b2b-btn-secondary" onClick={() => setPending((prev) => prev.filter((p) => !p.held))} disabled={outBusy}>건너뛰기</button>
                  <button className="b2b-btn-secondary" onClick={() => recordOutflow(true)} disabled={outBusy || !!removingId}>그래도 빼기</button>
                </span>
              </div>
            </div>
            );
          })()}
          {outDone && <div className="sm-success" style={{ marginBottom: 10 }}>{outDone}</div>}
          {warn && <div className="sm-warn" style={{ marginBottom: 10 }}>{warn}</div>}

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
                  <div className="b2b-empty" style={{ padding: 20 }}>매칭된 품목이 없습니다.</div>
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
                    {preview.rows.length > 300 && <p className="sm-faint" style={{ fontSize: 12, padding: "6px 2px" }}>...외 {preview.rows.length - 300}건(전체 반영됩니다)</p>}
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
                  <label className="b2b-field"><span className="b2b-field-label">반품일 <span className="opt">· 파일 전체</span></span>
                    <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
                  <label className="b2b-field"><span className="b2b-field-label">제조사 <span className="opt">(선택)</span></span>
                    <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} /></label>
                </div>
                <p className="sm-faint" style={{ fontSize: 12, marginTop: 12 }}>
                  <a href={`/api/inventory/returns/template?month=${month}`} className="sm-link">양식 내려받기</a>
                </p>
              </div>
            )
          ) : (
            <>
              <div className="b2b-field"><span className="b2b-field-label">품목</span>
                <span className="b2b-field-hint">초성으로도 검색됩니다</span>
                <Combobox
                  invalid={!!fieldErr.product}
                  value={productLabel}
                  options={productOptions}
                  onSelect={(opt) => { setProductId(opt.id); if (fieldErr.product) setFieldErr((x) => ({ ...x, product: undefined })); }}
                  placeholder="품목·SKU 검색"
                  ariaLabel="품목 검색"
                  emptyText="일치하는 품목이 없습니다"
                />
                {fieldErr.product && <span className="b2b-field-error">{fieldErr.product}</span>}
              </div>
              {product && (
                <p className="sm-faint" style={{ fontSize: 12, margin: "2px 0 8px" }}>
                  {product.qty > 0 ? <>{mm}월 매입 <strong>{product.qty.toLocaleString()}</strong></>
                    : <>{mm}월 매입 없음</>}
                  {alreadyReturned > 0 && <> · 이미 반품 <strong style={{ color: "var(--sm-danger)" }}>{alreadyReturned.toLocaleString()}</strong></>}
                </p>
              )}

              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">반품수량</span>
                  <input className="b2b-input" type="number" step={0.01} min={0} value={qty} onChange={(e) => { setQty(e.target.value); if (fieldErr.qty) setFieldErr((x) => ({ ...x, qty: undefined })); }} placeholder="0" aria-invalid={fieldErr.qty ? "true" : undefined} />
                  {fieldErr.qty && <span className="b2b-field-error">{fieldErr.qty}</span>}</label>
                <label className="b2b-field"><span className="b2b-field-label">반품일</span>
                  <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
              </div>
              <div className="b2b-field-row">
                <label className="b2b-field"><span className="b2b-field-label">반품 단가(원) <span className="opt">· 비우면 매입가</span></span>
                  <input className="b2b-input" type="number" min={0} value={unitAmount} onChange={(e) => setUnitAmount(e.target.value)} placeholder="0" /></label>
                <label className="b2b-field"><span className="b2b-field-label">제조사 <span className="opt">(선택)</span></span>
                  <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} /></label>
              </div>
              <label className="b2b-field"><span className="b2b-field-label">메모 <span className="opt">· 반품 사유</span></span>
                <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>

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
                      <table className="b2b-table is-responsive" style={{ fontSize: 12 }}>
                        <thead><tr><th>날짜</th><th>품목</th><th className="num">수량</th><th className="num">단가</th><th /></tr></thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.id}>
                              <td data-label="날짜" style={{ whiteSpace: "nowrap" }}>{r.return_date.slice(5)}</td>
                              <td data-label="품목" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.memo || ""}>{r.name}</td>
                              <td data-label="수량" className="num b2b-money" style={{ color: "var(--sm-danger)", fontWeight: 700 }}>{r.qty.toLocaleString()}</td>
                              <td data-label="단가" className="num b2b-money">{r.unit_amount ? won(r.unit_amount) : <span className="sm-faint">매입가</span>}</td>
                              <td className="actions">
                                <IconButton className="is-danger" label="삭제" onClick={() => remove(r.id)} disabled={outBusy || !!removingId}>{removingId === r.id ? "..." : "✕"}</IconButton>
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

          {fieldErr.product && fieldErr.qty
            ? <div className="b2b-error" style={{ marginTop: 8 }}><ul><li>{fieldErr.product}</li><li>{fieldErr.qty}</li></ul></div>
            : error ? <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div> : null}
        </div>
        <div className="b2b-modal-foot">
          {mode === "엑셀" && preview
            ? <button className="b2b-btn-secondary" onClick={() => { setPreview(null); setError(""); }} disabled={applying}>← 다시 선택</button>
            : <span />}
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={close} disabled={closeBlocked}>닫기</button>
            {mode === "엑셀" ? (
              preview ? (
                <>
                  {preview.valid === 0 && !applying && <span className="b2b-btn-why">반영할 행이 없습니다</span>}
                  <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.valid === 0 || outBusy}>
                    {applying ? "반영 중..." : `${preview.valid.toLocaleString()}건 반영`}
                  </button>
                </>
              ) : (
                <label className="b2b-btn-primary" style={{ cursor: importing ? "default" : "pointer" }}>
                  {importing ? "분석 중..." : "엑셀 파일 선택"}
                  <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
                </label>
              )
            ) : (
              <button className="b2b-btn-primary" onClick={save} disabled={saving || outBusy}>{saving ? "저장 중..." : "반품 기록"}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
