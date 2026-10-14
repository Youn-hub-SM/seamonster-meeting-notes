"use client";

import { useCallback, useEffect, useState } from "react";
import { INV_TYPE_COLOR, INV_CHANNEL_COLOR, type InventoryTxn, type InvTxnType, type InvChannel } from "@/app/lib/inventory";

// 칸 이동·프로모션 합류 행인가 — app/lib/production-velocity.ts isMoveRow 와 같은 규칙(S1·S11, 화면용 순수 함수 — supabase 를 끌어오지 않는다).
//  source(131)가 있으면 move·promo_close 만 이동, 없으면(131 이전 기록·미적용) 주문번호 없는 partner '채널이동'.
//  주문번호를 못 읽은 응답(undefined)이면 종전처럼 partner 만으로 본다. 잠금 판정은 서버(lockKindOf)가 한다 — 이건 표시·경로 고르기용.
export const MOVE_SOURCES: ReadonlySet<string> = new Set(["move", "promo_close"]);
export const isMoveTxn = (r: { source?: string | null; partner?: string | null; order_no?: string | null }): boolean =>
  r.source != null ? MOVE_SOURCES.has(r.source) : (r.partner === "채널이동" && !r.order_no);

// 원장 취소 DELETE 공용(txn·orders·move) — 서버 계약:
//  409 code 'confirm_required'(온라인발주 배치 한 줄·되살릴 수 없는 [재고 차감 기록] 묶음) → 서버 확인 문구로 묻고 같은 URL 에 confirm=1 을 붙여 다시 보낸다.
//  그 밖의 409(locked_* 등)는 규칙상 거부라 문구만 보이고 재시도를 권하지 않는다. 응답이 끊기면 취소됐을 수 있다고 알린다.
//  ok=false 면 이미 알렸거나(실패) 사람이 확인창에서 그만뒀다. notice = 성공 안내(예: [재고 차감 기록] 목록에 다시 올림).
//  부분 성공(원장 행은 지웠고 뒤처리만 실패, 아래 isPartial)은 ok=true·warn=true·notice=서버 문구 — 호출부가 목록을 다시 읽고
//  문구를 닫을 때까지 남는 경고 배너로 보인다(적어 둘 코드가 들어 있다, S9). 실패로 다루면 '다시 시도'로 읽혀 404 를 받거나 따로 보정해 이중 반영된다.
export type LedgerDeleteResult = { ok: boolean; notice?: string; warn?: boolean };
type LedgerJ = { ok?: boolean; error?: string; code?: string; confirm?: string; notice?: string; deleted?: boolean; partial?: boolean } | null;
// 서버 표식(deleted·partial)을 우선 보고, 표식이 없는 응답은 문구 머리로 본다 — '재고는 원복됐지만 ...' 은 txn·orders DELETE 가
//  행을 지운 뒤에만 내는 문구다(FULFILL_MARK_FAIL·미반영분 출고 취소 실패·135 폴백 키/이력 삭제 실패·[재고 차감 기록] 목록 재오픈 실패).
const isPartial = (j: LedgerJ): boolean =>
  !!j && (j.deleted === true || j.partial === true || (!j.code && /^재고는 원복됐지만/.test(j.error || "")));
export async function deleteLedger(url: string): Promise<LedgerDeleteResult> {
  type J = LedgerJ;
  const send = async (u: string): Promise<{ r: Response | null; j: J }> => {
    try {
      const r = await fetch(u, { method: "DELETE" });
      return { r, j: (await r.json().catch(() => null)) as J };
    } catch { return { r: null, j: null }; }
  };
  let { r, j } = await send(url);
  if (r?.status === 409 && j?.code === "confirm_required") {
    if (!window.confirm(j.confirm || j.error || "이 기록을 취소할까요?")) return { ok: false };
    ({ r, j } = await send(`${url}${url.includes("?") ? "&" : "?"}confirm=1`));
  }
  if (!r) { alert("응답을 받지 못했습니다 — 취소됐을 수 있으니 새로고침해 먼저 확인하세요."); return { ok: false }; }
  if (!r.ok || !j?.ok) {
    if (isPartial(j)) return { ok: true, warn: true, notice: j?.error || "재고는 원복됐지만 뒤처리 일부를 마치지 못했습니다 — 새로고침해 목록을 확인하세요." };
    const tail = r.status === 409 || /새로고침|다시 시도/.test(j?.error || "") ? "" : " — 새로고침 후 다시 시도하세요.";
    alert(`취소 실패: ${j?.error || "서버 오류"}${tail}`);
    return { ok: false };
  }
  return { ok: true, notice: j.notice || undefined };
}

