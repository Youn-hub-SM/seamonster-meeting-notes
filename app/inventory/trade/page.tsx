"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import OrdersTable from "../OrdersTable";
import { ChannelPicker } from "../ChannelTabs";
import { LOST_MSG, linkMessage, confirmUnlinkedInbound } from "../TxnModal";
import { useConfirm, useToast } from "@/app/components/Feedback";
import { INV_TYPE_COLOR, MOVE_ONLY_CHANNELS, type InvChannel } from "@/app/lib/inventory";
import type { LinkResultLite } from "@/app/lib/link-result";

type OpenReq = { id: string; req_no: string | null; title: string | null; prod_start: string; due_date: string | null; in_window: boolean; full?: boolean };
// 요청서 목록 조회 결과 → 입고 화면 경고 문구(없으면 ""). 조회 실패·이행률 판독 실패 모두 사람이 직접 골라야 한다.
const reqWarnOf = (j: { ok?: boolean; full_ok?: boolean } | null) =>
  !j?.ok ? "요청서 목록을 불러오지 못했습니다 — 새로고침 후 다시 시도하세요. 이대로 저장하면 요청서에 연결되지 않습니다."
  : j.full_ok === false ? "이행률을 읽지 못해 기본 요청서를 고르지 않았습니다 — 연결할 요청서를 직접 고르세요." : "";

type ImportRow = { type: "입고" | "출고"; qty: number; product_id: string; product_name: string; unit_amount: number | null; txn_date: string; partner: string | null; memo: string | null; reason?: string | null };
// key = 이 미리보기의 제출 키(131) — 반영을 다시 눌러도 한 번만 기록된다
type Preview = { summary: { valid: number; errors: number; merged?: number; skipped?: number; untracked?: number }; rows: ImportRow[]; errors: { line: number; msg: string }[]; key: string };
const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

