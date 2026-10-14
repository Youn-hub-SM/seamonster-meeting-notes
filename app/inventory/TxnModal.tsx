"use client";

import { useEscClose } from "@/app/lib/use-esc";
import { useEffect, useMemo, useRef, useState } from "react";
import { INV_TXN_TYPES, INV_TYPE_COLOR, MOVE_ONLY_CHANNELS, type InvTxnType, type InvChannel, type InvChannelFilter } from "@/app/lib/inventory";
import { ChannelPicker } from "./ChannelTabs";
import { Combobox, type ComboOption } from "@/app/b2b/orders/Combobox";
import { formatLinkResult, type LinkResultLite } from "@/app/lib/link-result";
import { useConfirm, useToast, type ConfirmOptions } from "@/app/components/Feedback";

// 공용 확인 모달 호출 함수 — 훅(useConfirm)은 컴포넌트 안에서만 부를 수 있어, 입고 화면 3곳이 함께 쓰는 유틸에는 호출부가 넘겨 준다.
export type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
// 줄바꿈이 있는 본문(품목 목록 등) — 모달 본문은 white-space 기본값이라 줄을 살려 넣는다
export const preLines = (s: string) => <span style={{ whiteSpace: "pre-line" }}>{s}</span>;

const TODAY = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const DAYS_AGO = (n: number) => new Date(Date.now() + 9 * 3600_000 - n * 86400_000).toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 제출 키(131) — 창(또는 미리보기)마다 하나. 응답이 끊겨 다시 눌러도 서버가 같은 키를 알아보고 한 번만 기록한다.
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
// 응답을 못 받았을 때(시간 초과·네트워크) — 서버에는 저장됐을 수 있다. 다시 기록·취소 전에 목록부터 본다(입고 화면 3곳 공용).
export const LOST_MSG = "응답을 받지 못했습니다 — 이미 저장됐을 수 있으니 [입고 및 출고] 목록을 먼저 확인하세요.";

// 입고 → 요청서 연결 결과 알림(입고 화면 3곳 공용). 연결이 빠지면 입고 원장은 그대로 두고 연결만 다시 잇는다(S11) —
//  '취소 후 재기록'은 안내하지 않는다(재기록 사이에 재고·이행이 흔들리고, 응답을 잃은 경우 이중 입고가 된다).
export function linkMessage(link: LinkResultLite, nameOf: (productId: string) => string): string {
  const relink = (reqNo?: string) => `입고는 저장됐습니다(재고는 그대로) — 생산 요청 화면에서 ${reqNo || "그 요청서"}의 [입고 연결]로 다시 연결하세요.`;
  if (!link.ok) {
    const reason = link.reason || "원인 불명";
    return `요청서에 연결되지 않았습니다 — ${reason}${/\[입고 연결\]/.test(reason) ? "" : `\n${relink(link.req_no)}`}`;
  }
  const failed = link.failed ?? [];
  if (!failed.length) return formatLinkResult(link, nameOf);
  const names = failed.map((f) => `${nameOf(f.product_id)}${f.qty ? ` ${f.qty.toLocaleString()}` : ""}`).join(", ");
  const head = link.lines.length ? formatLinkResult({ ...link, failed: [] }, nameOf) : `${link.req_no || "요청서"}에 연결되지 않은 품목이 있습니다.`;
  return `${head}\n연결 실패: ${names}\n${relink(link.req_no)}`;
}

// 제조사 입고를 '연결 안 함'으로 저장하기 전(S9) — 열린 제조사 요청서에 남은 수량이 있는 품목이면 확인을 받는다.
//  요청서로 들어온 물건을 연결 없이 넣으면 현재고와 입고 예정에 두 번 잡혀 생산 권장이 줄어든다.
//  잔여를 못 읽으면(remain_ok=false·조회 실패) 경고 없이 저장하지 않고 확인을 받는다(S4). true = 저장 진행.
//  품목 id 를 모르는 줄이 있으면(구 서버 응답 — 입출고 목록의 대기 입고처리) 잔여를 셀 수 없으니 같은 확인을 받는다.
type RemainMap = Record<string, { qty: number; reqs: { req_no: string | null; qty: number }[] }>;
export async function confirmUnlinkedInbound(date: string, items: { product_id: string; name: string }[], confirm: ConfirmFn): Promise<boolean> {
  if (!items.length) return true;
  const unknown = () => confirm({ title: "요청서 연결 없이 입고", body: "열린 생산 요청서의 남은 수량을 확인하지 못했습니다. 요청서로 들어온 물건이면 그만두고 요청서를 고르세요 — 연결 없이 넣으면 현재고와 입고 예정에 두 번 잡힙니다. 협의분·일반 입고면 요청서 연결 없이 저장합니다.", action: "연결 없이 저장" });
  if (items.some((x) => !x.product_id)) return unknown();
  let j: { ok?: boolean; remain_by_product?: RemainMap; remain_ok?: boolean } | null = null;
  try { j = await (await fetch(`/api/production/requests/open?date=${encodeURIComponent(date)}&remain=1`, { cache: "no-store" })).json(); } catch { j = null; }
  const remain = j?.ok && j.remain_ok !== false ? j.remain_by_product : undefined;
  if (!remain) return unknown();
  const hits = items.filter((x) => (Number(remain[x.product_id]?.qty) || 0) > 0);
  if (!hits.length) return true;
  const lines = hits.slice(0, 8).map((x) => {
    const r = remain[x.product_id];
    const reqs = (r.reqs || []).slice(0, 3).map((q) => `${q.req_no || "요청서"} ${Number(q.qty).toLocaleString()}`).join(", ");
    return `- ${x.name}: 남은 ${Number(r.qty).toLocaleString()}${reqs ? ` (${reqs}${r.reqs.length > 3 ? " 외" : ""})` : ""}`;
  });
  return confirm({
    title: "요청서 연결 없이 입고",
    body: preLines(`열린 요청서에 남은 수량이 있는 품목입니다.\n${lines.join("\n")}${hits.length > 8 ? `\n- 외 ${hits.length - 8}개 품목` : ""}\n요청서로 들어온 물건이면 그만두고 요청서를 고르세요. 협의분·일반 입고면 요청서 연결 없이 저장합니다.`),
    action: "연결 없이 저장",
  });
}

