"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConfirm, type ConfirmOptions } from "@/app/components/Feedback";
import { qty, qtyText, dateTime } from "@/app/lib/format";

type Warn = { rowNo: number; addr: string; name: string };
type FileOut = { name: string; b64: string };
type Parcel = { category: string; normal: number; guarantee: number };
type Result = {
  stats: { total: number; excludedNothing: number; normalCount: number; guaranteeCount: number; parcels: number; parcelsGuar: number; mergedParcels?: number };
  fees: { baseNormal: number; baseGuar: number; guarExtra: number };
  parcelSummary: Parcel[];
  addressWarnings: Warn[];
  messageWarnings?: { rowNo: number; orderNo: string; name: string; msg: string }[];
  unmatched: string[];
  outbound: { sku: string; name: string; qty: number; orderDate: string | null }[];
  sig?: string; // 배치 서명(batchSig) — ④ 출고가 그대로 전달해야 대기 키·중복 검사가 이 파일과 이어진다
  hasKeys?: boolean;               // 대기 키 저장됨 — ④ 출고에 expectKeys 로 전달
  dedupEnabled?: boolean;          // false = 중복 방지 꺼짐(이미 출고한 주문을 거르지 않음)
  openOverlap?: { orders: number; batches: { fileName: string | null; at: string }[] } | { error: true } | null; // CN 받은 미출고 배치와 겹침
  excludedProcessed?: number;      // 이미 출고 처리돼 자동 제외된 주문 수(079)
  excludedOrderNos?: string[];
  interruptedResume?: boolean;     // 재고가 안 빠진 중단된 출고의 파일을 다시 올림 — ④에서 이어서 차감
  interruptedExcluded?: number;    // 제외한 주문 중 중단된 출고(재고 미차감)의 주문 수
  codeCount: number;
  files: { normal: FileOut; guarantee: FileOut | null; parcel: FileOut };
};
type DItem = { sku: string; name: string; qty: number; kind: "single" | "bundle" | "unmatched" | "ambiguous" | "untracked" };
type DProd = { productId: string; name: string; option: string; need: number; current: number; after: number; short: boolean };
type Unm = { sku: string; qty: number; kind: "unmatched" | "ambiguous" };
type DispatchPreview = { items: DItem[]; products: DProd[]; shortages: number; message?: string; untrackedOnly?: boolean; unmatchedOnly?: boolean; unmatched?: Unm[] };
type DispatchDone = { orderNo: string; groupId: string; dispatched: number; totalQty: number; shortages: number; already?: boolean; resumed?: number; closed?: number; unmatched?: Unm[]; unmatchedSaved?: boolean;
  unmatchedNotSaved?: "no_column" | "no_table" | "same_day_force" }; // 목록을 못 남긴 이유(서버)
// 재고가 빠지지 않은 코드 목록을 저장하지 못했을 때 안내 — 이유별(같은 날 다시 출고는 135 적용과 무관하게 남길 행이 없다)
const UNM_NOT_SAVED: Record<NonNullable<DispatchDone["unmatchedNotSaved"]>, string> = {
  same_day_force: "같은 날 다시 출고한 배치라 이 목록은 저장되지 않습니다 — 코드를 적어 두고, 상품마스터에 등록한 뒤 [입고 및 출고]에서 직접 출고하세요.",
  no_column: "목록이 저장되지 않았습니다(migration 135 미적용) — 코드를 적어 두세요.",
  no_table: "목록이 저장되지 않았습니다(출고 이력 표 없음, migration 065 미적용) — 코드를 적어 두세요.",
};
type OpenBatch = { sig: string; file_name: string | null; order_count: number | null; total_qty: number | null; downloaded_at: string; interrupted?: boolean };
type UnmRow = { id: string; dispatch_date: string; order_no: string | null; codes: { sku: string; qty: number; registered: boolean }[] };

const KW_KEY = "fulfill_addr_keywords";
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const STEPS = ["발주엑셀 업로드", "CN 파일 다운로드", "배송일지 기록", "상품 출고"];
// 확인 모달(공용 useConfirm) 문구 — 나가기는 파괴가 아니라 danger:false
const LEAVE_ASK: ConfirmOptions = { title: "상품 출고 전에 나가기", body: "CN 파일을 받았지만 ④ 상품 출고(재고 차감)를 아직 안 했습니다.", action: "그래도 나가기", danger: false };
// 중단된 출고를 이어서 차감하지 않기로 했을 때 — 재고를 이미 맞췄으면 차감 없이 닫는다(서버 closeInterrupted)
const CLOSE_GHOST_ASK: ConfirmOptions = {
  title: "앞선 출고를 차감 없이 닫기",
  body: "그 사이 [입고 및 출고]에서 직접 기록했거나 실사로 재고를 이미 맞췄을 때만 — 재고를 차감하지 않고 앞선 출고를 '처리됨'으로 닫습니다. 모르면 그만두고 [입고 및 출고]에서 먼저 확인하세요.",
  action: "차감 없이 닫기",
};

