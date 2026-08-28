"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  OrderListItem,
  OrderLinePreview,
  ORDER_STATUSES,
  PRODUCTION_STATUSES,
  PAYMENT_STATUSES,
  TAX_INVOICE_STATUSES,
  OrderStatus,
  ProductionStatus,
  PaymentStatus,
  TaxInvoiceStatus,
  STATUS_COLORS,
  STATUS_SHORT,
  PRODUCTION_COLORS,
  SHOW_ORDER_PRODUCTION,
  PAYMENT_COLORS,
  TAX_INVOICE_COLORS,
  SHIPMENT_STATUS_COLORS,
  SHIPMENT_STATUSES,
  ShipmentStatus,
  ShipmentDatePreview,
  formatMoney,
  formatQty,
  getUrgency,
  isOrderComplete,
  nextPendingShipDate,
  splitTracking,
  joinTracking,
  todayISO,
  URGENCY_LABEL,
  OrderExportOption,
  ShipmentExportOption,
  ExportLineItem,
} from "@/app/lib/b2b-orders";
import { Company } from "@/app/lib/b2b-types";
import CalendarView from "./CalendarView";
import WeeklyView from "./WeeklyView";
import ProductionView from "./ProductionView";
import { pingActivityFeed } from "../ActivityFeed";
import { matchKoQuery } from "@/app/lib/hangul";

type View = "list" | "calendar" | "weekly" | "production";

