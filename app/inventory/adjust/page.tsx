"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INV_CHANNELS, INV_TYPE_COLOR, type InventoryRow, type InvChannel, type InvTxnType } from "@/app/lib/inventory";
import type { AdjustRow } from "@/app/api/inventory/adjust/import/route";
import type { CountChecks } from "@/app/api/inventory/adjust/count-check";
import TxnModal from "../TxnModal";
import TxnTable from "../TxnTable";
import { ChannelPicker } from "../ChannelTabs";

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const shift = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// 반영 한 번의 키 — 더블클릭·재요청이 같은 조정을 두 번 넣지 않게 서버가 request_key 로 막는다(S2)
const newBatchKey = () => {
  try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
};

// reqChannel·reqDate = 이 미리보기를 만든 칸·실사일. 분석 중에 바꿔도 표(옛 기준 델타)와 반영이 어긋나지 않게 화면·반영 모두 이 값을 쓴다.
type Preview = {
  reqChannel: InvChannel; reqDate: string; batchKey: string;
  summary: { valid: number; changed: number; errors: number; skipped?: number; untracked?: number };
  rows: AdjustRow[]; errors: { line: number; msg: string }[]; checks?: CountChecks;
};
type Notice = { ok: boolean; text: string };

// 확인이 필요한 점검 — B2B 선점 미발송·대기 행·실사일 당일 입출고·양식 기준일 ≠ 실사일. 실사일 뒤 입출고는 조정 뒤에 그대로 남아 확인 대상이 아니다.
const needsAck = (c?: CountChecks | null) => !!c && (c.b2b.length > 0 || c.pendingTotal > 0 || c.sameDay > 0 || !!c.formDate);

