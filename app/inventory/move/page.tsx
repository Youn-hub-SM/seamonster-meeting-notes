"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Combobox } from "@/app/b2b/orders/Combobox";

type Prod = { id: string; sku: string | null; name: string; spec: string | null; active?: boolean; is_bundle?: boolean; attrs?: string | null };
type Move = { group_id: string; product_name: string; sku: string | null; qty: number; from: string; to: string; txn_date: string; memo: string | null; created_by: string | null; created_at: string; complete: boolean; alloc_qty?: number; alloc_reqs?: string[] };
type Target = { item_id: string; request_id: string; req_no: string | null; title: string | null; request_date: string; due_date: string | null; requested_qty: number; received_qty: number; remaining: number };
// 이동 줄 — 여러 품목을 한 번에 옮긴다(2026-09-16 대표 요청). alloc 은 요청서(item_id)→입력값 문자열.
type Line = { key: number; pid: string; plabel: string; qty: string; targets: Target[]; alloc: Map<string, string> };

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const newLine = (key: number): Line => ({ key, pid: "", plabel: "", qty: "", targets: [], alloc: new Map() });
const nQtyOf = (l: Line) => Math.max(0, Math.round((Number(l.qty) || 0) * 100) / 100);
const allocSumOf = (l: Line) => {
  let s = 0;
  for (const t of l.targets) s += Math.max(0, Math.round((Number(l.alloc.get(t.item_id)) || 0) * 100) / 100);
  return Math.round(s * 100) / 100;
};