export default function TradePage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false); // 업로드 설정 모달
  const [ioType, setIoType] = useState<"입고" | "출고">("출고"); // 기본 출고
  const [ioChannel, setIoChannel] = useState<InvChannel>("소매");
  const [ioDate, setIoDate] = useState(TODAY());
  const [ioPartner, setIoPartner] = useState("");
  const [ioDone, setIoDone] = useState(true); // 즉시 입고/출고처리(기본 체크)
  const [ioReason, setIoReason] = useState("판매"); // 출고 사유 — '판매' 외에는 대사(구매·판매·재고 확인)에서 분리 집계(099)
  const [inReason, setInReason] = useState(""); // 입고 사유 — '' = 매입·생산, '고객 반품'(D4b) = 요청서 연결·단가 없음
  const customerReturn = ioType === "입고" && inReason === "고객 반품";
  // 지정 매칭 — 엑셀 입고를 연결할 제조사 요청서. 거래일이 생산기간에 드는 요청서가 기본값(사람이 고르면 그대로).
  const [reqs, setReqs] = useState<OpenReq[]>([]);
  const [reqId, setReqId] = useState("");
  const [reqTouched, setReqTouched] = useState(false);
  const [reqWarn, setReqWarn] = useState("");
  useEffect(() => {
    if (ioType !== "입고" || !uploadOpen) return;
    let alive = true;
    fetch(`/api/production/requests/open?date=${ioDate}`, { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!alive) return;
      setReqWarn(reqWarnOf(j));
      if (!j?.ok) { setReqId(""); setReqs([]); return; } // 경고('연결되지 않습니다')와 실제 저장이 맞게 — 옛 선택·옛 목록(다른 거래일 기준)을 남기지 않는다
      setReqs(j.requests || []);
      if (!reqTouched) setReqId(j.default_id || "");
    }).catch(() => { if (alive) { setReqWarn(reqWarnOf(null)); setReqId(""); setReqs([]); } });
    return () => { alive = false; };
  }, [ioType, ioDate, uploadOpen, reqTouched]);

  function openUpload() { setError(""); setIoDate(TODAY()); setReqTouched(false); setUploadOpen(true); } // 열 때 거래일은 오늘로 리셋

  async function handleFile(file: File) {
    setImporting(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("type", ioType); fd.append("txn_date", ioDate); fd.append("partner", ioPartner);
      fd.append("done", ioDone ? "1" : "0"); // 즉시 처리면 미래 날짜 행은 오류로(S6)
      const res = await fetch("/api/inventory/txns/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      setPreview({ ...(j as Omit<Preview, "key">), key: newKey() });
      setUploadOpen(false); // 분석 성공 → 설정 모달 닫고 미리보기로
    } catch (e) { setError(e instanceof Error ? e.message : "분석 실패"); }
    setImporting(false);
  }
  async function applyImport() {
    if (!preview) return;
    setApplying(true); setError("");
    try {
      // 제조사 입고를 '연결 안 함'으로 반영 — 열린 요청서 잔여가 있는 품목이면 확인(S9)
      if (ioType === "입고" && ioDone && !customerReturn && !reqId) {
        const seen = new Set<string>();
        const items = preview.rows.filter((r) => r.type === "입고" && !seen.has(r.product_id) && seen.add(r.product_id)).map((r) => ({ product_id: r.product_id, name: r.product_name }));
        if (!(await confirmUnlinkedInbound(ioDate, items, confirm))) { setApplying(false); return; }
      }
      const lost = LOST_MSG;
      let res: Response;
      let j: { ok?: boolean; error?: string; code?: string; replay?: boolean; link?: LinkResultLite } | null = null;
      try {
        res = await fetch("/api/inventory/txns/import/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          rows: preview.rows.map((r) => (r.type === "출고" && ioReason !== "판매" ? { ...r, reason: ioReason } : r.type === "입고" && customerReturn ? { ...r, reason: inReason, unit_amount: null } : r)),
          done: ioDone, channel: ioChannel, request_key: preview.key,
          request_id: ioType === "입고" && ioDone && !customerReturn ? (reqId || null) : null,
        }) });
        j = await res.json().catch(() => null);
      } catch { throw new Error(lost); }
      if (!j) throw new Error(lost);
      if (j.code === "request_key_conflict") setPreview((p) => (p ? { ...p, key: newKey() } : p)); // 다음 누름은 새 기록
      if (!res.ok || !j.ok) throw new Error(j.error || "적용 실패");
      if (j.replay) toast.success("이미 반영돼 있던 요청입니다 — 다시 기록하지 않았습니다.");
      if (j.link) {
        const m = linkMessage(j.link, (pid) => preview.rows.find((r) => r.product_id === pid)?.product_name || "품목");
        if (j.link.ok && !j.link.failed?.length) toast.success(m); else toast.error(m);
      }
      setPreview(null); setReload((n) => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "적용 실패"); }
    setApplying(false);
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div><h1 className="b2b-page-title">입고 및 출고</h1></div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={openUpload}>엑셀 업로드</button>
          <Link className="b2b-btn-primary" href="/inventory/trade/new">+ 입고/출고 기록</Link>
        </div>
      </header>

      {error && !uploadOpen && !preview && <div className="b2b-error">{error}</div>}

      <section className="b2b-card">
        <div className="b2b-card-head"><span className="b2b-card-title">입고·출고 내역 (주문 단위)</span></div>
        <OrdersTable reloadKey={reload} />
      </section>

      {/* 엑셀 업로드 설정 → 파일 첨부 */}
      {uploadOpen && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">엑셀 일괄 업로드</h2>
              <button className="b2b-modal-close" aria-label="닫기" onClick={() => setUploadOpen(false)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div className="b2b-field">
                <label className="b2b-field-label">① 유형</label>
                <div className="sm-tabs" style={{ margin: 0 }}>
                  <button className={`sm-tab ${ioType === "출고" ? "is-active" : ""}`} onClick={() => { setIoType("출고"); setInReason(""); }}>판매(출고)</button>
                  <button className={`sm-tab ${ioType === "입고" ? "is-active" : ""}`} onClick={() => { setIoType("입고"); setIoReason("판매"); if (ioChannel !== "소매") setIoChannel("소매"); }}>구매(입고)</button>
                </div>
              </div>

              <div className="b2b-field" style={{ marginTop: 12 }}>
                <label className="b2b-field-label">② 채널</label>
                <ChannelPicker value={ioChannel} onChange={setIoChannel}
                  disabledChannels={ioType === "입고" ? MOVE_ONLY_CHANNELS : []}
                  disabledHint="도매·프로모션·도매 대량은 소매로 입고한 뒤 [재고 이동]에서 옮깁니다" />
              </div>

              <div className="b2b-field-row" style={{ marginTop: 12 }}>
                <div className="b2b-field">
                  <label className="b2b-field-label">③ 거래일</label>
                  <input className="b2b-input" type="date" value={ioDate} max={ioDone ? TODAY() : undefined} onChange={(e) => setIoDate(e.target.value)} />
                </div>
                <div className="b2b-field">
                  <label className="b2b-field-label">{ioType === "입고" ? (customerReturn ? "고객" : "매입처") : ioReason !== "판매" ? "전달처" : "판매처"} <span className="opt">(선택)</span></label>
                  <input className="b2b-input" value={ioPartner} onChange={(e) => setIoPartner(e.target.value)} />
                </div>
              </div>

              {ioType === "입고" && (
                <div className="b2b-field" style={{ marginTop: 12 }}>
                  <label className="b2b-field-label">사유</label>
                  <select className="b2b-input" value={inReason} onChange={(e) => setInReason(e.target.value)}>
                    <option value="">입고(매입·생산)</option>
                    <option value="고객 반품">고객 반품·교환 회수</option>
                  </select>
                  {customerReturn && <span className="sm-faint" style={{ display: "block", fontSize: 12, marginTop: 4 }}>요청서 연결·매입 단가 없이 기록됩니다</span>}
                </div>
              )}

              {ioType === "입고" && (
                <div className="b2b-field" style={{ marginTop: 12 }}>
                  <label className="b2b-field-label">요청서</label>
                  <select className="b2b-input" value={ioDone && !customerReturn ? reqId : ""} disabled={!ioDone || customerReturn} onChange={(e) => { setReqId(e.target.value); setReqTouched(true); }}>
                    <option value="">연결 안 함</option>
                    {reqs.map((r) => <option key={r.id} value={r.id}>{r.req_no || "요청서"}{r.title ? ` · ${r.title}` : ""} · 생산 {r.prod_start.slice(5)}~{(r.due_date || "").slice(5)}{r.in_window ? "" : " (기간 밖)"}{r.full ? " (이행 100%)" : ""}</option>)}
                  </select>
                  {reqWarn && !customerReturn && <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--sm-danger)", marginTop: 4 }}>{reqWarn}</span>}
                </div>
              )}

              {ioType === "출고" && (
                <div className="b2b-field" style={{ marginTop: 12 }}>
                  <label className="b2b-field-label">사유</label>
                  <select className="b2b-input" value={ioReason} onChange={(e) => setIoReason(e.target.value)}>
                    <option value="판매">판매</option>
                    <option value="협찬">협찬·증정</option>
                    <option value="폐기">폐기</option>
                    <option value="제조사 반품">제조사 반품</option>
                    <option value="기타">기타</option>
                  </select>
                </div>
              )}

              <label className="sm-row" style={{ gap: 7, marginTop: 12, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={ioDone} onChange={(e) => setIoDone(e.target.checked)} /> 즉시 {ioType === "입고" ? "입고" : "출고"}처리
                <span className="sm-faint" style={{ fontSize: 12 }}>(미래 날짜는 해제해 대기로)</span>
              </label>

              <p className="sm-faint" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
                {ioType === "입고"
                  ? <>양식 = <strong>SKU · 수량 · 단가</strong></>
                  : <>양식 = <strong>수량 · (무시) · SKU</strong></>}
                {" · "}<a href={`/api/inventory/txns/template?type=${ioType}`} className="sm-link">양식 내려받기</a>
                <br />거래일·거래처·채널·{ioType === "출고" ? "사유" : "요청서"}는 파일 전체에 적용됩니다.
              </p>

              {error && <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div>}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setUploadOpen(false)} disabled={importing}>그만두기</button>
                <label className="b2b-btn-primary" style={{ cursor: importing ? "default" : "pointer" }}>
                  {importing ? "분석 중..." : "④ 엑셀 첨부"}
                  <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">엑셀 업로드 — 미리보기</h2>
              <button className="b2b-modal-close" aria-label="닫기" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              {error && <div className="b2b-error" style={{ marginBottom: 8 }}>{error}</div>}
              <div className="sm-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                <span>반영 가능 <strong style={{ color: "var(--sm-success)" }}>{preview.summary.valid}</strong>건</span>
                {!!preview.summary.merged && <span className="sm-faint">중복 SKU {preview.summary.merged}건 합산됨</span>}
                {!!preview.summary.skipped && <span className="sm-faint">미입력 {preview.summary.skipped.toLocaleString()}행 건너뜀</span>}
                {!!preview.summary.untracked && <span className="sm-faint">재고 관리 사용 안함 {preview.summary.untracked.toLocaleString()}행 제외</span>}
                {preview.summary.errors > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.summary.errors}건(제외)</span>}
              </div>
              {preview.summary.valid === 0 && <div className="b2b-empty" style={{ padding: 20 }}>반영할 행이 없습니다.</div>}
              {preview.rows.length > 0 && (
                <div className="b2b-table-wrap" style={{ maxHeight: 320, overflow: "auto", marginBottom: 12 }}>
                  <table className="b2b-table">
                    <thead><tr><th>날짜</th><th>유형</th><th>품목</th><th className="num">수량</th><th className="num">단가</th><th>거래처</th></tr></thead>
                    <tbody>
                      {preview.rows.slice(0, 200).map((r, i) => { const c = INV_TYPE_COLOR[r.type]; return (
                        <tr key={i}>
                          <td style={{ whiteSpace: "nowrap" }}>{r.txn_date?.slice(5)}</td>
                          <td><span className="b2b-status-pill" style={{ background: c.bg, color: c.fg }}>{r.type}</span></td>
                          <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.product_name}</td>
                          <td className="num b2b-money" style={{ color: c.fg, fontWeight: 700 }}>{r.qty > 0 ? "+" : ""}{r.qty.toLocaleString()}</td>
                          <td className="num b2b-money">{r.unit_amount ? r.unit_amount.toLocaleString() : "-"}</td>
                          <td>{r.partner || "-"}</td>
                        </tr>
                      ); })}
                    </tbody>
                  </table>
                  {preview.rows.length > 200 && <p className="sm-faint" style={{ fontSize: 12, padding: "6px 2px" }}>...외 {preview.rows.length - 200}건(전체 반영됩니다)</p>}
                </div>
              )}
              {preview.errors.length > 0 && (
                <section>
                  <div className="b2b-field-label" style={{ fontWeight: 700, color: "var(--sm-danger)" }}>오류 ({preview.errors.length}) — 해당 행은 제외</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--sm-danger)", maxHeight: 140, overflow: "auto" }}>
                    {preview.errors.map((e, i) => <li key={i}>{e.line}행: {e.msg}</li>)}
                  </ul>
                </section>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setPreview(null)} disabled={applying}>그만두기</button>
                {preview.summary.valid === 0 && !applying && <span className="b2b-btn-why">반영할 행이 없습니다</span>}
                <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.summary.valid === 0}>{applying ? "반영 중..." : `${preview.summary.valid}건 반영`}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
