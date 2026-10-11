"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Order,
  OrderInput,
  OrderItem,
  OrderItemInput,
  PRODUCTION_STATUSES,
  SHOW_ORDER_PRODUCTION,
  PAYMENT_STATUSES,
  TAX_INVOICE_STATUSES,
  SHIPMENT_STATUSES,
  SHIPMENT_STATUS_COLORS,
  EMPTY_ORDER,
  EMPTY_ORDER_ITEM,
  EMPTY_RECIPIENT,
  EMPTY_SHIPMENT_SCHEDULE,
  RecipientInput,
  ShipmentScheduleInput,
  Shipment,
  formatMoney,
  formatQty,
  splitTracking,
  joinTracking,
  computeRemaining,
  shipView,
  PARTIAL_SHIP,
} from "@/app/lib/b2b-orders";
import { Company, Product, TAX_TYPES, TAX_TYPE_LABEL } from "@/app/lib/b2b-types";
import { computeOrderMargin, seasonForDate, SEASON_MONTHS } from "@/app/lib/b2b-margin";
import { Combobox } from "./Combobox";

type Mode = "create" | "edit";

// 라인 수량 ↔ 차수 배분 점검(수정 화면을 열 때 읽은 차수 기준) — 서버 b2b-shipments planLineAllocCut 과 같은 계산이다(서버 모듈이라 가져올 수 없다).
//  잠긴 몫 = 취소 차수 + 발송된 차수(발송완료·발송 시각 있음). 안 나간 차수 하나에만 있으면 그 차수가 함께 줄어든다.
//  단일 발송 전량(취소 아닌 차수 하나에 이 라인 전량, 취소 배분 없음)이면 배분이 새 수량을 따른다 — 발송된 차수면 저장 전에 확인을 받는다.
//  저장된 수량부터 배분보다 작은 옛 데이터는 수량을 그대로 두면 막지 않고 알리기만 한다.
//  품목 칸에서 연결 상품만 바꾼 줄(줄 id 유지)은 지운 줄과 같이 본다 — 발송된·안 돌아옴 배분이 있으면 막고,
//  미연동 줄에 처음 연결하는 것은 저장 전에 확인을 받는다(발송된 수량이 그 상품 재고에서 빠진다).
type AllocShip = {
  id: string; seq?: number; status: string; shipped_at: string | null; ship_date: string | null;
  items: { order_item_id: string; qty: number }[];
};
type AllocBase = { ships: AllocShip[]; prev: Map<string, number>; label: Map<string, string>; product: Map<string, string | null> };
type AllocLine = { id: string; qty: number; prev: number | null; label: string; product?: string | null; prevProduct?: string | null; prevLabel?: string };
type AllocCut = { shipId: string; seq: number | null; lineId: string; label: string; from: number; to: number; shipped: boolean };
type AllocRelink = { lineId: string; label: string; qty: number };
type AllocIssue = { kind: "short" | "split" | "empty" | "removed" | "stale" | "product"; lineId?: string; text: string };
const ALLOC_GUIDE =
  "취소한 차수 몫은 이미 재고·매출·청구에서 빠져 있으니 수량은 그대로 두세요. 실제로 덜 나갔거나 차수를 나눠 줄여야 하면 발주 목록의 발송일 칸에서 그 차수 수량을 먼저 고치세요.";
const ALLOC_STALE_GUIDE =
  "배분이 맞으면 수량을 배분 합으로 고치고(취소 몫은 재고·매출에서 자동으로 빠집니다), 수량이 맞으면 발주 목록의 발송일 칸에서 차수 수량을 줄이거나 취소 차수를 지우세요.";
const ALLOC_PRODUCT_GUIDE =
  "잘못 고른 품목이면 발주 목록에서 그 발송을 '발송대기'로 되돌려 품목을 고친 뒤 다시 '발송완료'로 바꾸세요(취소한 발주는 먼저 복구). 다른 품목을 더 보낸 것이면 줄을 새로 추가하세요.";
const lineLabelOf = (name: string, spec: string | null | undefined) => `${name.trim() || "품목"}${spec ? ` ${spec}` : ""}`;
const EPS = 1e-9;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const allocKind = (s: AllocShip) =>
  s.status === "취소" ? "cancelled" : s.status === "발송완료" || !!s.shipped_at ? "shipped" : "pending";
const isAllocReal = (s: AllocShip) => !!s.ship_date || s.items.some((it) => Number(it.qty) > 0);
function lineAllocOf(ships: AllocShip[], lineId: string) {
  const a = { total: 0, cancelled: 0, kept: 0, shipped: 0, pending: new Map<string, number>() };
  for (const s of ships) {
    const q = s.items.filter((it) => it.order_item_id === lineId).reduce((x, it) => x + (Number(it.qty) || 0), 0);
    if (q <= 0) continue;
    a.total += q;
    const k = allocKind(s);
    if (k === "cancelled") {
      a.cancelled += q;
      if (s.shipped_at) a.kept += q;
    } else if (k === "shipped") a.shipped += q;
    else a.pending.set(s.id, (a.pending.get(s.id) || 0) + q);
  }
  return a;
}
function planLineAlloc(lines: AllocLine[], removed: AllocLine[], ships: AllocShip[]) {
  const removedIds = new Set(removed.map((l) => l.id));
  const after = ships.map((s) => ({ ...s, items: s.items.filter((it) => !removedIds.has(it.order_item_id)) }));
  const real = after.filter(isAllocReal);
  const live = real.filter((s) => allocKind(s) !== "cancelled");
  const sole = live.length === 1 ? live[0] : null;
  const errors: AllocIssue[] = [];
  const stale: AllocIssue[] = [];
  const cuts: AllocCut[] = [];
  const relinks: AllocRelink[] = [];
  for (const l of lines) {
    const a = lineAllocOf(real, l.id);
    if (a.total <= EPS) continue;
    if (l.product !== undefined && l.prevProduct !== undefined && (l.product || null) !== (l.prevProduct || null)) {
      if (a.kept > EPS || (a.shipped > EPS && l.prevProduct)) {
        const where = [
          a.shipped > EPS ? `발송된 차수에 ${formatQty(r3(a.shipped))}` : "",
          a.kept > EPS ? `발송 뒤 취소(안 돌아옴)한 차수에 ${formatQty(r3(a.kept))}` : "",
        ].filter(Boolean).join(" · ");
        const name = l.prevLabel && l.prevLabel !== l.label ? `${l.prevLabel} → ${l.label}` : l.label;
        errors.push({ kind: "product", lineId: l.id, text: `${name}: ${where} 배분` });
      } else if (a.shipped > EPS) {
        relinks.push({ lineId: l.id, label: l.label, qty: r3(a.shipped) });
      }
    }
    const q = l.qty;
    const prev = l.prev;
    if (sole && a.cancelled <= EPS && prev !== null && Math.abs(a.total - prev) <= EPS && q > EPS) {
      if (Math.abs(q - a.total) > EPS) {
        cuts.push({ shipId: sole.id, seq: sole.seq ?? null, lineId: l.id, label: l.label, from: r3(a.total), to: r3(q), shipped: allocKind(sole) === "shipped" });
      }
      continue;
    }
    if (q >= a.total - EPS) continue;
    const parts = [a.shipped > 0 ? `발송 ${formatQty(r3(a.shipped))}` : "", a.cancelled > 0 ? `취소 ${formatQty(r3(a.cancelled))}` : ""].filter(Boolean).join(" · ");
    const wasShort = prev !== null && prev < a.total - EPS;
    if (wasShort) {
      const same = Math.abs(q - (prev as number)) <= EPS;
      const issue: AllocIssue = {
        kind: "stale", lineId: l.id,
        text: `${l.label}: 발주 ${formatQty(r3(q))}${same ? "" : `(저장된 수량 ${formatQty(r3(prev as number))})`} / 배분 ${formatQty(r3(a.total))}${parts ? `(${parts})` : ""}`,
      };
      if (same) { stale.push(issue); continue; }
      if (q < a.cancelled + a.shipped - EPS || a.pending.size !== 1) { errors.push(issue); continue; }
    } else if (q < a.cancelled + a.shipped - EPS) {
      errors.push({ kind: "short", lineId: l.id, text: `${l.label}: 발주 ${formatQty(r3(q))} / 배분 ${formatQty(r3(a.total))}(${parts} 포함)` });
      continue;
    } else if (a.pending.size !== 1) {
      errors.push({ kind: "split", lineId: l.id, text: `${l.label}: 발주 ${formatQty(r3(q))} / 배분 ${formatQty(r3(a.total))} — 안 나간 차수 ${a.pending.size}곳에 나뉘어 있습니다` });
      continue;
    }
    const [shipId, from] = [...a.pending.entries()][0];
    const ship = real.find((s) => s.id === shipId);
    cuts.push({ shipId, seq: ship?.seq ?? null, lineId: l.id, label: l.label, from: r3(from), to: r3(Math.max(0, from - (a.total - q))), shipped: false });
  }
  const leftOf = (s: AllocShip) => {
    const mine = cuts.filter((c) => c.shipId === s.id);
    return s.items.reduce((x, it) => x + (mine.some((m) => m.lineId === it.order_item_id) ? 0 : Number(it.qty) || 0), 0)
      + mine.reduce((x, c) => x + c.to, 0);
  };
  const lostFrom = new Set(ships.filter((s) => s.items.some((it) => removedIds.has(it.order_item_id) && Number(it.qty) > 0)).map((s) => s.id));
  const autoRefill = !real.some((s) => leftOf(s) > EPS) && live.filter((s) => !!s.ship_date).length <= 1;
  if (!autoRefill) {
    for (const s of real) {
      if (allocKind(s) !== "pending" || !s.ship_date) continue;
      if (!cuts.some((c) => c.shipId === s.id) && !lostFrom.has(s.id)) continue;
      if (leftOf(s) <= EPS) errors.push({ kind: "empty", text: `${s.seq ? `${s.seq}차` : "안 나간 차수"}(${s.ship_date})에 보낼 수량이 0 이 됩니다 — 발송일 창에서 그 차수를 먼저 지우세요` });
    }
  }
  const realBefore = ships.filter(isAllocReal);
  for (const l of removed) {
    const a = lineAllocOf(realBefore, l.id);
    const where = [
      a.shipped > EPS ? `발송된 차수에 ${formatQty(r3(a.shipped))}` : "",
      a.kept > EPS ? `발송 뒤 취소(안 돌아옴)한 차수에 ${formatQty(r3(a.kept))}` : "",
    ].filter(Boolean).join(" · ");
    if (where) errors.push({ kind: "removed", lineId: l.id, text: `${l.label}: ${where} 배분 — 지울 수 없습니다` });
  }
  return { errors, stale, cuts, relinks, multi: real.length >= 2 };
}