export default function InventoryMovePage() {
  const [products, setProducts] = useState<Prod[]>([]);
  const [retail, setRetail] = useState<Map<string, number>>(new Map());
  const [whole, setWhole] = useState<Map<string, number>>(new Map());
  const [moves, setMoves] = useState<Move[]>([]);

  const [lines, setLines] = useState<Line[]>([newLine(1)]);
  const [nextKey, setNextKey] = useState(2);
  const [dir, setDir] = useState<{ from: "소매" | "도매"; to: "소매" | "도매" }>({ from: "소매", to: "도매" });
  const [date, setDate] = useState(kstToday());
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const loadStock = useCallback(async () => {
    const [r, w, m] = await Promise.all([
      fetch("/api/inventory?channel=소매", { cache: "no-store" }).then((x) => x.json()).catch(() => null),
      fetch("/api/inventory?channel=도매", { cache: "no-store" }).then((x) => x.json()).catch(() => null),
      fetch("/api/inventory/move?limit=50", { cache: "no-store" }).then((x) => x.json()).catch(() => null),
    ]);
    if (r?.ok) setRetail(new Map((r.rows || []).map((x: { product_id: string; qty: number }) => [x.product_id, x.qty])));
    if (w?.ok) setWhole(new Map((w.rows || []).map((x: { product_id: string; qty: number }) => [x.product_id, x.qty])));
    if (m?.ok) setMoves(m.moves || []);
  }, []);
  useEffect(() => {
    fetch("/api/products", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) setProducts(j.products || []); }).catch(() => {});
    loadStock();
  }, [loadStock]);

  const fetchTargets = useCallback(async (productId: string): Promise<Target[]> => {
    try {
      const j = await (await fetch(`/api/inventory/move/targets?product_id=${encodeURIComponent(productId)}`, { cache: "no-store" })).json();
      return j.ok ? (j.targets || []) : [];
    } catch { return []; }
  }, []);

  // 방향이 바뀌면 배정 입력 초기화(+소매→도매 복귀 시 요청서 재로드).
  //  주의: fetch 동안의 사용자 편집(수량·줄 추가)이 날아가지 않게, 착지 시 통째 교체가 아니라
  //  key 별로 targets/alloc 만 함수형 병합한다(검증 확정 보정 — 스냅샷 덮어쓰기 방지).
  useEffect(() => {
    let live = true;
    (async () => {
      const snapshot = lines;
      const targetsByKey = new Map<number, Target[]>();
      await Promise.all(snapshot.map(async (l) => {
        targetsByKey.set(l.key, l.pid && dir.from === "소매" ? await fetchTargets(l.pid) : []);
      }));
      if (!live) return;
      setLines((prev) => prev.map((l) => ({ ...l, targets: targetsByKey.get(l.key) ?? [], alloc: new Map<string, string>() })));
    })();
    return () => { live = false; };
    // lines 를 deps 에 넣으면 무한 루프 — 방향 전환 시점의 lines 로만 요청서를 조회한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir.from, fetchTargets]);

  const patchLine = (key: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function selectProduct(key: number, id: string, label: string) {
    patchLine(key, { pid: id, plabel: label, targets: [], alloc: new Map() });
    if (dir.from === "소매") {
      const targets = await fetchTargets(id);
      // 빠른 재선택으로 응답이 뒤바뀌어도 이전 품목의 요청서가 남지 않게 — 여전히 이 품목일 때만 반영
      setLines((prev) => prev.map((l) => (l.key === key && l.pid === id ? { ...l, targets } : l)));
    }
  }

  // 묶음(세트)은 자체 재고가 없어 이동 대상이 아니고, 비활성(단종) 품목도 목록에서 뺀다.
  const options = useMemo(() => products
    .filter((p) => !p.is_bundle && p.active !== false)
    .map((p) => ({ id: p.id, label: p.spec ? `${p.name} | ${p.spec}` : p.name, sub: p.sku || "", extra: p.attrs || "" })), [products]);

  const activeLines = lines.filter((l) => l.pid && nQtyOf(l) > 0);
  const totalQty = Math.round(activeLines.reduce((s, l) => s + nQtyOf(l), 0) * 100) / 100;
  // 중복 판정은 '실제 전송될 줄' 기준 — 수량을 지운 줄까지 세면 서버는 통과인데 화면만 막는다(검증 지적)
  const dupPids = useMemo(() => {
    const seen = new Set<string>(), dup = new Set<string>();
    for (const l of activeLines) { if (seen.has(l.pid)) dup.add(l.pid); seen.add(l.pid); }
    return dup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);
  const anyAllocOver = activeLines.some((l) => allocSumOf(l) > nQtyOf(l) + 0.001);

  async function submit() {
    setError(""); setOk("");
    if (activeLines.length === 0) { setError("품목과 수량을 1줄 이상 입력하세요."); return; }
    if (dupPids.size > 0) { setError("같은 품목이 두 줄에 있습니다 — 한 줄로 합쳐 주세요."); return; }
    if (anyAllocOver) { setError("배정 합계가 이동 수량보다 많은 품목이 있습니다. 배정을 줄이세요."); return; }
    // 수량 없이 배정만 입력된 줄 — 조용히 빠지면 배정이 유실된 줄 모른다(검증 확정): 명시적으로 막는다
    const allocNoQty = lines.find((l) => l.pid && nQtyOf(l) === 0 && allocSumOf(l) > 0);
    if (allocNoQty) { setError(`'${allocNoQty.plabel}' 줄에 배정만 있고 이동 수량이 없습니다 — 수량을 넣거나 줄을 삭제하세요.`); return; }
    const items = activeLines.map((l) => ({
      product_id: l.pid,
      qty: nQtyOf(l),
      allocations: l.targets
        .map((t) => ({ item_id: t.item_id, qty: Math.max(0, Math.round((Number(l.alloc.get(t.item_id)) || 0) * 100) / 100) }))
        .filter((a) => a.qty > 0),
    }));
    setBusy(true);
    try {
      const res = await fetch("/api/inventory/move", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: dir.from, to: dir.to, txn_date: date, memo, items }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        // 부분 실패 응답에도 경고(앞 줄의 배정 경고 등)가 실려 온다 — 함께 표시(검증 확정 보정)
        const extra = Array.isArray(j?.warnings) && j.warnings.length ? ` · ${j.warnings.join(" · ")}` : "";
        setError(`${j?.error || "이동 실패"}${extra}`);
        await loadStock();
        setBusy(false);
        return;
      }
      const allocTotal = Math.round(items.reduce((s, it) => s + it.allocations.reduce((a, x) => a + x.qty, 0), 0) * 100) / 100;
      setOk(`${items.length}개 품목 ${totalQty.toLocaleString()}개를 ${dir.from} → ${dir.to} 로 옮겼어요.${allocTotal > 0 ? ` (요청서 배정 ${allocTotal.toLocaleString()} · 기타 ${Math.max(0, Math.round((totalQty - allocTotal) * 100) / 100).toLocaleString()})` : ""}`);
      if (Array.isArray(j.warnings) && j.warnings.length) setError(j.warnings.join(" · "));
      setLines([newLine(nextKey)]); setNextKey((k) => k + 1); setMemo("");
      await loadStock();
    } catch (e) { setError(e instanceof Error ? e.message : "이동 실패"); await loadStock(); }
    setBusy(false);
  }

  async function cancelMove(group_id: string) {
    if (!window.confirm("이 이동을 취소할까요? 양쪽 채널 재고가 원래대로 돌아갑니다.")) return;
    const r = await fetch(`/api/inventory/move?group_id=${encodeURIComponent(group_id)}`, { method: "DELETE" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) { alert(`취소 실패: ${j?.error || "서버 오류"} — 새로고침 후 다시 시도하세요.`); return; }
    await loadStock();
    // 취소로 요청서 잔여·상태가 바뀌었을 수 있음 — 열려 있는 줄의 요청서 목록 갱신
    if (dir.from === "소매") {
      for (const l of lines) if (l.pid) { const targets = await fetchTargets(l.pid); patchLine(l.key, { targets }); }
    }
  }

  const swap = () => setDir((d) => ({ from: d.to, to: d.from }));

  return (
    <div className="b2b-container" style={{ maxWidth: 820 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">재고 옮기기 (소매 ↔ 도매)</h1>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {ok && <div className="sm-success">✓ {ok}</div>}

      <section className="b2b-card" style={{ marginBottom: 16 }}>
        <div className="b2b-field">
          <label className="b2b-field-label">어디로 옮길까요?</label>
          <div className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div className="sm-tabs" style={{ margin: 0 }}>
              <button className={`sm-tab ${dir.from === "소매" ? "is-active" : ""}`} onClick={() => setDir({ from: "소매", to: "도매" })}>소매 → 도매</button>
              <button className={`sm-tab ${dir.from === "도매" ? "is-active" : ""}`} onClick={() => setDir({ from: "도매", to: "소매" })}>도매 → 소매</button>
            </div>
            <button className="b2b-btn-secondary" onClick={swap} style={{ padding: "6px 10px", fontSize: 12 }} title="방향 뒤집기">⇄</button>
            <span className="sm-faint" style={{ fontSize: 12 }}>{dir.from} 재고에서 빼고 → {dir.to} 재고에 더함</span>
          </div>
        </div>

        {lines.map((l, idx) => {
          const fromQty = l.pid ? (dir.from === "소매" ? retail.get(l.pid) : whole.get(l.pid)) ?? 0 : 0;
          const toQty = l.pid ? (dir.to === "소매" ? retail.get(l.pid) : whole.get(l.pid)) ?? 0 : 0;
          const nQty = nQtyOf(l);
          const shortage = l.pid && nQty > 0 && nQty > fromQty;
          const allocSum = allocSumOf(l);
          const allocOver = allocSum > nQty + 0.001;
          const isDup = l.pid && dupPids.has(l.pid);
          return (
            <div key={l.key} style={{ border: "1px solid var(--sm-border)", borderRadius: 10, padding: 14, marginTop: 12 }}>
              <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span className="sm-faint" style={{ fontSize: 12, fontWeight: 700 }}>품목 {idx + 1}</span>
                {lines.length > 1 && (
                  <button className="b2b-link-btn" style={{ color: "var(--sm-danger)", fontSize: 12 }} onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}>줄 삭제</button>
                )}
              </div>
              <div className="b2b-field">
                <Combobox value={l.plabel} options={options}
                  onSelect={(o) => { void selectProduct(l.key, o.id, o.label); }}
                  placeholder="제품 검색 — 이름 또는 SKU" ariaLabel={`품목 ${idx + 1}`} />
                {isDup && <span style={{ fontSize: 12, color: "var(--sm-danger)" }}>같은 품목이 다른 줄에도 있습니다 — 한 줄로 합쳐 주세요.</span>}
              </div>
              {l.pid && (
                <div className="sm-row" style={{ gap: 12, margin: "8px 0 0", fontSize: 14, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="b2b-status-pill" style={{ background: "var(--sm-info-bg)", color: "var(--sm-info)" }}>소매 {(retail.get(l.pid) ?? 0).toLocaleString()}</span>
                  <span className="b2b-status-pill" style={{ background: "var(--sm-orange-light)", color: "var(--sm-orange)" }}>도매 {(whole.get(l.pid) ?? 0).toLocaleString()}</span>
                  <input className="b2b-input b2b-money" type="number" min={0.01} step={0.01} value={l.qty}
                    onChange={(e) => patchLine(l.key, { qty: e.target.value })}
                    placeholder="옮길 수량" style={{ width: 120 }} aria-label={`품목 ${idx + 1} 수량`} />
                  {nQty > 0 && (
                    <span className="sm-faint" style={{ fontSize: 12 }}>
                      옮긴 뒤 — {dir.from} {(fromQty - nQty).toLocaleString()} · {dir.to} {(toQty + nQty).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              {shortage && <p style={{ fontSize: 12, color: "var(--sm-danger)", margin: "6px 0 0" }}>{dir.from} 재고({fromQty.toLocaleString()})보다 많아요. 그래도 옮기면 {dir.from}가 마이너스가 됩니다.</p>}

              {dir.from === "소매" && l.pid && (
                <div style={{ marginTop: 10 }}>
                  {l.targets.length === 0 ? (
                    <p className="sm-faint" style={{ fontSize: 12, margin: 0 }}>열린 도매 생산 요청 없음 — 전량 기타(요청 미연결)로 기록됩니다.</p>
                  ) : (
                    <>
                      <div className="b2b-table-wrap">
                        <table className="b2b-table">
                          <thead><tr><th>요청서</th><th>마감일</th><th className="num">요청</th><th className="num">기입고</th><th className="num">잔여</th><th className="num" style={{ width: 120 }}>배정 수량</th></tr></thead>
                          <tbody>
                            {l.targets.map((t) => {
                              const v = l.alloc.get(t.item_id) || "";
                              const n = Math.max(0, Math.round((Number(v) || 0) * 100) / 100);
                              const overRemain = n > t.remaining + 0.001;
                              return (
                                <tr key={t.item_id}>
                                  <td><strong>{t.req_no || "-"}</strong>{t.title ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{t.title}</span> : null}</td>
                                  <td style={{ whiteSpace: "nowrap" }}>{t.due_date || "-"}</td>
                                  <td className="num b2b-money">{t.requested_qty.toLocaleString()}</td>
                                  <td className="num b2b-money">{t.received_qty.toLocaleString()}</td>
                                  <td className="num b2b-money" style={{ fontWeight: 700 }}>{t.remaining.toLocaleString()}</td>
                                  <td className="num">
                                    <input className="b2b-input b2b-money" type="number" min={0} step={0.01} value={v}
                                      onChange={(e) => { const m2 = new Map(l.alloc); m2.set(t.item_id, e.target.value); patchLine(l.key, { alloc: m2 }); }}
                                      style={{ width: 100, textAlign: "right" }} placeholder="0" aria-label={`${t.req_no || "요청서"} 배정 수량`} />
                                    {overRemain && <div style={{ fontSize: 11, color: "var(--sm-orange)" }}>잔여보다 많음</div>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p style={{ fontSize: 12, marginTop: 6, color: allocOver ? "var(--sm-danger)" : "var(--sm-text-mid)" }}>
                        요청서 배정 {allocSum.toLocaleString()} + 기타 {Math.max(0, Math.round((nQty - allocSum) * 100) / 100).toLocaleString()} = 이동 {nQty.toLocaleString()}
                        {allocOver && " — 배정 합계가 이동 수량보다 많아 저장할 수 없습니다"}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <div className="sm-row" style={{ marginTop: 10 }}>
          <button className="b2b-btn-secondary" style={{ fontSize: 13 }} onClick={() => { setLines((prev) => [...prev, newLine(nextKey)]); setNextKey((k) => k + 1); }}>+ 품목 추가</button>
        </div>

        {dir.from === "소매" && activeLines.some((l) => l.targets.length > 0) && (
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 10 }}>배정으로 요청서가 100% 채워지면 자동으로 완료되어 도매 요청 종합에서 빠집니다. 이동을 취소하면 배정도 함께 돌아옵니다.</p>
        )}

        <div className="b2b-field-row" style={{ marginTop: 12 }}>
          <div className="b2b-field">
            <label className="b2b-field-label">옮긴 날짜</label>
            <input className="b2b-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="b2b-field">
            <label className="b2b-field-label">메모 <span className="sm-faint" style={{ fontWeight: 400 }}>(선택 · 전체 공통)</span></label>
            <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 도매 주문 대응" />
          </div>
        </div>

        <div className="sm-row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 12, flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontSize: 14 }}>{activeLines.length > 0 ? <>합계 <strong>{activeLines.length}개 품목 · {totalQty.toLocaleString()}개</strong></> : <span className="sm-faint">품목과 수량을 입력하세요</span>}</span>
          <button className="b2b-btn-primary" onClick={submit} disabled={busy || activeLines.length === 0}>{busy ? "옮기는 중..." : `옮기기${activeLines.length > 1 ? ` (${activeLines.length}개 품목)` : ""}`}</button>
        </div>
      </section>

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">최근 옮긴 내역 <span className="sm-faint" style={{ fontSize: 12, fontWeight: 400 }}>· {moves.length}건</span></span></div>
        {moves.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 20 }}>아직 옮긴 내역이 없습니다.</div>
        ) : (
          <div className="b2b-table-wrap">
            <table className="b2b-table">
              <thead><tr><th>날짜</th><th>품목</th><th className="num">수량</th><th>방향</th><th>담당</th><th></th></tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.group_id}>
                    <td style={{ whiteSpace: "nowrap" }}>{m.txn_date}</td>
                    <td>
                      <strong>{m.product_name}</strong>
                      {m.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{m.sku}</span> : null}
                      {m.memo ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>· {m.memo}</span> : null}
                      {(m.alloc_qty ?? 0) > 0 && (
                        <div className="sm-faint" style={{ fontSize: 12 }}>
                          배정 {Number(m.alloc_qty).toLocaleString()} → {(m.alloc_reqs || []).join(", ") || "요청서"}
                          {m.qty - (m.alloc_qty ?? 0) > 0.001 ? ` · 기타 ${(Math.round((m.qty - (m.alloc_qty ?? 0)) * 100) / 100).toLocaleString()}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="num b2b-money" style={{ fontWeight: 700 }}>{m.qty.toLocaleString()}</td>
                    <td><span className="b2b-status-pill" style={{ background: "var(--sm-bg-subtle)", color: "var(--sm-text-mid)" }}>{m.from} → {m.to}</span>{!m.complete && <span style={{ marginLeft: 6, fontSize: 12, color: "var(--sm-danger)" }}>불완전</span>}</td>
                    <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{m.created_by || "-"}</td>
                    <td><button className="b2b-link-btn" onClick={() => cancelMove(m.group_id)} style={{ color: "var(--sm-danger)" }}>취소</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