export default function AdjustPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  // 실사 칸은 사람이 고른다(S8) — 기본값을 두면 다른 칸을 센 수량이 그 칸에 덮어써진다
  const [channel, setChannel] = useState<InvChannel | null>(null);
  const [countDate, setCountDate] = useState(TODAY());
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ack, setAck] = useState(false);
  const minDate = shift(TODAY(), -31);
  const dateOk = countDate >= minDate && countDate <= TODAY();

  const load = useCallback(async () => {
    if (!channel) { setRows([]); return; }
    const j = await (await fetch(`/api/inventory?channel=${encodeURIComponent(channel)}`, { cache: "no-store" })).json().catch(() => null);
    if (j?.ok) setRows(j.rows || []);
  }, [channel]);
  useEffect(() => { load(); }, [load]);
  const products = useMemo(() => rows.map((r) => ({ id: r.product_id, name: r.name, sku: r.sku, unit: r.unit, is_bundle: r.is_bundle })), [rows]);
  const qtyOf = useCallback((id: string) => rows.find((r) => r.product_id === id)?.qty || 0, [rows]);

  // 실사 전 점검(D4a·S8) — 칸·실사일이 정해지면 세기 전에 보여 준다. 늦게 온 옛 응답은 버린다.
  const [pre, setPre] = useState<{ checks: CountChecks | null; error: string; loading: boolean }>({ checks: null, error: "", loading: false });
  const preSeq = useRef(0);
  const loadPre = useCallback(async () => {
    const seq = ++preSeq.current;
    if (!channel || !dateOk) { setPre({ checks: null, error: "", loading: false }); return; }
    setPre({ checks: null, error: "", loading: true }); // 다른 칸·날짜의 옛 결과를 남기지 않는다
    try {
      const j = await (await fetch(`/api/inventory/adjust/precheck?channel=${encodeURIComponent(channel)}&date=${countDate}`, { cache: "no-store" })).json().catch(() => null);
      if (seq !== preSeq.current) return;
      if (!j?.ok || !j.checks) throw new Error(j?.error || "점검 응답을 받지 못했습니다"); // ok:false(501·500)·응답 끊김·결과 누락 = 확인 못 함
      setPre({ checks: j.checks, error: "", loading: false });
    } catch (e) { if (seq === preSeq.current) setPre({ checks: null, error: e instanceof Error ? e.message : "점검 실패", loading: false }); }
  }, [channel, countDate, dateOk]);
  useEffect(() => { loadPre(); }, [loadPre]);
  // 실사 전 점검(발송일 지난 B2B 선점·대기 등)을 읽었을 때만 실사를 받는다 — 못 읽은 것(ok:false·응답 끊김)은 '경고 없음'이 아니라 '확인 못 함'(S4)
  const preOk = !!pre.checks && !pre.loading && !pre.error;
  const preHint = pre.loading ? "실사 전 점검 중입니다" : pre.error ? "실사 전 점검을 확인하지 못했습니다 — [다시 확인]을 누르세요" : undefined;

  async function handleFile(file: File) {
    if (!channel || !dateOk || !preOk) return;
    const reqChannel = channel, reqDate = countDate; // 이 요청의 칸·실사일을 고정
    setImporting(true); setError(""); setNotice(null);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("channel", reqChannel); fd.append("count_date", reqDate);
      const res = await fetch("/api/inventory/adjust/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setAck(false);
      setPreview({ summary: j.summary, rows: j.rows || [], errors: j.errors || [], checks: j.checks, reqChannel, reqDate, batchKey: newBatchKey() });
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setImporting(false);
  }
  async function applyImport() {
    if (!preview) return;
    // 이 파일 품목의 점검이 없으면(구 서버·응답 누락) 확인 없이 반영하지 않는다(S4)
    if (!preview.checks) { setError("이 파일의 실사 전 점검을 확인하지 못했습니다 — 파일을 다시 올리세요."); return; }
    setApplying(true); setError("");
    try {
      const res = await fetch("/api/inventory/adjust/import/apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // 칸·실사일은 미리보기를 만든 값으로 — 화면에서 확인한 현재고·조정값과 실제 기록되는 칸·거래일이 같아야 한다.
        body: JSON.stringify({ channel: preview.reqChannel, count_date: preview.reqDate, batch_key: preview.batchKey, rows: preview.rows.map((r) => ({ product_id: r.product_id, target: r.target, memo: r.memo })) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "반영 실패");
      const parts: string[] = [];
      if (j.note) parts.push(j.note); else parts.push(`${Number(j.applied) || 0}건 조정했습니다.`);
      if (Number(j.invalid) > 0) parts.push(`${j.invalid}건은 실사수량이 숫자가 아니라 건너뛰었습니다.`);
      const mm = Array.isArray(j.mismatch) ? j.mismatch.length : 0;
      if (mm > 0) parts.push(`반영 직후 ${mm}종이 실사수량과 다릅니다 — 같은 순간 다른 기록이 들어왔을 수 있으니 조정 내역을 확인하세요.`);
      setNotice({ ok: mm === 0 && !(Number(j.invalid) > 0), text: parts.join(" ") });
      setPreview(null); setReload((n) => n + 1); load(); loadPre();
    } catch (e) { setError(e instanceof Error ? e.message : "반영 실패"); }
    setApplying(false);
  }

  const templateHref = channel ? `/api/inventory/adjust/template?fill=1&channel=${encodeURIComponent(channel)}&asof=${countDate}` : "";
  const ready = !!channel && dateOk;
  const canCount = ready && preOk; // 엑셀 업로드·한 품목 조정은 점검을 읽은 뒤에만

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">재고 조정</h1></div>
        <div className="b2b-page-actions">
          <ChannelPicker value={channel} onChange={(c) => { setChannel(c); setNotice(null); }} disabledChannels={importing ? INV_CHANNELS : undefined} disabledHint="분석 중에는 칸을 바꿀 수 없습니다" style={{ marginRight: 4 }} />
          <label className="sm-row" style={{ gap: 6 }} title="센 수량이 맞아야 하는 날(그날 마감 기준)">
            <span className="b2b-field-label" style={{ margin: 0 }}>실사일</span>
            <input type="date" className="b2b-input" value={countDate} min={minDate} max={TODAY()} disabled={importing}
              onChange={(e) => { setCountDate(e.target.value); setNotice(null); }} style={{ width: "auto" }} />
          </label>
          {ready
            ? <a className="b2b-btn-secondary" href={templateHref} title="SKU·품목명·실사일 기준 현재고가 채워진 양식">엑셀 양식</a>
            : <button className="b2b-btn-secondary" disabled title="칸·실사일을 먼저 고르세요">엑셀 양식</button>}
          <label className="b2b-btn-secondary" style={{ cursor: canCount && !importing ? "pointer" : "not-allowed", opacity: canCount ? 1 : 0.5 }} title={!ready ? "칸·실사일을 먼저 고르세요" : preHint}>
            {importing ? "분석 중..." : "엑셀 업로드"}
            <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing || !canCount}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          </label>
          <button className="b2b-btn-primary" onClick={() => setOpen(true)} disabled={!canCount} title={!ready ? "칸·실사일을 먼저 고르세요" : preHint || "한 품목 조정 — 이 칸·실사일로 열립니다"}>+ 조정 기록</button>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {notice && <div className={notice.ok ? "sm-success" : "sm-warn"} style={{ marginBottom: 12 }}>{notice.text}</div>}
      {!dateOk && <div className="b2b-error">실사일은 최근 31일 안, 오늘까지 고를 수 있습니다.</div>}

      {/* 수동 절차(D4) — 실사가 장부와 선반의 원래 어긋남을 덮지 않게 세기 전에 정리할 것 */}
      <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 12px" }}>실사 전: 발송 안 된 B2B 발주 정리 · 대기 건 처리 · 고객 반품은 입고(사유 &apos;고객 반품&apos;)로 먼저 기록 · 실사일 = 그날 마감 기준(그날 입출고 전에 셌다면 전날)</p>

      {!channel ? (
        <div className="b2b-empty" style={{ marginBottom: 16 }}>실사할 칸을 고르세요.</div>
      ) : pre.loading ? (
        <div className="b2b-loading" style={{ marginBottom: 16 }}>실사 전 점검 중...</div>
      ) : pre.error ? (
        <div className="b2b-error" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span>실사 전 점검 확인 못 함 — {pre.error}. 확인될 때까지 실사를 받지 않습니다.</span>
          <button className="b2b-link-btn" onClick={() => { void loadPre(); }}>다시 확인</button>
        </div>
      ) : pre.checks ? (
        <CountCheckPanel checks={pre.checks} channel={channel} />
      ) : null}

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">조정 내역</span></div>
        <TxnTable type="조정" reloadKey={reload} onChanged={() => { load(); loadPre(); }} />
      </section>

      {/* 이 화면의 칸·실사일로 연다 — channelChosen: 여기서 고른 칸을 창의 조정 칸 선택으로 인정(S8), defaultDate: 실사일 마감 기준 */}
      {open && channel && <TxnModal products={products} qtyOf={qtyOf} defaultType="조정" defaultChannel={channel} channelChosen defaultDate={countDate} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); setReload((n) => n + 1); load(); loadPre(); }} />}

      {preview && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
            <div className="b2b-modal-head">
              <span className="b2b-modal-title">엑셀 실사 · {preview.reqChannel} · {preview.reqDate} 마감 — 미리보기</span>
              <button className="b2b-modal-close" aria-label="닫기" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                <span>실제 변경 <strong style={{ color: "var(--sm-orange)" }}>{preview.summary.changed}</strong>건</span>
                <span className="sm-faint">일치 {preview.summary.valid}건 중</span>
                {!!preview.summary.skipped && <span className="sm-faint">미입력 {preview.summary.skipped.toLocaleString()}행 건너뜀</span>}
                {!!preview.summary.untracked && <span className="sm-faint">재고 관리 사용 안함 {preview.summary.untracked.toLocaleString()}행 제외</span>}
                {preview.summary.errors > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.summary.errors}건(제외)</span>}
              </div>
              {preview.checks && <CountCheckPanel checks={preview.checks} channel={preview.reqChannel} compact />}
              {preview.rows.length === 0 && <div className="b2b-empty" style={{ padding: 20 }}>매칭된 품목이 없습니다.</div>}
              {preview.rows.length > 0 && (
                // flex 세로 본문 안의 스크롤 표 — flexShrink 0 이 없으면 점검 패널이 길 때 이 표가 한 줄 높이로 눌린다
                <div className="b2b-table-wrap" style={{ flexShrink: 0, maxHeight: 340, overflow: "auto", marginBottom: 12 }}>
                  <table className="b2b-table">
                    <thead><tr><th>품목</th><th>SKU</th><th className="num">{preview.reqDate.slice(5)} 재고</th><th className="num">실사</th><th className="num">조정</th><th>메모</th></tr></thead>
                    <tbody>
                      {preview.rows.slice(0, 300).map((r, i) => (
                        <tr key={i} style={r.delta === 0 ? { color: "var(--sm-text-light)" } : undefined}>
                          <td>
                            {r.name}{r.spec ? <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{r.spec}</span> : null}
                            {(r.pending ?? 0) > 0 && <span className="b2b-status-pill" style={{ marginLeft: 6, background: "var(--sm-warning-bg)", color: "var(--sm-warning)" }} title="현재고에 안 들어간 입출고 — 실사 뒤 처리하면 두 번 반영됩니다">대기 {r.pending}</span>}
                          </td>
                          <td className="sm-faint">{r.sku || "-"}</td>
                          <td className="num b2b-money">{r.current.toLocaleString()}</td>
                          <td className="num b2b-money" style={{ fontWeight: 700 }}>{r.target.toLocaleString()}</td>
                          <td className="num b2b-money" style={{ fontWeight: 700, color: r.delta > 0 ? "var(--sm-success)" : r.delta < 0 ? "var(--sm-danger)" : "var(--sm-text-light)" }}>{r.delta > 0 ? "+" : ""}{r.delta.toLocaleString()}</td>
                          <td style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.memo || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.rows.length > 300 && <p className="sm-faint" style={{ fontSize: 12, padding: "6px 2px" }}>외 {preview.rows.length - 300}건(전체 반영됩니다)</p>}
                </div>
              )}
              {preview.errors.length > 0 && (
                <section>
                  <div className="b2b-field-label" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>오류 ({preview.errors.length}) — 해당 행 제외</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--sm-danger)", maxHeight: 130, overflow: "auto" }}>
                    {preview.errors.map((e, i) => <li key={i}>{e.line}행: {e.msg}</li>)}
                  </ul>
                </section>
              )}
            </div>
            <div className="b2b-modal-foot">
              {needsAck(preview.checks)
                ? <label className="sm-row" style={{ gap: 6, fontSize: 15 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 위 점검을 확인했습니다</label>
                : <span />}
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setPreview(null)} disabled={applying}>취소</button>
                <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.summary.changed === 0 || !preview.checks || (needsAck(preview.checks) && !ack)}>{applying ? "반영 중..." : `${preview.summary.changed}건 조정`}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 실사 전 점검 결과 — 실사 화면 위(칸 전체)와 엑셀 미리보기(그 파일 품목만)가 같이 쓴다.
//  B2B 선점·대기·실사일 당일 입출고는 경고(미리보기에서 확인을 받는다), 실사일 뒤 입출고는 건수만.
function CountCheckPanel({ checks, channel, compact }: { checks: CountChecks; channel: InvChannel; compact?: boolean }) {
  const nm = (id: string) => checks.names[id] || "(품목)";
  const listMax = compact ? 160 : 220;
  const nothing = !checks.b2b.length && !checks.pendingTotal && !checks.sameDay && !checks.after && !checks.formDate;
  if (nothing) return compact ? null : <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 12px" }}>{channel} · {checks.date} 기준 점검 이상 없음</p>;
  const rem = (n: number | null) => (n === null ? "확인 필요" : n.toLocaleString());
  return (
    <div className="sm-col" style={{ gap: 8, marginBottom: 12, flexShrink: 0 }}>
      {checks.formDate && (
        <div className="sm-warn"><strong>양식 기준일 {checks.formDate.slice(5)} ≠ 실사일 {checks.date.slice(5)}</strong> — 표의 재고는 실사일 기준입니다. 센 날 마감이 실사일이 맞는지 확인하세요.</div>
      )}
      {checks.b2b.length > 0 && (
        <div className="sm-warn">
          <div><strong>장부에서 이미 빠졌지만 아직 안 나간 B2B 발주 {checks.b2b.length}건</strong> — 실사 전에 발송완료(실제 발송일)로 바꾸거나 발송일을 다시 잡으세요. 그대로 세면 그만큼 재고가 늘어납니다. 일부 발송 건은 &apos;안 나간 수량&apos;을 선반 수량에서 빼고 넣으세요.</div>
          <div className="b2b-table-wrap" style={{ maxHeight: listMax, overflow: "auto", marginTop: 8 }}>
            <table className="b2b-table is-responsive">
              <thead><tr><th>발주</th><th>거래처</th><th>차감일</th><th>남은 발송일</th><th>상태</th><th className="num">안 나간 수량</th></tr></thead>
              <tbody>
                {checks.b2b.map((h) => (
                  <tr key={h.order_id}>
                    <td data-label="발주" style={{ whiteSpace: "nowrap" }}><a className="sm-link" href={`/b2b/orders/${h.order_id}`} target="_blank" rel="noreferrer">{h.order_no || "발주"}</a></td>
                    <td data-label="거래처">{h.company || "-"}</td>
                    <td data-label="차감일" style={{ whiteSpace: "nowrap" }}>{h.deduct_date.slice(5)}</td>
                    <td data-label="남은 발송일" style={{ whiteSpace: "nowrap" }}>{h.open_dates.length ? h.open_dates.map((d) => d.slice(5)).join(", ") : "-"}</td>
                    <td data-label="상태">{h.partial ? "일부 발송" : "미발송"}</td>
                    <td data-label="안 나간 수량" className="num b2b-money" style={{ whiteSpace: "nowrap" }}
                      title={h.remaining === null ? "발송완료 차수에 품목 수량이 없어 남은 수량을 알 수 없습니다 — 발주에서 확인하세요" : h.items.map((x) => `${nm(x.product_id)} ${rem(x.remaining)}${h.partial ? ` / 차감 ${x.qty.toLocaleString()}` : ""}`).join("\n")}>
                      {rem(h.remaining)}{h.partial && <span className="sm-faint" style={{ fontSize: 12, marginLeft: 4 }}>/ 차감 {h.qty.toLocaleString()}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {checks.pendingTotal > 0 && (
        <div className="sm-warn">
          <div><strong>대기 {checks.pendingTotal}건</strong> — 현재고에 안 들어간 입출고입니다. 실물이 이미 움직였으면 실사 전에 &apos;입고 및 출고&apos;에서 처리하거나 취소하세요. 실사 뒤에 처리하면 두 번 반영됩니다.</div>
          <div className="b2b-table-wrap" style={{ maxHeight: listMax, overflow: "auto", marginTop: 8 }}>
            <table className="b2b-table is-responsive">
              <thead><tr><th>거래일</th><th>유형</th><th>품목</th><th className="num">수량</th><th>거래처</th></tr></thead>
              <tbody>
                {checks.pending.map((t) => <CheckRow key={t.id} t={t} name={nm(t.product_id)} />)}
              </tbody>
            </table>
            {checks.pendingTotal > checks.pending.length && <p className="sm-faint" style={{ fontSize: 12, padding: "6px 2px" }}>외 {checks.pendingTotal - checks.pending.length}건</p>}
          </div>
        </div>
      )}
      {checks.sameDay > 0 && (
        <div className="sm-warn">
          <div><strong>실사일({checks.date.slice(5)}) 당일 입출고 {checks.sameDay}건</strong> — 실사일 재고에 들어가 있습니다. 그날 입출고 전에 셌다면 실사일을 전날로 고르세요.</div>
          {!compact && (
            <div className="b2b-table-wrap" style={{ maxHeight: listMax, overflow: "auto", marginTop: 8 }}>
              <table className="b2b-table is-responsive">
                <thead><tr><th>거래일</th><th>유형</th><th>품목</th><th className="num">수량</th><th>거래처</th></tr></thead>
                <tbody>
                  {checks.moved.filter((t) => t.txn_date === checks.date).map((t) => <CheckRow key={t.id} t={t} name={nm(t.product_id)} />)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {checks.after > 0 && <p className="sm-faint" style={{ fontSize: 12, margin: 0 }}>실사일 뒤 입출고 {checks.after}건은 조정 뒤에 그대로 반영됩니다.</p>}
    </div>
  );
}

function CheckRow({ t, name }: { t: CountChecks["pending"][number]; name: string }) {
  const c = INV_TYPE_COLOR[t.type as InvTxnType] || INV_TYPE_COLOR["조정"];
  return (
    <tr>
      <td data-label="거래일" style={{ whiteSpace: "nowrap" }}>{t.txn_date.slice(5)}</td>
      <td data-label="유형"><span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{t.type}</span></td>
      <td data-label="품목" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</td>
      <td data-label="수량" className="num b2b-money">{Number(t.qty) > 0 ? "+" : ""}{Number(t.qty).toLocaleString()}</td>
      <td data-label="거래처">{t.partner || "-"}</td>
    </tr>
  );
}