// 실사 전 점검(D4a·S8) — /api/inventory/adjust/precheck · 엑셀 실사 미리보기가 돌려주는 점검 중 이 창이 쓰는 부분.
//  b2b = 재고에서 이미 빠졌지만(선점 거래일 ≤ 실사일) 아직 안 나간 B2B 발주, pendingBy = 품목별 '대기' 입출고 수.
//  remaining = 선반에 남은(안 나간) 수량(null = 계산할 수 없음 — 확인 필요). 다 나간 품목은 items 에서 빠져 온다.
type B2bHold = { order_id: string; order_no: string | null; company: string | null; deduct_date: string; open_dates: string[]; partial: boolean; qty: number; remaining?: number | null; items: { product_id: string; qty: number; remaining?: number | null }[] };
//  moved = 실사일 당일·이후 입출고 앞 50건(당일 먼저) — 직접 입력에서 그 품목의 당일 건수를 셀 때 쓴다.
type CountChecks = { date: string; b2b: B2bHold[]; pendingTotal: number; pendingBy: Record<string, number>; sameDay: number; formDate?: string; moved?: { product_id: string; txn_date: string }[] };
// pid = 직접 입력(한 품목) — 안 나간 수량을 그 품목 기준으로 보인다. formDate = 엑셀 양식 기준일(실사일과 다를 때만)
//  sameDayChan = 당일 건수가 그 품목이 아니라 칸 전체 기준(목록이 잘려 품목별로 셀 수 없을 때 — 적게 세지 않게)
type ShownChecks = { b2b: B2bHold[]; pending: number; sameDay: number; date: string; formDate?: string; pid?: string; sameDayChan?: boolean };
// 발주 하나의 안 나간 수량 — 품목 지정이면 그 품목 줄만. undefined = 구 서버(표시 안 함), null = 확인 필요
const holdRemain = (h: B2bHold, pid?: string): number | null | undefined => {
  if (!pid) return h.remaining;
  const it = h.items.find((x) => x.product_id === pid);
  return it ? it.remaining : undefined;
};
const remainText = (v: number | null | undefined) => (v === undefined ? "" : v === null ? "안 나간 수량 확인 필요" : `안 나간 ${v.toLocaleString()}`);
// 실사 전 점검 확인 모달 — 걸린 것이 없으면 null(묻지 않음)
const checkConfirmAsk = (c: ShownChecks): ConfirmOptions | null => {
  const parts: string[] = [];
  if (c.formDate) parts.push(`양식 기준일(${c.formDate}) ≠ 실사일(${c.date}) — 표의 재고는 실사일 기준입니다. 센 날 마감이 실사일이 맞는지 확인하세요.`);
  if (c.b2b.length) {
    const rs = c.b2b.map((h) => holdRemain(h, c.pid));
    const known = rs.every((v) => typeof v === "number");
    const unknown = rs.some((v) => v === null);
    const sum = known ? Math.round((rs as number[]).reduce((a, v) => a + v, 0) * 1000) / 1000 : 0;
    const tail = unknown ? "(안 나간 수량 확인 필요)" : known ? `(안 나간 ${sum.toLocaleString()})` : "";
    parts.push(`재고에서 이미 빠졌지만 아직 안 나간 B2B 발주 ${c.b2b.length}건${tail} — 이대로 맞추면 그 수량만큼 유령 재고가 생깁니다(나갔으면 발송완료, 안 나갔으면 발송일 다시 지정).`);
  }
  if (c.pending) parts.push(`'대기' 입출고 ${c.pending}건 — 실물이 이미 움직였다면 실사 뒤 처리할 때 이중 반영됩니다(먼저 처리·취소).`);
  if (c.sameDay) parts.push(`${c.sameDayChan ? "이 칸 " : ""}실사일 당일 입출고 ${c.sameDay}건 — 실사 전 움직임인지 확인하세요.`);
  return parts.length ? { title: "실사 전 점검", body: preLines(`- ${parts.join("\n- ")}\n정리했으면 이대로 반영합니다.`), action: "이대로 반영" } : null;
};
export type OpenReq = { id: string; req_no: string | null; title: string | null; prod_start: string; due_date: string | null; in_window: boolean; full?: boolean };
// 요청서 목록 조회 결과 → 입고 화면 경고 문구(없으면 ""). 조회 실패·이행률 판독 실패 모두 사람이 직접 골라야 한다.
export const reqWarnOf = (j: { ok?: boolean; full_ok?: boolean } | null) =>
  !j?.ok ? "요청서 목록을 불러오지 못했습니다 — 새로고침 후 다시 시도하세요. 이대로 저장하면 요청서에 연결되지 않습니다."
  : j.full_ok === false ? "이행률을 읽지 못해 기본 요청서를 고르지 않았습니다 — 연결할 요청서를 직접 고르세요." : "";

// 입고 → 요청서 선택(지정 매칭). 직접 입력·엑셀 두 모드가 같이 쓴다.
export function RequestSelect({ reqs, value, disabled, warn, onChange }: { reqs: OpenReq[]; value: string; disabled?: boolean; warn?: string; onChange: (v: string) => void }) {
  return (
    <label className="b2b-field"><span className="b2b-field-label">요청서</span>
      <select className="b2b-input" value={disabled ? "" : value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">연결 안 함</option>
        {reqs.map((r) => <option key={r.id} value={r.id}>{r.req_no || "요청서"}{r.title ? ` · ${r.title}` : ""} · 생산 {r.prod_start.slice(5)}~{(r.due_date || "").slice(5)}{r.in_window ? "" : " (기간 밖)"}{r.full ? " (이행 100%)" : ""}</option>)}
      </select>
      {warn && <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--sm-danger)", marginTop: 4 }}>{warn}</span>}</label>
  );
}

// 입고 사유 — 고객 반품·교환으로 돌아온 물건은 '고객 반품'으로 입고한다(D4b 수동 절차). 매입이 아니라 요청서·단가 없이 기록된다.
function InReasonSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="b2b-field"><span className="b2b-field-label">사유</span>
      <select className="b2b-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">입고(매입·생산)</option>
        <option value="고객 반품">고객 반품·교환 회수</option>
      </select>
      {value === "고객 반품" && <span className="sm-faint" style={{ display: "block", fontSize: 12, marginTop: 4 }}>요청서 연결·매입 단가 없이 기록됩니다</span>}</label>
  );
}

// 실사 전 점검(D4a·S8) — 확인 실패는 오류로(조정이 막힌다, S4).
function CountCheckWarn({ c, err }: { c: ShownChecks | null; err: string }) {
  if (err) return <div className="b2b-error" style={{ marginBottom: 12 }}>{err}</div>;
  if (!c || (!c.b2b.length && !c.pending && !c.sameDay && !c.formDate)) return null;
  return (
    <div className="sm-warn" style={{ marginBottom: 12 }}>
      {c.formDate && (
        <div style={{ marginBottom: c.b2b.length || c.pending || c.sameDay ? 6 : 0 }}>
          <strong>양식 기준일 {c.formDate.slice(5)} ≠ 실사일 {c.date.slice(5)}</strong> — 표의 재고는 실사일 기준입니다. 센 날 마감이 실사일이 맞는지 확인하세요.
        </div>
      )}
      {c.b2b.length > 0 && (
        <>
          <strong>재고에서 빠졌지만 아직 안 나간 B2B 발주 {c.b2b.length}건</strong> — 실사 전에 정리하세요(나갔으면 발송완료, 안 나갔으면 발송일 다시 지정).
          <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12 }}>
            {c.b2b.slice(0, 6).map((h) => {
              const rt = remainText(holdRemain(h, c.pid));
              return (
                <li key={h.order_id}>
                  <a className="sm-link" href={`/b2b/orders/${h.order_id}`} target="_blank" rel="noreferrer">{h.order_no || "발주"}</a>
                  {` · ${h.company || "-"} · 차감 ${h.deduct_date.slice(5)}${h.open_dates[0] ? ` · 발송 ${h.open_dates[0].slice(5)}` : ""}${h.partial ? " · 일부 발송" : ""}`}
                  {rt && <strong>{` · ${rt}`}</strong>}
                </li>
              );
            })}
            {c.b2b.length > 6 && <li>외 {c.b2b.length - 6}건</li>}
          </ul>
        </>
      )}
      {c.pending > 0 && <div style={{ marginTop: c.b2b.length ? 6 : 0 }}>대기 입출고 {c.pending.toLocaleString()}건 — 이미 움직였으면 먼저 처리·취소하세요.</div>}
      {c.sameDay > 0 && <div>{c.sameDayChan ? "이 칸 " : ""}실사일 당일 입출고 {c.sameDay.toLocaleString()}건 — 실사 전 움직임인지 확인하세요.</div>}
    </div>
  );
}

