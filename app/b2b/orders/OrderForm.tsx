"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Order,
  OrderInput,
  OrderItem,
  OrderItemInput,
  ORDER_STATUSES,
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
import { computeOrderMargin, seasonForDate, suggestBoxes, SEASON_MONTHS } from "@/app/lib/b2b-margin";
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

  // 복수 발송(실제 일정 2건 이상) — 상위발주가 되어 발주 상태는 차수별로 관리(상태칸 숨김)
  const realScheduleCount = useMemo(
    () => data.shipments.filter((s) => s.ship_date || s.items.some((i) => Number(i.qty) > 0)).length,
    [data.shipments]
  );
  const isMultiShipment = realScheduleCount >= 2;

  // 박스 수: 발송 차수가 있으면 차수 박스 수의 합(자동), 없으면 발주에 직접 입력한 값.
  const scheduleBoxSum = useMemo(
    () =>
      data.shipments
        .filter((s) => s.ship_date || s.items.some((i) => Number(i.qty) > 0))
        .reduce((sum, s) => sum + Math.max(1, Math.floor(Number(s.box_count) || 1)), 0),
    [data.shipments]
  );
  const effectiveBoxCount = realScheduleCount > 0 ? scheduleBoxSum : Math.max(1, Number(data.box_count) || 1);

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
    const m = computeOrderMargin(lines, effectiveBoxCount, season);
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
  // 차수 박스 수 변경 — 송장 칸 수가 따라 바뀌므로 tracking 문자열도 길이에 맞춤
  function setScheduleBoxCount(si: number, raw: string) {
    const n = raw === "" ? 1 : Math.max(1, Math.floor(Number(raw) || 1));
    setData((prev) => ({
      ...prev,
      shipments: prev.shipments.map((s, i) => {
        if (i !== si) return s;
        const boxes = splitTracking(s.tracking_no, n); // n 길이에 맞춰 패딩/자름
        return { ...s, box_count: n, tracking_no: joinTracking(boxes) };
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
        body: JSON.stringify(data),
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
    if (!confirm(`발주 ${orderLabel} 을(를) 삭제하시겠어요?\n라인아이템·송장도 함께 삭제됩니다.`)) return;
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
    data.items.every((it) => it.product_name.trim() && Number(it.qty) > 0) &&
    (data.status !== "발송완료" || !!String(data.tracking_no).trim());

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
          <p className="b2b-page-subtitle">
            {mode === "create"
              ? cloneFromId
                ? "복제된 내용입니다. 발주일·일정·상태는 초기화됐어요. 확인 후 등록하세요."
                : "업체와 일정, 라인아이템을 입력하세요. 합계는 자동 계산됩니다."
              : "라인아이템을 수정하면 합계는 저장 후 자동으로 재계산됩니다."}
          </p>
        </div>
        <div className="b2b-page-actions">
          {mode === "edit" && orderId && (
            <button
              type="button"
              className="b2b-btn-secondary"
              onClick={() => router.push(`/b2b/orders/new?from=${orderId}`)}
              title="이 발주의 업체·라인아이템·송장 정보를 복사해 새 발주를 만듭니다"
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
                <span style={{ fontSize: 11, color: "var(--sm-danger)" }}>
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
              {isMultiShipment ? (
                <div style={{ fontSize: 11.5, color: "var(--sm-text-light)", padding: "11px 0" }}>
                  복수발송 — 발송일은 아래 ‘발송 일정’의 차수별로 관리됩니다.
                </div>
              ) : (
                <input
                  type="date"
                  className="b2b-input"
                  value={data.ship_date}
                  onChange={(e) => setField("ship_date", e.target.value)}
                />
              )}
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
            <div className="b2b-field">
              <label className="b2b-field-label">발송 상태</label>
              {isMultiShipment ? (
                <div style={{ padding: "9px 12px", background: "var(--sm-bg)", borderRadius: 8, fontSize: 12, color: "var(--sm-text-mid)", lineHeight: 1.4 }}>
                  복수 발송이라 발송 상태는 <strong>발송 일정(차수)별</strong>로 관리됩니다.
                </div>
              ) : (
                <select
                  className="b2b-select"
                  value={data.status}
                  onChange={(e) => setField("status", e.target.value as OrderInput["status"])}
                >
                  {ORDER_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              )}
            </div>
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
          {/* 헤더 송장번호 — 단일 발송에서만 (복수발송은 차수별 송장) */}
          {!isMultiShipment && (
            <div className="b2b-field-row" style={{ marginTop: 12 }}>
              <div className="b2b-field">
                <label className="b2b-field-label">
                  송장번호
                  {data.status === "발송완료" && <span className="req">*</span>}
                </label>
                <input
                  type="text"
                  className="b2b-input"
                  value={data.tracking_no}
                  onChange={(e) => setField("tracking_no", e.target.value)}
                  placeholder="발송완료 시 필수"
                />
                {data.status === "발송완료" && !String(data.tracking_no).trim() && (
                  <span style={{ fontSize: 11, color: "var(--sm-danger)" }}>발송완료로 저장하려면 송장번호가 필요합니다.</span>
                )}
              </div>
              <div className="b2b-field" aria-hidden />
            </div>
          )}
        </CollapsibleSection>

        {/* ───── 배송 정보 (공통) ───── */}
        <CollapsibleSection title="배송 정보" titleExtra={
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: "var(--sm-text-light)", textTransform: "none", letterSpacing: 0 }}>
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

        {/* ───── 발송 일정 (분할 발송) ───── */}
        <CollapsibleSection title="발송 일정" titleExtra={
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: "var(--sm-text-light)", textTransform: "none", letterSpacing: 0 }}>
            나눠서 보낼 경우 일정을 여러 개 추가 — 각 일정에 날짜·상태·보낼 수량
          </span>
        }>

          {data.shipments.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--sm-text-light)", margin: "4px 0 12px" }}>
              아직 발송 일정이 없습니다. 한 번에 다 보내면 비워두셔도 되고, 나눠 보내면 일정을 추가하세요.
            </p>
          )}

          <div className="sm-col sm-gap-3">
            {data.shipments.map((sch, si) => (
              <div key={si} style={{ borderTop: "1px solid var(--sm-border)", paddingTop: 14 }}>
                <div className="sm-between" style={{ marginBottom: 10 }}>
                  <strong style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>발송 {si + 1}</strong>
                  <button type="button" className="b2b-icon-btn is-danger" onClick={() => removeSchedule(si)} title="발송 일정 삭제">✕</button>
                </div>
                <div className="b2b-field-row">
                  <div className="b2b-field">
                    <label className="b2b-field-label">발송예정일</label>
                    <input
                      type="date"
                      className="b2b-input"
                      value={sch.ship_date}
                      onChange={(e) => setSchedule(si, { ship_date: e.target.value })}
                    />
                  </div>
                  <div className="b2b-field">
                    <label className="b2b-field-label">상태</label>
                    <select
                      className="b2b-select"
                      value={sch.status}
                      onChange={(e) => setSchedule(si, { status: e.target.value as ShipmentScheduleInput["status"] })}
                      style={{ background: SHIPMENT_STATUS_COLORS[sch.status]?.bg, color: SHIPMENT_STATUS_COLORS[sch.status]?.fg, fontWeight: 600 }}
                    >
                      {SHIPMENT_STATUSES.map((s) => (
                        <option key={s} value={s} style={{ background: "var(--sm-white)", color: "var(--sm-black)" }}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div className="b2b-field" style={{ maxWidth: 110 }}>
                    <label className="b2b-field-label">박스 수</label>
                    <input
                      type="number"
                      inputMode="numeric"
                      className="b2b-input"
                      min={1}
                      step={1}
                      value={sch.box_count}
                      onChange={(e) => setScheduleBoxCount(si, e.target.value)}
                      style={{ textAlign: "right" }}
                    />
                  </div>
                </div>

                <label className="sm-row" style={{ gap: 7, fontSize: 13, marginTop: 10, cursor: "pointer", alignItems: "center" }}>
                  <input type="checkbox" checked={sch.stock_out !== false} onChange={(e) => setSchedule(si, { stock_out: e.target.checked })} />
                  재고 즉시 출고 <span className="sm-faint" style={{ fontSize: 11 }}>(발송 잡는 순간 재고 차감 · 오버부킹 방지)</span>
                </label>

                {/* 이 발송에 담을 상품/수량 */}
                <div style={{ marginTop: 12 }}>
                  <label className="b2b-field-label" style={{ display: "block", marginBottom: 6 }}>보낼 수량 (상품별)</label>
                  <div className="sm-col" style={{ gap: 6 }}>
                    {data.items.filter((it) => it.product_name.trim()).map((it) => {
                      const oi = data.items.indexOf(it);
                      return (
                        <div key={oi} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ flex: 1, fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {it.product_name}{it.spec ? ` · ${it.spec}` : ""}
                            <span style={{ color: "var(--sm-text-light)", marginLeft: 6 }}>(주문 {formatQty(it.qty)})</span>
                          </span>
                          <input
                            type="number"
                            inputMode="numeric"
                            className="b2b-input"
                            style={{ width: 90, textAlign: "right" }}
                            min={0}
                            placeholder="0"
                            value={getScheduleQty(si, oi)}
                            onChange={(e) => setScheduleQty(si, oi, e.target.value)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="b2b-field" style={{ marginTop: 12 }}>
                  <label className="b2b-field-label">
                    운송장 번호 (선택){Math.max(1, Number(sch.box_count) || 1) > 1 ? ` · 박스 ${Math.max(1, Number(sch.box_count) || 1)}개` : ""}
                  </label>
                  <div className="sm-col" style={{ gap: 6 }}>
                    {splitTracking(sch.tracking_no, Math.max(1, Number(sch.box_count) || 1)).map((tn, bi) => (
                      <input
                        key={bi}
                        type="text"
                        className="b2b-input"
                        value={tn}
                        placeholder={Math.max(1, Number(sch.box_count) || 1) > 1 ? `박스 ${bi + 1} 송장번호` : "송장번호"}
                        onChange={(e) => setScheduleTracking(si, bi, e.target.value)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {splitWarnings.length > 0 && (
            <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--sm-warning-bg)", borderRadius: 8, fontSize: 12, color: "var(--sm-warning)" }}>
              {splitWarnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <button type="button" className="b2b-btn-secondary" onClick={addSchedule}>+ 발송 일정 추가</button>
          </div>
        </CollapsibleSection>

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
                  return (
                    <tr key={idx}>
                      <td data-label="품목명">
                        <Combobox
                          value={it.product_name}
                          options={products.map((p) => ({ id: p.id, label: p.name, sub: p.spec ?? "" }))}
                          onSelect={(o) => pickProduct(idx, o.id)}
                          onType={(text) => updateItem(idx, { product_name: text, product_id: null })}
                          allowFreeText
                          placeholder="제품 검색 또는 직접 입력"
                          ariaLabel="품목명"
                        />
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
            <div className="b2b-totals-row is-grand">
              합계 <strong className="b2b-money">{formatMoney(totals.total)}원</strong>
            </div>
          </div>
        </section>

        {/* ───── 이익률 (배송 박스 단위) ───── */}
        <CollapsibleSection title="이익률 (배송 박스 기준)">
          <p style={{ margin: "0 0 12px", fontSize: 11.5, color: "var(--sm-text-mid)" }}>
            매출 − 제품원가 − 배송비(박스 × 아이스박스+운반비+보냉비). 과세 상품은 공급가(÷1.1) 기준.
          </p>

          <div className="b2b-field-row" style={{ marginBottom: 12 }}>
            <div className="b2b-field" style={{ maxWidth: 180 }}>
              <label className="b2b-field-label">배송 박스 수</label>
              <input
                type="number"
                inputMode="numeric"
                className="b2b-input"
                value={realScheduleCount > 0 ? effectiveBoxCount : data.box_count}
                min={1}
                step={1}
                readOnly={realScheduleCount > 0}
                onChange={(e) => setField("box_count", e.target.value === "" ? 1 : Number(e.target.value))}
                style={realScheduleCount > 0 ? { background: "var(--sm-bg)", color: "var(--sm-text-mid)" } : undefined}
              />
              <span style={{ fontSize: 10.5, color: "var(--sm-text-light)", marginTop: 4 }}>
                {realScheduleCount > 0
                  ? `발송 차수 박스 수 합 (자동) · 총 부피 ${orderMargin.volume.toLocaleString()}kg`
                  : `총 부피 ${orderMargin.volume.toLocaleString()}kg · 권장 ${suggestBoxes(orderMargin.volume)}박스`}
              </span>
            </div>
            <div className="b2b-field" style={{ maxWidth: 180 }}>
              <label className="b2b-field-label">계절 (보냉비)</label>
              <input
                type="text"
                className="b2b-input"
                value={`${orderMargin.season} (${SEASON_MONTHS[orderMargin.season]})`}
                readOnly
                style={{ background: "var(--sm-bg)", color: "var(--sm-text-mid)" }}
              />
              <span style={{ fontSize: 10.5, color: "var(--sm-text-light)", marginTop: 4 }}>
                발송예정일 기준 자동
              </span>
            </div>
          </div>

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
                  <span style={{ marginLeft: 8, fontSize: 13 }}>
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
        <div className="b2b-modal-backdrop" onClick={() => setClonePrompt(null)}>
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">최근 발주 복제</h2>
              <button className="b2b-modal-close" onClick={() => setClonePrompt(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div style={{ fontSize: 12.5, color: "var(--sm-text-mid)", marginBottom: 10 }}>
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