// 재고 원장 테이블 — 활동 히스토리·구매판매·조정 공용. type/types 필터·품목 필터 지원, 행 취소.
export default function TxnTable({ type, types, productId, reloadKey = 0, onChanged }: { type?: InvTxnType; types?: InvTxnType[]; productId?: string; reloadKey?: number; onChanged?: () => void }) {
  const [rows, setRows] = useState<InventoryTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 단가 인라인 수정 — 단가만 고칠 수 있다(수량·품목·날짜는 재고에 영향 → 취소 후 재기록)
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);
  // 취소 결과 안내(성공 notice·부분 성공 경고) — 목록을 다시 읽어도 남고 [닫기]로 지운다(적어 둘 문구가 들어 있을 수 있다, S9)
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const sp = new URLSearchParams();
      if (type) sp.set("type", type);
      if (productId) sp.set("product_id", productId);
      const j = await (await fetch(`/api/inventory/txns?${sp.toString()}`, { cache: "no-store" })).json();
      if (!j.ok) throw new Error(j.error || "조회 실패");
      const all: InventoryTxn[] = j.rows || [];
      setRows(types && types.length ? all.filter((t) => types.includes(t.type)) : all);
    } catch (e) { setError(e instanceof Error ? e.message : "조회 오류"); }
    setLoading(false);
  }, [type, types, productId]);
  useEffect(() => { load(); }, [load, reloadKey]);

  async function cancel(t: InventoryTxn) {
    if (!window.confirm(`이 거래를 취소(삭제)할까요? ${t.status === "대기" ? "대기 기록이 지워집니다." : "재고가 원복됩니다."}`)) return;
    setFlash(null);
    const res = await deleteLedger(`/api/inventory/txn?id=${encodeURIComponent(t.id)}`);
    if (!res.ok) return;
    if (res.notice) setFlash({ ok: !res.warn, text: res.notice });
    await load();
    onChanged?.();
  }

  async function saveUnit(t: InventoryTxn) {
    if (saving) return;
    setSaving(true);
    const r = await fetch("/api/inventory/txn", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, unit_amount: editVal.trim() === "" ? null : Number(editVal) }),
    });
    const j = await r.json().catch(() => null);
    setSaving(false);
    if (!r.ok || !j?.ok) { alert(`단가 수정 실패: ${j?.error || "서버 오류"} — 새로고침 후 다시 시도하세요.`); return; }
    setEditId(null);
    await load();
    onChanged?.();
  }

  const flashEl = flash && (
    <div className={flash.ok ? "sm-success" : "sm-warn"} style={{ marginBottom: 12, whiteSpace: "pre-line", display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ flex: 1 }}>{flash.text}</span>
      <button className="b2b-link-btn" onClick={() => setFlash(null)}>닫기</button>
    </div>
  );
  if (loading) return <>{flashEl}<div className="b2b-loading">불러오는 중...</div></>;
  if (error) return <>{flashEl}<div className="b2b-error">{error}{(error.includes("inventory") || error.includes("relation")) ? " — supabase/migrations/031_inventory.sql 를 먼저 적용하세요." : ""}</div></>;
  if (rows.length === 0) return <>{flashEl}<div className="b2b-empty">내역이 없습니다.</div></>;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  return (
    <>{flashEl}
    <div className="b2b-table-wrap">
      <table className="b2b-table">
        <thead><tr><th>거래일</th><th>품목</th><th>유형</th><th>채널</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th><th>메모</th><th>담당</th><th></th></tr></thead>
        <tbody>
          {rows.map((t) => {
            const c = INV_TYPE_COLOR[t.type];
            const ch = t.channel ? INV_CHANNEL_COLOR[t.channel as InvChannel] : null;
            return (
              <tr key={t.id}>
                <td style={{ whiteSpace: "nowrap" }}>{t.txn_date?.slice(5)}</td>
                <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.product_name}{t.sku ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{t.sku}</span> : null}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{t.type}</span>
                  {/* 대기 = 현재고에 안 들어간 행, 예정 = 오늘 뒤 거래일(대개 B2B 선점) — 오늘 재고와 구분해 보인다(S6) */}
                  {t.status === "대기"
                    ? <span className="b2b-status-pill" style={{ marginLeft: 4, background: "var(--sm-warning-bg)", color: "var(--sm-warning)" }}>대기</span>
                    : t.txn_date > today ? <span className="b2b-status-pill" style={{ marginLeft: 4, background: "var(--sm-info-bg)", color: "var(--sm-info)" }}>예정</span> : null}
                </td>
                <td>{ch ? <span className="b2b-status-pill" style={{ background: ch.bg, color: ch.fg }}>{t.channel}</span> : <span className="sm-faint">-</span>}</td>
                <td className="num b2b-money" style={{ color: c.fg, fontWeight: 700 }}>{t.qty > 0 ? "+" : ""}{t.qty.toLocaleString()}</td>
                <td className="num b2b-money" style={{ whiteSpace: "nowrap" }}>
                  {editId === t.id ? (
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                      <input
                        autoFocus type="number" min={0} className="b2b-input" value={editVal}
                        onChange={(e) => setEditVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveUnit(t); if (e.key === "Escape") setEditId(null); }}
                        style={{ width: 90, padding: "3px 8px", fontSize: 15, textAlign: "right" }}
                      />
                      <button className="b2b-link-btn" onClick={() => saveUnit(t)} disabled={saving}>저장</button>
                      <button className="b2b-link-btn sm-faint" onClick={() => setEditId(null)}>취소</button>
                    </span>
                  ) : (
                    <>
                      {t.unit_amount ? t.unit_amount.toLocaleString() : "-"}
                      {t.type !== "조정" && (
                        <button className="b2b-link-btn sm-faint" style={{ marginLeft: 6, fontSize: 12 }} title="단가만 수정합니다 — 수량·날짜는 취소 후 다시 기록"
                          onClick={() => { setEditId(t.id); setEditVal(t.unit_amount ? String(t.unit_amount) : ""); }}>수정</button>
                      )}
                    </>
                  )}
                </td>
                <td>{t.partner || "-"}</td>
                <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.memo || ""}>{t.memo || "-"}</td>
                <td className="sm-faint" style={{ whiteSpace: "nowrap" }}>{t.created_by || "-"}</td>
                <td><button className="b2b-link-btn" onClick={() => cancel(t)} style={{ color: "var(--sm-danger)" }}>취소</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}
