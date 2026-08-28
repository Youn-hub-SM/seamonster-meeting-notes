"use client";

import { useEffect, useMemo, useState } from "react";
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
} from "@/app/lib/b2b-orders";
import { Company, Product, TAX_TYPES, TAX_TYPE_LABEL } from "@/app/lib/b2b-types";
import { computeOrderMargin, seasonForDate, SEASON_MONTHS } from "@/app/lib/b2b-margin";
import { Combobox } from "./Combobox";

type Mode = "create" | "edit";

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
  // 할인 입력 — 원(₩) 또는 %(합계 기준). 저장은 항상 원 금액(data 가 아니라 저장 시점에 환산 주입).
  const [discountMode, setDiscountMode] = useState<"won" | "pct">("won");
  const [discountRaw, setDiscountRaw] = useState("");
  const [originalOrder, setOriginalOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // 거래처 선택 시 "최근 발주 복제?" 프롬프트 (신규 등록에서만)
  const [clonePrompt, setClonePrompt] = useState<{ orderId: string; summary: string } | null>(null);
  const [cloning, setCloning] = useState(false);
  const [companyPrices, setCompanyPrices] = useState<Record<string, number>>({}); // 거래처별 상품 단가(product_id→단가)

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
          const orderRes = await fetch(`/api/b2b/orders/${orderId}`, { cache: "no-store" });
          const orderJson = await orderRes.json();
          if (!orderJson.ok) throw new Error(orderJson.error || "발주 조회 실패");
          const o = orderJson.order as Order & { items: OrderItem[]; company: Company; shipments: Shipment[] };
          setOriginalOrder(o);
          if (Number(o.discount_amount) > 0) { setDiscountMode("won"); setDiscountRaw(String(Math.round(Number(o.discount_amount)))); }
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
        } else if (mode === "create" && cloneFromId) {
          // 복제 모드: 원본 발주를 불러와 업체·라인·송장은 복사, 날짜·상태는 초기화
          const t = new Date();
          const todayIso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
          const orderRes = await fetch(`/api/b2b/orders/${cloneFromId}`, { cache: "no-store" });
          const orderJson = await orderRes.json();
          if (!orderJson.ok) throw new Error(orderJson.error || "복제할 발주 조회 실패");
          const o = orderJson.order as Order & { items: OrderItem[]; company: Company; shipments: Shipment[] };
          if (Number(o.discount_amount) > 0) { setDiscountMode("won"); setDiscountRaw(String(Math.round(Number(o.discount_amount)))); }
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

  // 할인 금액(원) — % 입력이면 할인 전 합계 기준으로 환산. 합계를 넘지 않게 잘라낸다.
  const discountAmount = useMemo(() => {
    const raw = Number(discountRaw) || 0;
    if (raw <= 0) return 0;
    const amt = discountMode === "pct" ? Math.round(totals.total * Math.min(raw, 100) / 100) : Math.round(raw);
    return Math.min(amt, totals.total);
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
  }, [data.items, effectiveBoxCount, data.ship_date, data.order_date, products, currentMonth]);

  // 분할 수량 점검: 발송 일정에 배분한 수량 합계가 발주 수량과 다르면 경고 (저장은 막지 않음)
  const splitWarnings = useMemo(() => {
    const out: string[] = [];
    const active = data.shipments.filter((s) => s.status !== "취소");
    if (active.length === 0) return out;
    data.items.forEach((it, idx) => {
      if (!it.product_name.trim()) return;
      const allocated = active.reduce((sum, s) => {
        const f = s.items.find((x) => x.order_item_index === idx);
        return sum + (f ? Number(f.qty) || 0 : 0);
      }, 0);
      const ordered = Number(it.qty) || 0;
      if (allocated > 0 && allocated !== ordered) {
        out.push(`${it.product_name}${it.spec ? ` ${it.spec}` : ""}: 발주 ${formatQty(ordered)}개인데 발송 일정에 ${formatQty(allocated)}개 배분됨`);
      }
    });
    return out;
  }, [data.items, data.shipments]);

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

  function removeItemRow(idx: number) {
    if (data.items.length === 1) {
      // 최소 1개는 유지 — 빈 줄로 초기화
      setData((prev) => ({ ...prev, items: [{ ...EMPTY_ORDER_ITEM }] }));
      return;
    }
    setData((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }));
  }

  // ─────────────────────────────────────────────
  // 저장 / 삭제
  // ─────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const url = mode === "create" ? "/api/b2b/orders" : `/api/b2b/orders/${orderId}`;
      const method = mode === "create" ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, discount_amount: discountAmount }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "저장 실패");

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
    const orderLabel = originalOrder?.order_no || orderId;
    if (!confirm(`발주 ${orderLabel} 을(를) 삭제하시겠어요?\n품목·송장도 함께 삭제됩니다.`)) return;
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
            <p className="b2b-page-subtitle">복제된 내용입니다. 발주일·일정·상태는 초기화됐어요. 확인 후 등록하세요.</p>
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
                <span style={{ fontSize: 12, color: "var(--sm-danger)" }}>
                  등록된 업체가 없습니다 — <Link href="/b2b/companies" style={{ color: "var(--sm-orange)" }}>주소록에서 먼저 등록</Link>
                </span>
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
              <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>
                발주 목록의 ‘+ 발송일’ 창에서 잡습니다{isMultiShipment ? " (복수발송 — 가장 이른 날짜)" : ""}
              </span>
            </div>
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
            업체 선택 시 자동 채움 — 모든 발송 일정에 공통 적용
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
            {/* 할인 — 원 또는 %(합계 기준)로 넣고, 저장은 원 금액으로 확정된다 */}
            <div className="b2b-totals-row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: "0 0 auto" }}>할인</span>
              <span className="sm-row" style={{ gap: 6, marginLeft: "auto", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <input className="b2b-input" type="number" min={0} value={discountRaw}
                  onChange={(e) => setDiscountRaw(e.target.value)}
                  placeholder="0" style={{ width: 110, textAlign: "right", padding: "6px 8px" }}
                  aria-label="할인 값" />
                <select className="b2b-input" value={discountMode}
                  onChange={(e) => setDiscountMode(e.target.value as "won" | "pct")}
                  style={{ width: "auto", padding: "6px 8px" }} aria-label="할인 단위">
                  <option value="won">원</option>
                  <option value="pct">%</option>
                </select>
                <input className="b2b-input" value={data.discount_reason}
                  onChange={(e) => setData((p) => ({ ...p, discount_reason: e.target.value }))}
                  placeholder="사유 (예: 장기거래 감사)" style={{ width: 200, padding: "6px 8px" }}
                  aria-label="할인 사유" />
              </span>
            </div>
            {discountAmount > 0 && (
              <div className="b2b-totals-row" style={{ color: "var(--sm-danger)" }}>
                할인 적용{discountMode === "pct" ? ` (${Number(discountRaw) || 0}%)` : ""}
                <strong className="b2b-money">-{formatMoney(discountAmount)}원</strong>
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
            매출 − 제품원가 − 배송비(박스 × 아이스박스+운반비+보냉비). 과세 상품은 공급가(÷1.1) 기준.
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
                  : `총 부피 ${orderMargin.volume.toLocaleString()}kg · 발주 목록에서 ‘+ 발송일’로 발송 일정과 박스 수를 넣으면 계산됩니다`}
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
              매출{orderMargin.revenue !== totals.subtotal ? " (공급가)" : ""}{" "}
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
              disabled={saving || !canSave}
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
              <div style={{ fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 10 }}>
                이 업체의 <strong>가장 최근 발주</strong>를 그대로 불러올까요? (날짜·상태·송장은 새로 시작)
              </div>
              <div style={{ fontSize: 12, padding: "10px 12px", background: "var(--sm-bg)", borderRadius: 8 }}>
                {clonePrompt.summary}
              </div>
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setClonePrompt(null)} disabled={cloning}>
                  아니요
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