// 모바일에서는 접히는 섹션(아코디언), 데스크톱에서는 항상 펼침.
function CollapsibleSection({ title, titleExtra, children }: { title: React.ReactNode; titleExtra?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => { setMobile(mq.matches); setOpen(!mq.matches); };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return (
    <section className="b2b-form-section">
      <div
        className={`b2b-form-section-title b2b-collapsible-head${mobile ? " is-mobile" : ""}`}
        style={{ marginBottom: open ? 14 : 0 }}
        onClick={mobile ? () => setOpen((o) => !o) : undefined}
        role={mobile ? "button" : undefined}
        aria-expanded={mobile ? open : undefined}
      >
        <span>{title}{titleExtra}</span>
        {mobile && <span className="b2b-collapse-chev" aria-hidden>{open ? "▲" : "▼"}</span>}
      </div>
      {open && children}
    </section>
  );
}

// 발주 상세 → 복제용 폼 데이터.
//  업체·라인·수령인·박스수·메모는 복사, 날짜·상태·송장·발송일정은 초기화(건마다 다름).
function buildCloneData(
  o: Order & { items: OrderItem[]; shipments: Shipment[] },
  todayIso: string
): OrderInput {
  return {
    company_id: o.company_id,
    order_date: todayIso,
    production_date: "",
    ship_date: "",
    status: "발송대기",
    production_status: "생산대기",
    payment_status: "입금전",
    tax_invoice_status: "미발행",
    notes: o.notes ?? "",
    discount_amount: o.discount_amount ?? "",
    discount_reason: o.discount_reason ?? "",
    box_count: o.box_count ?? 1,
    tracking_no: "",
    is_bulk: o.is_bulk ?? false,   // 대량 여부는 거래 성격이라 복제 때 함께 가져온다(저장 전 폼에서 눈으로 확인 가능)
    items: (o.items || []).map((it, idx) => ({
      product_id: it.product_id,
      product_name: it.product_name,
      option_label: it.option_label ?? "",
      spec: it.spec ?? "",
      qty: it.qty,
      unit_price: it.unit_price,
      cost_at_order: it.cost_at_order ?? "",
      tax_type: it.tax_type,
      sort_order: idx,
    })),
    recipient: o.shipments?.[0]
      ? {
          recipient_name: o.shipments[0].recipient_name ?? "",
          recipient_phone: o.shipments[0].recipient_phone ?? "",
          address: o.shipments[0].address ?? "",
          delivery_memo: o.shipments[0].delivery_memo ?? "",
          courier: "",
        }
      : { ...EMPTY_RECIPIENT },
    shipments: [],
  };
}

export default function OrderForm({
  mode,
  orderId,
  cloneFromId,
}: {
  mode: Mode;
  orderId?: string;
  cloneFromId?: string;
}) {
  const router = useRouter();

  const [companies, setCompanies] = useState<Company[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [data, setData] = useState<OrderInput>({ ...EMPTY_ORDER, items: [{ ...EMPTY_ORDER_ITEM }], recipient: { ...EMPTY_RECIPIENT }, shipments: [] });
  // 서버가 옛 차감 칸을 유지하는 조건(b2b-shipments effChannel) — 발송완료 차수, 또는 발송예정일이 오늘보다 앞(나간 것으로 봄)
  const alreadyOut = useMemo<"shipped" | "past" | null>(() => {
    const t = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    if (data.shipments.some((s) => s.status === "발송완료")) return "shipped";
    return data.shipments.some((s) => !!s.ship_date && s.ship_date < t && s.status !== "취소") ? "past" : null;
  }, [data.shipments]);
  // 할인/추가금 입력 — 원(₩) 또는 %(합계 기준), 음수 = 추가금. 저장은 항상 원 금액(저장 시점에 환산 주입).
  const [discountMode, setDiscountMode] = useState<"won" | "pct">("won");
  const [discountRaw, setDiscountRaw] = useState("");
  const [originalOrder, setOriginalOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [salesWarn, setSalesWarn] = useState(""); // 매출 원장 반영 실패(수정 저장 뒤) — 다시 [수정]을 누르면 다시 맞춰진다
  // 저장 뒤 다시 불러오기 실패 — 화면 값이 DB 와 어긋났다(새 줄에 id 없음). 새로고침 전까지 [수정]을 막는다
  const [reloadFailed, setReloadFailed] = useState(false);
  // 거래처 선택 시 "최근 발주 복제?" 프롬프트 (신규 등록에서만)
  const [clonePrompt, setClonePrompt] = useState<{ orderId: string; summary: string } | null>(null);
  const [cloning, setCloning] = useState(false);
  const [companyPrices, setCompanyPrices] = useState<Record<string, number>>({}); // 거래처별 상품 단가(product_id→단가)
  // 복제로 채운 거래처 — 그 회차의 단가 재도출을 건너뛴다(복제 원본 단가 유지, '최근 발주 복제'와 같은 결과)
  const clonePriceKeep = useRef<string | null>(null);
  // 등록 요청 키 — 응답이 끊겨 [등록]을 다시 눌러도 같은 발주가 두 번 생기지 않게 서버가 이 키로 막는다(134)
  const [requestKey] = useState(() =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  );
  // 이미 발송된 발주(발송완료 또는 발송 시각이 남은 차수) — 삭제하지 않고 취소한다(D3)
  const [shippedOrder, setShippedOrder] = useState(false);
  const [allocBase, setAllocBase] = useState<AllocBase | null>(null); // 열 때 읽은 차수 배분(취소 포함)·저장된 수량

  // 수정 화면의 발주 불러오기 — 첫 로드와, 저장 뒤 매출 반영 실패로 이 화면에 남을 때(라인 id·updated_at 을 서버 값으로 맞춘다).
  //  다시 [수정]할 때 옛 화면 값(새 줄에 id 없음)으로 보내면 방금 넣은 줄을 지우고 또 넣어 차수 배분이 끊긴다.
  async function loadEditOrder(id: string) {
    const orderRes = await fetch(`/api/b2b/orders/${id}`, { cache: "no-store" });
    const orderJson = await orderRes.json();
    if (!orderJson.ok) throw new Error(orderJson.error || "발주 조회 실패");
    const o = orderJson.order as Order & { items: OrderItem[]; company: Company; shipments: Shipment[] };
    setOriginalOrder(o);
    setShippedOrder(o.status === "발송완료" || (o.shipments || []).some((sh) => sh.status === "발송완료" || !!sh.shipped_at));
    setAllocBase({
      ships: (o.shipments || []).map((sh) => ({
        id: sh.id,
        seq: Number(sh.seq) || undefined,
        status: sh.status,
        shipped_at: sh.shipped_at ?? null,
        ship_date: sh.ship_date ?? null,
        items: (sh.items || [])
          .filter((si) => !!si.order_item_id)
          .map((si) => ({ order_item_id: String(si.order_item_id), qty: Number(si.qty) || 0 })),
      })),
      prev: new Map((o.items || []).map((it) => [it.id, Number(it.qty) || 0])),
      label: new Map((o.items || []).map((it) => [it.id, lineLabelOf(it.product_name || "", it.spec)])),
      product: new Map((o.items || []).map((it) => [it.id, it.product_id || null])),
    });
    if (Number(o.discount_amount) !== 0) { setDiscountMode("won"); setDiscountRaw(String(Math.round(Number(o.discount_amount)))); }
    setData({
      id: o.id,
      company_id: o.company_id,
      order_date: o.order_date,
      production_date: o.production_date ?? "",
      ship_date: o.ship_date ?? "",
      status: o.status,
      production_status: o.production_status ?? "생산대기",
      payment_status: o.payment_status,
      tax_invoice_status: o.tax_invoice_status,
      notes: o.notes ?? "",
      discount_amount: o.discount_amount ?? "",
      discount_reason: o.discount_reason ?? "",
      box_count: o.box_count ?? 1,
      tracking_no: o.tracking_no ?? "",
      is_bulk: o.is_bulk ?? false,
      items: (o.items || []).map((it) => ({
        id: it.id,
        product_id: it.product_id,
        product_name: it.product_name,
        option_label: it.option_label ?? "",
        spec: it.spec ?? "",
        qty: it.qty,
        unit_price: it.unit_price,
        cost_at_order: it.cost_at_order ?? "",
        tax_type: it.tax_type,
        sort_order: it.sort_order,
      })),
      recipient: o.shipments?.[0]
        ? {
            recipient_name: o.shipments[0].recipient_name ?? "",
            recipient_phone: o.shipments[0].recipient_phone ?? "",
            address: o.shipments[0].address ?? "",
            delivery_memo: o.shipments[0].delivery_memo ?? "",
            courier: o.shipments[0].courier ?? "",
          }
        : { ...EMPTY_RECIPIENT },
      shipments: (o.shipments || [])
        // 날짜·상품이 모두 없는 행은 '배송 정보 전용' 기본 행 → 발송 일정 카드로는 노출 안 함
        .filter((sh) => sh.ship_date || (sh.items && sh.items.length > 0))
        .map((sh) => ({
        id: sh.id,
        ship_date: sh.ship_date ?? "",
        status: sh.status,
        tracking_no: sh.tracking_no ?? "",
        box_count: sh.box_count ?? 1,
        stock_out: (sh as { stock_out?: boolean }).stock_out ?? false,
        items: (sh.items || []).map((si) => ({
          // order_item_id → 현재 items 배열의 인덱스로 매핑
          order_item_index: (o.items || []).findIndex((oi) => oi.id === si.order_item_id),
          qty: si.qty,
        })).filter((x) => x.order_item_index >= 0),
      })),
    });
  }

  // ─────────────────────────────────────────────
  // 초기 데이터 로드
  // ─────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const [compRes, prodRes] = await Promise.all([
          fetch("/api/b2b/companies", { cache: "no-store" }),
          fetch("/api/b2b/products", { cache: "no-store" }),
        ]);
        const compJson = await compRes.json();
        const prodJson = await prodRes.json();
        if (!compJson.ok) throw new Error(compJson.error || "업체 조회 실패");
        if (!prodJson.ok) throw new Error(prodJson.error || "제품 조회 실패");
        setCompanies(compJson.companies || []);
        setProducts((prodJson.products as Product[] || []).filter((p) => p.active));

        if (mode === "edit" && orderId) {
          await loadEditOrder(orderId);
        } else if (mode === "create" && cloneFromId) {
          // 복제 모드: 원본 발주를 불러와 업체·라인·송장은 복사, 날짜·상태는 초기화
          const t = new Date();
          const todayIso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
          const orderRes = await fetch(`/api/b2b/orders/${cloneFromId}`, { cache: "no-store" });
          const orderJson = await orderRes.json();
          if (!orderJson.ok) throw new Error(orderJson.error || "복제할 발주 조회 실패");
          const o = orderJson.order as Order & { items: OrderItem[]; company: Company; shipments: Shipment[] };
          if (Number(o.discount_amount) !== 0) { setDiscountMode("won"); setDiscountRaw(String(Math.round(Number(o.discount_amount)))); }
          // 거래처가 ''→원본 거래처로 바뀌어 단가 재도출이 돌면 원본 단가가 거래처·기본 단가로 덮인다(점검 확정) — 이번 한 번은 건너뛴다
          clonePriceKeep.current = o.company_id;
          setData(buildCloneData(o, todayIso));
        } else {
          // create 모드: 발주일 기본값을 오늘로
          const t = new Date();
          const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
          setData((prev) => ({ ...prev, order_date: iso }));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "데이터 조회 중 오류");
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadEditOrder 는 상태 setter 만 쓴다
  }, [mode, orderId, cloneFromId]);

  // ─────────────────────────────────────────────
  // 합계 계산 (입력 동안에는 클라이언트, 저장 후엔 트리거가 재계산)
  // ─────────────────────────────────────────────
  const totals = useMemo(() => {
    let taxable = 0;
    let exempt = 0;
    for (const it of data.items) {
      const qty = Number(it.qty) || 0;
      const price = Number(it.unit_price) || 0;
      const amt = qty * price;
      if (it.tax_type === "exempt") exempt += amt;
      else taxable += amt;
    }
    const subtotal = taxable + exempt;
    const vat = Math.round(taxable * 0.1);
    return { taxable, exempt, subtotal, vat, total: subtotal + vat };
  }, [data.items]);

  // 할인/추가금 금액(원) — 양수 = 할인(합계 차감), 음수 = 추가금(합계 가산).
  //  % 입력이면 할인 전 합계 기준으로 환산(-100~100% 클램프). 할인은 합계를 넘지 않게 잘라낸다.
  const discountAmount = useMemo(() => {
    const raw = Number(discountRaw) || 0;
    if (raw === 0) return 0;
    const amt = discountMode === "pct"
      ? Math.round(totals.total * Math.max(-100, Math.min(raw, 100)) / 100)
      : Math.round(raw);
    return amt > 0 ? Math.min(amt, totals.total) : amt;
  }, [discountRaw, discountMode, totals.total]);
  const totalAfterDiscount = totals.total - discountAmount;

  // 복수 발송(실제 일정 2건 이상) — 상위발주가 되어 발주 상태는 차수별로 관리(상태칸 숨김)
  const realScheduleCount = useMemo(
    () => data.shipments.filter((s) => s.ship_date || s.items.some((i) => Number(i.qty) > 0)).length,
    [data.shipments]
  );
  const isMultiShipment = realScheduleCount >= 2;

  // 박스 수: 발송 차수가 있으면 차수 박스 수의 합(자동), 없으면 발주에 직접 입력한 값.
  //  취소 차수는 뺀다 — 서버가 저장하는 합(saveOrderShipments 의 totalBoxes)과 같은 규칙이라야
  //  이 화면의 이익률이 저장 후 값과 어긋나지 않는다.
  const scheduleBoxSum = useMemo(
    () =>
      data.shipments
        .filter((s) => (s.ship_date || s.items.some((i) => Number(i.qty) > 0)) && s.status !== "취소")
        .reduce((sum, s) => sum + Math.max(1, Math.floor(Number(s.box_count) || 1)), 0),
    [data.shipments]
  );
  //  전 차수 취소면 합이 0 이 되므로 1 로 받친다 — 0 이면 배송비 계산이 박스당 부피에서 나눗셈이 깨진다.
  const effectiveBoxCount = realScheduleCount > 0 ? Math.max(1, scheduleBoxSum) : Math.max(1, Number(data.box_count) || 1);

  // ── 발송·송장 (읽기 전용, 수정 화면) — 발송완료 후 송장번호를 확인할 곳이 없어 여기서 보여준다.
  //  송장은 차수(shipments.tracking_no)에 있고, 발주 단위로 발송완료 처리한 옛 데이터는
  //  orders.tracking_no 에만 있으므로 차수 송장이 비면 발주 송장으로 채운다(단일 차수일 때만).
  const [copiedTrack, setCopiedTrack] = useState("");
  const shippedInfo = useMemo(() => {
    const real = data.shipments.filter((sh) => sh.ship_date || sh.items.some((i) => Number(i.qty) > 0));
    const rows = real.map((sh, idx) => ({
      key: sh.id || String(idx),
      seq: idx + 1,
      ship_date: sh.ship_date || "",
      status: sh.status as string,
      box_count: Math.max(1, Math.floor(Number(sh.box_count) || 1)),
      tracking: (sh.tracking_no || "").trim() || (real.length <= 1 ? (data.tracking_no || "").trim() : ""),
      itemsLabel: sh.items
        .map((it) => {
          const oi = data.items[it.order_item_index];
          return oi ? `${oi.product_name}${oi.spec ? ` ${oi.spec}` : ""} ×${formatQty(Number(it.qty) || 0)}` : null;
        })
        .filter(Boolean)
        .join(", "),
    }));
    // 차수가 아예 없는 옛 발주 — 발주 단위 송장만 있다
    if (rows.length === 0 && (data.tracking_no || "").trim()) {
      rows.push({
        key: "order", seq: 1, ship_date: data.ship_date || "", status: data.status as string,
        box_count: Math.max(1, Math.floor(Number(data.box_count) || 1)),
        tracking: (data.tracking_no || "").trim(), itemsLabel: "",
      });
    }
    return rows;
  }, [data.shipments, data.items, data.tracking_no, data.ship_date, data.status, data.box_count]);
  const showShipInfo = mode === "edit" && shippedInfo.some((r) => r.tracking || r.status === "발송완료");
  // 일부 발송 표시(목록과 같은 규칙 b2b-orders shipView) — 폼 데이터는 차수 상품을 라인 인덱스로 들고 있어 인덱스를 id 로 맞춘다
  const partialView = useMemo(() => {
    if (mode !== "edit") return null;
    const items = data.items.map((it, i) => ({ id: String(i), qty: Number(it.qty) || 0 }));
    const shipments = data.shipments.map((sh) => ({
      status: sh.status as string,
      ship_date: sh.ship_date || null,
      items: sh.items.map((x) => ({ order_item_id: String(x.order_item_index), qty: Number(x.qty) || 0 })),
    }));
    const remaining_total = computeRemaining(items, shipments).reduce((a, b) => a + b, 0);
    const v = shipView({ status: data.status as string, items, shipments, remaining_total });
    return v.status === PARTIAL_SHIP ? v : null;
  }, [mode, data.items, data.shipments, data.status]);
  const orderItemsLabel = data.items
    .filter((it) => it.product_id)
    .map((it) => `${it.product_name}${it.spec ? ` ${it.spec}` : ""} ×${formatQty(Number(it.qty) || 0)}`)
    .join(", ");
  function copyTracking(key: string, num: string) {
    navigator.clipboard?.writeText(num).then(() => {
      setCopiedTrack(key);
      setTimeout(() => setCopiedTrack((cur) => (cur === key ? "" : cur)), 1500);
    }).catch(() => {});
  }

  // 발주 단위 이익률 (배송 박스 비용 포함)
  const currentMonth = useMemo(() => new Date().getMonth() + 1, []);
  const orderMargin = useMemo(() => {
    const volById = new Map(products.map((p) => [p.id, p.volume_kg]));
    const lines = data.items.map((it) => ({
      unitPrice: Number(it.unit_price) || 0,
      qty: Number(it.qty) || 0,
      costAtOrder: Number(it.cost_at_order) || 0,
      taxType: it.tax_type,
      volumeKg: (it.product_id ? Number(volById.get(it.product_id)) : 0) || 0,
    }));
    const season = seasonForDate(data.ship_date || data.order_date, currentMonth);
    const m = computeOrderMargin(lines, effectiveBoxCount, season, discountAmount);
    return { ...m, season };
  }, [data.items, effectiveBoxCount, data.ship_date, data.order_date, products, currentMonth, discountAmount]);

  // 수량 ↔ 차수 배분 점검 — 발송·취소된 몫보다 줄이거나, 안 나간 차수 여럿에 걸친 수량을 줄이거나, 대기 차수를 비우거나,
  //  발송된(안 돌아옴 취소 포함) 품목을 지우면 저장을 막는다(서버도 같은 규칙으로 막는다 — 그대로 저장되면 재고·매출·청구가
  //  실제로 나간 것보다 적게 잡힌다). 이미 어긋난 옛 데이터(stale)는 막지 않고 알린다. cuts 중 shipped 는 저장 전에 확인을 받는다.
  const allocPlan = useMemo(() => {
    if (mode !== "edit" || !allocBase) return null;
    const seen = new Set<string>();
    const lines: AllocLine[] = [];
    for (const it of data.items) {
      if (!it.id || !allocBase.prev.has(it.id) || seen.has(it.id)) continue; // 서버와 같은 규칙 — 같은 id 의 두 번째 줄은 새 줄
      seen.add(it.id);
      lines.push({
        id: it.id, qty: Number(it.qty) || 0, prev: allocBase.prev.get(it.id) ?? null, label: lineLabelOf(it.product_name, it.spec),
        product: it.product_id || null, prevProduct: allocBase.product.get(it.id) ?? null, prevLabel: allocBase.label.get(it.id),
      });
    }
    const removed: AllocLine[] = [...allocBase.prev.keys()]
      .filter((id) => !seen.has(id))
      .map((id) => ({ id, qty: 0, prev: null, label: allocBase.label.get(id) || "품목" }));
    return planLineAlloc(lines, removed, allocBase.ships);
  }, [mode, data.items, allocBase]);
  const allocErrors = allocPlan?.errors ?? [];
  const allocShort = allocErrors.filter((e) => e.kind !== "stale" && e.kind !== "product").map((e) => e.text);
  const allocStaleErr = allocErrors.filter((e) => e.kind === "stale").map((e) => e.text);
  const allocProduct = allocErrors.filter((e) => e.kind === "product").map((e) => e.text);
  const allocStale = (allocPlan?.stale ?? []).map((e) => e.text);
  const shippedMoves = (allocPlan?.cuts ?? []).filter((c) => c.shipped);
  const shippedRelinks = allocPlan?.relinks ?? [];

  // ─────────────────────────────────────────────
  // 폼 필드 수정 핸들러
  // ─────────────────────────────────────────────
  function setField<K extends keyof OrderInput>(key: K, value: OrderInput[K]) {
    setData((prev) => ({ ...prev, [key]: value }));
  }

  function setRecipient(patch: Partial<RecipientInput>) {
    setData((prev) => ({ ...prev, recipient: { ...prev.recipient, ...patch } }));
  }

  // 거래처별 단가 로드 — 발주 단가 자동 채움용. 거래처가 바뀌면(신규 등록) 담긴 라인도 그 단가로 갱신.
  useEffect(() => {
    const cid = data.company_id;
    if (!cid) { setCompanyPrices({}); return; }
    let alive = true;
    (async () => {
      try {
        const j = await (await fetch(`/api/b2b/companies/${cid}/prices`, { cache: "no-store" })).json();
        if (!alive || !j.ok) return;
        const map: Record<string, number> = {};
        for (const r of (j.prices || []) as { product_id: string; unit_price: number }[]) map[r.product_id] = Number(r.unit_price) || 0;
        setCompanyPrices(map);
        // 복제로 채운 거래처면 원본 단가를 그대로 둔다(맵만 갱신 — 새로 고르는 품목에는 거래처 단가가 들어간다)
        if (clonePriceKeep.current && clonePriceKeep.current === cid) { clonePriceKeep.current = null; return; }
        if (mode === "create") {
          // 거래처가 바뀌면 담긴 라인의 단가를 '무조건' 재도출한다. 새 거래처 전용단가가 있으면 그 값,
          //  없으면 기본판매가로 리셋 — 옛 거래처 단가만 갱신하면(있는 것만) 옛 협상단가가 잔존해
          //  다른 거래처에 잘못된 단가로 발주가 나간다. pickProduct(460)와 동일 규칙.
          setData((prev) => ({
            ...prev,
            items: prev.items.map((it) => {
              if (!it.product_id) return it;
              const p = products.find((pp) => pp.id === it.product_id);
              return { ...it, unit_price: map[it.product_id] ?? p?.sale_price ?? it.unit_price };
            }),
          }));
        }
      } catch { /* noop */ }
    })();
    return () => { alive = false; };
  }, [data.company_id, mode, products]);

  // 업체 변경 시 공통 배송 정보 자동 채움 (담당자·연락처·주소 → 수령인)
  function selectCompany(companyId: string) {
    clonePriceKeep.current = null; // 사람이 거래처를 고르면 그 거래처 단가로 다시 맞춘다
    setData((prev) => {
      const c = companies.find((cc) => cc.id === companyId);
      if (!c) return { ...prev, company_id: companyId };
      return {
        ...prev,
        company_id: companyId,
        recipient: {
          ...prev.recipient,
          recipient_name: c.contact_name ?? prev.recipient.recipient_name,
          recipient_phone: c.contact_phone ?? prev.recipient.recipient_phone,
          address: c.address ?? prev.recipient.address,
        },
      };
    });
    // 신규 등록 + 업체 선택 시: 이 업체의 최근 발주가 있으면 "복제?" 프롬프트
    setClonePrompt(null);
    if (mode === "create" && companyId) void checkRecentOrder(companyId);
  }

  // 선택한 업체의 가장 최근 발주를 찾아 복제 프롬프트 띄움
  async function checkRecentOrder(companyId: string) {
    try {
      const res = await fetch(`/api/b2b/orders?company_id=${companyId}`, { cache: "no-store" });
      const j = await res.json();
      if (!j.ok) return;
      const latest = (j.orders || [])[0]; // 목록은 발주일·생성순 내림차순
      if (!latest) return;
      const its = latest.items || [];
      const head = its.slice(0, 2).map((it: { product_name: string; spec: string | null; qty: number }) =>
        `${it.product_name}${it.spec ? ` ${it.spec}` : ""}×${formatQty(it.qty)}`).join(", ");
      const more = its.length > 2 ? ` 외 ${its.length - 2}종` : "";
      const summary = `${latest.order_no} · ${head}${more} · ${formatMoney(latest.total)}원`;
      setClonePrompt({ orderId: latest.id, summary });
    } catch {
      // 조회 실패는 조용히 무시 — 그냥 빈 폼으로 진행
    }
  }

  // "복제하기" — 최근 발주 상세를 불러와 폼을 채움
  async function applyRecentClone() {
    if (!clonePrompt) return;
    setCloning(true);
    try {
      const res = await fetch(`/api/b2b/orders/${clonePrompt.orderId}`, { cache: "no-store" });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "복제할 발주 조회 실패");
      const o = j.order as Order & { items: OrderItem[]; shipments: Shipment[] };
      const t = new Date();
      const todayIso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      // 할인/추가금도 원본대로 복원 — 저장은 discountRaw 기반이라 여기서 안 채우면 0으로 소실되고,
      //  반대로 프롬프트 전에 입력해 둔 값이 있으면 복제본에 섞인다(0이면 빈 값으로 리셋).
      setDiscountMode("won");
      setDiscountRaw(Number(o.discount_amount) !== 0 ? String(Math.round(Number(o.discount_amount))) : "");
      setData(buildCloneData(o, todayIso));
      setClonePrompt(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "복제 중 오류");
    }
    setCloning(false);
  }

  // ── 발송 일정 핸들러 ──
  function addSchedule() {
    setData((prev) => ({ ...prev, shipments: [...prev.shipments, { ...EMPTY_SHIPMENT_SCHEDULE, items: [] }] }));
  }
  function removeSchedule(si: number) {
    setData((prev) => ({ ...prev, shipments: prev.shipments.filter((_, i) => i !== si) }));
  }
  function setSchedule(si: number, patch: Partial<ShipmentScheduleInput>) {
    setData((prev) => ({
      ...prev,
      shipments: prev.shipments.map((s, i) => (i === si ? { ...s, ...patch } : s)),
    }));
  }
  function setScheduleQty(si: number, orderItemIndex: number, qty: string) {
    setData((prev) => ({
      ...prev,
      shipments: prev.shipments.map((s, i) => {
        if (i !== si) return s;
        const items = [...s.items];
        const found = items.findIndex((x) => x.order_item_index === orderItemIndex);
        if (found >= 0) items[found] = { ...items[found], qty };
        else items.push({ order_item_index: orderItemIndex, qty });
        return { ...s, items };
      }),
    }));
  }
  function getScheduleQty(si: number, orderItemIndex: number): string {
    const found = data.shipments[si]?.items.find((x) => x.order_item_index === orderItemIndex);
    return found ? String(found.qty) : "";
  }
  // 차수 박스 수 변경 — 송장 칸 수가 따라 바뀌므로 tracking 문자열도 길이에 맞춤.
  //  빈 값을 즉시 1로 되돌리면 모바일에서 기본값 1을 지우고 새 숫자를 입력할 수 없다(1→13 처럼 붙음)
  //  → 입력 중에는 빈 값을 그대로 두고, blur(칸 벗어남)·저장 시에 1로 보정한다. 서버도 숫자로 강제 변환한다.
  function setScheduleBoxCount(si: number, raw: string) {
    const n = Math.max(1, Math.floor(Number(raw) || 1)); // 송장 칸 수 계산용(빈 값=1칸 유지)
    setData((prev) => ({
      ...prev,
      shipments: prev.shipments.map((s, i) => {
        if (i !== si) return s;
        const boxes = splitTracking(s.tracking_no, n); // n 길이에 맞춰 패딩/자름
        return { ...s, box_count: raw === "" ? "" : n, tracking_no: joinTracking(boxes) };
      }),
    }));
  }
  // 박스별 송장번호 1칸 변경 → 콤마 join 으로 보관
  function setScheduleTracking(si: number, boxIdx: number, val: string) {
    setData((prev) => ({
      ...prev,
      shipments: prev.shipments.map((s, i) => {
        if (i !== si) return s;
        const n = Math.max(1, Math.floor(Number(s.box_count) || 1));
        const boxes = splitTracking(s.tracking_no, n);
        boxes[boxIdx] = val;
        return { ...s, tracking_no: joinTracking(boxes) };
      }),
    }));
  }

  function updateItem(idx: number, patch: Partial<OrderItemInput>) {
    setData((prev) => ({
      ...prev,
      items: prev.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    }));
  }

  function pickProduct(idx: number, productId: string) {
    if (!productId) {
      updateItem(idx, { product_id: null });
      return;
    }
    const p = products.find((pp) => pp.id === productId);
    if (!p) return;
    updateItem(idx, {
      product_id: p.id,
      product_name: p.name,
      spec: p.spec ?? "",
      unit_price: companyPrices[p.id] ?? p.sale_price, // 거래처별 단가 있으면 우선, 없으면 기본판매가
      cost_at_order: p.cost_price,
      tax_type: p.tax_type,
    });
  }

  function addItemRow() {
    setData((prev) => ({
      ...prev,
      items: [...prev.items, { ...EMPTY_ORDER_ITEM, sort_order: prev.items.length }],
    }));
  }

  // 발송 차수의 상품 배분은 라인 '순번'(order_item_index)으로 묶여 있다 — 라인을 지우면 그 배분은 빼고
  //  뒤 라인의 순번을 하나씩 당긴다. 안 그러면 저장 후 배분이 엉뚱한 라인에 붙어 'N개 남음'이 틀어진다.
  function remapShipments(prev: OrderInput, idx: number): OrderInput["shipments"] {
    return (prev.shipments || []).map((s) => ({
      ...s,
      items: (s.items || [])
        .filter((it) => it.order_item_index !== idx)
        .map((it) => (it.order_item_index > idx ? { ...it, order_item_index: it.order_item_index - 1 } : it)),
    }));
  }
  function removeItemRow(idx: number) {
    if (data.items.length === 1) {
      // 최소 1개는 유지 — 빈 줄로 초기화(같은 자리에 다른 품목을 넣는 경우라 차수 배분은 그대로 둔다)
      setData((prev) => ({ ...prev, items: [{ ...EMPTY_ORDER_ITEM }] }));
      return;
    }
    setData((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== idx), shipments: remapShipments(prev, idx) }));
  }

  // ─────────────────────────────────────────────
  // 저장 / 삭제
  // ─────────────────────────────────────────────
  async function handleSave() {
    // 상품을 고르지 않고 이름만 친 품목은 재고에서 빠지지 않는다 — 조용히 저장하지 않고 확인을 받는다(서버도 확인 없이는 막는다)
    const unlinked = data.items.filter((it) => !it.product_id && it.product_name.trim()).map((it) => it.product_name.trim());
    let allowUnlinked = false;
    if (unlinked.length) {
      if (!window.confirm(`다음 품목은 상품이 연결되지 않아 재고에서 빠지지 않습니다:\n${unlinked.join("\n")}\n\n그대로 저장할까요? 재고 품목이면 [취소]를 누르고 품목칸에서 목록의 상품을 고르세요.`)) return;
      allowUnlinked = true;
    }
    // 단일 발송 발주의 발송된 수량을 고치면 그 차수에 나간 수량을 다시 기록한다 — 선점·매출이 새 수량을 따르므로 확인을 받는다.
    //  발송된 미연동 줄에 상품을 처음 연결하는 것도 같다(그 수량이 그 상품 재고에서 빠진다)
    let allowShippedQty = false;
    if (mode === "edit" && (shippedMoves.length || shippedRelinks.length)) {
      const lines = [
        ...shippedMoves.map((c) => `${c.label}: 발송된 수량을 ${formatQty(c.from)} → ${formatQty(c.to)} 으로 고칩니다`),
        ...shippedRelinks.map((r) => `${r.label}: 상품을 연결해 발송된 ${formatQty(r.qty)} 이 그 상품 재고에서 빠집니다`),
      ].join("\n");
      if (!window.confirm(`${lines}\n— 재고·매출이 함께 바뀝니다.\n\n저장할까요?`)) return;
      allowShippedQty = true;
    }
    setSaving(true);
    setError("");
    setSalesWarn("");
    try {
      const url = mode === "create" ? "/api/b2b/orders" : `/api/b2b/orders/${orderId}`;
      const method = mode === "create" ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        // 라인 순번(sort_order)을 화면 순서로 다시 매긴다 — 서버가 저장한 라인을 sort_order 로 정렬한 뒤 차수 배분의
        //  라인 순번(order_item_index)을 그 목록에 대응시키므로, 줄을 지우고 추가해 순번이 어긋나면 배분이 엉뚱한 라인에 붙는다.
        //  updated_at = 열 때 읽은 값 — 그 사이 다른 곳에서 바뀌었으면 서버가 409 로 덮지 않는다.
        body: JSON.stringify({
          ...data,
          items: data.items.map((it, i) => ({ ...it, sort_order: i })),
          discount_amount: discountAmount,
          allow_unlinked: allowUnlinked,
          ...(mode === "create"
            ? { client_request_id: requestKey }
            : { updated_at: originalOrder?.updated_at ?? null, allow_shipped_qty: allowShippedQty }),
        }),
      });
      const json = await res.json();
      if (res.status === 409 && json.stale) throw new Error(json.error || "다른 곳에서 이 발주가 바뀌었습니다 — 새로고침한 뒤 다시 고쳐 저장하세요.");
      if (!res.ok || !json.ok) throw new Error(json.error || "저장 실패");
      // 차감 칸이 유지됐거나(이미 나감) 바뀌었으면(옮길 방향) 안내 — 따르지 않으면 칸마다 유령 재고가 생긴다
      if (json.channel_notice) alert(json.channel_notice);
      // 매출 원장 반영 실패(수정) — 품목·차수·재고는 저장됐다. 목록으로 가면 경고가 사라지므로 이 화면에 남아
      //  배너를 띄우고, 다시 [수정]을 누르면 매출이 다시 맞춰진다. 화면 값·updated_at 은 다시 불러오기로만 맞춘다 —
      //  응답의 updated_at 만 먼저 받아 두면 다시 불러오기가 실패해도 409 검사가 통과해, 옛 화면 값(새 줄에 id 없음)이
      //  방금 넣은 줄을 지우고 또 넣어 차수 배분이 끊긴다. 실패하면 새로고침 전까지 [수정]을 막는다.
      //  등록(POST)은 새 발주가 항상 발송대기라 매출 행이 없어 실패해도 원장에 남는 것이 없다 — 목록으로 간다.
      if (mode === "edit" && orderId && json.sales_sync_failed) {
        setSalesWarn(json.sales_sync_message || "매출 반영 실패");
        try {
          await loadEditOrder(orderId);
        } catch {
          setReloadFailed(true);
          setError("발주를 다시 불러오지 못했습니다 — 새로고침한 뒤 [수정]을 누르세요.");
        }
        setSaving(false);
        return;
      }

      // 저장 성공 — 리스트로 돌아감 (혹은 상세로?)
      router.push("/b2b/orders");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 중 오류");
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (mode !== "edit" || !orderId) return;
    // 발송된 발주를 지우면 실제로 나간 물건이 장부에 되살아난다 — 취소로 바꾼다(서버도 막는다)
    if (shippedOrder) {
      setError("발송된 발주는 삭제할 수 없습니다 — 발주 목록에서 상태를 '취소'로 바꾸세요. 발송완료로 잘못 바꾼 것이면 먼저 '발송대기'로 되돌린 뒤 삭제하세요.");
      return;
    }
    const orderLabel = originalOrder?.order_no || orderId;
    if (!confirm(`발주 ${orderLabel} 을(를) 삭제하시겠어요?\n품목·발송 일정이 함께 삭제되고 선점된 재고가 원복됩니다.`)) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/b2b/orders/${orderId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "삭제 실패");
      router.push("/b2b/orders");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 중 오류");
      setSaving(false);
    }
  }

  // ─────────────────────────────────────────────
  // 렌더
  // ─────────────────────────────────────────────
  if (loading) return <div className="b2b-loading">불러오는 중...</div>;

  const canSave =
    !!data.company_id && !!data.order_date && data.items.length > 0 &&
    data.items.every((it) => it.product_name.trim() && Number(it.qty) > 0);
  // 취소된 발주에 취소 안 된 실제 차수가 남은 옛 데이터 — 서버가 저장을 막는다(재저장하면 발주가 되살아나거나 선점만 다시 기록된다)
  const cancelledLive = mode === "edit" && originalOrder?.status === "취소" &&
    data.shipments.some((s) => s.status !== "취소" && (!!s.ship_date || (s.items || []).some((it) => Number(it.qty) > 0)));

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">
            {mode === "create"
              ? cloneFromId
                ? "발주 복제"
                : "새 발주 등록"
              : `발주 수정 · ${originalOrder?.order_no ?? ""}`}
          </h1>
          {mode === "create" && cloneFromId && (
            <p className="b2b-page-subtitle">발주일·일정·상태는 초기화됐습니다.</p>
          )}
        </div>
        <div className="b2b-page-actions">
          {mode === "edit" && orderId && (
            <button
              type="button"
              className="b2b-btn-secondary"
              onClick={() => router.push(`/b2b/orders/new?from=${orderId}`)}
              title="이 발주의 업체·품목·송장 정보를 복사해 새 발주를 만듭니다"
            >
              복제
            </button>
          )}
          <Link href="/b2b/orders" className="b2b-btn-secondary">목록으로</Link>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}
      {salesWarn && <div className="sm-warn">{salesWarn}</div>}
      {cancelledLive && (
        <div className="sm-warn">취소된 발주에 취소되지 않은 차수가 있어 저장할 수 없습니다 — 발주 목록에서 차수 상태를 먼저 맞추세요.</div>
      )}

      <div className="b2b-form-sections">
        {/* ───── 기본 정보 ───── */}
        <section className="b2b-form-section">
          <div className="b2b-form-section-title">기본 정보</div>
          <div className="b2b-field-row">
            <div className="b2b-field">
              <label className="b2b-field-label">업체<span className="req">*</span></label>
              <Combobox
                value={companies.find((c) => c.id === data.company_id)?.name ?? ""}
                options={companies.map((c) => ({ id: c.id, label: c.name }))}
                onSelect={(o) => selectCompany(o.id)}
                placeholder="업체 검색 또는 선택"
                ariaLabel="업체"
                emptyText="일치하는 업체가 없습니다"
              />
              {companies.length === 0 && (
                <span style={{ fontSize: 12, color: "var(--sm-danger)" }}>등록된 업체가 없습니다</span>
              )}
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">발주일<span className="req">*</span></label>
              <input
                type="date"
                className="b2b-input"
                value={data.order_date}
                onChange={(e) => setField("order_date", e.target.value)}
              />
            </div>
          </div>

          <div className="b2b-field-row" style={{ marginTop: 12 }}>
            {/* 생산예정일 — 생산관리로 이관되어 발주에선 숨김(SHOW_ORDER_PRODUCTION). 2열 그리드 유지 위해 빈 칸 대체 */}
            {SHOW_ORDER_PRODUCTION ? (
              <div className="b2b-field">
                <label className="b2b-field-label">생산예정일</label>
                <input
                  type="date"
                  className="b2b-input"
                  value={data.production_date}
                  onChange={(e) => setField("production_date", e.target.value)}
                />
              </div>
            ) : (
              <div className="b2b-field" aria-hidden />
            )}
            <div className="b2b-field">
              <label className="b2b-field-label">발송예정일</label>
              <div style={{ fontSize: 15, padding: "10px 0", color: data.ship_date ? undefined : "var(--sm-text-light)" }}>
                {data.ship_date || "미정"}
              </div>
              {isMultiShipment && (
                <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>복수발송 — 가장 이른 날짜</span>
              )}
            </div>
          </div>

          {/* 대량 발주(선결제) — 체크하면 발송 선점 출고가 '도매 대량' 칸에서 빠진다(115).
              도매 일반 주문이 이 물량을 가져가지 못하게 칸을 나눈 것이라, 판단은 담당자가 발주 단위로 한다. */}
          <div className="b2b-field" style={{ marginTop: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" }}>
              <input
                type="checkbox"
                className="b2b-checkbox"
                checked={!!data.is_bulk}
                onChange={(e) => setField("is_bulk", e.target.checked)}
              />
              대량 발주 (선결제)
            </label>
            <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>
              체크하면 발송 재고를 ‘도매 대량’ 칸에서 뺍니다
            </span>
            {alreadyOut && (
              <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--sm-danger)" }}>
                {alreadyOut === "shipped"
                  ? "이 발주는 이미 발송완료돼 체크를 바꿔도 차감 칸이 바뀌지 않습니다 — 재고 이동을 하지 마세요"
                  : "발송예정일이 지나 체크를 바꿔도 차감 칸이 그대로입니다 — 아직 안 나갔다면 발주 목록의 발송일 칸을 눌러 오늘이나 그 뒤 날짜로 다시 잡으세요(그때 칸이 바뀝니다)"}
              </span>
            )}
          </div>

          <div className="b2b-field" style={{ marginTop: 12 }}>
            <label className="b2b-field-label">메모</label>
            <textarea
              className="b2b-textarea"
              value={data.notes}
              onChange={(e) => setField("notes", e.target.value)}
              rows={2}
              placeholder="포장 요청·전달 사항·결제 메모 등"
            />
          </div>
        </section>

        {/* ───── 상태 ───── */}
        <CollapsibleSection title="상태">
          {/* 생산(발주 단위) · 발송(차수) 분리 */}
          <div className="b2b-field-row">
            {/* 생산 상태 — 생산관리로 이관되어 발주에선 숨김(SHOW_ORDER_PRODUCTION). 2열 그리드 유지 위해 빈 칸 대체 */}
            {SHOW_ORDER_PRODUCTION ? (
              <div className="b2b-field">
                <label className="b2b-field-label">생산 상태</label>
                <select
                  className="b2b-select"
                  value={data.production_status}
                  onChange={(e) => setField("production_status", e.target.value as OrderInput["production_status"])}
                >
                  {PRODUCTION_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="b2b-field" aria-hidden />
            )}
            <div className="b2b-field" aria-hidden />
          </div>
          <div className="b2b-field-row" style={{ marginTop: 12 }}>
            <div className="b2b-field">
              <label className="b2b-field-label">입금 상태</label>
              <select
                className="b2b-select"
                value={data.payment_status}
                onChange={(e) => setField("payment_status", e.target.value as OrderInput["payment_status"])}
              >
                {PAYMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">세금계산서</label>
              <select
                className="b2b-select"
                value={data.tax_invoice_status}
                onChange={(e) => setField("tax_invoice_status", e.target.value as OrderInput["tax_invoice_status"])}
              >
                {TAX_INVOICE_STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
        </CollapsibleSection>

        {/* ───── 배송 정보 (공통) ───── */}
        <CollapsibleSection title="배송 정보" titleExtra={
          <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 500, color: "var(--sm-text-light)", textTransform: "none", letterSpacing: 0 }}>
            모든 발송 일정에 공통 적용
          </span>
        }>
          <div className="b2b-field-row">
            <div className="b2b-field">
              <label className="b2b-field-label">수령인 이름</label>
              <input
                type="text"
                className="b2b-input"
                value={data.recipient.recipient_name}
                onChange={(e) => setRecipient({ recipient_name: e.target.value })}
                placeholder="홍길동"
              />
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">수령인 연락처</label>
              <input
                type="text"
                className="b2b-input"
                value={data.recipient.recipient_phone}
                onChange={(e) => setRecipient({ recipient_phone: e.target.value })}
                placeholder="010-0000-0000"
              />
            </div>
          </div>
          <div className="b2b-field" style={{ marginTop: 12 }}>
            <label className="b2b-field-label">배송지 주소</label>
            <input
              type="text"
              className="b2b-input"
              value={data.recipient.address}
              onChange={(e) => setRecipient({ address: e.target.value })}
              placeholder="(우편번호) 시/도 시/군/구 도로명 + 상세"
            />
          </div>
          <div className="b2b-field-row" style={{ marginTop: 12 }}>
            <div className="b2b-field">
              <label className="b2b-field-label">배송 메세지</label>
              <input
                type="text"
                className="b2b-input"
                value={data.recipient.delivery_memo}
                onChange={(e) => setRecipient({ delivery_memo: e.target.value })}
                placeholder="문 앞 / 부재 시 경비실 등"
              />
            </div>
            <div className="b2b-field">
              <label className="b2b-field-label">택배사 (선택)</label>
              <input
                type="text"
                className="b2b-input"
                value={data.recipient.courier}
                onChange={(e) => setRecipient({ courier: e.target.value })}
                placeholder="CJ대한통운"
              />
            </div>
          </div>
        </CollapsibleSection>

        {/* 발송 일정(차수)은 발주 목록의 '+ 발송일' 창에서만 만든다 —
            실제 발송 기준으로 날짜·박스 수·수량을 한 곳에서 잡기 위해 이 폼에서는 뺐다. */}

        {/* ───── 발송 · 송장번호 (읽기 전용) ───── */}
        {showShipInfo && (
          <section className="b2b-form-section">
            <div className="b2b-form-section-title">
              발송 · 송장번호
              {partialView && (
                <span className="b2b-status-pill" style={{ marginLeft: 8, background: partialView.color?.bg, color: partialView.color?.fg }}>{partialView.label}</span>
              )}
              {data.recipient.courier ? <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "var(--sm-text-mid)" }}>{data.recipient.courier}</span> : null}
            </div>
            <div className="sm-col" style={{ gap: 10 }}>
              {shippedInfo.map((r) => (
                <div key={r.key} style={{ border: "1px solid var(--sm-border)", borderRadius: 10, padding: "10px 12px" }}>
                  <div className="sm-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <strong style={{ fontSize: 15 }}>
                      {shippedInfo.length > 1 ? `${r.seq}차 · ` : ""}{r.ship_date || "날짜미정"}
                    </strong>
                    <span className="b2b-status-pill" style={{
                      background: SHIPMENT_STATUS_COLORS[r.status as keyof typeof SHIPMENT_STATUS_COLORS]?.bg,
                      color: SHIPMENT_STATUS_COLORS[r.status as keyof typeof SHIPMENT_STATUS_COLORS]?.fg,
                    }}>{r.status}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--sm-text-mid)", marginTop: 6 }}>
                    <span style={{ color: "var(--sm-text-light)", marginRight: 5 }}>발송 제품</span>
                    {r.itemsLabel || orderItemsLabel || "-"}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    {r.tracking === "직접배송" ? (
                      <span style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>직접배송 — 택배 송장 없음</span>
                    ) : r.tracking ? (
                      <div className="sm-col" style={{ gap: 3 }}>
                        {splitTracking(r.tracking, r.box_count).map((num, bi) => (
                          <div key={bi} className="sm-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            {r.box_count > 1 && <span style={{ fontSize: 12, color: "var(--sm-text-light)", width: 40, flexShrink: 0 }}>박스 {bi + 1}</span>}
                            {num ? (
                              <>
                                <span style={{ fontFamily: "var(--sm-mono)", fontSize: 15, fontWeight: 600 }}>{num}</span>
                                <button type="button" className="b2b-link-btn" style={{ fontSize: 12 }}
                                  onClick={() => copyTracking(`${r.key}-${bi}`, num)}>
                                  {copiedTrack === `${r.key}-${bi}` ? "복사됨" : "복사"}
                                </button>
                              </>
                            ) : (
                              <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>미입력</span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>
                        {r.status === "발송완료" ? "송장번호 미입력" : "아직 발송 전"}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ───── 발주 상품 ───── */}
        <section className="b2b-form-section">
          <div className="b2b-form-section-title">발주 상품</div>
          <div className="b2b-table-wrap">
            <table className="b2b-items-table">
              <thead>
                <tr>
                  <th style={{ minWidth: 240 }}>품목명 <span style={{ color: "var(--sm-orange)" }}>*</span></th>
                  <th style={{ width: 130 }}>옵션</th>
                  <th className="num" style={{ width: 90 }}>수량 *</th>
                  <th className="num" style={{ width: 120 }}>단가</th>
                  <th style={{ width: 80 }}>과세</th>
                  <th className="num" style={{ width: 120 }}>금액</th>
                  <th style={{ width: 1 }}></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it, idx) => {
                  const qty = Number(it.qty) || 0;
                  const price = Number(it.unit_price) || 0;
                  // 검색 목록: 묶음(세트) 제외 — 자체 재고가 없어 발주 라인에 직접 걸면 안 된다.
                  //  다른 라인에 이미 담긴 상품도 제외(중복 라인 방지) — 단, 이 라인이 고른 상품은 남긴다.
                  const usedElsewhere = new Set(data.items.filter((_, i) => i !== idx).map((x) => x.product_id).filter(Boolean));
                  // 연결된 실제 상품 — 화면의 이름·옵션은 스냅샷이라, 재고가 빠지는 진짜 SKU 는 이걸로 확인한다
                  //  (동명 상품을 잘못 골라 다른 SKU 재고가 나간 실제 사고의 재발 방지).
                  const linked = it.product_id ? products.find((pp) => pp.id === it.product_id) : null;
                  return (
                    <tr key={idx}>
                      <td data-label="품목명">
                        <Combobox
                          value={it.product_name}
                          options={products
                            .filter((p) => !p.is_bundle && (!usedElsewhere.has(p.id) || p.id === it.product_id))
                            .map((p) => ({ id: p.id, label: p.name, sub: [p.spec, p.origin, p.attrs, p.sku].filter(Boolean).join(" · ") }))}
                          onSelect={(o) => pickProduct(idx, o.id)}
                          onType={(text) => updateItem(idx, { product_name: text, product_id: null })}
                          allowFreeText
                          placeholder="제품 검색 또는 직접 입력"
                          ariaLabel="품목명"
                        />
                        {it.product_id ? (
                          <div className="sm-faint" style={{ fontSize: 12, marginTop: 3 }}>
                            {linked ? (linked.sku || "SKU 미지정") : "연결 상품이 목록에 없음(비활성?) — 재저장 전 확인"}
                          </div>
                        ) : it.product_name.trim() ? (
                          <div style={{ fontSize: 12, marginTop: 3, color: "var(--sm-warning)" }}>직접입력 — 재고 연동 안 됨</div>
                        ) : null}
                        {it.id && data.items.findIndex((x) => x.id === it.id) === idx && (
                          allocPlan?.errors.some((e) => e.kind === "product" && e.lineId === it.id) ? (
                            <div style={{ fontSize: 12, marginTop: 3, color: "var(--sm-danger)" }}>발송된 품목 — 바꿀 수 없음</div>
                          ) : allocPlan?.relinks.some((r) => r.lineId === it.id) ? (
                            <div style={{ fontSize: 12, marginTop: 3, color: "var(--sm-warning)" }}>발송된 수량이 이 상품 재고에서 빠짐</div>
                          ) : null
                        )}
                      </td>
                      <td data-label="옵션">
                        <input
                          type="text"
                          value={it.spec}
                          onChange={(e) => updateItem(idx, { spec: e.target.value })}
                          placeholder="100g / 옵션"
                        />
                      </td>
                      <td data-label="수량">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={it.qty}
                          onChange={(e) => updateItem(idx, { qty: e.target.value })}
                          min={0}
                          style={{ textAlign: "right" }}
                        />
                        {(() => {
                          // 발송·취소된 차수 배분(줄일 수 없는 몫), 여러 차수에 나뉜 배분, 어긋난 옛 데이터, 발송 수량 다시 기록이면
                          //  수량 칸 아래에 보인다. 빨강 = 이대로 저장 안 됨, 노랑 = 저장 때 확인(발송 수량)·어긋난 데이터
                          if (mode !== "edit" || !it.id || !allocBase || !allocPlan) return null;
                          const firstIdx = data.items.findIndex((x) => x.id === it.id);
                          if (firstIdx !== idx || !allocBase.prev.has(it.id)) return null; // 같은 id 의 두 번째 줄은 새 줄
                          const a = lineAllocOf(allocBase.ships.filter(isAllocReal), it.id);
                          if (a.total <= EPS) return null;
                          const cut = allocPlan.cuts.find((c) => c.lineId === it.id);
                          const bad = allocPlan.errors.some((e) => e.lineId === it.id);
                          const stale = allocPlan.stale.some((e) => e.lineId === it.id);
                          const shown = a.cancelled + a.shipped > EPS || a.pending.size >= 2 || bad || stale || (!!cut && (cut.shipped || allocPlan.multi));
                          if (!shown) return null;
                          const pending = a.total - a.cancelled - a.shipped;
                          const parts = [
                            a.shipped > 0 ? `발송 ${formatQty(r3(a.shipped))}` : "",
                            a.cancelled > 0 ? `취소 ${formatQty(r3(a.cancelled))}` : "",
                            pending > EPS ? `대기 ${formatQty(r3(pending))}` : "",
                          ].filter(Boolean).join(" · ");
                          const color = bad ? "var(--sm-danger)" : stale || cut?.shipped ? "var(--sm-warning)" : null;
                          return (
                            <div className={color ? undefined : "sm-faint"} style={{ fontSize: 12, marginTop: 3, textAlign: "right", ...(color ? { color } : {}) }}>
                              배분 {formatQty(r3(a.total))}{cut ? ` → ${formatQty(r3(a.total - cut.from + cut.to))}` : ""} ({parts})
                            </div>
                          );
                        })()}
                      </td>
                      <td data-label="단가">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={it.unit_price}
                          onChange={(e) => updateItem(idx, { unit_price: e.target.value })}
                          min={0}
                          style={{ textAlign: "right" }}
                        />
                      </td>
                      <td data-label="과세">
                        <select
                          value={it.tax_type}
                          onChange={(e) => updateItem(idx, { tax_type: e.target.value as typeof it.tax_type })}
                        >
                          {TAX_TYPES.map((t) => (
                            <option key={t} value={t}>{TAX_TYPE_LABEL[t]}</option>
                          ))}
                        </select>
                      </td>
                      <td data-label="금액" className="num b2b-money b2b-item-amount" style={{ padding: "12px 10px", color: "var(--sm-text-mid)" }}>
                        {formatMoney(qty * price)}
                      </td>
                      <td className="b2b-item-remove">
                        <button
                          type="button"
                          className="b2b-icon-btn is-danger"
                          onClick={() => removeItemRow(idx)}
                          title="상품 삭제"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="b2b-items-add-row">
            <button type="button" className="b2b-btn-secondary" onClick={addItemRow}>
              + 상품 추가
            </button>
          </div>
        </section>

        {/* ───── 합계 ───── */}
        <section className="b2b-form-section">
          <div className="b2b-totals">
            <div className="b2b-totals-row">
              과세 분 <strong className="b2b-money">{formatMoney(totals.taxable)}원</strong>
            </div>
            <div className="b2b-totals-row">
              면세 분 <strong className="b2b-money">{formatMoney(totals.exempt)}원</strong>
            </div>
            <div className="b2b-totals-row">
              부가세 <strong className="b2b-money">{formatMoney(totals.vat)}원</strong>
            </div>
            {/* 할인/추가금 — 원 또는 %(합계 기준)로 넣고, 저장은 원 금액으로 확정된다. 음수 = 추가금(합계 가산) */}
            <div className="b2b-totals-row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: "0 0 auto" }}>할인/추가금</span>
              <span className="sm-row" style={{ gap: 6, marginLeft: "auto", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <input className="b2b-input" type="number" value={discountRaw}
                  onChange={(e) => setDiscountRaw(e.target.value)}
                  placeholder="0" title="양수 = 할인, 음수 = 추가금"
                  style={{ width: 110, textAlign: "right", padding: "6px 8px" }}
                  aria-label="할인/추가금 값" />
                <select className="b2b-input" value={discountMode}
                  onChange={(e) => setDiscountMode(e.target.value as "won" | "pct")}
                  style={{ width: "auto", padding: "6px 8px" }} aria-label="할인/추가금 단위">
                  <option value="won">원</option>
                  <option value="pct">%</option>
                </select>
                <input className="b2b-input" value={data.discount_reason}
                  onChange={(e) => setData((p) => ({ ...p, discount_reason: e.target.value }))}
                  placeholder="사유 (예: 장기거래 감사, 추가 포장비)" style={{ width: 200, padding: "6px 8px" }}
                  aria-label="할인/추가금 사유" />
              </span>
            </div>
            {discountAmount > 0 && (
              <div className="b2b-totals-row" style={{ color: "var(--sm-danger)" }}>
                할인 적용{discountMode === "pct" ? ` (${Number(discountRaw) || 0}%)` : ""}
                <strong className="b2b-money">-{formatMoney(discountAmount)}원</strong>
              </div>
            )}
            {discountAmount < 0 && (
              <div className="b2b-totals-row">
                추가금 적용{discountMode === "pct" ? ` (${Math.abs(Number(discountRaw) || 0)}%)` : ""}
                <strong className="b2b-money">+{formatMoney(-discountAmount)}원</strong>
              </div>
            )}
            <div className="b2b-totals-row is-grand">
              합계 <strong className="b2b-money">{formatMoney(totalAfterDiscount)}원</strong>
            </div>
          </div>
        </section>

        {/* ───── 이익률 (배송 박스 단위) ───── */}
        <CollapsibleSection title="이익률 (배송 박스 기준)">
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--sm-text-mid)" }}>
            매출 − 제품원가 − 배송비(박스 × 아이스박스+운반비+보냉비). 단가 = 공급가(부가세 별도) 기준.
          </p>

          {/* 박스 수는 여기서 고치지 않는다 — 실제 발송한 박스 수(발송일 등록에서 입력)만 이익률에 반영한다.
              readOnly input 은 모바일에서 키보드만 뜨고 입력이 안 돼 텍스트로 표시한다. */}
          <div className="b2b-field-row" style={{ marginBottom: 12 }}>
            <div className="b2b-field" style={{ maxWidth: 220 }}>
              <label className="b2b-field-label">배송 박스 수</label>
              <div style={{ fontSize: 15, fontWeight: 700, padding: "9px 0" }}>
                {realScheduleCount > 0 ? `${effectiveBoxCount}박스` : "미정"}
              </div>
              <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>
                {realScheduleCount > 0
                  ? `발송 일정 ${realScheduleCount}건의 박스 수 합 · 총 부피 ${orderMargin.volume.toLocaleString()}kg`
                  : `총 부피 ${orderMargin.volume.toLocaleString()}kg`}
              </span>
            </div>
            <div className="b2b-field" style={{ maxWidth: 220 }}>
              <label className="b2b-field-label">계절 (보냉비)</label>
              <div style={{ fontSize: 15, fontWeight: 700, padding: "9px 0" }}>
                {orderMargin.season} <span style={{ fontWeight: 400, fontSize: 12, color: "var(--sm-text-mid)" }}>({SEASON_MONTHS[orderMargin.season]})</span>
              </div>
              <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>발송예정일 기준 자동</span>
            </div>
          </div>
          {realScheduleCount === 0 && (
            <p className="sm-faint" style={{ fontSize: 12, margin: "-4px 0 12px" }}>
              발송 일정이 없어 배송비를 1박스로 잡은 잠정 이익률입니다.
            </p>
          )}

          <div className="b2b-totals">
            <div className="b2b-totals-row">
              {/* 매출 = 단가(공급가) × 수량 — 합계와 다르면 할인·추가금이 비율로 반영된 것 */}
              매출{orderMargin.revenue !== totals.subtotal ? (discountAmount < 0 ? " (추가금 반영)" : " (할인 반영)") : ""}{" "}
              <strong className="b2b-money">{formatMoney(Math.round(orderMargin.revenue))}원</strong>
            </div>
            <div className="b2b-totals-row">
              제품원가 <strong className="b2b-money">− {formatMoney(Math.round(orderMargin.productCost))}원</strong>
            </div>
            <div className="b2b-totals-row" title={`박스 ${orderMargin.boxes}개 × (아이스박스 ${formatMoney(orderMargin.iceboxPerBox)} + 운반비 ${formatMoney(orderMargin.deliveryPerBox)} + 보냉비 ${formatMoney(orderMargin.coolingPerBox)})`}>
              배송비 ({orderMargin.boxes}박스){" "}
              <strong className="b2b-money">− {formatMoney(Math.round(orderMargin.shipping))}원</strong>
            </div>
            <div className="b2b-totals-row is-grand">
              이익{" "}
              <strong className="b2b-money" style={{ color: orderMargin.profit >= 0 ? "var(--sm-success)" : "var(--sm-danger)" }}>
                {orderMargin.profit >= 0 ? "+" : ""}{formatMoney(Math.round(orderMargin.profit))}원
                {orderMargin.revenue > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 15 }}>
                    ({orderMargin.marginPct.toFixed(1)}%)
                  </span>
                )}
              </strong>
            </div>
          </div>
        </CollapsibleSection>

        {allocProduct.length > 0 && (
          <div className="sm-warn">
            발송된 품목은 바꿀 수 없습니다 — {allocProduct.join(" / ")}. {ALLOC_PRODUCT_GUIDE}
          </div>
        )}
        {allocShort.length > 0 && (
          <div className="sm-warn">
            수량을 차수 배분보다 줄일 수 없습니다 — {allocShort.join(" / ")}. {ALLOC_GUIDE}
          </div>
        )}
        {allocStaleErr.length > 0 && (
          <div className="sm-warn">
            저장된 수량이 이미 차수 배분과 어긋난 품목입니다 — {allocStaleErr.join(" / ")}. {ALLOC_STALE_GUIDE}
          </div>
        )}
        {allocStale.length > 0 && (
          <div className="sm-warn">
            저장된 수량이 차수 배분과 어긋나 있습니다(다른 칸은 그대로 저장됩니다) — {allocStale.join(" / ")}. {ALLOC_STALE_GUIDE}
          </div>
        )}
        {shippedMoves.length > 0 && (
          <div className="sm-warn">
            발송된 수량을 고칩니다 — {shippedMoves.map((c) => `${c.label} ${formatQty(c.from)} → ${formatQty(c.to)}`).join(", ")}. 재고·매출이 함께 바뀝니다.
          </div>
        )}
        {shippedRelinks.length > 0 && (
          <div className="sm-warn">
            발송된 품목에 상품을 연결합니다 — {shippedRelinks.map((r) => `${r.label} ${formatQty(r.qty)}`).join(", ")}. 그 수량이 발송일 기준으로 재고에서 빠집니다.
          </div>
        )}

        {/* ───── 푸터 ───── */}
        <div className="b2b-form-foot">
          {mode === "edit" ? (
            <button
              type="button"
              className="b2b-btn-danger"
              onClick={handleDelete}
              disabled={saving}
              style={{ border: "1px solid var(--sm-danger-border)" }}
            >
              삭제
            </button>
          ) : <span />}
          <div className="b2b-form-foot-right">
            <Link href="/b2b/orders" className="b2b-btn-secondary">취소</Link>
            <button
              type="button"
              className="b2b-btn-primary"
              onClick={handleSave}
              disabled={saving || !canSave || reloadFailed || allocErrors.length > 0}
            >
              {saving ? "저장 중..." : mode === "create" ? "등록" : "수정"}
            </button>
          </div>
        </div>
      </div>

      {/* 거래처 선택 시: 최근 발주 복제 프롬프트 */}
      {clonePrompt && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">최근 발주 복제</h2>
              <button className="b2b-modal-close" onClick={() => setClonePrompt(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div style={{ fontSize: 12, padding: "10px 12px", background: "var(--sm-bg)", borderRadius: 8 }}>
                {clonePrompt.summary}
              </div>
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setClonePrompt(null)} disabled={cloning}>
                  취소
                </button>
                <button className="b2b-btn-primary" onClick={applyRecentClone} disabled={cloning}>
                  {cloning ? "불러오는 중..." : "복제하기"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