export default function OrdersListPage() {
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("list");
  // 엑셀 필터식 체크박스 다중선택 (체크된 상태만 표시). 기본=전체 체크.
  const [statusSel, setStatusSel] = useState<Set<OrderStatus>>(() => new Set(ORDER_STATUSES));
  const [paymentSel, setPaymentSel] = useState<Set<PaymentStatus>>(() => new Set(PAYMENT_STATUSES));
  const [taxSel, setTaxSel] = useState<Set<TaxInvoiceStatus>>(() => new Set(TAX_INVOICE_STATUSES));
  // '오늘 할일' 카드에서 고른 항목 — 그 발주들만 목록에 남긴다(ids 로 직접 좁혀 필터 매핑 오차가 없다)
  const [taskPick, setTaskPick] = useState<{ key: string; label: string; ids: Set<string> } | null>(null);
  const [companyFilter, setCompanyFilter] = useState<string>(""); // ""=전체
  const [productFilter, setProductFilter] = useState<string>(""); // ""=전체
  const [hideComplete, setHideComplete] = useState(false); // 완료(발송·입금·발행 다 끝) 숨기기
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [exportOptions, setExportOptions] = useState<OrderExportOption[] | null>(null);
  // 발송완료 변경 시 송장번호 입력 프롬프트 (발주 or 발송 차수)
  //  boxCount 만큼 송장 입력칸을 띄움 (박스당 1개).
  const [trackingPrompt, setTrackingPrompt] = useState<
    | { kind: "order"; id: string; label: string; boxCount: number; recipientName?: string; recipientPhone?: string }
    | { kind: "shipment"; id: string; orderId: string; label: string; boxCount: number; recipientName?: string; recipientPhone?: string }
    | null
  >(null);
  const [trackingInput, setTrackingInput] = useState<string[]>([""]);
  // 발송일 등록 창 — 차수(발송예정일 + 박스 수)를 여기서만 만든다. 발주 등록 폼에는 발송 일정이 없다.
  const [shipPrompt, setShipPrompt] = useState<{ id: string; label: string } | null>(null);
  //  status·tracking_no·stock_out 은 이 창에서 고치지 않지만 반드시 함께 실어 왕복시킨다 —
  //  저장이 차수를 통째로 지우고 다시 넣는 방식이라(saveOrderShipments), 안 실으면 송장번호가 사라지고
  //  발송완료가 발송대기로 되돌아간다.
  const [shipRows, setShipRows] = useState<
    { ship_date: string; box_count: string; status: ShipmentStatus; tracking_no: string; stock_out: boolean; items: Record<number, string> }[]
  >([]);
  // 창을 열 때 날짜가 있던 차수 수 — 0이 되도록 지우고 저장하면 '전체 삭제'로 확인 후 진행
  const [shipInitialCount, setShipInitialCount] = useState(0);
  const [shipItems, setShipItems] = useState<{ id: string; product_name: string; spec: string | null; qty: number }[]>([]);
  const [shipSaving, setShipSaving] = useState(false);
  const [shipLoading, setShipLoading] = useState(false);
  // 직접 배송(택배 아님) — 체크 시 송장번호 없이 발송완료 가능
  const [directDelivery, setDirectDelivery] = useState(false);
  // 접힌 상위발주(복수발송) — 기본 펼침이라 여기에 담긴 것만 접힘
  // 복수발송 하위 차수 — 기본은 접힘. 사용자가 펼친 발주 id만 여기에 담김.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ── 필터 유지 (로그인 사용자별 localStorage) ──
  //  초기화 버튼을 누르기 전까지 페이지를 떠났다 와도 필터가 유지됨.
  const [filterUser, setFilterUser] = useState<string | null>(null);
  const [filterRestored, setFilterRestored] = useState(false);
  const filterStoreKey = filterUser ? `b2b:orders:filters:${filterUser}` : null;

  useEffect(() => {
    fetch("/api/b2b/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setFilterUser(j.ok && j.name ? j.name : "공용"))
      .catch(() => setFilterUser("공용"));
  }, []);

  // 복원 (사용자 확인 후 1회). setState 가 적용된 다음 렌더부터 저장 effect 가 동작하도록
  // filterRestored 는 state 로 — 복원 전에 기본값이 저장본을 덮어쓰는 걸 방지.
  useEffect(() => {
    if (!filterStoreKey) return;
    try {
      const raw = localStorage.getItem(filterStoreKey);
      if (raw) {
        const s = JSON.parse(raw) as {
          v?: number;
          status?: string[];
          payment?: string[];
          tax?: string[];
          company?: string;
          product?: string;
          hideComplete?: boolean;
          search?: string;
        };
        if (s && s.v === 1) {
          if (Array.isArray(s.status))
            setStatusSel(new Set(s.status.filter((x): x is OrderStatus => (ORDER_STATUSES as readonly string[]).includes(x))));
          if (Array.isArray(s.payment))
            setPaymentSel(new Set(s.payment.filter((x): x is PaymentStatus => (PAYMENT_STATUSES as readonly string[]).includes(x))));
          if (Array.isArray(s.tax))
            setTaxSel(new Set(s.tax.filter((x): x is TaxInvoiceStatus => (TAX_INVOICE_STATUSES as readonly string[]).includes(x))));
          if (typeof s.company === "string") setCompanyFilter(s.company);
          if (typeof s.product === "string") setProductFilter(s.product);
          if (typeof s.hideComplete === "boolean") setHideComplete(s.hideComplete);
        }
      }
    } catch {
      // 저장본이 깨졌으면 무시하고 기본값 사용
    }
    setFilterRestored(true);
  }, [filterStoreKey]);

  // 저장 — 필터가 바뀔 때마다 (복원 완료 후에만)
  useEffect(() => {
    if (!filterStoreKey || !filterRestored) return;
    try {
      localStorage.setItem(
        filterStoreKey,
        JSON.stringify({
          v: 1,
          status: Array.from(statusSel),
          payment: Array.from(paymentSel),
          tax: Array.from(taxSel),
          company: companyFilter,
          product: productFilter,
          hideComplete,
          // search 는 저장하지 않는다 — 다음날 지난 검색어로 좁혀진 목록이 떠 새 발주가 안 보이는 사고 방지(2026-08-28)
        })
      );
    } catch {
      // 저장 실패(시크릿 모드 등)는 무시 — 기능엔 영향 없음
    }
  }, [filterStoreKey, filterRestored, statusSel, paymentSel, taxSel, companyFilter, productFilter, hideComplete, search]);

  function resetFilters() {
    setStatusSel(new Set(ORDER_STATUSES));
    setCompanyFilter("");
    setTaxSel(new Set(TAX_INVOICE_STATUSES));
    setPaymentSel(new Set(PAYMENT_STATUSES));
    setProductFilter("");
    setHideComplete(false);
    setSearch("");
    if (filterStoreKey) {
      try { localStorage.removeItem(filterStoreKey); } catch {}
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const today = useMemo(() => todayISO(), []);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const [ordersRes, compRes] = await Promise.all([
        fetch("/api/b2b/orders", { cache: "no-store" }),
        fetch("/api/b2b/companies", { cache: "no-store" }),
      ]);
      const ordersJson = await ordersRes.json();
      const compJson = await compRes.json();
      if (!ordersJson.ok) throw new Error(ordersJson.error || "발주 조회 실패");
      if (!compJson.ok) throw new Error(compJson.error || "업체 조회 실패");
      setOrders(ordersJson.orders || []);
      setCompanies(compJson.companies || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 중 오류");
    }
    setLoading(false);
  }

  useEffect(() => {
    reload();
  }, []);

  // 전체 발주의 품목명 목록 (제품 필터 드롭다운용)
  const productNames = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) for (const it of o.items || []) if (it.product_name) set.add(it.product_name);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
  }, [orders]);

  // 체크박스 필터가 전체 선택 상태인지 (전체면 그 필터는 적용 안 한 것과 동일)
  const statusAll = statusSel.size === ORDER_STATUSES.length;
  const paymentAll = paymentSel.size === PAYMENT_STATUSES.length;
  const taxAll = taxSel.size === TAX_INVOICE_STATUSES.length;

  // 오늘 할일 — 아침 Flow 알림(b2b-digest)이 쓰는 것과 같은 기준 4가지.
  //  화면에 이미 발주 전체가 있으므로 서버를 다시 부르지 않고 여기서 센다.
  const todayTasks = useMemo(() => {
    const live = orders.filter((o) => o.status !== "취소");
    const dated = (o: OrderListItem) => (o.shipments ?? []).filter((sh) => sh.ship_date);
    // 오늘 나가는 차수 — 이미 보낸 것도 오늘 발송한 건이므로 세고, 완료 여부는 아래 hint 로 알린다.
    //  (완료를 빼면 오후에 다 보낸 날 '없음' 으로 떠서 오늘 발송이 없었던 것처럼 보인다)
    const todayShips = (o: OrderListItem) => dated(o).filter((sh) => sh.ship_date === today && sh.status !== "취소");
    const shipToday = live.filter((o) => todayShips(o).length > 0);
    const shipDone = shipToday.filter((o) => todayShips(o).every((sh) => sh.status === "발송완료"));
    const shipLeft = shipToday.length - shipDone.length;
    // 발송일이 지났는데 아직 발송완료 처리가 안 된 차수 — 완료 처리든 일정 변경이든 손이 필요하다.
    //  평소엔 0건이어야 정상이라 건수가 있을 때만 카드를 노출한다(아래 return 의 조건부 삽입).
    const overdueShip = live.filter((o) =>
      dated(o).some((sh) => sh.ship_date && sh.ship_date < today && sh.status !== "취소" && sh.status !== "발송완료")
    );
    const unscheduled = live.filter((o) => o.status === "발송대기" && dated(o).length === 0);
    const needInvoice = live.filter((o) => o.status === "발송완료" && o.tax_invoice_status === "미발행");
    const needPay = live.filter((o) => o.status === "발송완료" && (o.payment_status === "입금전" || o.payment_status === "일부입금"));
    const unpaidTotal = needPay.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    return [
      ...(overdueShip.length ? [{
        key: "overdue", label: "발송일 지남", rows: overdueShip,
        hint: "발송완료 처리 또는 일정 변경", tone: "var(--sm-danger)",
      }] : []),
      {
        key: "ship", label: "오늘 발송", rows: shipToday,
        hint: shipLeft === 0 ? "모두 발송완료" : shipDone.length > 0 ? `${shipDone.length}건 완료 · ${shipLeft}건 남음` : `${shipLeft}건 남음`,
        tone: shipLeft === 0 ? "var(--sm-success)" : "var(--sm-orange)",
      },
      { key: "unscheduled", label: "발송일정 미등록", rows: unscheduled, hint: "일정 잡아야 함", tone: "var(--sm-warning)" },
      { key: "invoice", label: "계산서 미발행", rows: needInvoice, hint: "", tone: "var(--sm-info)" },
      { key: "pay", label: "입금 대기", rows: needPay, hint: unpaidTotal > 0 ? `${formatMoney(unpaidTotal)}원` : "", tone: "var(--sm-danger)" },
    ];
  }, [orders, today]);

  const filtered = useMemo(() => {
    let arr = orders;
    if (taskPick) arr = arr.filter((o) => taskPick.ids.has(o.id));
    if (!statusAll) arr = arr.filter((o) => statusSel.has(o.status));
    if (!paymentAll) arr = arr.filter((o) => paymentSel.has(o.payment_status));
    if (!taxAll) arr = arr.filter((o) => taxSel.has(o.tax_invoice_status));
    if (companyFilter) arr = arr.filter((o) => o.company_id === companyFilter);
    if (productFilter) arr = arr.filter((o) => (o.items || []).some((it) => it.product_name === productFilter));
    if (hideComplete) arr = arr.filter((o) => !isOrderComplete(o));
    const q = search.trim();
    if (q) {
      // 초성·영문자판 입력까지 받는 공용 매처 — 한/영 키를 안 눌러도 찾힌다
      arr = arr.filter((o) =>
        matchKoQuery(
          [o.order_no, o.company_name, o.notes, ...(o.items || []).map((it) => it.product_name)]
            .filter(Boolean).join(" "),
          q
        )
      );
    }
    return arr;
  }, [taskPick, orders, statusSel, paymentSel, taxSel, statusAll, paymentAll, taxAll, companyFilter, productFilter, hideComplete, search]);

  // 지연/임박 카운트 (배너용)
  const urgencyCount = useMemo(() => {
    let overdue = 0,
      urgent = 0;
    for (const o of orders) {
      const u = getUrgency({ ...o, ship_date: nextPendingShipDate(o) }, today);
      if (u === "overdue") overdue++;
      else if (u === "urgent") urgent++;
    }
    return { overdue, urgent };
  }, [orders, today]);

  async function handleStatusChange(id: string, newStatus: OrderStatus) {
    const target = orders.find((o) => o.id === id);
    if (!target || target.status === newStatus) return;
    // 발송완료로 바꾸는데 송장번호가 없으면 입력 프롬프트 (박스 수만큼 칸)
    if (newStatus === "발송완료" && !String(target.tracking_no ?? "").trim()) {
      const boxCount = Math.max(1, Number(target.box_count) || 1);
      const rcpt = (target.shipments ?? [])[0];   // 발송정보는 차수 공통 → 첫 차수의 수령인 사용
      setTrackingInput(splitTracking(target.tracking_no, boxCount));
      setDirectDelivery(false);
      setTrackingPrompt({ kind: "order", id, label: target.order_no, boxCount, recipientName: rcpt?.recipient_name, recipientPhone: rcpt?.recipient_phone });
      return;
    }
    await patchStatus(id, newStatus);
  }

  async function patchProduction(id: string, newProd: ProductionStatus) {
    const target = orders.find((o) => o.id === id);
    if (!target || target.production_status === newProd) return;
    const snapshot = orders;
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, production_status: newProd } : o)));
    try {
      const res = await fetch(`/api/b2b/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ production_status: newProd }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "생산상태 변경 실패");
      } else {
        pingActivityFeed();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "생산상태 변경 오류");
    }
  }

  // 발송일 등록 창 열기 — 기존 차수가 있으면 불러와 이어서 편집(복수 발송 세팅).
  async function openShipPrompt(id: string, label: string) {
    setShipPrompt({ id, label });
    setShipRows([]); setShipItems([]); setShipInitialCount(0);
    setShipLoading(true);
    try {
      const j = await (await fetch(`/api/b2b/orders/${id}/shipments`, { cache: "no-store" })).json();
      const items = (j?.ok ? j.items : []) as typeof shipItems;
      setShipItems(items || []);
      type Sch = {
        ship_date: string; box_count: number; status?: ShipmentStatus; tracking_no?: string; stock_out?: boolean;
        items: { order_item_index: number; qty: number }[];
      };
      const rows = ((j?.ok ? j.schedules : []) as Sch[] | undefined)?.map((s) => ({
        ship_date: s.ship_date || "",
        box_count: String(Math.max(1, Number(s.box_count) || 1)),
        status: (s.status || "발송대기") as ShipmentStatus,
        tracking_no: s.tracking_no || "",
        stock_out: s.stock_out !== false,
        items: Object.fromEntries((s.items || []).map((x) => [x.order_item_index, String(x.qty)])),
      }));
      // 새로 만드는 첫 차수는 발주 전량을 미리 담아 둔다(그대로 저장하면 단일 발송).
      const blank = {
        ship_date: "", box_count: "1", status: "발송대기" as ShipmentStatus, tracking_no: "", stock_out: true,
        items: Object.fromEntries((items || []).map((it, i) => [i, String(it.qty)])),
      };
      setShipRows(rows?.length ? rows : [blank]);
      setShipInitialCount(((rows as { ship_date?: string }[] | undefined) || []).filter((r) => r.ship_date).length);
    } catch {
      setShipRows([{ ship_date: "", box_count: "1", status: "발송대기", tracking_no: "", stock_out: true, items: {} }]);
    }
    setShipLoading(false);
  }

  // 차수별 배분 합계 — 발주 수량과 다르면 경고(저장은 막지 않음)
  const shipAllocWarn = useMemo(() => {
    if (!shipPrompt || !shipItems.length) return [] as string[];
    const out: string[] = [];
    shipItems.forEach((it, i) => {
      const sum = shipRows.reduce((a, r) => a + (Number(r.items[i]) || 0), 0);
      if (sum !== it.qty) out.push(`${it.product_name}${it.spec ? ` ${it.spec}` : ""}: 발주 ${it.qty} / 배분 ${sum}`);
    });
    return out;
  }, [shipPrompt, shipItems, shipRows]);

  // 발송 일정 저장 — 차수 통째 교체. 서버가 도매 재고 차감·헤더 발송일/상태/박스 수까지 맞춘다.
  async function saveShipments() {
    if (!shipPrompt) return;
    const schedules = shipRows
      .filter((r) => r.ship_date)
      .map((r) => ({
        ship_date: r.ship_date,
        status: r.status,
        tracking_no: r.tracking_no,
        box_count: Math.max(1, Math.floor(Number(r.box_count) || 1)),
        stock_out: r.stock_out,
        items: Object.entries(r.items)
          .map(([k, v]) => ({ order_item_index: Number(k), qty: Number(v) || 0 }))
          .filter((x) => x.qty > 0),
      }));
    if (!schedules.length) {
      // 있던 일정을 다 지운 경우 = 전체 삭제 의도 — 확인 후 빈 목록으로 저장한다(서버가 삭제 처리).
      if (shipInitialCount === 0) { setError("발송예정일을 1개 이상 넣으세요."); return; }
      if (!window.confirm("등록된 발송 일정을 모두 삭제할까요?\n선점된 재고가 원복되고 '발송일정 미등록'으로 돌아갑니다.")) return;
    }
    setShipSaving(true);
    try {
      const res = await fetch(`/api/b2b/orders/${shipPrompt.id}/shipments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedules }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) setError(data.error || "발송 일정 저장 실패");
      else { setShipPrompt(null); pingActivityFeed(); await reload(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : "발송 일정 저장 오류");
    }
    setShipSaving(false);
  }

  // (구) 발송일 인라인 등록 — 캘린더·주간뷰에서 날짜만 바꿀 때 계속 쓴다.
  async function patchShipDate(id: string, date: string) {
    if (!date) return;
    const snapshot = orders;
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, ship_date: date } : o)));
    try {
      const res = await fetch(`/api/b2b/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ship_date: date }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "발송일 등록 실패");
      } else {
        pingActivityFeed();
        await reload();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "발송일 등록 오류");
    }
  }

  async function patchStatus(id: string, newStatus: OrderStatus, trackingNo?: string) {
    const snapshot = orders;
    setOrders((prev) =>
      prev.map((o) => (o.id === id ? { ...o, status: newStatus, ...(trackingNo ? { tracking_no: trackingNo } : {}) } : o))
    );
    try {
      const res = await fetch(`/api/b2b/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, ...(trackingNo ? { tracking_no: trackingNo } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "상태 변경 실패");
      } else {
        pingActivityFeed();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "상태 변경 오류");
    }
  }

  // 발송완료 처리 가능 여부: 직접 배송이거나, 박스 수만큼 송장이 다 채워졌을 때
  const trackingComplete =
    directDelivery || (trackingInput.length > 0 && trackingInput.every((t) => t.trim() !== ""));

  async function confirmTracking() {
    if (!trackingPrompt || !trackingComplete) return;
    // 직접 배송이면 송장 자리에 '직접배송' 마커 저장
    const tracking = directDelivery ? "직접배송" : joinTracking(trackingInput);
    const p = trackingPrompt;
    setTrackingPrompt(null);
    setDirectDelivery(false);
    if (p.kind === "order") await patchStatus(p.id, "발송완료", tracking);
    else await patchShipment(p.orderId, p.id, "발송완료", tracking);
  }

  // 하위 차수(발송 일정) 상태 변경 — 발송완료면 송장번호 필요 (박스 수만큼 칸)
  function handleShipmentStatus(o: OrderListItem, ship: ShipmentDatePreview, newStatus: ShipmentStatus) {
    if (ship.status === newStatus) return;
    if (newStatus === "발송완료" && !String(ship.tracking_no ?? "").trim()) {
      const boxCount = Math.max(1, Number(ship.box_count) || 1);
      setTrackingInput(splitTracking(ship.tracking_no, boxCount));
      setDirectDelivery(false);
      setTrackingPrompt({ kind: "shipment", id: ship.id, orderId: o.id, label: `${o.order_no} · ${ship.seq}차 발송`, boxCount, recipientName: ship.recipient_name, recipientPhone: ship.recipient_phone });
      return;
    }
    void patchShipment(o.id, ship.id, newStatus);
  }

  async function patchShipment(orderId: string, shipmentId: string, newStatus: ShipmentStatus, trackingNo?: string) {
    const snapshot = orders;
    setOrders((prev) =>
      prev.map((o) =>
        o.id !== orderId
          ? o
          : {
              ...o,
              shipments: (o.shipments ?? []).map((s) =>
                s.id !== shipmentId ? s : { ...s, status: newStatus, ...(trackingNo ? { tracking_no: trackingNo } : {}) }
              ),
            }
      )
    );
    try {
      const res = await fetch(`/api/b2b/shipments/${shipmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, ...(trackingNo ? { tracking_no: trackingNo } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "발송 상태 변경 실패");
      } else {
        pingActivityFeed();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "발송 상태 변경 오류");
    }
  }

  function toggleSelectOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const filteredIds = new Set(filtered.map((o) => o.id));
      const allSelected = filtered.length > 0 && filtered.every((o) => prev.has(o.id));
      if (allSelected) {
        // 현재 보이는 것 전체 해제
        const next = new Set(prev);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      }
      // 현재 보이는 것 전체 추가
      const next = new Set(prev);
      filteredIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function handleBulkStatus(newStatus: OrderStatus) {
    if (selected.size === 0) return;
    // 발송완료는 발주마다 송장번호가 달라 일괄 변경 불가 — 개별로 처리
    if (newStatus === "발송완료") {
      setError("발송완료는 송장번호가 발주마다 달라 일괄 변경할 수 없습니다. 발주별로 변경해주세요.");
      return;
    }
    const ids = Array.from(selected);
    if (!confirm(`선택한 ${ids.length}건의 발주 상태를 "${newStatus}" 로 변경할까요?`)) return;
    setBulkSaving(true);
    setError("");
    const snapshot = orders;
    // Optimistic
    setOrders((prev) => prev.map((o) => (selected.has(o.id) ? { ...o, status: newStatus } : o)));
    try {
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`/api/b2b/orders/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: newStatus }),
          }).then((r) => r.ok)
        )
      );
      const failed = results.filter((ok) => !ok).length;
      if (failed > 0) {
        setOrders(snapshot);
        setError(`${failed}건 변경 실패 — 다시 시도해주세요.`);
      } else {
        setSelected(new Set());
        pingActivityFeed();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "일괄 변경 오류");
    }
    setBulkSaving(false);
  }

  // 선택한 발주 중 뽑을 발송이 없는 것 — 양식은 발송 차수 단위로 뽑히므로 이런 발주는 뽑을 수 없다.
  //  차수 '개수'로 보면 안 된다: 발주 등록 시 배송정보만으로 날짜 없는 행이 하나 생기므로(b2b-shipments 의 fallback),
  //  일정을 안 잡아도 차수는 1건이다. 실제 기준은 '발송예정일이 있는 취소 아닌 차수'다.
  //  목록 조회가 발주의 모든 차수를 함께 실어오므로(api/b2b/orders route) 서버에 다시 묻지 않고 판정한다.
  const noScheduleSelected = useMemo(() => {
    const names: string[] = [];
    for (const o of orders) {
      if (!selected.has(o.id)) continue;
      const pickable = (o.shipments ?? []).some((s) => s.ship_date && s.status !== "취소");
      if (!pickable) names.push(o.company_name || o.order_no);
    }
    return names;
  }, [orders, selected]);

  // 실제 xlsx 다운로드 (발송 단위 shipment_ids + 과거 발주 order_ids)
  async function downloadShipping(payload: { shipment_ids?: string[]; order_ids?: string[]; boxes?: Record<string, number> }) {
    setExporting(true);
    setError("");
    try {
      // 양식에 적은 박스 수를 먼저 확정 저장 — 이 엑셀이 송장 출력 직전 단계라, 여기서 정한 수가
      //  송장 행 수·발송완료 시 송장 입력칸 수·이익률 배송비의 기준이 된다.
      //  저장이 실패하면 엑셀의 송장 행 수가 틀리게 나오므로, 다운로드까지 가지 않고 멈춘다.
      const boxes = payload.boxes || {};
      const changed = Object.entries(boxes);
      if (changed.length) {
        const saved = await Promise.all(changed.map(([id, n]) =>
          fetch(`/api/b2b/shipments/${id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ box_count: n }),
          }).then((r) => r.ok).catch(() => false)
        ));
        if (saved.some((ok) => !ok)) throw new Error("박스 수 저장에 실패했습니다. 잠시 후 다시 시도해주세요.");
      }
      const res = await fetch("/api/b2b/orders/export-shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        try {
          const j = JSON.parse(text);
          throw new Error(j.error || "다운로드 실패");
        } catch {
          throw new Error("다운로드 실패 (HTTP " + res.status + ")");
        }
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^";]+)"?/);
      a.download = m ? m[1] : "shipping-request.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportOptions(null);
      if (Object.keys(payload.boxes || {}).length) await reload(); // 확정 박스 수 반영
    } catch (err) {
      setError(err instanceof Error ? err.message : "다운로드 중 오류");
    }
    setExporting(false);
  }

  // 항상 선택 모달을 연다 — 실제 포장 박스 수를 여기서 확정 입력받아야 하기 때문(차수가 1개여도 마찬가지).
  async function handleExportShipping() {
    if (selected.size === 0) return;
    if (noScheduleSelected.length > 0) {
      setError(`뽑을 발송이 없는 발주가 있습니다: ${noScheduleSelected.join(", ")} — 목록의 발송일 칸에서 ‘+ 발송일’로 먼저 등록하세요.`);
      return;
    }
    setExporting(true);
    setError("");
    try {
      const res = await fetch("/api/b2b/orders/export-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_ids: Array.from(selected) }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "발송 정보 조회 실패");
      const options: OrderExportOption[] = json.options || [];

      // 목록 데이터가 오래됐을 수 있으니 서버 응답으로 한 번 더 막는다.
      const missing = options.filter((o) => !o.shipments.some((s) => s.ship_date && s.status !== "취소"));
      if (missing.length > 0) {
        setExporting(false);
        setError(
          `뽑을 발송이 없는 발주가 있습니다(발송일정 미등록 또는 전 차수 취소): ${missing.map((o) => o.company_name || o.order_no).join(", ")}` +
            " — 목록의 발송일 칸에서 ‘+ 발송일’로 먼저 등록하세요."
        );
        return;
      }

      setExporting(false);
      setExportOptions(options); // 박스 수 확정 + 차수 선택 모달
    } catch (err) {
      setError(err instanceof Error ? err.message : "다운로드 중 오류");
      setExporting(false);
    }
  }

  async function handleTaxInvoiceChange(id: string, newStatus: TaxInvoiceStatus) {
    const target = orders.find((o) => o.id === id);
    if (!target || target.tax_invoice_status === newStatus) return;
    const snapshot = orders;
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, tax_invoice_status: newStatus } : o)));
    try {
      const res = await fetch(`/api/b2b/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tax_invoice_status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "세금계산서 상태 변경 실패");
      } else {
        pingActivityFeed();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "세금계산서 상태 변경 오류");
    }
  }

  async function handlePaymentChange(id: string, newStatus: PaymentStatus) {
    const target = orders.find((o) => o.id === id);
    if (!target || target.payment_status === newStatus) return;
    const snapshot = orders;
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, payment_status: newStatus } : o)));
    try {
      const res = await fetch(`/api/b2b/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOrders(snapshot);
        setError(data.error || "입금 상태 변경 실패");
      } else {
        pingActivityFeed();
      }
    } catch (err) {
      setOrders(snapshot);
      setError(err instanceof Error ? err.message : "입금 상태 변경 오류");
    }
  }

  return (
    <>
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">발주 관리</h1>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={reload} disabled={loading}>
            {loading ? "불러오는 중..." : "새로고침"}
          </button>
          {/* 발주와 무관한 1회성 명세표 — 발주별 명세표는 각 줄의 [명세표] */}
          <Link href="/b2b/orders/statement" className="b2b-btn-secondary">
            거래명세표 작성
          </Link>
          <Link href="/b2b/orders/new" className="b2b-btn-primary">
            + 새 발주
          </Link>
        </div>
      </header>

      {error && <div className="b2b-error">{error}</div>}

      {(urgencyCount.overdue > 0 || urgencyCount.urgent > 0) && (
        <div className="b2b-urgency-banner">
          {urgencyCount.overdue > 0 && (
            <span className="b2b-urgency-pill is-overdue">
              지연 {urgencyCount.overdue}건
            </span>
          )}
          {urgencyCount.urgent > 0 && (
            <span className="b2b-urgency-pill is-urgent">
              임박 {urgencyCount.urgent}건
            </span>
          )}
        </div>
      )}

      {/* 오늘 할일 — B2B 대시보드를 없애면서 거기서 보던 것을 여기로 올렸다.
          카드를 누르면 그 발주들만 목록에 남는다(다시 누르면 해제). */}
      <div className="b2b-dash-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
        {todayTasks.map((t) => {
          const on = taskPick?.key === t.key;
          const none = t.rows.length === 0;
          return (
            <button
              key={t.key}
              type="button"
              className="b2b-stat-card"
              disabled={none}
              onClick={() => {
                setView("list");
                setTaskPick(on ? null : { key: t.key, label: t.label, ids: new Set(t.rows.map((o) => o.id)) });
              }}
              style={{
                padding: 16, textAlign: "left", font: "inherit",
                cursor: none ? "default" : "pointer",
                borderColor: on ? t.tone : undefined,
                boxShadow: on ? `inset 0 0 0 1px ${t.tone}` : undefined,
                opacity: none ? 0.6 : 1,
              }}
            >
              <div className="b2b-stat-card-label" style={{ color: none ? undefined : t.tone }}>{t.label}</div>
              <div className="b2b-stat-card-value" style={{ marginTop: 6, fontSize: none ? 17 : 27, color: none ? "var(--sm-text-light)" : t.tone }}>
                {none ? "없음" : `${t.rows.length}건`}
              </div>
              {!none && t.hint && <div className="b2b-stat-card-hint">{t.hint}</div>}
            </button>
          );
        })}
      </div>

      {taskPick && (
        <div className="sm-row" style={{ gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <span className="b2b-status-pill" style={{ background: "var(--sm-orange-light)", color: "var(--sm-orange)" }}>
            {taskPick.label} {taskPick.ids.size}건만 보는 중
          </span>
          <button type="button" className="b2b-link-btn" style={{ fontSize: 12 }} onClick={() => setTaskPick(null)}>전체 보기</button>
        </div>
      )}

      <div className="sm-tabbar">
        <button
          type="button"
          className={`sm-tab ${view === "list" ? "is-active" : ""}`}
          onClick={() => setView("list")}
        >
          목록
        </button>
        <button
          type="button"
          className={`sm-tab ${view === "calendar" ? "is-active" : ""}`}
          onClick={() => setView("calendar")}
        >
          캘린더
        </button>
        <button
          type="button"
          className={`sm-tab ${view === "weekly" ? "is-active" : ""}`}
          onClick={() => setView("weekly")}
        >
          주간 (발송일)
        </button>
        {/* 생산 집계 — 생산관리로 이관되어 발주에선 숨김(SHOW_ORDER_PRODUCTION). 탭·화면·API 는 롤백 대비 보존 */}
        {SHOW_ORDER_PRODUCTION && (
          <button
            type="button"
            className={`sm-tab ${view === "production" ? "is-active" : ""}`}
            onClick={() => setView("production")}
          >
            생산 집계
          </button>
        )}
      </div>

      {view === "production" && SHOW_ORDER_PRODUCTION ? (
        <ProductionView />
      ) : (
      <div className="b2b-card">
        <div className="b2b-card-head" style={{ gap: 12, flexWrap: "wrap", justifyContent: "flex-start" }}>
          <input
            type="text"
            className="b2b-search"
            placeholder="발주번호·업체·메모 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 280 }}
          />
          <CheckFilter label="상태" options={ORDER_STATUSES} selected={statusSel} onChange={setStatusSel} />
          <select
            className="b2b-select"
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            style={{ width: "auto", maxWidth: 220 }}
          >
            <option value="">전체 업체</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <CheckFilter label="입금" options={PAYMENT_STATUSES} selected={paymentSel} onChange={setPaymentSel} />
          <CheckFilter label="세금계산서" options={TAX_INVOICE_STATUSES} selected={taxSel} onChange={setTaxSel} />
          <select
            className="b2b-select"
            value={productFilter}
            onChange={(e) => setProductFilter(e.target.value)}
            style={{ width: "auto", maxWidth: 200 }}
            title="품목 포함 필터"
          >
            <option value="">전체 품목</option>
            {productNames.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <label
            className={`b2b-hidecomplete ${hideComplete ? "is-on" : ""}`}
            title="발송·입금·세금계산서가 모두 끝난 발주 숨기기"
          >
            <input
              type="checkbox"
              checked={hideComplete}
              onChange={(e) => setHideComplete(e.target.checked)}
            />
            완료 숨기기
          </label>
          {(!statusAll || companyFilter || !taxAll || !paymentAll || productFilter || hideComplete || search) && (
            <button
              type="button"
              className="b2b-btn-secondary"
              style={{ padding: "6px 12px", fontSize: 12 }}
              onClick={resetFilters}
            >
              필터 초기화
            </button>
          )}
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--sm-text-light)" }}>
            {filtered.length}건
          </span>
        </div>

        {loading ? (
          <div className="b2b-loading">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="b2b-empty">
            {orders.length === 0 ? (
              <>
                등록된 발주가 없습니다.
                <br />
                <Link href="/b2b/orders/new" style={{ color: "var(--sm-orange)", fontWeight: 600 }}>
                  + 첫 발주 등록하기
                </Link>
              </>
            ) : (
              "검색 결과가 없습니다."
            )}
          </div>
        ) : view === "calendar" ? (
          <CalendarView orders={filtered} todayIso={today} />
        ) : view === "weekly" ? (
          <WeeklyView orders={filtered} todayIso={today} />
        ) : (
          <>
            {selected.size > 0 && (
              // 안내문이 한 줄에 눌리지 않도록 이 바만 줄바꿈 허용 (.b2b-selection-bar 는 공용이라 CSS 를 건드리지 않는다)
              <div className="b2b-selection-bar" style={{ flexWrap: "wrap", rowGap: 8 }}>
                <span>
                  <strong>{selected.size}건</strong> 선택됨
                </span>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <select
                    className="b2b-select"
                    value=""
                    disabled={bulkSaving}
                    onChange={(e) => {
                      if (e.target.value) handleBulkStatus(e.target.value as OrderStatus);
                      e.target.value = "";
                    }}
                    style={{ width: "auto" }}
                    title="선택한 발주의 상태를 한 번에 변경"
                  >
                    <option value="">{bulkSaving ? "변경 중..." : "상태 일괄 변경 →"}</option>
                    {ORDER_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="b2b-btn-secondary"
                    onClick={() => setSelected(new Set())}
                  >
                    선택 해제
                  </button>
                  <button
                    type="button"
                    className="b2b-btn-primary"
                    onClick={handleExportShipping}
                    disabled={exporting || noScheduleSelected.length > 0}
                    title={
                      noScheduleSelected.length > 0
                        ? "뽑을 발송이 없는 발주가 선택되어 있습니다 — 목록에서 ‘+ 발송일’로 먼저 등록하세요"
                        : undefined
                    }
                  >
                    {exporting ? "생성 중..." : "발송요청 양식 다운로드"}
                  </button>
                </div>
                {noScheduleSelected.length > 0 && (
                  // 양식은 발송 차수 단위로 뽑히고 박스 수도 차수에 저장된다 — 일정 없이는 뽑을 것이 없다.
                  <div style={{ flexBasis: "100%", fontSize: 12, color: "var(--sm-text-mid)" }}>
                    뽑을 발송이 없어 양식을 만들 수 없는 발주: <strong>{noScheduleSelected.join(", ")}</strong>
                    {" "}— 목록의 발송일 칸에서 ‘+ 발송일’로 먼저 등록하세요.
                  </div>
                )}
              </div>
            )}
            <div className="b2b-table-wrap b2b-orders-table-wrap">
            <table className="b2b-table">
              <thead>
                <tr>
                  <th style={{ width: 44, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      className="b2b-checkbox"
                      checked={filtered.length > 0 && filtered.every((o) => selected.has(o.id))}
                      onChange={toggleSelectAll}
                      title="이 페이지의 발주 전체 선택"
                    />
                  </th>
                  <th style={{ width: 1 }}></th>
                  <th style={{ minWidth: 88 }}>업체</th>
                  <th style={{ minWidth: 150 }}>품목</th>
                  <th className="b2b-col-date">발주일</th>
                  {SHOW_ORDER_PRODUCTION && <th className="b2b-col-date">생산일</th>}
                  <th className="b2b-col-date">발송일</th>
                  <th className="num">합계</th>
                  {SHOW_ORDER_PRODUCTION && <th className="b2b-col-status">생산</th>}
                  <th className="b2b-col-status">발송</th>
                  <th className="b2b-col-status">입금</th>
                  <th className="b2b-col-status">세금계산서</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const urgency = getUrgency({ ...o, ship_date: nextPendingShipDate(o) }, today);
                  const parent = isParentOrder(o);
                  const prog = parent ? shipProgress(o) : null;
                  const isCollapsed = !expanded.has(o.id); // 기본 접힘
                  const complete = isOrderComplete(o);
                  return (
                    <Fragment key={o.id}>
                    <tr className={`${urgency !== "normal" ? `is-${urgency}` : ""} ${parent ? "is-parent" : ""}`}>
                      <td
                        onClick={(e) => {
                          e.stopPropagation();
                          // 셀 아무 데나 눌러도 토글 (체크박스 자체 클릭은 기본 동작)
                          if ((e.target as HTMLElement).tagName !== "INPUT") toggleSelectOne(o.id);
                        }}
                        style={{ padding: "8px", cursor: "pointer" }}
                      >
                        <input
                          type="checkbox"
                          className="b2b-checkbox"
                          checked={selected.has(o.id)}
                          onChange={() => toggleSelectOne(o.id)}
                        />
                      </td>
                      <td className="cell-flag" style={{ padding: "8px 4px" }}>
                        {complete ? (
                          <span className="b2b-urgency-pill is-complete">완료</span>
                        ) : urgency !== "normal" ? (
                          <span className={`b2b-urgency-pill is-${urgency}`}>
                            {URGENCY_LABEL[urgency]}
                          </span>
                        ) : null}
                      </td>
                      <RowCell href={`/b2b/orders/${o.id}`} nowrap>
                        <span>{o.company_name}</span>
                        <span style={{ display: "block", fontSize: 12, color: "var(--sm-text-light)", marginTop: 2 }}>
                          {o.order_no}{parent ? " · 복수발송" : ""}
                        </span>
                      </RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`}>
                        <ItemsPreview items={o.items} />
                      </RowCell>
                      <RowCell href={`/b2b/orders/${o.id}`} className="b2b-col-date" nowrap>{o.order_date}</RowCell>
                      {SHOW_ORDER_PRODUCTION && <RowCell href={`/b2b/orders/${o.id}`} className="b2b-col-date" nowrap>{o.production_date || "-"}</RowCell>}
                      {parent ? (
                        <td className="b2b-col-date" onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                          {/* 복수발송은 날짜가 차수마다 달라 한 칸에 못 적는다 — 차수 창을 여는 입구만 둔다 */}
                          <button type="button" className="b2b-link-btn" style={{ fontSize: 15 }}
                            title="발송 차수 수정"
                            onClick={() => openShipPrompt(o.id, o.company_name || o.order_no)}>
                            {(o.shipments ?? []).length}차 · 수정
                          </button>
                        </td>
                      ) : o.ship_date ? (
                        <td className="b2b-col-date" onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                          {/* 등록된 발송일도 눌러서 고친다 — 같은 창에서 차수 추가·삭제까지 */}
                          <button type="button" className="b2b-link-btn" style={{ fontSize: 15 }}
                            title="발송일 수정"
                            onClick={() => openShipPrompt(o.id, o.company_name || o.order_no)}>
                            {o.ship_date}
                          </button>
                        </td>
                      ) : (
                        <td className="b2b-col-date" onClick={(e) => e.stopPropagation()} style={{ position: "relative" }}>
                          {/* 발송일 미등록 — 버튼이 달력을 직접 연다(showPicker). 투명 input 오버레이는
                              브라우저가 포커스만 주고 달력을 안 열 때가 있어 '안 눌리는' 느낌을 줬다. */}
                          <button
                            type="button"
                            className="b2b-btn-secondary"
                            style={{ padding: "4px 10px", fontSize: 12, whiteSpace: "nowrap" }}
                            title="발송일 등록(재고 차감)"
                            onClick={() => openShipPrompt(o.id, o.company_name || o.order_no)}
                          >
                            + 발송일
                          </button>
                        </td>
                      )}
                      <RowCell href={`/b2b/orders/${o.id}`} className="num b2b-money">
                        {formatMoney(o.total)}
                      </RowCell>
                      {SHOW_ORDER_PRODUCTION && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          className="b2b-status-select"
                          value={o.production_status}
                          onChange={(e) => patchProduction(o.id, e.target.value as ProductionStatus)}
                          style={{
                            background: PRODUCTION_COLORS[o.production_status]?.bg,
                            color: PRODUCTION_COLORS[o.production_status]?.fg,
                          }}
                        >
                          {PRODUCTION_STATUSES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                      )}
                      <td onClick={(e) => e.stopPropagation()}>
                        {parent && prog ? (
                          <button
                            type="button"
                            className="b2b-parent-toggle"
                            onClick={() => toggleExpand(o.id)}
                            title="발송 차수 펼치기/접기"
                          >
                            {prog.done}/{prog.total} <span style={{ fontSize: 12 }}>{isCollapsed ? "▸" : "▾"}</span>
                          </button>
                        ) : (
                          <select
                            className="b2b-status-select"
                            value={o.status}
                            onChange={(e) => handleStatusChange(o.id, e.target.value as OrderStatus)}
                            style={{
                              background: STATUS_COLORS[o.status]?.bg,
                              color: STATUS_COLORS[o.status]?.fg,
                            }}
                          >
                            {ORDER_STATUSES.map((s) => (
                              <option key={s} value={s}>{STATUS_SHORT[s] || s}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          className="b2b-status-select"
                          value={o.payment_status}
                          onChange={(e) => handlePaymentChange(o.id, e.target.value as PaymentStatus)}
                          style={{
                            background: PAYMENT_COLORS[o.payment_status]?.bg,
                            color: PAYMENT_COLORS[o.payment_status]?.fg,
                          }}
                        >
                          {PAYMENT_STATUSES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          className="b2b-status-select"
                          value={o.tax_invoice_status}
                          onChange={(e) => handleTaxInvoiceChange(o.id, e.target.value as TaxInvoiceStatus)}
                          style={{
                            background: TAX_INVOICE_COLORS[o.tax_invoice_status]?.bg,
                            color: TAX_INVOICE_COLORS[o.tax_invoice_status]?.fg,
                          }}
                        >
                          {TAX_INVOICE_STATUSES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                      <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                        <Link
                          href={`/b2b/orders/new?from=${o.id}`}
                          className="b2b-btn-secondary"
                          style={{ padding: "5px 10px", fontSize: 12 }}
                          title="이 발주를 복제해 새 발주 만들기"
                        >
                          복제
                        </Link>
                        <Link
                          href={`/b2b/orders/${o.id}/statement`}
                          className="b2b-btn-secondary"
                          style={{ padding: "5px 10px", fontSize: 12, marginLeft: 6 }}
                          title="이 발주의 거래명세표 인쇄/PDF"
                        >
                          명세표
                        </Link>
                      </td>
                    </tr>
                    {parent && !isCollapsed && (o.shipments ?? []).map((s) => (
                      <tr key={s.id} className="b2b-child-row">
                        <td></td>
                        <td></td>
                        <td colSpan={SHOW_ORDER_PRODUCTION ? 11 : 9} style={{ padding: "8px 18px 8px 30px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            <Link href={`/b2b/orders/${o.id}`} className="b2b-row-link" style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                              <span style={{ color: "var(--sm-text-light)", fontSize: 12 }}>└ {s.seq}차</span>
                              <span style={{ fontSize: 12 }}>{s.ship_date || "날짜 미정"}</span>
                              {s.items.length > 0 && (
                                <span style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>
                                  {s.items.slice(0, 2).map((it) => `${it.product_name}${it.spec ? ` ${it.spec}` : ""} ×${formatQty(it.qty)}`).join(", ")}
                                  {s.items.length > 2 ? ` 외 ${s.items.length - 2}종` : ""}
                                </span>
                              )}
                            </Link>
                            <select
                              className="b2b-status-select"
                              value={s.status}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => handleShipmentStatus(o, s, e.target.value as ShipmentStatus)}
                              style={{ background: SHIPMENT_STATUS_COLORS[s.status]?.bg, color: SHIPMENT_STATUS_COLORS[s.status]?.fg }}
                              title="이 차수의 상태 변경"
                            >
                              {SHIPMENT_STATUSES.map((st) => (
                                <option key={st} value={st}>{STATUS_SHORT[st] || st}</option>
                              ))}
                            </select>
                          </div>
                        </td>
                      </tr>
                    ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            </div>

            {/* 모바일 카드 뷰 */}
            <div className="b2b-order-cards">
              {filtered.map((o) => {
                const urgency = getUrgency({ ...o, ship_date: nextPendingShipDate(o) }, today);
                const parent = isParentOrder(o);
                const prog = parent ? shipProgress(o) : null;
                const isCollapsed = !expanded.has(o.id); // 기본 접힘
                const complete = isOrderComplete(o);
                return (
                  <div key={o.id} className={`b2b-order-card ${urgency !== "normal" ? `is-${urgency}` : ""}`}>
                    <div className="b2b-order-card-check">
                      <input
                        type="checkbox"
                        className="b2b-checkbox"
                        checked={selected.has(o.id)}
                        onChange={() => toggleSelectOne(o.id)}
                      />
                    </div>
                    <Link href={`/b2b/orders/${o.id}`} className="b2b-order-card-body">
                      <div className="b2b-order-card-top">
                        <div>
                          <div className="b2b-order-card-company">{o.company_name}</div>
                          <div className="b2b-order-card-no">{o.order_no}</div>
                        </div>
                        {complete ? (
                          <span className="b2b-urgency-pill is-complete">완료</span>
                        ) : urgency !== "normal" ? (
                          <span className={`b2b-urgency-pill is-${urgency}`}>{URGENCY_LABEL[urgency]}</span>
                        ) : null}
                      </div>
                      <div className="b2b-order-card-items">
                        <ItemsPreview items={o.items} />
                      </div>
                      <div className="b2b-order-card-dates">
                        <span><em>발주</em>{o.order_date?.slice(5) || "-"}</span>
                        {SHOW_ORDER_PRODUCTION && <span><em>생산</em>{o.production_date?.slice(5) || "-"}</span>}
                        {/* 카드 전체가 상세로 가는 링크라 눌림을 여기서 끊는다 — 안 그러면 창 대신 상세가 열린다.
                            손가락으로 누르는 화면이라 글자보다 넉넉한 영역을 준다. */}
                        <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                          <em>발송</em>
                          <button type="button" className="b2b-link-btn"
                            style={{ fontSize: "inherit", padding: "4px 2px", margin: "-4px 0" }}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openShipPrompt(o.id, o.company_name || o.order_no); }}>
                            {parent ? `${(o.shipments ?? []).length}차 · 수정` : o.ship_date ? o.ship_date.slice(5) : "+ 발송일"}
                          </button>
                        </span>
                      </div>
                      <div className="b2b-order-card-foot">
                        <span className="b2b-order-card-total">{formatMoney(o.total)}원</span>
                        <div className="b2b-order-card-pills">
                          {SHOW_ORDER_PRODUCTION && (
                          <span className="b2b-status-pill" style={{ background: PRODUCTION_COLORS[o.production_status]?.bg, color: PRODUCTION_COLORS[o.production_status]?.fg }}>
                            {o.production_status}
                          </span>
                          )}
                          {parent && prog ? (
                            <span
                              className="b2b-parent-toggle"
                              role="button"
                              tabIndex={0}
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleExpand(o.id); }}
                              style={{ cursor: "pointer" }}
                              title="발송 차수 펼치기/접기"
                            >
                              발송 {prog.done}/{prog.total} <span style={{ fontSize: 12 }}>{isCollapsed ? "▸" : "▾"}</span>
                            </span>
                          ) : (
                            <span className="b2b-status-pill" style={{ background: STATUS_COLORS[o.status]?.bg, color: STATUS_COLORS[o.status]?.fg }}>
                              {STATUS_SHORT[o.status] || o.status}
                            </span>
                          )}
                          <span className="b2b-status-pill" style={{ background: PAYMENT_COLORS[o.payment_status]?.bg, color: PAYMENT_COLORS[o.payment_status]?.fg }}>
                            {o.payment_status}
                          </span>
                        </div>
                      </div>
                    </Link>
                    {parent && !isCollapsed && (
                      <div className="b2b-order-card-children">
                        {(o.shipments ?? []).map((s) => (
                          <div key={s.id} className="b2b-order-card-child">
                            <span style={{ color: "var(--sm-text-light)", fontSize: 12, whiteSpace: "nowrap" }}>└ {s.seq}차</span>
                            <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>{s.ship_date?.slice(5) || "날짜미정"}</span>
                            {s.items.length > 0 && (
                              <span style={{ fontSize: 12, color: "var(--sm-text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
                                {s.items.map((it) => `${it.product_name}${it.spec ? ` ${it.spec}` : ""}×${formatQty(it.qty)}`).join(", ")}
                              </span>
                            )}
                            <select
                              className="b2b-status-select"
                              value={s.status}
                              onChange={(e) => handleShipmentStatus(o, s, e.target.value as ShipmentStatus)}
                              style={{ background: SHIPMENT_STATUS_COLORS[s.status]?.bg, color: SHIPMENT_STATUS_COLORS[s.status]?.fg, marginLeft: "auto", flexShrink: 0 }}
                            >
                              {SHIPMENT_STATUSES.map((st) => (
                                <option key={st} value={st}>{STATUS_SHORT[st] || st}</option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      )}

      {exportOptions && (
        <ExportPickModal
          options={exportOptions}
          exporting={exporting}
          onClose={() => setExportOptions(null)}
          onConfirm={(payload) => downloadShipping(payload)}
        />
      )}

      {/* 발송일 등록 — 차수(발송예정일 + 박스 수)를 만드는 유일한 창. 여러 줄이면 복수 발송. */}
      {shipPrompt && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">발송일 등록 — {shipPrompt.label}</h2>
              <button className="b2b-modal-close" onClick={() => setShipPrompt(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <p className="sm-faint" style={{ fontSize: 12, margin: "0 0 12px", lineHeight: 1.6 }}>
                나눠 보내면 줄을 추가하세요. 박스 수는 실제 포장할 때 정해지므로 여기서는 넣지 않고, ‘발송요청 양식 다운로드’에서 확정합니다.
                저장하면 도매 재고에서 발주 전량이 가장 이른 발송일에 차감됩니다.
              </p>
              {shipLoading ? (
                <div className="b2b-loading">불러오는 중...</div>
              ) : (
                <div className="sm-col" style={{ gap: 10 }}>
                  {shipRows.length === 0 && shipInitialCount > 0 && (
                    <div className="sm-warn" style={{ fontSize: 13 }}>
                      일정을 모두 지웠습니다. 이대로 저장하면 발송 일정이 전부 삭제되고 선점 재고가 원복됩니다.
                    </div>
                  )}
                  {shipRows.map((r, i) => (
                    <div key={i} style={{ border: "1px solid var(--sm-border)", borderRadius: 10, padding: 12 }}>
                      <div className="sm-row" style={{ gap: 8, alignItems: "flex-end" }}>
                      <label className="b2b-field" style={{ flex: 1, minWidth: 0 }}>
                        <span className="b2b-field-label">
                          {shipRows.length > 1 ? `${i + 1}차 발송예정일` : "발송예정일"}
                          {/* 이미 처리된 차수를 건드리는 중임을 알린다 — 상태·송장번호는 그대로 보존된다 */}
                          {r.status !== "발송대기" && (
                            <span className="b2b-status-pill" style={{
                              marginLeft: 6,
                              background: SHIPMENT_STATUS_COLORS[r.status]?.bg,
                              color: SHIPMENT_STATUS_COLORS[r.status]?.fg,
                            }}>{r.status}</span>
                          )}
                        </span>
                        <ShipDateField
                          value={r.ship_date}
                          ariaLabel={shipRows.length > 1 ? `${i + 1}차 발송예정일 선택` : "발송예정일 선택"}
                          onChange={(v) => setShipRows((p) => p.map((x, j) => (j === i ? { ...x, ship_date: v } : x)))} />
                      </label>
                      <button type="button" className="b2b-icon-btn is-danger" aria-label={`${i + 1}차 삭제`} style={{ marginBottom: 2 }}
                        onClick={() => setShipRows((p) => p.filter((_, j) => j !== i))}>✕</button>
                      </div>
                      {/* 이 차수에 담을 수량 — 발송요청 엑셀·매출 집계가 이 배분을 읽는다 */}
                      {shipItems.length > 0 && (
                        <div className="sm-col" style={{ gap: 6, marginTop: 8, paddingLeft: 2 }}>
                          <span className="b2b-field-label" style={{ margin: 0 }}>보낼 수량 (상품별)</span>
                          {shipItems.map((it, oi) => (
                            <div key={oi} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {it.product_name}{it.spec ? ` · ${it.spec}` : ""}
                                <span className="sm-faint" style={{ marginLeft: 6 }}>(주문 {it.qty})</span>
                              </span>
                              <input type="number" inputMode="numeric" min={0} className="b2b-input" placeholder="0"
                                style={{ width: 90, textAlign: "right" }}
                                value={r.items[oi] ?? ""}
                                onChange={(e) => setShipRows((p) => p.map((x, j) => (j === i ? { ...x, items: { ...x.items, [oi]: e.target.value } } : x)))} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {shipAllocWarn.length > 0 && (
                    <div className="sm-warn" style={{ fontSize: 12 }}>
                      배분 수량이 발주 수량과 다릅니다 — {shipAllocWarn.join(" / ")}
                    </div>
                  )}
                  <div>
                    <button type="button" className="b2b-btn-secondary"
                      onClick={() => setShipRows((p) => [...p, { ship_date: "", box_count: "1", status: "발송대기", tracking_no: "", stock_out: true, items: {} }])}>+ 발송 일정 추가</button>
                  </div>
                </div>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setShipPrompt(null)} disabled={shipSaving}>취소</button>
                <button className="b2b-btn-primary" onClick={saveShipments} disabled={shipSaving || shipLoading}>
                  {shipSaving ? "저장 중..." : "저장"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {trackingPrompt && (
        <div className="b2b-modal-backdrop">
          <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="b2b-modal-head">
              <h2 className="b2b-modal-title">발송완료 — 송장번호 입력</h2>
              <button className="b2b-modal-close" onClick={() => setTrackingPrompt(null)}>✕</button>
            </div>
            <div className="b2b-modal-body">
              <div style={{ fontSize: 12, color: "var(--sm-text-mid)", marginBottom: 10 }}>
                <strong>{trackingPrompt.label}</strong> 을(를) 발송완료 처리합니다.{" "}
                {directDelivery
                  ? "직접 배송 — 송장번호 없이 처리됩니다."
                  : trackingPrompt.boxCount > 1
                  ? `${trackingPrompt.boxCount}박스 — 박스별 송장번호를 모두 입력하세요.`
                  : "송장번호를 입력하세요."}
              </div>

              {/* 수령인 정보 — 발송완료 처리자가 누구에게 보내는지 확인용 */}
              {(() => {
                const rName = (trackingPrompt.recipientName || "").trim();
                const showName = rName && rName !== "(미지정)" ? rName : "";
                const rPhone = (trackingPrompt.recipientPhone || "").trim();
                if (!showName && !rPhone) return null;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 10px", marginBottom: 12, background: "var(--sm-bg-subtle)", border: "1px solid var(--sm-border)", borderRadius: 8, fontSize: 12 }}>
                    <span style={{ color: "var(--sm-text-light)" }}>수령인</span>
                    {showName && <strong style={{ color: "var(--sm-dark)" }}>{showName}</strong>}
                    {rPhone && <span style={{ color: "var(--sm-text-mid)" }}>{rPhone}</span>}
                  </div>
                );
              })()}

              {/* 직접 배송(택배 아님): 체크 시 송장번호 불필요 */}
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: directDelivery ? 0 : 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  className="b2b-checkbox"
                  checked={directDelivery}
                  onChange={(e) => setDirectDelivery(e.target.checked)}
                />
                직접 배송 (송장번호 없음)
              </label>

              {!directDelivery && (
                <div className="sm-col sm-gap-2">
                  {trackingInput.map((tn, bi) => (
                    <input
                      key={bi}
                      type="text"
                      className="b2b-input"
                      value={tn}
                      onChange={(e) =>
                        setTrackingInput((prev) => prev.map((v, i) => (i === bi ? e.target.value : v)))
                      }
                      placeholder={trackingPrompt.boxCount > 1 ? `박스 ${bi + 1} 송장번호` : "송장번호"}
                      autoFocus={bi === 0}
                      onKeyDown={(e) => { if (e.key === "Enter" && trackingComplete) confirmTracking(); }}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="b2b-modal-foot">
              <span />
              <div className="b2b-modal-foot-right">
                <button className="b2b-btn-secondary" onClick={() => setTrackingPrompt(null)}>취소</button>
                <button className="b2b-btn-primary" onClick={confirmTracking} disabled={!trackingComplete}>
                  발송완료 처리
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// 엑셀 필터식 체크박스 다중선택 드롭다운 (체크된 항목만 표시)
// ─────────────────────────────────────────────
function CheckFilter<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly T[];
  selected: Set<T>;
  onChange: (next: Set<T>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const all = options.every((o) => selected.has(o));
  const summary = all ? "전체" : selected.size === 0 ? "없음" : `${selected.size}개`;

  function toggle(o: T) {
    const next = new Set(selected);
    if (next.has(o)) next.delete(o);
    else next.add(o);
    onChange(next);
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="b2b-select"
        onClick={() => setOpen((v) => !v)}
        style={{ width: "auto", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, color: all ? "var(--sm-text-mid)" : "var(--sm-dark)", fontWeight: all ? 400 : 600 }}
        title={`${label} 필터`}
      >
        {label}: {summary} ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 30,
            minWidth: 180,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--sm-white)",
            border: "1px solid var(--sm-border)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            padding: 6,
          }}
        >
          <label className="b2b-checkfilter-row" style={{ fontWeight: 700 }}>
            <input
              type="checkbox"
              className="b2b-checkbox"
              checked={all}
              onChange={() => onChange(all ? new Set() : new Set(options))}
            />
            전체 선택
          </label>
          <div style={{ height: 1, background: "var(--sm-border)", margin: "4px 0" }} />
          {options.map((o) => (
            <label key={o} className="b2b-checkfilter-row">
              <input type="checkbox" className="b2b-checkbox" checked={selected.has(o)} onChange={() => toggle(o)} />
              {o}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 발송 일정 선택 모달 — 분할 발송이 있는 발주에서 "어떤 발송을 뽑을지" 선택
// ─────────────────────────────────────────────
// 양식으로 뽑을 수 있는 발송 = 발송예정일이 잡혔고 취소가 아닌 차수.
//  날짜 없는 행은 발주 등록 때 배송정보만으로 만들어진 자리표시 행이라 보낼 물건이 아니다.
function isPickable(s: ShipmentExportOption): boolean {
  return !!s.ship_date && s.status !== "취소";
}

function shipmentSummary(s: ShipmentExportOption, fallback: ExportLineItem[]): string {
  const list = s.items.length > 0 ? s.items : fallback;
  if (list.length === 0) return "(상품 없음)";
  const label = (it: ExportLineItem) =>
    `${it.product_name}${it.spec ? ` ${it.spec}` : ""} ×${formatQty(it.qty)}`;
  const head = list.slice(0, 2).map(label).join(", ");
  const rest = list.length - Math.min(2, list.length);
  const base = rest > 0 ? `${head} 외 ${rest}종` : head;
  return s.items.length === 0 ? `${base} · 전체상품` : base;
}

function ExportPickModal({
  options,
  exporting,
  onClose,
  onConfirm,
}: {
  options: OrderExportOption[];
  exporting: boolean;
  onClose: () => void;
  onConfirm: (payload: { shipment_ids: string[]; order_ids: string[]; boxes: Record<string, number> }) => void;
}) {
  // 기본 선택: 뽑을 수 있는 발송 전부. 취소 차수와 날짜 미정 행(배송정보만 든 fallback)은 보낼 게 아니라 제외한다.
  const [shipSel, setShipSel] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const o of options) for (const sh of o.shipments) if (isPickable(sh)) s.add(sh.id);
    return s;
  });
  // 분할 발송이 섞여 있을 때만 '차수를 고르라'는 안내를 붙인다.
  const hasSplit = options.some((o) => o.shipments.length >= 2);

  const totalSelected = shipSel.size;

  // 실제 포장 박스 수 — 여기서 확정하면 저장되어 송장 출력 행 수·송장 입력칸 수·이익률에 반영된다.
  const [boxes, setBoxes] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const o of options) for (const s of o.shipments) m[s.id] = String(Math.max(1, Number(s.box_count) || 1));
    return m;
  });

  function toggleShip(id: string) {
    setShipSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <div className="b2b-modal-backdrop">
      <div className="b2b-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
        <div className="b2b-modal-head">
          <div>
            <h2 className="b2b-modal-title">발송요청 양식 — 실제 포장 박스 수</h2>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--sm-text-mid)" }}>
              실제로 포장한 박스 수를 넣으세요. 저장되어 송장 매수와 이익률 배송비의 기준이 됩니다.
              {hasSplit ? " 나눠 보내는 발주는 이번에 뽑을 차수만 남기세요." : ""}
            </div>
          </div>
          <button className="b2b-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="b2b-modal-body sm-col" style={{ gap: 14 }}>
          {options.map((o) => (
            <div
              key={o.order_id}
              style={{ border: "1px solid var(--sm-border)", borderRadius: 10, overflow: "hidden" }}
            >
              <div
                style={{
                  padding: "9px 12px",
                  background: "var(--sm-bg)",
                  fontSize: 12,
                  fontWeight: 700,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span>{o.company_name}</span>
                <span style={{ color: "var(--sm-text-light)", fontWeight: 500 }}>{o.order_no}</span>
              </div>

              {o.shipments.length === 0 ? (
                // 목록에서 미리 막지만, 조회 시점 차이로 여기까지 오면 이유를 보여주고 선택은 막는다.
                <div className="b2b-export-pick">
                  <span className="b2b-export-pick-main">
                    <span className="b2b-export-pick-date" style={{ color: "var(--sm-text-light)" }}>
                      발송일정 없음 — 뽑을 수 없음
                    </span>
                    <span className="b2b-export-pick-items">
                      목록의 발송일 칸에서 ‘+ 발송일’로 먼저 등록하세요
                    </span>
                  </span>
                </div>
              ) : (
                // 취소·날짜미정 행은 선택 불가로 남겨 이유를 보여준다(왜 안 뽑히는지 화면에서 알 수 있게).
                o.shipments.map((s) => {
                  const c = SHIPMENT_STATUS_COLORS[s.status];
                  const pickable = isPickable(s);
                  return (
                    <div
                      key={s.id}
                      className="b2b-export-pick"
                      style={{ alignItems: "center", opacity: pickable ? 1 : 0.5 }}
                    >
                      <input
                        type="checkbox"
                        className="b2b-checkbox"
                        checked={shipSel.has(s.id)}
                        disabled={!pickable}
                        onChange={() => toggleShip(s.id)}
                        aria-label={`${s.ship_date || "예정일 미정"} 선택`}
                      />
                      <span className="b2b-export-pick-main">
                        <span className="b2b-export-pick-date">
                          {s.ship_date || "예정일 미정"}
                          <span
                            className="b2b-status-pill"
                            style={{ background: c?.bg, color: c?.fg, marginLeft: 8 }}
                          >
                            {s.status}
                          </span>
                        </span>
                        <span className="b2b-export-pick-items">{shipmentSummary(s, o.fallbackItems)}</span>
                      </span>
                      {pickable ? (
                        <label className="sm-row" style={{ gap: 6, flexShrink: 0, fontSize: 12, color: "var(--sm-text-mid)" }}>
                          박스
                          <input
                            type="number" inputMode="numeric" min={1} step={1} className="b2b-input"
                            style={{ width: 74, textAlign: "right" }}
                            value={boxes[s.id] ?? "1"}
                            onChange={(e) => setBoxes((p) => ({ ...p, [s.id]: e.target.value }))}
                            onBlur={() => setBoxes((p) => ({ ...p, [s.id]: p[s.id] === "" ? "1" : p[s.id] }))}
                          />
                        </label>
                      ) : (
                        <span style={{ flexShrink: 0, fontSize: 12, color: "var(--sm-text-light)" }}>
                          {s.status === "취소" ? "취소 — 제외" : "발송일 미정 — 제외"}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ))}
        </div>

        <div className="b2b-modal-foot">
          <span style={{ fontSize: 12, color: "var(--sm-text-mid)" }}>
            <strong>{totalSelected}건</strong> 발송 선택됨
          </span>
          <div className="b2b-modal-foot-right">
            <button type="button" className="b2b-btn-secondary" onClick={onClose}>
              취소
            </button>
            <button
              type="button"
              className="b2b-btn-primary"
              disabled={exporting || totalSelected === 0}
              onClick={() =>
                onConfirm({
                  shipment_ids: Array.from(shipSel),
                  order_ids: [],
                  boxes: Object.fromEntries(
                    Array.from(shipSel).map((id) => [id, Math.max(1, Math.floor(Number(boxes[id]) || 1))])
                  ),
                })
              }
            >
              {exporting ? "생성 중..." : "선택 발송 양식 다운로드"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 발송예정일 입력 필드 — 네이티브 date 입력은 iOS 에서 얇게 찌그러져 누르기 어렵다.
//  큼직한 버튼이 값을 보여주고, 누르면 숨은 input 의 달력을 연다(showPicker).
//  input 을 필드 크기로 깔아 두는 이유: 데스크톱 크롬의 달력이 input 위치에 열리므로
//  0×0 으로 두면 달력이 엉뚱한 곳에 뜬다. 클릭은 pointerEvents 로 버튼만 받는다.
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;
function ShipDateField({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : null;
  // 탭/클릭은 투명한 input 이 직접 받는다 — 모바일(웹뷰·구형 iOS 포함)은 네이티브 피커가 그 자체로 열리고,
  //  showPicker 를 지원하는 데스크톱 크롬은 onClick 에서 마저 열어준다.
  //  (이전에는 버튼이 클릭을 받고 showPicker 를 불렀는데, 미지원 브라우저 폴백인
  //   focus()+click() 이 모바일에서 피커를 못 열어 '날짜 수정이 안 되는' 증상이 났다.)
  function tryShowPicker() {
    const el = ref.current;
    if (!el) return;
    try { el.showPicker(); } catch { /* 미지원 — 네이티브 탭 동작에 맡긴다 */ }
  }
  return (
    <div style={{ position: "relative" }}>
      <input
        ref={ref} type="date" value={value} aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        onClick={tryShowPicker}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, border: 0, padding: 0, cursor: "pointer" }}
      />
      <div
        aria-hidden
        style={{
          width: "100%", minHeight: 48, padding: "0 14px",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          border: "1px solid var(--sm-border)", borderRadius: "var(--sm-radius)",
          background: "var(--sm-white)", font: "inherit", fontSize: 15, pointerEvents: "none",
        }}
      >
        {d ? (
          <span style={{ fontWeight: 700 }}>
            {value} <span style={{ fontWeight: 400, color: "var(--sm-text-mid)" }}>({WEEKDAYS[d.getDay()]})</span>
          </span>
        ) : (
          <span style={{ color: "var(--sm-text-light)" }}>날짜 선택</span>
        )}
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sm-orange)", flexShrink: 0 }}>{d ? "변경" : "선택"}</span>
      </div>
    </div>
  );
}

// 복수 발송(발송 일정 2건 이상) = 상위발주. 상태는 표시하지 않고 하위 차수가 각자 가짐.
function isParentOrder(o: OrderListItem): boolean {
  return (o.shipments?.length ?? 0) >= 2;
}
// 상위발주 발송 진행도: 발송완료 / 전체(취소 제외)
function shipProgress(o: OrderListItem): { done: number; total: number } {
  const ships = (o.shipments ?? []).filter((s) => s.status !== "취소");
  return { done: ships.filter((s) => s.status === "발송완료").length, total: ships.length };
}

// 품목 미리보기 — 발주 상품을 "품목명 옵션 ×수량" 으로 나열, 많으면 외 N
function ItemsPreview({ items }: { items: OrderLinePreview[] }) {
  if (!items || items.length === 0) {
    return <span className="sm-faint">-</span>;
  }
  const MAX = 3;
  const shown = items.slice(0, MAX);
  const rest = items.length - shown.length;
  return (
    <div className="sm-col" style={{ gap: 2, lineHeight: 1.45 }}>
      {shown.map((it, i) => (
        <span key={i} className="sm-nowrap">
          {it.product_name}
          {it.spec ? <span className="sm-faint"> · {it.spec}</span> : ""}
          <span className="sm-muted"> ×{it.qty}</span>
        </span>
      ))}
      {rest > 0 && (
        <span style={{ fontSize: 12, color: "var(--sm-text-light)" }}>외 {rest}종</span>
      )}
    </div>
  );
}

// 셀 안의 <a> 가 전체 셀 영역 클릭되도록 — display:block + 셀 padding 0
function RowCell({
  href,
  className,
  nowrap,
  children,
}: {
  href: string;
  className?: string;
  nowrap?: boolean;
  children: React.ReactNode;
}) {
  return (
    <td className={className} style={{ padding: 0 }}>
      <Link
        href={href}
        className="b2b-row-link"
        style={{ display: "block", padding: "15px 18px", whiteSpace: nowrap ? "nowrap" : undefined }}
      >
        {children}
      </Link>
    </td>
  );
}