function downloadB64(name: string, b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

export default function FulfillPage() {
  const confirm = useConfirm();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [msgAck, setMsgAck] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [step, setStep] = useState(0);
  const [ack, setAck] = useState(false);
  const [recordDate, setRecordDate] = useState(kstToday());
  const [recordMode, setRecordMode] = useState<"replace" | "add">("add"); // 더하기 기본
  const [recording, setRecording] = useState(false);
  const [recordOk, setRecordOk] = useState("");
  const [lastRecord, setLastRecord] = useState<{ date: string; id: string } | null>(null); // 방금 기록(즉시 취소용)
  const [undoing, setUndoing] = useState(false);
  const [dispatch, setDispatch] = useState<DispatchPreview | null>(null);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchDone, setDispatchDone] = useState<DispatchDone | null>(null);
  const [dispatchErr, setDispatchErr] = useState(false); // 재고 미리보기 실패 — '품목 없음'과 구분(같으면 차감을 건너뛴 것으로 오인)
  const [dispatchRetry, setDispatchRetry] = useState(0);
  const [cnDownloaded, setCnDownloaded] = useState(false); // CN 파일을 받음 — ④ 전에 나가면 확인
  const [unmatchedAck, setUnmatchedAck] = useState(false);  // 재고가 안 빠지는 코드 동의
  const [overlapAck, setOverlapAck] = useState(false);      // 미출고 배치와 겹침 확인
  const [openBatches, setOpenBatches] = useState<OpenBatch[]>([]);
  const [unmRows, setUnmRows] = useState<UnmRow[]>([]);
  const [sideBusy, setSideBusy] = useState("");

  useEffect(() => { setKeywords(localStorage.getItem(KW_KEY) || ""); }, []);

  // CN 을 받았지만 출고 안 한 배치 · 재고가 빠지지 않은 코드 — ① 화면에 계속 띄운다(S9·S12)
  async function loadSide() {
    try {
      const [a, b] = await Promise.all([
        fetch("/api/fulfill/pending", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/fulfill/unmatched", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (a.ok) setOpenBatches(a.batches || []);
      if (b.ok) setUnmRows(b.rows || []);
    } catch { /* 표시용 — 다음 로드 때 다시 */ }
  }
  useEffect(() => { void loadSide(); }, []);
  async function discardBatch(b: OpenBatch) {
    if (!(await confirm({ title: `${b.file_name || "이 배치"}(${dateTime(b.downloaded_at)}) 발송 안 함`, body: "발송하지 않은 배치일 때만 — 미출고 배치 목록에서 빠지고 재고는 차감하지 않습니다.", action: "발송 안 함" }))) return;
    setSideBusy(b.sig);
    try {
      const j = await (await fetch("/api/fulfill/pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sig: b.sig, action: "discard" }) })).json();
      if (!j.ok) throw new Error(j.error || "배치를 목록에서 빼지 못했습니다. 새로고침 뒤 다시 누르세요.");
    } catch (e) { setError(e instanceof Error ? e.message : "배치를 목록에서 빼지 못했습니다. 새로고침 뒤 다시 누르세요."); }
    setSideBusy(""); void loadSide();
  }
  async function resolveUnm(row: UnmRow, action: "record" | "done") {
    const ask: ConfirmOptions = action === "record"
      ? { title: `${row.dispatch_date} 출고분 재고 차감 기록`, body: `등록된 코드를 ${row.dispatch_date} 날짜로 소매 재고에서 차감합니다.`, action: "재고 차감 기록" }
      : { title: `${row.dispatch_date} 출고분 확인 완료`, body: "재고 기록 없이 목록에서만 뺍니다.", action: "확인 완료" };
    if (!(await confirm(ask))) return;
    setSideBusy(row.id);
    try {
      // 출고일 뒤 실사 조정이 있으면 서버가 409 countAfter 로 멈춘다 — 실사에 반영되지 않은 게 확실할 때만 ackCount 로 다시
      let ackCount = false;
      for (let i = 0; i < 2; i++) {
        const r = await fetch("/api/fulfill/unmatched", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: row.id, action, ackCount }) });
        const j = await r.json();
        if (r.status === 409 && j.countAfter && !ackCount) {
          if (!(await confirm({ title: "실사 뒤 재고 차감", body: `${j.error} 실사에 반영되지 않은 게 확실할 때만 — ${row.dispatch_date} 날짜로 차감합니다.`, action: `${row.dispatch_date} 날짜로 차감` }))) break;
          ackCount = true; continue;
        }
        if (!j.ok) throw new Error(j.error || "재고 차감을 기록하지 못했습니다. 새로고침 뒤 다시 누르세요.");
        break;
      }
    } catch (e) { setError(e instanceof Error ? e.message : "재고 차감을 기록하지 못했습니다. 새로고침 뒤 다시 누르세요."); }
    setSideBusy(""); void loadSide();
  }

  // CN 다운로드 기록 — 출고 완료 전까지 '미출고 배치'로 남는다
  function markDownloaded() {
    setCnDownloaded(true);
    if (res?.hasKeys && res.sig) void fetch("/api/fulfill/pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sig: res.sig, action: "downloaded" }) }).catch(() => {});
  }
  const leaveRisk = cnDownloaded && !dispatchDone;
  useEffect(() => {
    if (!leaveRisk) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [leaveRisk]);
  const okToLeave = async () => !leaveRisk || (await confirm(LEAVE_ASK));
  function saveKeywords(v: string) { setKeywords(v); localStorage.setItem(KW_KEY, v); }

  // res 갱신 시 상품 출고 미리보기(재고 확인) 자동 로드
  useEffect(() => {
    setDispatch(null); setDispatchDone(null); setDispatchErr(false); setUnmatchedAck(false);
    const items = res?.outbound?.map((o) => ({ sku: o.sku, qty: o.qty, orderDate: o.orderDate ?? null })) || [];
    if (!items.length) return;
    let cancel = false;
    setDispatchLoading(true);
    (async () => {
      try {
        const j = await (await fetch("/api/fulfill/dispatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, commit: false, sig: res?.sig }) })).json();
        if (!cancel) { if (j.ok) setDispatch(j); else setDispatchErr(true); }
      } catch { if (!cancel) setDispatchErr(true); }
      if (!cancel) setDispatchLoading(false);
    })();
    return () => { cancel = true; };
  }, [res, dispatchRetry]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name); setError(""); setRes(null); setAck(false); setMsgAck(false); setOverlapAck(false); setCnDownloaded(false); setRecordOk(""); setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("keywords", keywords);
      const j = await (await fetch("/api/fulfill/generate", { method: "POST", body: fd })).json();
      if (!j.ok) throw new Error(j.error || "발주 파일을 만들지 못했습니다. 주문 엑셀을 다시 올리세요.");
      setRes(j as Result);
    } catch (err) { setError(err instanceof Error ? err.message : "발주 파일을 만들지 못했습니다. 주문 엑셀을 다시 올리세요."); }
    setLoading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function recordLog(): Promise<boolean> {
    if (!res || !recordDate) return false;
    if (res.unmatched.length > 0 && !(await confirm({ title: "미매칭 SKU 가 있는 채로 배송일지 기록", body: `미매칭 SKU ${qtyText(res.unmatched.length)}가 있어 기본운임이 실제보다 적게 기록될 수 있습니다. 상품마스터에서 택배 정보를 채운 뒤 다시 만드는 것을 권장합니다.`, action: "지금 기록", danger: false }))) return false;
    setRecording(true); setRecordOk(""); setError(""); setLastRecord(null);
    let ok = false;
    try {
      const ex = await (await fetch(`/api/fulfill/log?from=${recordDate}&to=${recordDate}`, { cache: "no-store" })).json();
      const cur = ex.ok ? (ex.rows || []).find((r: { log_date: string; boxes_normal: Record<string, number>; boxes_guar: Record<string, number>; base_fee_normal: number; base_fee_guar: number }) => r.log_date === recordDate) : null;
      const hasData = !!cur && (Object.keys(cur.boxes_normal || {}).length > 0 || Object.keys(cur.boxes_guar || {}).length > 0 || cur.base_fee_normal > 0 || cur.base_fee_guar > 0);
      // 동일 데이터 감지 시 덮어쓰기 권유
      if (hasData) {
        if (recordMode === "add") {
          if (!(await confirm({ title: `${recordDate} 배송일지에 더하기`, body: `${recordDate}에 이미 배송일지 기록이 있습니다. 같은 발주를 또 '더하기'하면 이중 집계됩니다 — 동일한 데이터라면 그만두고 '덮어쓰기'로 바꿔 다시 누르세요.`, action: "그래도 더하기" }))) { setRecording(false); return false; }
        } else if (!(await confirm({ title: `${recordDate} 배송일지 덮어쓰기`, body: `${recordDate}에 이미 기록이 있습니다. 기존 기록이 이 발주 내용으로 바뀝니다.`, action: "덮어쓰기" }))) { setRecording(false); return false; }
      }
      const boxes_normal: Record<string, number> = {}, boxes_guar: Record<string, number> = {};
      for (const p of res.parcelSummary) { if (p.normal) boxes_normal[p.category] = p.normal; if (p.guarantee) boxes_guar[p.category] = p.guarantee; }
      // 같은 내용이 이미 기록돼 있으면 서버가 중복(409)으로 차단 — 사용자가 확인하면 강행(force) 재시도
      let force = false;
      for (;;) {
        const r = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ log_date: recordDate, record: true, mode: recordMode, force, boxes_normal, boxes_guar, base_fee_normal: res.fees.baseNormal, base_fee_guar: res.fees.baseGuar, guar_extra_fee: res.fees.guarExtra }) });
        const j = await r.json();
        if (r.status === 409 && j.duplicate) {
          if (!(await confirm({ title: "같은 내용 다시 기록", body: `${j.error} 그래도 기록하면 이중 집계됩니다.`, action: "그래도 기록" }))) { setRecording(false); return false; }
          force = true; continue;
        }
        if (!j.ok) throw new Error(j.error || "배송일지에 기록하지 못했습니다. 다시 누르세요.");
        if (j.recordedId) setLastRecord({ date: recordDate, id: j.recordedId }); // 즉시 취소용(078 적용 시)
        break;
      }
      setRecordOk(`${recordDate} 배송일지에 ${recordMode === "add" ? "더했습니다(누적)" : "기록했습니다"}.`);
      ok = true;
    } catch (e) { setError(e instanceof Error ? e.message : "배송일지에 기록하지 못했습니다. 다시 누르세요."); }
    setRecording(false);
    return ok;
  }

  // 방금 기록한 배송일지 취소 — 그 배치 이력 1건을 되돌린다(합계·운임 재계산).
  async function undoRecord() {
    if (!lastRecord) return;
    if (!(await confirm({ title: `${lastRecord.date} 배송일지 기록 취소`, body: "방금 기록한 배치 이력 1건이 빠지고 합계·운임을 다시 계산합니다.", action: "기록 취소" }))) return;
    setUndoing(true); setError("");
    try {
      const r = await fetch("/api/fulfill/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ log_date: lastRecord.date, del_record: { id: lastRecord.id } }) });
      const j = await r.json(); if (!j.ok) throw new Error(j.error || "기록을 취소하지 못했습니다. 배송일지에서 해당 날짜의 기록을 되돌리세요.");
      setLastRecord(null); setRecordOk("");
    } catch (e) { setError(e instanceof Error ? e.message : "기록을 취소하지 못했습니다. 배송일지에서 해당 날짜의 기록을 되돌리세요."); }
    setUndoing(false);
  }

  // '다음 단계' = 그 단계 작업 수행 후 이동
  async function onNext() {
    if (!res) return;
    if (step === 0) { setStep(1); return; }
    if (step === 1) { // CN 2종 다운로드 후 이동
      if (!blocked) {
        const g = res.files.guarantee;
        if (res.stats.normalCount > 0) downloadB64(res.files.normal.name, res.files.normal.b64);
        if (g) setTimeout(() => downloadB64(g.name, g.b64), 400);
        if (res.stats.normalCount > 0 || g) markDownloaded();
      }
      setStep(2); return;
    }
    if (step === 2) { // 아직 기록 안 했으면 배송일지 기록 후 이동
      if (!recordOk) { const done = await recordLog(); if (!done) return; }
      setStep(3); return;
    }
  }

  // 서버가 409 로 멈추면(같은 배치·중간에 끊긴 앞선 출고·이미 처리된 주문·중복 방지 꺼짐) 사람에게 묻고 그 플래그를 켜서 다시 보낸다.
  //  inFlight(같은 배치가 방금 진행 중)는 묻지 않고 오류로 보여 준다 — 잠시 뒤 다시 누르면 끝났거나 '끊긴 출고'로 판정된다.
  //  중단된 출고(interrupted)·그 뒤 실사·직접 기록(countAfter)에서 이어서 차감을 [취소]하면 '차감 없이 정리'를 한 번 더 묻는다.
  async function commitDispatch() {
    const items = res?.outbound?.map((o) => ({ sku: o.sku, qty: o.qty, orderDate: o.orderDate ?? null })) || [];
    if (!items.length) return;
    const flags = { force: false, allowOverlap: false, allowUnmatched: unmatchedAck, ackDedupOff: false, resumeInterrupted: false, ackCount: false, closeInterrupted: false };
    const again = dispatch && dispatch.products.length > 0 ? " (재고가 또 차감됩니다)" : "";
    setDispatching(true); setError("");
    try {
      for (let i = 0; i < 9; i++) {
        const r = await fetch("/api/fulfill/dispatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, commit: true, sig: res?.sig, expectKeys: !!res?.hasKeys, ...flags }) });
        const j = await r.json();
        if (r.status === 409 && j.duplicate && !flags.force) {
          if (!(await confirm({ title: "같은 배치 다시 출고", body: `${j.error}${again}`, action: "다시 출고" }))) break;
          flags.force = true; continue;
        }
        if (r.status === 409 && j.interrupted && !flags.resumeInterrupted && !flags.closeInterrupted) {
          // 1차: 이어서 차감 — 그만두면 2차로 '차감 없이 닫기'를 묻는다
          if (await confirm({ title: "중단된 앞선 출고 이어서 차감", body: `${j.error} 그 기록을 정리하고 지금(오늘 날짜로) 재고를 차감합니다. 그만두면 차감 없이 닫을지 다시 묻습니다.`, action: "오늘 날짜로 차감", cancel: "차감 안 함" })) { flags.resumeInterrupted = true; continue; }
          if (!(await confirm(CLOSE_GHOST_ASK))) break;
          flags.closeInterrupted = true; continue;
        }
        if (r.status === 409 && j.countAfter && !flags.ackCount && !flags.closeInterrupted) {
          if (await confirm({ title: "실사 뒤 재고 차감", body: `${j.error} 그 기록에 이 출고분이 반영되지 않은 게 확실할 때만 — 오늘 날짜로 차감합니다. 그만두면 차감 없이 닫을지 다시 묻습니다.`, action: "오늘 날짜로 차감", cancel: "차감 안 함" })) { flags.ackCount = true; continue; }
          if (!(await confirm(CLOSE_GHOST_ASK))) break;
          flags.resumeInterrupted = false; flags.closeInterrupted = true; continue;
        }
        if (r.status === 409 && j.overlap && !flags.allowOverlap) {
          if (!(await confirm({ title: "미출고 배치와 겹치는 주문 출고", body: `${j.error} 실제로 다시 보냈을 때만 출고하세요. 아니면 그만두고 발주엑셀을 다시 올리세요.${again}`, action: "다시 보냈음 — 출고" }))) break;
          flags.allowOverlap = true; continue;
        }
        if (r.status === 409 && j.dedupOff && !flags.ackDedupOff) {
          if (!(await confirm({ title: "중복 방지가 꺼진 채 출고", body: String(j.error), action: "그래도 출고" }))) break;
          flags.ackDedupOff = true; continue;
        }
        if (r.status === 409 && j.needUnmatchedAck) setUnmatchedAck(false);
        if (!j.ok) throw new Error(j.error || "출고를 완료하지 못했습니다. [출고 완료]를 다시 누르세요.");
        setDispatchDone(j); void loadSide();
        break;
      }
    } catch (e) { setError(e instanceof Error ? e.message : "출고를 완료하지 못했습니다. [출고 완료]를 다시 누르세요."); }
    setDispatching(false);
  }

  async function reset() {
    if (!(await okToLeave())) return;
    setRes(null); setStep(0); setFileName(""); setAck(false); setMsgAck(false); setOverlapAck(false); setCnDownloaded(false); setRecordOk(""); setError("");
    void loadSide();
  }

  const msgWarns = res?.messageWarnings ?? [];
  // 완전히 같은 문장(공백 차이만 무시)은 한 줄로 합쳐 "윤현석 등 3명 · 문 앞" 으로 보인다 —
  //  표준 문구가 수십 줄 반복되는 것을 접어 훑는 시간을 줄인다. 이름은 중복 제거해 센다.
  const msgGroups = (() => {
    const m = new Map<string, { msg: string; names: string[] }>();
    for (const w of msgWarns) {
      const key = w.msg.replace(/\s+/g, "");
      const g = m.get(key);
      const nm = w.name || "(이름?)";
      if (!g) m.set(key, { msg: w.msg, names: [nm] });
      else if (!g.names.includes(nm)) g.names.push(nm);
    }
    return [...m.values()];
  })();
  // 주소 경고·배송메시지 각각 확인(체크)해야 다운로드가 풀린다
  const overlapWarn = !!res?.openOverlap && ("error" in res.openOverlap || res.openOverlap.orders > 0);
  const blocked = !!res && ((res.addressWarnings.length > 0 && !ack) || (msgWarns.length > 0 && !msgAck) || (overlapWarn && !overlapAck));
  const unm = dispatch?.unmatched ?? [];
  const unmQty = unm.reduce((s, u) => s + u.qty, 0);
  const dedupOffBanner = res && res.dedupEnabled === false && (
    <div className="sm-warn"><strong>중복 방지 꺼짐</strong> — 이미 출고한 주문이 섞여도 걸러지지 않습니다. <Link className="sm-link" href="/fulfill/settings">설정</Link></div>
  );
  const canJump = (i: number) => i === 0 || !!res;
  const canNext = step === 0 ? !!res : step === 1 ? !blocked : step === 2 ? true : false;

  return (
    <div className="b2b-container" style={{ maxWidth: 880 }}>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">발주처리</h1>
        </div>
        <div className="b2b-page-actions sm-row" style={{ gap: 6 }}>
          {res && <button className="b2b-btn-secondary" onClick={reset}>새 발주 시작</button>}
          {/* 출고 전 나가기 — 모달 답이 비동기라 링크 이동을 먼저 막고, 확인하면 router 로 이동 */}
          <Link className="b2b-btn-secondary" href="/fulfill/log" onClick={(e) => { if (!leaveRisk) return; e.preventDefault(); void okToLeave().then((ok) => { if (ok) router.push("/fulfill/log"); }); }}>배송일지 보기</Link>
        </div>
      </header>

      {/* 진행 단계 */}
      <div className="sm-row" style={{ gap: 0, marginBottom: 18, alignItems: "flex-start" }}>
        {STEPS.map((label, i) => {
          const state = i < step ? "done" : i === step ? "cur" : "todo";
          const color = state === "done" ? "var(--sm-success)" : state === "cur" ? "var(--sm-orange)" : "var(--sm-border)";
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", flex: i < STEPS.length - 1 ? 1 : "0 0 auto" }}>
              <button onClick={() => canJump(i) && setStep(i)} disabled={!canJump(i)} title={label}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", cursor: canJump(i) ? "pointer" : "default", padding: 0 }}>
                <span style={{ width: 30, height: 30, borderRadius: "50%", background: state === "todo" ? "var(--sm-white)" : color, border: `2px solid ${color}`, color: state === "todo" ? "var(--sm-text-light)" : "var(--sm-white)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, flex: "0 0 auto" }}>
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span style={{ fontSize: 12, fontWeight: state === "cur" ? 700 : 500, color: state === "cur" ? "var(--sm-dark)" : "var(--sm-text-light)", textAlign: "center" }}>{label}</span>
              </button>
              {i < STEPS.length - 1 && <div style={{ flex: 1, height: 2, background: i < step ? "var(--sm-success)" : "var(--sm-border)", margin: "0 8px", alignSelf: "flex-start", marginTop: 14 }} />}
            </div>
          );
        })}
      </div>

      {error && <div className="b2b-error">{error}{error.includes("054") ? " — 상품마스터에 택배 정보(migration 054)가 필요합니다." : ""}</div>}

      {/* STEP 0 — 업로드 */}
      {step === 0 && (
        <>
          <section className="b2b-card" style={{ marginBottom: 16 }}>
            <div className="b2b-card-head"><span className="b2b-card-title">① 발주엑셀 업로드</span></div>
            <div className="b2b-field" style={{ marginBottom: 12 }}>
              <label className="b2b-field-label">주소 경고어 <span className="opt">(쉼표로 구분, 이 브라우저에만 저장)</span></label>
              <input className="b2b-input" value={keywords} onChange={(e) => saveKeywords(e.target.value)} placeholder="제주마루 702호, 군부대, 사서함" />
            </div>
            <div className="sm-row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button className="b2b-btn-primary" onClick={async () => { if (await okToLeave()) fileRef.current?.click(); }} disabled={loading}>{loading ? "만드는 중..." : res ? "다른 엑셀로 다시" : "주문 엑셀 올리기"}</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onFile} style={{ display: "none" }} />
              {fileName && <span className="sm-faint" style={{ fontSize: 12 }}>{fileName}</span>}
            </div>
          </section>

          {openBatches.filter((b) => b.sig !== res?.sig).length > 0 && (
            <div className="sm-warn" style={{ lineHeight: 1.6 }}>
              <strong>CN 파일을 받았지만 출고 완료 안 한 배치 {qtyText(openBatches.filter((b) => b.sig !== res?.sig).length, "건")}</strong> — 발송했으면 같은 파일을 다시 올려 ④ 상품 출고까지 끝내세요.
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                {openBatches.filter((b) => b.sig !== res?.sig).map((b) => (
                  <li key={b.sig}>
                    {b.file_name || "(파일명 없음)"} ({dateTime(b.downloaded_at)}){b.order_count != null ? ` 주문 ${qtyText(b.order_count, "건")}` : ""}{b.total_qty != null ? `, ${qtyText(Number(b.total_qty))}` : ""}{b.interrupted ? " — 출고가 중간에 끊김(재고 미차감)" : ""}
                    <button className="b2b-link-btn" style={{ fontSize: 12, marginLeft: 8 }} onClick={() => discardBatch(b)} disabled={sideBusy === b.sig}>발송 안 함</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {unmRows.length > 0 && (
            <div className="b2b-error" style={{ lineHeight: 1.6 }}>
              <strong>재고가 빠지지 않은 코드 {qtyText(unmRows.length, "건")}</strong> — 상품마스터에 등록한 뒤 [재고 차감 기록]. 그 사이 실사를 했으면 [확인 완료]만 누르세요(출고일 뒤 실사가 있으면 차감 전에 한 번 더 묻습니다).
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                {unmRows.map((u) => (
                  <li key={u.id}>
                    {u.dispatch_date}{u.order_no ? ` (${u.order_no})` : ""}: {u.codes.map((c) => `${c.sku} ${qtyText(c.qty)}${c.registered ? "" : "(미등록)"}`).join(", ")}
                    <button className="b2b-link-btn" style={{ fontSize: 12, marginLeft: 8 }} onClick={() => resolveUnm(u, "record")} disabled={sideBusy === u.id || !u.codes.some((c) => c.registered)}>재고 차감 기록</button>
                    <button className="b2b-link-btn" style={{ fontSize: 12, marginLeft: 8 }} onClick={() => resolveUnm(u, "done")} disabled={sideBusy === u.id}>확인 완료</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {res && (
            <>
              {dedupOffBanner}
              {res.interruptedResume && (
                <div className="sm-warn"><strong>재고가 안 빠진 중단된 출고의 파일입니다</strong> — CN 파일을 이미 발송했으면 다시 올리지 말고 ④ 상품 출고로 바로 가세요. 그 사이 [입고 및 출고]에서 직접 기록했거나 실사로 맞췄으면 ④에서 차감 없이 닫으세요.</div>
              )}
              {(res.interruptedExcluded || 0) > 0 && (
                <div className="sm-warn">제외한 주문 중 {qtyText(res.interruptedExcluded, "건")}은 재고가 안 빠진 중단된 출고의 주문입니다 — 그 배치의 원래 파일을 그대로 다시 올려 ④ 상품 출고를 마치세요.</div>
              )}
              <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 16 }}>
                <div className="b2b-stat-card"><div className="b2b-stat-card-label">전체 주문행</div><div className="b2b-stat-card-value">{qty(res.stats.total)}</div></div>
                {(res.excludedProcessed || 0) > 0 && (
                  <div className="b2b-stat-card" style={{ borderColor: "var(--sm-warning)" }}>
                    <div className="b2b-stat-card-label">이미 처리된 주문 제외</div>
                    <div className="b2b-stat-card-value" style={{ color: "var(--sm-warning)" }}>{qty((res.excludedProcessed || 0))}</div>
                    <div className="b2b-stat-card-hint" title={(res.excludedOrderNos || []).join(", ")}>CN·택배량·출고에서 자동 제외</div>
                  </div>
                )}
                <div className="b2b-stat-card"><div className="b2b-stat-card-label">NOTHING 제외</div><div className="b2b-stat-card-value" style={{ color: res.stats.excludedNothing ? "var(--sm-warning)" : "var(--sm-text-light)" }}>{res.stats.excludedNothing}</div></div>
                <div className="b2b-stat-card"><div className="b2b-stat-card-label">일반</div><div className="b2b-stat-card-value">{qty(res.stats.normalCount)}</div></div>
                <div className="b2b-stat-card"><div className="b2b-stat-card-label">도착보장</div><div className="b2b-stat-card-value">{qty(res.stats.guaranteeCount)}</div></div>
              </div>
              {res.unmatched.length > 0 && (
                <div className="b2b-error" style={{ lineHeight: 1.6 }}>
                  <strong>상품마스터에 택배정보가 없는 단품코드 {qtyText(res.unmatched.length)}</strong> — 품목명이 비고 중량이 0이라 박스타입/운임이 틀릴 수 있고, ④ 출고 때 재고에서 빠지지 않습니다. <Link href="/b2b/products">상품마스터</Link>에서 채운 뒤 다시 만드세요.
                  <div className="sm-faint" style={{ marginTop: 6, fontSize: 12 }}>{res.unmatched.slice(0, 30).join(", ")}{res.unmatched.length > 30 ? " ..." : ""}</div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* STEP 1 — CN 다운로드 */}
      {step === 1 && res && (
        <>
          {overlapWarn && res.openOverlap && (
            <div className="b2b-error" style={{ lineHeight: 1.6 }}>
              {"error" in res.openOverlap
                ? <strong>CN 받고 출고 안 한 다른 배치와 겹치는지 확인하지 못했습니다 — ① 화면의 미출고 배치 목록을 직접 확인한 뒤 체크하세요</strong>
                : <>
                    <strong>이 파일의 주문 {qtyText(res.openOverlap.orders, "건")}이 아직 출고 완료 안 한 다른 배치에 들어 있습니다</strong> — 그 배치를 먼저 ④ 출고 완료하거나 ① 화면에서 [발송 안 함]으로 정리하세요.
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                      {res.openOverlap.batches.map((b, i) => <li key={i}>{b.fileName || "(파일명 없음)"} ({dateTime(b.at)})</li>)}
                    </ul>
                  </>}
              <label className="sm-row" style={{ gap: 7, marginTop: 10, fontSize: 13, cursor: "pointer", fontWeight: 700 }}>
                <input type="checkbox" checked={overlapAck} onChange={(e) => setOverlapAck(e.target.checked)} /> 확인했습니다
              </label>
            </div>
          )}
          {res.addressWarnings.length > 0 && (
            <div className="sm-warn" style={{ lineHeight: 1.6 }}>
              <strong>주소 경고 {qtyText(res.addressWarnings.length, "건")}</strong> — 발주 전 반드시 확인하세요.
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                {res.addressWarnings.slice(0, 20).map((w, i) => <li key={i}>{w.name || "(이름?)"}: {w.addr}</li>)}
              </ul>
              <label className="sm-row" style={{ gap: 7, marginTop: 10, fontSize: 13, cursor: "pointer", fontWeight: 700 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 위 주소들을 확인했습니다
              </label>
            </div>
          )}
          {msgWarns.length > 0 && (
            // 노란 경고 배너(sm-warn)는 목록이 길면 눈이 아프다 — 모양은 배너 그대로, 색만 흰 바탕·기본 글씨로.
            <div style={{
              background: "var(--sm-white)", color: "var(--sm-black)",
              border: "1px solid var(--sm-border)", borderRadius: "var(--sm-radius)",
              padding: "12px 16px", fontSize: "var(--sm-fs-sm)", marginBottom: "var(--sm-space-4)", lineHeight: 1.6,
            }}>
              <strong>배송메시지 {qtyText(msgWarns.length, "건")}{msgGroups.length !== msgWarns.length ? `(${msgGroups.length}줄)` : ""}</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, maxHeight: 300, overflowY: "auto" }}>
                {msgGroups.map((g, i) => (
                  <li key={i} title={g.names.length > 1 ? g.names.join(", ") : undefined}>
                    {g.names[0]}{g.names.length > 1 ? ` 등 ${g.names.length}명` : ""}: {g.msg}
                  </li>
                ))}
              </ul>
              <label className="sm-row" style={{ gap: 7, marginTop: 10, fontSize: 13, cursor: "pointer", fontWeight: 700 }}>
                <input type="checkbox" checked={msgAck} onChange={(e) => setMsgAck(e.target.checked)} /> 위 메시지들을 확인했습니다
              </label>
            </div>
          )}
          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">② CN 파일 다운로드</span></div>
            <div className="sm-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button className="b2b-btn-primary" style={{ padding: "10px 20px", fontSize: 13, fontWeight: 700 }} disabled={blocked || res.stats.normalCount === 0}
                onClick={() => { const g = res.files.guarantee; downloadB64(res.files.normal.name, res.files.normal.b64); if (g) setTimeout(() => downloadB64(g.name, g.b64), 400); markDownloaded(); }}>
                모두 내려받기{res.files.guarantee ? " (2종)" : ""}
              </button>
              <button className="b2b-btn-secondary" disabled={blocked || res.stats.normalCount === 0} onClick={() => { downloadB64(res.files.normal.name, res.files.normal.b64); markDownloaded(); }}>CNplus 일반 내려받기 ({res.stats.normalCount})</button>
              <button className="b2b-btn-secondary" disabled={blocked || !res.files.guarantee} onClick={() => { if (res.files.guarantee) { downloadB64(res.files.guarantee.name, res.files.guarantee.b64); markDownloaded(); } }}>CNplus [도착보장] 내려받기 ({res.stats.guaranteeCount})</button>
              {blocked ? <span className="b2b-btn-why">위 경고를 확인(체크)하면 켜집니다</span>
                : res.stats.normalCount === 0 ? <span className="b2b-btn-why">일반 주문이 없어 받을 파일이 없습니다 — 다음 단계로 넘어가세요</span>
                  : !res.files.guarantee ? <span className="b2b-btn-why">도착보장 주문 없음</span> : null}
            </div>
          </section>
        </>
      )}

      {/* STEP 2 — 배송일지 */}
      {step === 2 && res && (
        <section className="b2b-card">
          <div className="b2b-card-head" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span className="b2b-card-title">③ 배송일지 기록</span>
            <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <input type="date" className="b2b-input" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} style={{ width: "auto", padding: "5px 8px", fontSize: 12 }} />
              <div className="sm-tabs" style={{ margin: 0 }} title="같은 날짜에 이미 기록이 있을 때">
                <button className={`sm-tab ${recordMode === "add" ? "is-active" : ""}`} onClick={() => setRecordMode("add")}>더하기</button>
                <button className={`sm-tab ${recordMode === "replace" ? "is-active" : ""}`} onClick={() => setRecordMode("replace")}>덮어쓰기</button>
              </div>
              <button className="b2b-btn-primary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={recordLog} disabled={recording}>{recording ? "기록 중..." : "배송일지에 기록"}</button>
              <button className="b2b-btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => downloadB64(res.files.parcel.name, res.files.parcel.b64)}>택배량 엑셀 내려받기</button>
            </div>
          </div>
          <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 8px" }}>택배 {qtyText(res.stats.parcels, "건")} (일반 {res.stats.parcels - res.stats.parcelsGuar} · 도착보장 {res.stats.parcelsGuar}){(res.stats.mergedParcels ?? 0) > 0 && <>, 합배송 병합 {qtyText(res.stats.mergedParcels, "건")}</>}</p>
          {recordOk && (
            <div className="sm-success" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>✓ {recordOk}</span>
              <Link href="/fulfill/log">배송일지 보기</Link>
              {lastRecord && <button className="b2b-link-btn" style={{ color: "var(--sm-danger)" }} onClick={undoRecord} disabled={undoing}>{undoing ? "취소 중..." : "기록 취소"}</button>}
            </div>
          )}
          <div className="b2b-table-wrap">
            <table className="b2b-table is-responsive">
              <thead><tr><th>박스종류</th><th className="num">일반</th><th className="num">도착보장</th><th className="num">합계</th></tr></thead>
              <tbody>
                {res.parcelSummary.filter((p) => p.normal || p.guarantee).map((p) => (
                  <tr key={p.category}>
                    <td data-label="박스종류"><strong>{p.category}</strong></td>
                    <td data-label="일반" className="num b2b-money">{p.normal || "-"}</td>
                    <td data-label="도착보장" className="num b2b-money" style={{ color: p.guarantee ? undefined : "var(--sm-text-light)" }}>{p.guarantee || "-"}</td>
                    <td data-label="합계" className="num b2b-money" style={{ fontWeight: 700 }}>{p.normal + p.guarantee}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sm-faint" style={{ fontSize: 12, marginTop: 6 }}>같은 발주를 다시 더하면 이중 집계됩니다.</p>
        </section>
      )}

      {/* STEP 3 — 상품 출고 */}
      {step === 3 && res && (
        <section className="b2b-card">
          <div className="b2b-card-head" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span className="b2b-card-title">④ 상품 출고</span>
            {!dispatchDone && dispatch && (dispatch.products.length > 0 || dispatch.untrackedOnly || dispatch.unmatchedOnly) && (
              <span className="sm-row">
                <button className="b2b-btn-primary" onClick={commitDispatch} disabled={dispatching || (unm.length > 0 && !unmatchedAck)} title={unm.length > 0 && !unmatchedAck ? "재고가 빠지지 않는 코드를 확인(체크)하세요" : ""}>{dispatching ? "출고 중..." : dispatch.products.length > 0 ? `출고 완료 (${dispatch.products.length}품목)` : "출고 완료 (재고 차감 없음)"}</button>
                {unm.length > 0 && !unmatchedAck && !dispatching && <span className="b2b-btn-why">아래 코드를 확인(체크)하면 켜집니다</span>}
              </span>
            )}
          </div>
          {!dispatchDone && <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 8px" }}>소매 재고에서 차감</p>}
          {!dispatchDone && dedupOffBanner}
          {dispatchLoading ? <div className="b2b-loading">재고 확인 중...</div> : dispatchDone ? (
            <div className="sm-success" style={{ lineHeight: 1.7 }}>
              {(dispatchDone.closed ?? 0) > 0
                ? <>✓ <b>정리 완료</b> — 앞선 출고 {qtyText(dispatchDone.closed, "건")}을 재고 차감 없이 처리됨으로 닫았습니다{dispatchDone.orderNo ? <> (출고번호 <b>{dispatchDone.orderNo}</b>)</> : null}.</>
                : dispatchDone.dispatched > 0
                ? <>✓ <b>출고 완료</b> — {dispatchDone.dispatched}품목 {qtyText(dispatchDone.totalQty)}를 소매 재고에서 차감했습니다 (출고번호 <b>{dispatchDone.orderNo || "-"}</b>). <Link href="/inventory">재고 보기</Link></>
                : <>✓ <b>출고 완료</b> — 차감할 재고 품목이 없어 주문만 처리됨으로 표시했습니다.</>}
              {dispatchDone.already ? <div>이미 기록돼 있던 출고에 이어 붙였습니다.</div> : null}
              {dispatchDone.resumed ? <div>재고 기록이 없던 앞선 출고 기록 {qtyText(dispatchDone.resumed, "건")}을 정리했습니다.</div> : null}
              {dispatchDone.shortages > 0 ? <div style={{ color: "var(--sm-danger)" }}>재고 부족 {dispatchDone.shortages}품목(마이너스로 기록)</div> : null}
              {(dispatchDone.unmatched?.length ?? 0) > 0 && (
                <div style={{ color: "var(--sm-danger)", marginTop: 6 }}>
                  재고가 빠지지 않은 코드 {qtyText(dispatchDone.unmatched!.length)}(총 {qtyText(dispatchDone.unmatched!.reduce((s, u) => s + u.qty, 0))}) — {dispatchDone.unmatchedSaved ? "상품마스터에 등록한 뒤 ① 화면의 [재고 차감 기록]으로 넣으세요." : UNM_NOT_SAVED[dispatchDone.unmatchedNotSaved ?? "no_column"]}
                  <div style={{ fontSize: 12 }}>{dispatchDone.unmatched!.map((u) => `${u.sku} ${qtyText(u.qty)}`).join(", ")}</div>
                </div>
              )}
              <div style={{ fontSize: 12, marginTop: 6 }}><button className="b2b-link-btn" onClick={reset}>새 발주 시작</button></div>
            </div>
          ) : dispatch ? (
            <>
              {unm.length > 0 && (
                <div className="b2b-error" style={{ marginBottom: 12, lineHeight: 1.6 }}>
                  <strong>상품마스터에 없어 재고가 빠지지 않는 코드 {qtyText(unm.length)}</strong> — 이번 출고분은 재고에서 빠지지 않습니다. <Link href="/b2b/products">상품마스터</Link>에 등록한 뒤 <button className="b2b-link-btn" onClick={() => setDispatchRetry((n) => n + 1)}>다시 확인</button>
                  <div className="sm-faint" style={{ marginTop: 5, fontSize: 12 }}>{unm.map((u) => `${u.sku} ${qtyText(u.qty)}${u.kind === "ambiguous" ? "(중복SKU)" : ""}`).join(", ")}</div>
                  <label className="sm-row" style={{ gap: 7, marginTop: 8, fontSize: 13, cursor: "pointer", fontWeight: 700 }}>
                    <input type="checkbox" checked={unmatchedAck} onChange={(e) => setUnmatchedAck(e.target.checked)} /> 이 코드 {qtyText(unm.length)}(총 {qtyText(unmQty)})는 재고 차감 없이 출고합니다
                  </label>
                </div>
              )}
              {dispatch.items.some((i) => i.kind === "untracked") && (
                <div className="sm-faint" style={{ marginBottom: 10, fontSize: 12 }}>
                  재고 관리 사용 안함 — 차감하지 않는 품목: {dispatch.items.filter((i) => i.kind === "untracked").map((i) => i.name || i.sku).join(", ")}
                </div>
              )}
              {dispatch.products.length === 0 ? (
                <div className="b2b-empty">{dispatch.message || "출고할 품목이 없습니다. [새 발주 시작]으로 마치세요."}</div>
              ) : (
                <>
                  <div className="b2b-table-wrap">
                    <table className="b2b-table is-responsive">
                      <thead><tr><th>상품</th><th>옵션</th><th className="num">출고수량</th><th className="num">현재 재고</th><th className="num">출고 후</th></tr></thead>
                      <tbody>
                        {dispatch.products.map((p) => (
                          <tr key={p.productId} style={p.short ? { background: "var(--sm-danger-bg)" } : undefined}>
                            <td data-label="상품"><strong>{p.name}</strong></td>
                            <td data-label="옵션" style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>{p.option || "-"}</td>
                            <td data-label="출고수량" className="num b2b-money">{qty(p.need)}</td>
                            <td data-label="현재 재고" className="num b2b-money">{qty(p.current)}</td>
                            <td data-label="출고 후" className="num b2b-money" style={{ fontWeight: 700, color: p.short ? "var(--sm-danger)" : undefined }}>{qty(p.after)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {dispatch.shortages > 0 && <p style={{ fontSize: 12, color: "var(--sm-danger)", marginTop: 6 }}>재고 부족 {dispatch.shortages}품목 — 출고는 진행되지만 마이너스 재고로 기록됩니다.</p>}
                  <p className="sm-faint" style={{ fontSize: 12, marginTop: 6 }}>묶음(세트)은 구성품으로 전개, 정기배송 제외</p>
                </>
              )}
            </>
          ) : dispatchErr ? (
            <div className="b2b-error">재고를 확인하지 못했습니다 — 출고할 품목이 없는 것이 아닙니다. <button className="b2b-link-btn" onClick={() => setDispatchRetry((n) => n + 1)}>다시 확인</button></div>
          ) : <div className="b2b-empty">출고할 품목이 없습니다. [새 발주 시작]으로 마치세요.</div>}
        </section>
      )}

      {/* 이전/다음 */}
      {res && (
        <div className="sm-row" style={{ justifyContent: "space-between", marginTop: 18 }}>
          <button className="b2b-btn-secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>이전 단계</button>
          {step < STEPS.length - 1 ? (
            <span className="sm-row">
              {!canNext && <span className="b2b-btn-why is-before">{step === 0 ? "①을 먼저 — 엑셀을 올리면 켜집니다" : "②의 경고를 확인(체크)하면 켜집니다"}</span>}
              <button className="b2b-btn-primary" onClick={onNext} disabled={!canNext || recording} title={!canNext ? "이 단계를 완료해야 넘어갈 수 있습니다" : ""}>
                {step === 1 ? "CN 2종 받고 다음 단계"
                  : step === 2 ? (recording ? "기록 중..." : recordOk ? "다음 단계: 상품 출고" : "배송일지에 기록 후 다음 단계")
                    : `다음 단계: ${STEPS[step + 1]}`}
              </button>
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