type Product = { id: string; name: string; sku: string | null; unit: string; is_bundle?: boolean };

// 엑셀 미리보기 — 입고/출고와 조정은 서버 응답 모양이 달라 종류로 구분해 담는다.
type IoRow = { type: "입고" | "출고"; qty: number; product_id: string; product_name: string; unit_amount: number | null; txn_date: string; partner: string | null; memo: string | null; reason?: string | null };
type AdjRow = { product_id: string; sku: string | null; name: string; spec: string | null; unit: string; current: number; target: number; delta: number; memo: string | null; pending?: number };
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
  untracked: number; // 재고 관리 사용 안함(121) 품목이라 뺀 행
  key: string;       // 이 미리보기의 제출 키(131) — 반영을 다시 눌러도 한 번만 기록된다
  countDate?: string;    // 조정: 실사한 날(미리보기·반영 모두 이 날 마감 기준)
  checks?: CountChecks;  // 조정: 이 파일 품목의 실사 전 점검(서버)
};

export default function TxnModal({
  products, qtyOf, defaultType = "입고", defaultProductId = "", defaultChannel: defaultChannelProp, channelChosen = false, defaultDate, qtySource, lockProduct = false, onClose, onSaved,
}: {
  products: Product[];
  /** 부모 목록의 재고(qty = 가용 — 미래 발송일 선점까지 뺀 값). 출고 초과 경고·조정 델타의 기준. */
  qtyOf: (id: string) => number;
  defaultType?: InvTxnType;
  defaultProductId?: string;
  /** 연 탭의 칸. 없으면('전체' 탭 등) 출고·조정은 사람이 칸을 직접 고른다(S8) — 입고는 늘 소매. */
  defaultChannel?: InvChannel;
  /** true = 부모 화면에서 사람이 이미 고른 칸(실사 화면의 칸 선택 등) — defaultChannel 을 조정 칸의 명시 선택으로 인정한다(S8). */
  channelChosen?: boolean;
  /** 거래일(조정은 실사일) 초깃값 — 없으면 오늘(KST). */
  defaultDate?: string;
  /** qtyOf 가 어느 채널 기준인지. 부모 목록이 '전체'(도매+소매 합산)면 반드시 넘길 것 —
   *  합산 재고를 특정 채널의 현재고로 착각하면 조정 델타가 통째로 틀어진다. 기본값은 defaultChannel. */
  qtySource?: InvChannelFilter;
  lockProduct?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  useEscClose(onClose);
  const confirm = useConfirm();
  const toast = useToast();
  const defaultChannel: InvChannel = defaultChannelProp ?? "소매";
  const chanGiven = defaultChannelProp !== undefined;
  const [type, setType] = useState<InvTxnType>(defaultType);
  // 입고는 이동 전용 칸(도매·프로모션·도매 대량)을 못 고른다 — 세 칸 모두 소매 입고 후 [재고 이동]으로만 들어간다(실수 방지).
  //  그 칸 탭에서 열면 기본 채널이 그 칸으로 오므로 입고 기본형이면 소매로 돌려놓는다.
  const [channel, setChannel] = useState<InvChannel>(defaultType === "입고" && MOVE_ONLY_CHANNELS.includes(defaultChannel) ? "소매" : defaultChannel);
  // 사용자가 손으로 고른 칸 — 입고(소매 고정)에서 조정/출고로 돌아오면 그 칸, 안 골랐으면 연 탭의 칸(defaultChannel)으로 되돌린다
  //  (도매 대량 탭에서 연 창이 소매에 머물러 소매 칸을 덮어쓰는 사고 방지). 입고 중 소매를 다시 누른 건 '고름'이 아니다.
  //  channelChosen 이면 부모 화면에서 고른 칸이 곧 이 창의 선택이다(실사 화면 → 조정 창).
  const [picked, setPicked] = useState<InvChannel | null>(channelChosen && defaultChannelProp !== undefined ? defaultChannelProp : null);
  // 조정은 칸을 이 창에서 직접 눌러 고른 뒤에만(S8) — 연 탭의 기본값(전체 → 소매 등)으로 다른 칸의 실사가 들어가지 않게
  const chanExplicit = picked !== null && picked === channel;
  const submitKey = useRef(newKey());
  const [productId, setProductId] = useState(defaultProductId);
  const [qty, setQty] = useState("");
  const [adjMode, setAdjMode] = useState<"target" | "delta">("target");
  const [unitAmount, setUnitAmount] = useState("");
  const [date, setDate] = useState(() => (defaultDate && DATE_RE.test(defaultDate) ? defaultDate : TODAY()));
  const [partner, setPartner] = useState("");
  const [memo, setMemo] = useState("");
  const [reason, setReason] = useState("판매"); // 출고 사유 — '판매' 외에는 대사(구매·판매·재고 확인)에서 분리 집계(099)
  const [inReason, setInReason] = useState(""); // 입고 사유 — '' = 일반(매입), '고객 반품'(D4b) = 요청서 연결·단가 없음
  const customerReturn = type === "입고" && inReason === "고객 반품";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErr, setFieldErr] = useState<{ product?: string; qty?: string }>({}); // 칸 아래 한 줄(E5)
  // 지정 매칭 — 입고를 연결할 제조사 요청서. 거래일이 생산기간에 드는 요청서가 기본값(사람이 고르면 그대로).
  const [reqs, setReqs] = useState<OpenReq[]>([]);
  const [reqId, setReqId] = useState("");
  const [reqTouched, setReqTouched] = useState(false);
  const [reqWarn, setReqWarn] = useState("");
  useEffect(() => {
    if (type !== "입고") return;
    let alive = true;
    fetch(`/api/production/requests/open?date=${date}`, { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!alive) return;
      setReqWarn(reqWarnOf(j));
      if (!j?.ok) { setReqId(""); setReqs([]); return; } // 경고('연결되지 않습니다')와 실제 저장이 맞게 — 옛 선택·옛 목록(다른 거래일 기준)을 남기지 않는다
      setReqs(j.requests || []);
      if (!reqTouched) setReqId(j.default_id || "");
    }).catch(() => { if (alive) { setReqWarn(reqWarnOf(null)); setReqId(""); setReqs([]); } });
    return () => { alive = false; };
  }, [type, date, reqTouched]);
  const pickReq = (v: string) => { setReqId(v); setReqTouched(true); };

  const product = useMemo(() => products.find((p) => p.id === productId), [products, productId]);
  const isAdjust = type === "조정";
  // 칸을 이 창에서 직접 골라야 하는 경우 — 조정은 늘(S8), 출고는 연 탭이 칸을 정하지 않았을 때('전체' 탭)
  const needPick = isAdjust || (type === "출고" && !chanGiven);
  const pickMissing = needPick && !chanExplicit;

  // ── 엑셀 일괄 모드 — 양식 다운로드 → 첨부 → 미리보기 → 반영 ──
  //  파서·반영 API 는 기존 것을 그대로 쓴다: 입고/출고 = /api/inventory/txns/import(+/apply),
  //  조정 = /api/inventory/adjust/import(+/apply, 실사수량 기준이라 반영 시점에 서버가 델타 재계산).
  const [mode, setMode] = useState<"직접" | "엑셀">("직접");
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [ioDone, setIoDone] = useState(true); // 입고/출고 즉시처리(해제 시 '대기')
  const [preview, setPreview] = useState<Preview | null>(null);
  // 양식은 전 품목의 SKU·품목명·현재고를 채워서 받는다(fill=1) — 수량 칸만 채우면 되게.
  //  조정 양식은 실사한 날 마감 재고로 받는다(asof) — 오늘 양식을 과거 실사일로 올리면 '양식 기준일 ≠ 실사일'이 된다.
  const templateHref = isAdjust
    ? `/api/inventory/adjust/template?fill=1&channel=${encodeURIComponent(channel)}${DATE_RE.test(date) ? `&asof=${date}` : ""}`
    : `/api/inventory/txns/template?type=${type}&fill=1&channel=${encodeURIComponent(channel)}`;

  // 실사 전 점검(D4a·S8) — 조정 칸을 고르면 그 칸·실사일 기준으로 읽어 보여 준다(엑셀 실사 화면과 같은 점검, adjust/precheck).
  //  B2B 발주 전량이 가장 이른 발송일에 빠지므로 안 나간 발주의 물건은 창고에 있다 — 이대로 맞추면 유령 재고가 생긴다.
  //  null = 확인 중, checksErr = 확인 실패(이때는 조정을 막는다, S4). 엑셀은 미리보기가 오면 그 파일 품목의 점검을 쓴다.
  const [checks, setChecks] = useState<CountChecks | null>(null);
  const [checksErr, setChecksErr] = useState("");
  const checksOn = isAdjust && chanExplicit && DATE_RE.test(date);
  useEffect(() => {
    setChecks(null); setChecksErr("");
    if (!checksOn) return;
    let alive = true;
    const fail = "실사 전 점검을 불러오지 못했습니다 — 창을 닫았다 다시 여세요.";
    fetch(`/api/inventory/adjust/precheck?channel=${encodeURIComponent(channel)}&date=${date}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!alive) return; if (!j?.ok || !j.checks) setChecksErr(j?.error || fail); else setChecks(j.checks as CountChecks); })
      .catch(() => { if (alive) setChecksErr(fail); });
    return () => { alive = false; };
  }, [checksOn, channel, date]);
  // 직접 입력은 그 품목만, 엑셀 실사는 칸 전체(미리보기가 있으면 그 파일 품목만)
  const shownChecks = useMemo<ShownChecks | null>(() => {
    const fromPreview = mode === "엑셀" && preview?.kind === "조정" && preview.checks;
    const c = fromPreview ? preview.checks! : checks;
    if (!c) return null;
    const cDate = c.date || (fromPreview ? preview.countDate || date : date);
    // 양식 기준일 경고는 엑셀 미리보기에서만 온다(그 파일의 양식 헤더)
    if (mode === "엑셀") return { b2b: c.b2b ?? [], pending: c.pendingTotal || 0, sameDay: c.sameDay || 0, date: cDate, formDate: fromPreview ? c.formDate || undefined : undefined };
    if (!productId) return { b2b: [], pending: 0, sameDay: 0, date: cDate };
    // 당일 입출고 — 목록(moved)에 당일 건이 전부 실려 왔으면 그 품목만 세고, 잘렸거나 구 서버면 칸 전체 건수를 그대로 보인다
    const sameAll = Array.isArray(c.moved) ? c.moved.filter((t) => t.txn_date === cDate) : null;
    const complete = !!sameAll && sameAll.length >= (c.sameDay || 0);
    const sameDay = complete ? sameAll!.filter((t) => t.product_id === productId).length : c.sameDay || 0;
    return { b2b: (c.b2b ?? []).filter((h) => h.items.some((x) => x.product_id === productId)), pending: c.pendingBy?.[productId] || 0, sameDay, sameDayChan: !complete && sameDay > 0, date: cDate, pid: productId };
  }, [checks, mode, preview, productId, date]);

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
      if (adj) { fd.append("channel", reqChannel); fd.append("count_date", date); } // 실사한 날 마감 기준
      else { fd.append("type", reqType); fd.append("txn_date", date); fd.append("partner", partner); fd.append("done", ioDone ? "1" : "0"); } // 즉시 처리면 미래 날짜 행은 오류로
      const res = await fetch(adj ? "/api/inventory/adjust/import" : "/api/inventory/txns/import", { method: "POST", body: fd });
      const j = await res.json();
      if (seq !== reqSeq.current) return; // 그 사이 조건이 바뀜 → 폐기
      if (!res.ok || !j.ok) throw new Error(j.error || "분석 실패");
      const base = { reqType, reqChannel, rows: j.rows || [], errors: j.errors || [], valid: Number(j.summary?.valid) || 0, errCount: Number(j.summary?.errors) || 0, skipped: Number(j.summary?.skipped) || 0, untracked: Number(j.summary?.untracked) || 0, key: newKey() };
      setPreview(adj
        ? { ...base, kind: "조정", count: Number(j.summary?.changed) || 0, merged: 0, countDate: String(j.count_date || date), checks: j.checks as CountChecks | undefined }
        : { ...base, kind: "입출", count: Number(j.summary?.valid) || 0, merged: Number(j.summary?.merged) || 0 });
    } catch (e) { if (seq === reqSeq.current) setError(e instanceof Error ? e.message : "분석 실패"); }
    if (seq === reqSeq.current) setImporting(false);
  }

  async function applyImport() {
    if (!preview) return;
    // 채널·유형은 미리보기를 만든 값으로 보낸다 — 화면에서 확인한 숫자와 실제 기록이 같은 채널이어야 한다.
    const ch = preview.reqChannel;
    // 실사 전 점검(D4a·S8) — 걸린 것이 있으면 확인, 점검을 못 읽었으면 막는다(S4)
    if (preview.kind === "조정") {
      if (!shownChecks) { setError(checksErr || "실사 전 점검을 불러오는 중입니다 — 잠시 뒤 다시 누르세요."); return; }
      const w = checkConfirmAsk(shownChecks);
      if (w && !(await confirm(w))) return;
    }
    setApplying(true); setError("");
    try {
      const inR = preview.reqType === "입고" && inReason ? inReason : null;
      // 제조사 입고를 '연결 안 함'으로 반영 — 열린 요청서 잔여가 있는 품목이면 확인(S9)
      if (preview.kind === "입출" && preview.reqType === "입고" && ioDone && !inR && !reqId) {
        const seen = new Set<string>();
        const items = (preview.rows as IoRow[]).filter((r) => r.type === "입고" && !seen.has(r.product_id) && seen.add(r.product_id)).map((r) => ({ product_id: r.product_id, name: r.product_name }));
        if (!(await confirmUnlinkedInbound(date, items, confirm))) { setApplying(false); return; }
      }
      const [url, body] = preview.kind === "조정"
        ? ["/api/inventory/adjust/import/apply", { channel: ch, count_date: preview.countDate, batch_key: preview.key, rows: (preview.rows as AdjRow[]).map((r) => ({ product_id: r.product_id, target: r.target, memo: r.memo })) }]
        : ["/api/inventory/txns/import/apply", {
            rows: (preview.rows as IoRow[]).map((r) => (r.type === "출고" && reason !== "판매" ? { ...r, reason } : r.type === "입고" && inR ? { ...r, reason: inR, unit_amount: null } : r)),
            done: ioDone, channel: ch, request_key: preview.key,
            request_id: preview.reqType === "입고" && ioDone && !inR ? (reqId || null) : null,
          }];
      let res: Response;
      let j: { ok?: boolean; error?: string; code?: string; replay?: boolean; note?: string; applied?: number; invalid?: number; mismatch?: { product_id: string; target: number; actual: number }[]; link?: LinkResultLite } | null = null;
      try {
        res = await fetch(url as string, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        j = await res.json().catch(() => null);
      } catch { throw new Error(LOST_MSG); }
      if (!j) throw new Error(LOST_MSG);
      if (j.code === "request_key_conflict") setPreview((p) => (p ? { ...p, key: newKey() } : p)); // 다음 누름은 새 기록
      if (!res.ok || !j.ok) throw new Error(j.error || "반영 실패");
      if (preview.kind === "조정") {
        // 조정 반영 결과 — 안내(이미 반영됨·변경 없음)·숫자가 아닌 실사수량·반영 직후 실사수량과 다른 품목(S12)
        const nameOf = (pid: string) => (preview.rows as AdjRow[]).find((r) => r.product_id === pid)?.name || "품목";
        const parts: string[] = [];
        if (j.note) parts.push(j.note);
        if (Number(j.invalid) > 0) parts.push(`${j.invalid}건은 실사수량이 숫자가 아니라 건너뛰었습니다.`);
        const mm = Array.isArray(j.mismatch) ? j.mismatch : [];
        if (mm.length) parts.push(`반영 직후 ${mm.length}종이 실사수량과 다릅니다 — 같은 순간 다른 기록이 들어왔을 수 있으니 조정 내역을 확인하세요.\n${mm.slice(0, 8).map((m) => `- ${nameOf(m.product_id)}: 실사 ${Number(m.target).toLocaleString()} · 지금 ${Number(m.actual).toLocaleString()}`).join("\n")}${mm.length > 8 ? `\n- 외 ${mm.length - 8}종` : ""}`);
        // 건너뜀·어긋남이 있으면 오류 토스트(7초), 안내만이면 성공 토스트
        if (parts.length) (Number(j.invalid) > 0 || mm.length ? toast.error : toast.success)(parts.join(" "));
      } else if (j.replay) toast.success("이미 반영돼 있던 요청입니다 — 다시 기록하지 않았습니다.");
      if (j.link) {
        const m = linkMessage(j.link, (pid) => (preview.rows as IoRow[]).find((r) => r.product_id === pid)?.product_name || "품목");
        if (j.link.ok && !j.link.failed?.length) toast.success(m); else toast.error(m);
      }
      onSaved(); // 부모가 목록을 다시 읽고 이 창을 닫는다
    } catch (e) { setError(e instanceof Error ? e.message : "반영 실패"); }
    setApplying(false);
  }

  function switchMode(m: "직접" | "엑셀") { dropInflight(); setMode(m); setPreview(null); setError(""); setImporting(false); }

  // 품목 검색 콤보박스: 이름·SKU 로 필터(다른 상품 검색 UI 와 동일). 목록에서만 선택.
  //  묶음(세트)은 숨긴다 — 자체 재고가 없어 입·출·조정 대상이 아니다(원장은 구성품으로만 쓴다).
  const productOptions = useMemo<ComboOption[]>(() => products.filter((p) => !p.is_bundle).map((p) => ({ id: p.id, label: p.name, sub: p.sku || undefined })), [products]);
  const productLabel = product ? `${product.name}${product.sku ? ` (${product.sku})` : ""}` : "";

  // 현재고는 '선택한 채널' 기준. 부모가 넘긴 qtyOf 가 그 채널 기준일 때만 그대로 쓰고,
  //  아니면(다른 채널이거나 부모 목록이 '전체' 합산이면) 그 채널을 따로 조회해 캐시한다.
  //  합산 재고를 한 채널의 현재고로 쓰면 조정(목표−현재) 델타가 통째로 틀어진다.
  const qtyBase: InvChannelFilter = qtySource ?? defaultChannel;
  //  조정은 서버가 '조정 날짜 기준' 재고로 델타를 다시 계산한다 — 화면도 같은 기준(asof=거래일)으로 따로 조회한다.
  //  부모 목록(asof 없음)은 발송 예정 선점까지 빠진 값이라, 그걸로 실사를 맞추면 '현재고와 동일' 오판·유령 재고가 생긴다(감사 #6).
  //  입고·출고는 그 칸을 asof 없이 읽어 현재고(on_hand = 오늘까지)와 출고 예정(scheduled_out)을 따로 보여 준다(D1·S6).
  //  qty(가용 = 미래 발송일 선점까지 뺀 값)는 출고 초과 경고·'거래 후'의 기준으로 그대로 쓴다 — 선점분을 다시 내보내지 않게.
  type StockInfo = { qty: number; onHand: number | null; sched: number };
  const [chanQty, setChanQty] = useState<Record<string, StockInfo>>({});
  const [qtyErr, setQtyErr] = useState("");
  const datedAdjust = type === "조정" && DATE_RE.test(date);
  const qKey = datedAdjust ? `${channel} ${date} ${productId}` : `${channel} ${productId}`;
  useEffect(() => {
    if (!productId) return;
    if (qKey in chanQty) return;
    let alive = true;
    setQtyErr("");
    fetch(`/api/inventory?channel=${encodeURIComponent(channel)}${datedAdjust ? `&asof=${date}` : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j?.ok) { setQtyErr(j?.error || "현재고 조회 실패"); return; }
        const row = (j.rows || []).find((x: { product_id: string }) => x.product_id === productId) as { qty?: number; on_hand?: number; scheduled_out?: number } | undefined;
        const onHand = !datedAdjust && row && row.on_hand != null && Number.isFinite(Number(row.on_hand)) ? Number(row.on_hand) : null; // 구 서버(on_hand 없음)면 null
        setChanQty((m) => ({ ...m, [qKey]: { qty: row ? Number(row.qty) || 0 : 0, onHand: row ? onHand : datedAdjust ? null : 0, sched: !datedAdjust && row ? Math.max(0, Number(row.scheduled_out) || 0) : 0 } }));
      })
      .catch(() => { if (alive) setQtyErr("현재고 조회 실패"); });
    return () => { alive = false; };
  }, [channel, productId, chanQty, datedAdjust, date, qKey]);
  //  부모 목록이 같은 칸이면 조회가 끝나기 전·실패해도 그 값(가용)으로 계산한다(종전 동작).
  const fromParent = !datedAdjust && channel === qtyBase;
  const stockInfo: StockInfo | undefined = chanQty[qKey];
  const chanKnown = !!stockInfo || fromParent; // 조회 전에는 현재고를 모른다
  const current = !productId ? 0 : stockInfo ? stockInfo.qty : fromParent ? qtyOf(productId) : 0; // 가용(조정은 실사일 기준 재고)
  const onHand = stockInfo?.onHand ?? null;
  const sched = stockInfo?.sched ?? 0;
  const splitStock = !datedAdjust && onHand !== null && sched > 0; // 출고 예정이 있으면 현재고 · 출고 예정 · 가용으로 나눠 보인다

  // 미리보기: 이 거래 후 재고
  const after = useMemo(() => {
    const n = Number(qty) || 0;
    if (type === "입고") return current + Math.abs(n);
    if (type === "출고") return current - Math.abs(n);
    return adjMode === "target" ? n : current + n; // 조정
  }, [type, qty, current, adjMode]);

  async function save() {
    const errs: { product?: string; qty?: string } = {};
    if (!productId) errs.product = "품목을 선택하세요";
    if (qty.trim() === "") errs.qty = "수량을 입력하세요";
    setFieldErr(errs);
    if (errs.product || errs.qty) { setError(errs.product && errs.qty ? "" : (errs.product || errs.qty || "")); return; }
    if (pickMissing) { setError(isAdjust ? "조정할 칸을 고르세요." : "출고할 칸을 고르세요."); return; }
    // 목표(실사) 조정은 현재고를 빼서 델타를 만든다 → 그 채널 현재고를 모르면 계산 자체가 틀린다.
    if (type === "조정" && date > TODAY()) { setError("조정 날짜는 오늘 이후로 할 수 없습니다."); return; }
    // 미래 날짜 '완료'는 서버도 막는다(S6) — 예정 건은 즉시 처리를 해제해 대기로
    if (type !== "조정" && ioDone && date > TODAY()) { setError("미래 날짜는 '즉시 처리'를 해제해 대기로 저장하세요."); return; }
    if (type === "조정" && adjMode === "target" && !chanKnown) { setError(qtyErr ? `${channel} 현재고를 불러오지 못했습니다 — 창을 닫았다 다시 여세요.` : `${channel} 현재고를 불러오는 중입니다. 잠시 후 다시 시도하세요.`); return; }
    // 실사 수량은 0 이상의 숫자만(S8) — '420개'·빈칸·음수를 0 으로 읽으면 전량 0 조정이 된다. 서버도 같은 규칙으로 400.
    const targetRaw = qty.trim();
    if (type === "조정" && adjMode === "target" && !/^\d+(\.\d+)?$/.test(targetRaw)) { setError("실사 수량은 0 이상의 숫자로 입력하세요."); return; }
    let sendQty = Number(qty) || 0;
    if (type === "조정" && adjMode === "target") sendQty = Math.round((Number(targetRaw) - current) * 100) / 100; // 목표−현재 = 델타(구 서버 폴백용 — 새 서버는 target_qty 로 다시 계산)
    if (sendQty === 0) { setError(type === "조정" ? "현재고와 동일합니다 (변동 없음)." : "수량을 입력하세요."); return; }
    // 실사 전 점검(D4a·S8) — 확인 실패면 막고(S4), 걸린 것이 있으면 정리했는지 묻는다
    if (isAdjust) {
      if (checksErr) { setError(checksErr); return; }
      if (!shownChecks) { setError("실사 전 점검을 불러오는 중입니다 — 잠시 뒤 다시 누르세요."); return; }
      const w = checkConfirmAsk(shownChecks);
      if (w && !(await confirm(w))) return;
    }
    if (type !== "조정" && date < DAYS_AGO(7) && !(await confirm({ title: "7일 이상 전 날짜로 기록", body: `거래일이 ${date} 입니다.`, action: `${date} 로 기록`, danger: false }))) return;
    // 출고 초과는 가용(출고 예정 선점까지 뺀 값) 기준 — 현재고만 보면 이미 잡힌 B2B 발송분을 다시 내보낸다
    if (type === "출고" && after < 0 && !(await confirm({
      title: "재고보다 많은 출고",
      body: splitStock
        ? `가용 재고(${current.toLocaleString()} = 현재고 ${(onHand ?? 0).toLocaleString()} − 출고 예정 ${sched.toLocaleString()})보다 많은 출고입니다. 가용이 ${after.toLocaleString()} 가 됩니다.`
        : `현재고(${current.toLocaleString()})보다 많은 출고입니다. 재고가 ${after.toLocaleString()} 가 됩니다.`,
      action: "그래도 출고",
    }))) return;
    setSaving(true); setError("");
    // 제조사 입고를 '연결 안 함'으로 저장 — 열린 요청서 잔여가 있는 품목이면 확인(S9)
    if (type === "입고" && ioDone && !customerReturn && !reqId && !(await confirmUnlinkedInbound(date, [{ product_id: productId, name: product?.name || "품목" }], confirm))) { setSaving(false); return; }
    try {
      let res: Response;
      let j: { ok?: boolean; error?: string; code?: string; replay?: boolean; link?: LinkResultLite } | null = null;
      try {
        res = await fetch("/api/inventory/txn", {
          method: "POST", headers: { "Content-Type": "application/json" },
          // 목표(실사) 조정은 target_qty 도 함께 보낸다 — 서버가 기록 시점 현재고로 델타를 재계산해
          //  화면 로드 후 재고가 움직여도 낡은 델타가 기록되지 않는다(TOCTOU 방지). qty 는 구 서버 폴백.
          //  request_key = 이 창의 제출 키 — 응답이 끊겨 다시 눌러도 한 번만 기록된다(131).
          body: JSON.stringify({
            // target_qty 는 입력 그대로(trim) — 판독은 서버가 한다(빈값·숫자 아님·음수 400). Number()||0 으로 바꾸면 잘못된 입력이 목표 0 이 된다.
            product_id: productId, type, channel, qty: sendQty, ...(type === "조정" && adjMode === "target" ? { target_qty: targetRaw } : {}),
            unit_amount: isAdjust || customerReturn ? null : unitAmount, txn_date: date, partner: isAdjust ? "" : partner, memo,
            reason: type === "출고" && reason !== "판매" ? reason : customerReturn ? inReason : null,
            ...(isAdjust ? {} : { done: ioDone }),
            request_id: type === "입고" && ioDone && !customerReturn ? (reqId || null) : null,
            request_key: submitKey.current,
          }),
        });
        j = await res.json().catch(() => null);
      } catch { throw new Error(LOST_MSG); }
      if (!j) throw new Error(LOST_MSG);
      if (j.code === "request_key_conflict") submitKey.current = newKey(); // 다음 누름은 새 기록
      if (!res.ok || !j.ok) throw new Error(j.error || "기록 실패");
      if (j.replay) toast.success("이미 기록돼 있던 요청입니다 — 다시 기록하지 않았습니다.");
      if (j.link) {
        const m = linkMessage(j.link, () => product?.name || "품목");
        if (j.link.ok && !j.link.failed?.length) toast.success(m); else toast.error(m);
      }
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "기록 실패"); }
    setSaving(false);
  }

  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: preview ? 760 : 460 }}>
        <div className="b2b-modal-head">
          <span className="b2b-modal-title">입고 · 출고 · 조정</span>
          <button className="b2b-modal-close" aria-label="닫기" onClick={onClose}>✕</button>
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
                onClick={() => { dropInflight(); setType(t); if (t !== "출고") setReason("판매"); if (t !== "입고") setInReason(""); if (t === "입고") { if (channel !== "소매") setChannel("소매"); } else { const want = picked ?? defaultChannel; if (channel !== want) setChannel(want); } setPreview(null); setError(""); setImporting(false); }}>{t}</button>
            ))}
          </div>

          <div className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 12 }}>
            <span className="b2b-field-label" style={{ margin: 0 }}>채널</span>
            {/* 조정·'전체' 탭 출고는 이 창에서 칸을 직접 누르기 전까지 아무 칸도 선택돼 보이지 않는다(S8 칸 명시) */}
            <ChannelPicker value={pickMissing ? null : channel}
              onChange={(c) => { if (c === channel) { if (type !== "입고" && picked !== c) setPicked(c); return; } dropInflight(); setChannel(c); if (type !== "입고") setPicked(c); setPreview(null); setError(""); setImporting(false); }}
              disabledChannels={type === "입고" ? MOVE_ONLY_CHANNELS : []}
              disabledHint="도매·프로모션·도매 대량은 소매로 입고한 뒤 [재고 이동]에서 옮깁니다" />
            {pickMissing && <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sm-danger)" }}>칸을 고르세요</span>}
          </div>
          {checksOn && <CountCheckWarn c={shownChecks} err={checksErr} />}

          {mode === "엑셀" ? (
            /* 미리보기가 있으면 그 미리보기를 만든 유형으로 그린다(늦게 온 응답이 반대 표에 그려지지 않게) */
            <ExcelPane
              type={preview ? preview.reqType : type}
              isAdjust={preview ? preview.kind === "조정" : isAdjust}
              templateHref={pickMissing ? null : templateHref}
              date={date} setDate={setDate} partner={partner} setPartner={setPartner}
              reason={reason} setReason={setReason} inReason={inReason} setInReason={setInReason}
              ioDone={ioDone} setIoDone={setIoDone}
              reqs={reqs} reqId={reqId} setReqId={pickReq} reqWarn={reqWarn}
              importing={importing} preview={preview}
            />
          ) : (
          <>
          <div className="b2b-field"><span className="b2b-field-label">품목</span>
            {lockProduct ? (
              <input className="b2b-input" value={productLabel} disabled readOnly />
            ) : (
              <Combobox
                invalid={!!fieldErr.product}
                value={productLabel}
                options={productOptions}
                onSelect={(opt) => { setProductId(opt.id); if (fieldErr.product) setFieldErr((x) => ({ ...x, product: undefined })); }}
                placeholder="품목·SKU 검색"
                ariaLabel="품목 검색"
                emptyText="일치하는 품목이 없습니다"
              />
            )}
            {fieldErr.product && <span className="b2b-field-error">{fieldErr.product}</span>}
          </div>
          {product && (pickMissing ? null : chanKnown
            ? (splitStock
              // 현재고 = 오늘까지 실제로 움직인 것, 출고 예정 = 미래 발송일로 이미 잡힌 출고(대부분 B2B 선점), 거래 후 = 가용 기준
              ? <p className="sm-faint" style={{ fontSize: 12, margin: "2px 0 8px" }}>{channel} 현재고 <strong>{(onHand ?? 0).toLocaleString()}</strong>{product.unit} · 출고 예정 {sched.toLocaleString()} · 가용 {current.toLocaleString()} → 거래 후 가용 <strong style={{ color: after < 0 ? "var(--sm-danger)" : "var(--sm-black)" }}>{after.toLocaleString()}</strong>{product.unit}</p>
              : <p className="sm-faint" style={{ fontSize: 12, margin: "2px 0 8px" }}>{datedAdjust ? `${date} 기준 ` : ""}{channel} 현재고 <strong>{current.toLocaleString()}</strong>{product.unit} → 거래 후 <strong style={{ color: after < 0 ? "var(--sm-danger)" : "var(--sm-black)" }}>{after.toLocaleString()}</strong>{product.unit}</p>)
            : <p className="sm-faint" style={{ fontSize: 12, margin: "2px 0 8px", color: qtyErr ? "var(--sm-danger)" : undefined }}>{qtyErr ? `${channel} 현재고를 불러오지 못했습니다 — ${qtyErr}` : `${channel} 현재고 불러오는 중...`}</p>)}

          {isAdjust && (
            <div className="sm-tabs" style={{ marginBottom: 8 }}>
              <button className={`sm-tab ${adjMode === "target" ? "is-active" : ""}`} onClick={() => setAdjMode("target")}>실사 수량(목표)</button>
              <button className={`sm-tab ${adjMode === "delta" ? "is-active" : ""}`} onClick={() => setAdjMode("delta")}>증감(±)</button>
            </div>
          )}

          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">{isAdjust ? (adjMode === "target" ? "실사 수량" : "증감(±)") : "수량"}</span>
              <input className="b2b-input" type="number" step={0.01} value={qty} onChange={(e) => { setQty(e.target.value); if (fieldErr.qty) setFieldErr((x) => ({ ...x, qty: undefined })); }} placeholder={isAdjust && adjMode === "delta" ? "-3" : "0"} aria-invalid={fieldErr.qty ? "true" : undefined} autoFocus onKeyDown={(e) => { if (e.key === "Enter" && !saving) save(); }} />
              {fieldErr.qty && <span className="b2b-field-error">{fieldErr.qty}</span>}</label>
            <label className="b2b-field"><span className="b2b-field-label">거래일</span>
              <input className="b2b-input" type="date" value={date} max={isAdjust || ioDone ? TODAY() : undefined} onChange={(e) => setDate(e.target.value)} /></label>
          </div>
          {type === "입고" && <InReasonSelect value={inReason} onChange={setInReason} />}
          {type === "입고" && <RequestSelect reqs={reqs} value={reqId} disabled={!ioDone || customerReturn} warn={ioDone && !customerReturn ? reqWarn : ""} onChange={pickReq} />}

          {!isAdjust && (
            <div className="b2b-field-row">
              {!customerReturn && (
              <label className="b2b-field"><span className="b2b-field-label">{type === "입고" ? "매입 단가(원)" : "판매 단가(원)"} <span className="opt">(선택)</span></span>
                <input className="b2b-input" type="number" min={0} value={unitAmount} onChange={(e) => setUnitAmount(e.target.value)} placeholder="0" /></label>
              )}
              <label className="b2b-field"><span className="b2b-field-label">{type === "입고" ? (customerReturn ? "고객" : "매입처") : reason !== "판매" ? "전달처" : "판매처"} <span className="opt">(선택)</span></span>
                <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} /></label>
            </div>
          )}
          {type === "출고" && (
            <label className="b2b-field"><span className="b2b-field-label">사유</span>
              <select className="b2b-input" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="판매">판매</option>
                <option value="협찬">협찬·증정</option>
                <option value="폐기">폐기</option>
                <option value="제조사 반품">제조사 반품</option>
                <option value="기타">기타</option>
              </select></label>
          )}
          <label className="b2b-field"><span className="b2b-field-label">메모 <span className="opt">{isAdjust ? "· 조정 사유" : "(선택)"}</span></span>
            <input className="b2b-input" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
          {!isAdjust && (
            <label className="sm-row" style={{ gap: 7, marginTop: 4, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={ioDone} onChange={(e) => setIoDone(e.target.checked)} /> 즉시 {type}처리 <span className="sm-faint" style={{ fontSize: 12 }}>(해제 시 ‘대기’ — 미래 날짜는 대기로만)</span>
            </label>
          )}
          </>
          )}

          {fieldErr.product && fieldErr.qty
            ? <div className="b2b-error" style={{ marginTop: 8 }}><ul><li>{fieldErr.product}</li><li>{fieldErr.qty}</li></ul></div>
            : error ? <div className="b2b-error" style={{ marginTop: 8 }}>{error}</div> : null}
        </div>
        <div className="b2b-modal-foot">
          {/* 미리보기에서 파일·설정을 다시 고를 수 있는 유일한 경로 */}
          {mode === "엑셀" && preview
            ? <button className="b2b-btn-secondary" onClick={() => { setPreview(null); setError(""); }} disabled={applying}>← 다시 선택</button>
            : <span />}
          <div className="b2b-modal-foot-right">
            <button className="b2b-btn-secondary" onClick={onClose} disabled={saving || applying || importing}>그만두기</button>
            {mode === "엑셀" ? (
              preview ? (
                <>
                  {preview.count === 0 && !applying && <span className="b2b-btn-why">반영할 행이 없습니다</span>}
                  <button className="b2b-btn-primary" onClick={applyImport} disabled={applying || preview.count === 0}>
                    {applying ? "반영 중..." : `${preview.count.toLocaleString()}건 ${preview.kind === "조정" ? "조정" : "반영"}`}
                  </button>
                </>
              ) : (
                <label className="b2b-btn-primary" style={{ cursor: importing || pickMissing ? "default" : "pointer", opacity: pickMissing ? 0.5 : undefined }}
                  onClick={(e) => { if (pickMissing) { e.preventDefault(); setError("칸을 고르세요."); } }}>
                  {importing ? "분석 중..." : "엑셀 파일 선택"}
                  <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing || pickMissing}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
                </label>
              )
            ) : (
              <button className="b2b-btn-primary" onClick={save} disabled={saving}>{saving ? "저장 중..." : `${type} 기록`}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 엑셀 일괄 패널 — 양식 다운로드 + (입출고면) 파일 전체에 적용할 거래일·거래처·즉시처리 + 미리보기.
//  파일 첨부 버튼은 모달 푸터에 있다(다른 업로드 화면과 같은 위치).
function ExcelPane({ type, isAdjust, templateHref, date, setDate, partner, setPartner, reason, setReason, inReason, setInReason, ioDone, setIoDone, importing, preview, reqs, reqId, setReqId, reqWarn }: {
  type: InvTxnType; isAdjust: boolean; templateHref: string | null; // null = 조정 칸 미선택(양식 칸이 정해지지 않음)
  date: string; setDate: (v: string) => void;
  partner: string; setPartner: (v: string) => void;
  reason: string; setReason: (v: string) => void;
  inReason: string; setInReason: (v: string) => void;
  ioDone: boolean; setIoDone: (v: boolean) => void;
  importing: boolean; preview: Preview | null;
  reqs: OpenReq[]; reqId: string; setReqId: (v: string) => void; reqWarn: string;
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
          {!!preview.untracked && <span className="sm-faint">재고 관리 사용 안함 {preview.untracked.toLocaleString()}행 제외</span>}
          {preview.errCount > 0 && <span style={{ color: "var(--sm-danger)" }}>오류 {preview.errCount}건(제외)</span>}
        </div>

        {preview.rows.length === 0 ? (
          <div className="b2b-empty" style={{ padding: 20 }}>매칭된 품목이 없습니다.</div>
        ) : (
          <div className="b2b-table-wrap" style={{ maxHeight: 320, overflow: "auto", marginBottom: 12 }}>
            {isAdjust ? (
              <table className="b2b-table" style={{ fontSize: 13 }}>
                <thead><tr><th>품목</th><th>SKU</th><th className="num">현재고</th><th className="num">실사</th><th className="num">조정</th><th>메모</th></tr></thead>
                <tbody>
                  {(preview.rows as AdjRow[]).slice(0, 300).map((r, i) => (
                    <tr key={i} style={{ color: r.delta === 0 ? "var(--sm-text-light)" : undefined }}>
                      <td>{r.name}{r.spec ? <span className="sm-faint" style={{ marginLeft: 5, fontSize: 12 }}>{r.spec}</span> : null}{r.pending ? <span style={{ marginLeft: 6, fontSize: 12, fontWeight: 700, color: "var(--sm-warning)" }}>대기 {r.pending}</span> : null}</td>
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
              <table className="b2b-table" style={{ fontSize: 13 }}>
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
    );
  }

  return (
    <div>
      {!isAdjust && (
        <>
          <div className="b2b-field-row">
            <label className="b2b-field"><span className="b2b-field-label">거래일</span>
              <input className="b2b-input" type="date" value={date} max={ioDone ? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10) : undefined} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="b2b-field"><span className="b2b-field-label">{type === "입고" ? (inReason === "고객 반품" ? "고객" : "매입처") : reason !== "판매" ? "전달처" : "판매처"} <span className="opt">(선택)</span></span>
              <input className="b2b-input" value={partner} onChange={(e) => setPartner(e.target.value)} /></label>
          </div>
          {type === "입고" && <InReasonSelect value={inReason} onChange={setInReason} />}
          {type === "입고" && <RequestSelect reqs={reqs} value={reqId} disabled={!ioDone || inReason === "고객 반품"} warn={ioDone && inReason !== "고객 반품" ? reqWarn : ""} onChange={setReqId} />}
          {type === "출고" && (
            <label className="b2b-field"><span className="b2b-field-label">사유</span>
              <select className="b2b-input" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="판매">판매</option>
                <option value="협찬">협찬·증정</option>
                <option value="폐기">폐기</option>
                <option value="제조사 반품">제조사 반품</option>
                <option value="기타">기타</option>
              </select></label>
          )}
          <label className="sm-row" style={{ gap: 7, marginTop: 4, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={ioDone} onChange={(e) => setIoDone(e.target.checked)} /> 즉시 {type}처리 <span className="sm-faint" style={{ fontSize: 12 }}>(해제 시 ‘대기’)</span>
          </label>
        </>
      )}

      {isAdjust && (
        <label className="b2b-field"><span className="b2b-field-label">실사한 날</span>
          <input className="b2b-input" type="date" value={date} max={new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} /></label>
      )}
      <p className="sm-faint" style={{ fontSize: 12, marginTop: 12 }}>
        {templateHref ? <a href={templateHref} className="sm-link">양식 내려받기</a> : <span>칸을 고르면 양식을 받을 수 있습니다</span>}
        {isAdjust && " · 실사한 날 마감 기준으로 계산·기록됩니다"}
      </p>
    </div>
  );
}
