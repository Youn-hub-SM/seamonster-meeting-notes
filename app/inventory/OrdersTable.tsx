"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INV_TYPE_COLOR } from "@/app/lib/inventory";
import { matchKoQuery } from "@/app/lib/hangul";

type OrderItem = { id: string; product_name: string; sku: string | null; qty: number; unit_amount: number | null; amount: number };
type Order = {
  key: string; order_no: string | null; type: "입고" | "출고"; status: "대기" | "완료"; txn_date: string; created_at: string;
  partner: string | null; memo: string | null; created_by: string | null;
  item_count: number; total_qty: number; total_amount: number; items: OrderItem[];
};

// 입출고 '주문(묶음)' 목록 — BoxHero 구매목록 스타일. 한 번에 입력한 라인이 하나의 주문번호로 묶임.
export default function OrdersTable({ reloadKey = 0 }: { reloadKey?: number }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // 필터 — 유형(전체/입고/출고)·기간은 서버 쿼리, 품목 검색은 로드된 목록에서(초성·다중단어)
  const [fType, setFType] = useState<"전체" | "입고" | "출고">("전체");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [search, setSearch] = useState("");
  // 검색은 서버에서 전체 기록을 뒤진다 — 최근 N행 캡 안에서만 거르면 [전체] 탭에서 과거 매칭 건이
  // 빠진다(입고+출고 합산이 캡을 먼저 채움). 타이핑마다 요청하지 않게 350ms 디바운스.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebouncedSearch(search.trim()), 350); return () => clearTimeout(t); }, [search]);
  // 세부 내역 '전 → 후' 재고 변동 — 펼칠 때 1회 조회해 캐시
  const [balances, setBalances] = useState<Record<string, { before: number; after: number } | null>>({});
  // 세부 내역 단가 인라인 수정 — 단가만 고친다(수량·품목·날짜는 재고에 영향 → 취소 후 재기록)
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);

  // 지금 화면의 orders 가 어떤 검색어로 서버 필터된 것인지 — 클라 재필터를 건너뛸지 판단에 쓴다
  const [loadedQ, setLoadedQ] = useState("");
  // 요청 순번 가드 — 검색 요청(느림)과 일반 요청(빠름)이 겹칠 때 늦게 도착한 이전 응답이
  // 최신 목록을 덮어쓰지 않게 한다(검색어를 지웠는데 검색 결과가 남는 경합).
  const seqRef = useRef(0);

  const kstDay = (back = 0) => { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - back); return d.toISOString().slice(0, 10); };
  const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true); setError("");
    try {
      const qs = new URLSearchParams();
      if (fType !== "전체") qs.set("type", fType);
      if (DATE_OK.test(fFrom)) qs.set("from", fFrom);
      if (DATE_OK.test(fTo)) qs.set("to", fTo);
      if (debouncedSearch) qs.set("q", debouncedSearch);
      const j = await (await fetch("/api/inventory/orders" + (qs.toString() ? "?" + qs.toString() : ""), { cache: "no-store" })).json();
      if (seq !== seqRef.current) return; // 그 사이 새 요청이 나감 — 이 응답은 버린다
      if (!j.ok) throw new Error(j.error || "조회 실패");
      setOrders(j.orders || []);
      setLoadedQ(debouncedSearch);
    } catch (e) { if (seq === seqRef.current) setError(e instanceof Error ? e.message : "조회 오류"); }
    if (seq === seqRef.current) setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fType, fFrom, fTo, debouncedSearch]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const shown = useMemo(() => {
    const q = search.trim();
    if (!q) return orders;
    // 서버가 이미 이 검색어로 거른 목록이면 그대로 쓴다 — 서버(토큰 분해 ilike)와 클라(원문
    // matchKoQuery)의 판정 차이로 "(주)" 같은 검색어에서 찾아온 결과를 떨어뜨리는 일 방지.
    if (q === loadedQ) return orders;
    // 타이핑 중(디바운스 대기)엔 지금 로드된 목록에서 즉시 필터해 반응성 유지
    return orders.filter((o) => matchKoQuery(`${o.items.map((it) => `${it.product_name} ${it.sku || ""}`).join(" ")} ${o.partner || ""} ${o.order_no || ""}`, q));
  }, [orders, search, loadedQ]);

  function toggle(k: string) {
    setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    // 펼칠 때 그 주문 품목들의 '전 → 후' 잔고 조회(미조회분만)
    const o = orders.find((x) => x.key === k);
    if (!o || open.has(k)) return;
    const need = o.items.map((it) => it.id).filter((id) => !(id in balances));
    if (!need.length) return;
    fetch("/api/inventory/orders/balance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txn_ids: need }) })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) setBalances((prev) => ({ ...prev, ...j.balances })); })
      .catch(() => {});
  }
  async function cancel(o: Order) {
    if (!window.confirm(`${o.order_no || "이 건"} (${o.item_count}개 품목)을 취소할까요? 재고가 원복됩니다.`)) return;
    const qs = o.order_no ? `group_id=${encodeURIComponent(o.key)}` : `id=${encodeURIComponent(o.key)}`;
    const r = await fetch(`/api/inventory/orders?${qs}`, { method: "DELETE" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) { alert(`취소 실패: ${j?.error || "서버 오류"} — 새로고침 후 다시 시도하세요.`); return; }
    await load();
  }
  async function saveUnit(it: OrderItem) {
    if (saving) return;
    setSaving(true);
    const r = await fetch("/api/inventory/txn", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, unit_amount: editVal.trim() === "" ? null : Number(editVal) }),
    });
    const j = await r.json().catch(() => null);
    setSaving(false);
    if (!r.ok || !j?.ok) { alert(`단가 수정 실패: ${j?.error || "서버 오류"} — 새로고침 후 다시 시도하세요.`); return; }
    setEditId(null);
    await load(); // 금액·합계는 서버 재계산분으로 갱신
  }
  async function process(o: Order) {
    const key = o.order_no ? { group_id: o.key } : { id: o.key };
    await fetch(`/api/inventory/orders`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...key, status: "완료" }) });
    await load();
  }
  // created_at(UTC timestamptz)을 한국(KST) 시각으로 표시. sv-SE 로케일 = "YYYY-MM-DD HH:mm:ss".
  const dt = (iso: string) => {
    if (!iso) return "-";
    try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16); }
    catch { return iso.slice(0, 16).replace("T", " "); }
  };

  const filters = (
    <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
      <div className="sm-tabs" style={{ margin: 0 }}>
        {(["전체", "입고", "출고"] as const).map((t) => (
          <button key={t} type="button" className={`sm-tab ${fType === t ? "is-active" : ""}`} onClick={() => setFType(t)}>{t}</button>
        ))}
      </div>
      <div className="sm-tabs" style={{ margin: 0 }}>
        <button type="button" className="sm-tab" onClick={() => { setFFrom(kstDay(0)); setFTo(kstDay(0)); }}>오늘</button>
        <button type="button" className="sm-tab" onClick={() => { setFFrom(kstDay(1)); setFTo(kstDay(1)); }}>어제</button>
        <button type="button" className="sm-tab" onClick={() => { setFFrom(kstDay(6)); setFTo(kstDay(0)); }}>7일</button>
        <button type="button" className="sm-tab" onClick={() => { setFFrom(""); setFTo(""); }}>전체</button>
      </div>
      <input className="b2b-input" type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={{ width: 145 }} title="시작일" />
      <span className="sm-faint">~</span>
      <input className="b2b-input" type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{ width: 145 }} title="종료일" />
      <input className="b2b-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="품목·SKU·거래처·주문번호 — 품목은 초성 가능" style={{ width: 280, maxWidth: "100%" }} />
      {(fFrom || fTo || search || fType !== "전체") && (
        <button className="b2b-link-btn" onClick={() => { setFType("전체"); setFFrom(""); setFTo(""); setSearch(""); }}>초기화</button>
      )}
    </div>
  );

  // 재검색·재조회 중엔 기존 목록을 그대로 두고(깜빡임 방지), 첫 로드만 전체 로딩 표시
  if (loading && orders.length === 0) return <>{filters}<div className="b2b-loading">불러오는 중...</div></>;
  if (error) return <>{filters}<div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div></>;
  if (shown.length === 0) return <>{filters}<div className="b2b-empty">{loading ? "검색 중..." : debouncedSearch ? "검색 결과가 없습니다." : orders.length === 0 ? "입고·출고 내역이 없습니다." : "필터에 맞는 내역이 없습니다."}</div></>;

  return (
    <>
    {filters}
    <div className="b2b-table-wrap">
      <table className="b2b-table">
        <thead><tr><th>상태</th><th>일시</th><th>주문번호</th><th>거래처</th><th>품목 수</th><th className="num">총수량</th><th className="num">총액</th><th>메모</th><th></th></tr></thead>
        <tbody>
          {shown.map((o) => {
            const c = INV_TYPE_COLOR[o.type];
            const isOpen = open.has(o.key);
            const done = o.status === "완료";
            const badge = done ? c : { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" };
            return (
              <FragmentRows key={o.key}>
                <tr onClick={() => toggle(o.key)} style={{ cursor: "pointer" }}>
                  <td><span className="b2b-status-pill" style={{ background: badge.bg, color: badge.fg }}>{o.type} {o.status}</span></td>
                  <td style={{ whiteSpace: "nowrap" }}>{dt(o.created_at)}</td>
                  <td style={{ whiteSpace: "nowrap", fontWeight: 700 }}>{o.order_no || <span className="sm-faint">단건</span>}</td>
                  <td>{o.partner || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{o.item_count}개 품목 <span style={{ color: "var(--sm-text-light)", fontSize: 12 }}>{isOpen ? "▲" : "▼"}</span></td>
                  <td className="num b2b-money">{o.total_qty.toLocaleString()}</td>
                  <td className="num b2b-money" style={{ fontWeight: 700 }}>{o.total_amount.toLocaleString()}</td>
                  <td style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.memo || ""}>{o.memo || "-"}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                    {!done && <button className="b2b-btn-secondary" style={{ padding: "3px 10px", fontSize: 12, marginRight: 6 }} onClick={() => process(o)}>{o.type === "입고" ? "입고처리" : "출고처리"}</button>}
                    <button className="b2b-link-btn" onClick={() => cancel(o)} style={{ color: "var(--sm-danger)" }}>취소</button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={9} style={{ background: "var(--sm-bg-subtle)", padding: "10px 16px" }}>
                      {/* tableLayout fixed — 어느 주문을 펼쳐도 세부 표 셀 폭 동일 */}
                      <table className="b2b-table" style={{ background: "var(--sm-white)", tableLayout: "fixed", minWidth: 640 }}>
                        <thead><tr><th>제품</th><th className="num" style={{ width: 210 }}>수량</th><th className="num" style={{ width: 120 }}>단가</th><th className="num" style={{ width: 140 }}>금액</th></tr></thead>
                        <tbody>
                          {o.items.map((it) => {
                            const bal = balances[it.id];
                            return (
                              <tr key={it.id}>
                                <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.product_name}{it.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{it.sku}</span> : null}</td>
                                <td className="num" style={{ whiteSpace: "nowrap" }}>
                                  <span className="b2b-money" style={{ fontWeight: 700 }}>{it.qty.toLocaleString()}</span>
                                  {bal && <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>({bal.before.toLocaleString()} → {bal.after.toLocaleString()})</span>}
                                </td>
                                <td className="num b2b-money" style={{ whiteSpace: "nowrap" }}>
                                  {editId === it.id ? (
                                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                      <input
                                        autoFocus type="number" min={0} className="b2b-input" value={editVal}
                                        onChange={(e) => setEditVal(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") saveUnit(it); if (e.key === "Escape") setEditId(null); }}
                                        style={{ width: 80, padding: "3px 8px", fontSize: 13, textAlign: "right" }}
                                      />
                                      <button className="b2b-link-btn" onClick={() => saveUnit(it)} disabled={saving}>저장</button>
                                      <button className="b2b-link-btn sm-faint" onClick={() => setEditId(null)}>취소</button>
                                    </span>
                                  ) : (
                                    <>
                                      {it.unit_amount ? it.unit_amount.toLocaleString() : "-"}
                                      <button className="b2b-link-btn sm-faint" style={{ marginLeft: 6, fontSize: 12 }} title="단가만 수정합니다 — 수량·날짜는 취소 후 다시 기록"
                                        onClick={() => { setEditId(it.id); setEditVal(it.unit_amount ? String(it.unit_amount) : ""); }}>수정</button>
                                    </>
                                  )}
                                </td>
                                <td className="num b2b-money">{it.amount.toLocaleString()}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) { return <>{children}</>; }
