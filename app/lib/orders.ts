export const ORDER_STATUSES = ["대기", "생산중", "생산완료", "발송완료", "취소"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface Order {
  id: string;
  orderDate: string;       // YYYY-MM-DD
  productionDate: string;  // YYYY-MM-DD
  shipDate: string;        // YYYY-MM-DD
  client: string;          // 거래처명
  product: string;         // 생산품목
  spec: string;            // 규격
  weight: string;          // 중량
  quantity: string;        // 수량
  status: OrderStatus;
}

export type OrderInput = Omit<Order, "id"> & { id?: string };

export const EMPTY_ORDER: OrderInput = {
  orderDate: "",
  productionDate: "",
  shipDate: "",
  client: "",
  product: "",
  spec: "",
  weight: "",
  quantity: "",
  status: "대기",
};

export const STATUS_COLORS: Record<OrderStatus, { bg: string; fg: string }> = {
  "대기":     { bg: "#fff8e1", fg: "#b08800" },
  "생산중":   { bg: "#e3f2fd", fg: "#0a66c2" },
  "생산완료": { bg: "#e6ffed", fg: "#22863a" },
  "발송완료": { bg: "#ede7f6", fg: "#5e35b1" },
  "취소":     { bg: "#ffeef0", fg: "#cb2431" },
};

// 캘린더 셀에 표시할 날짜 타입(어떤 컬럼에 해당하는 날짜인지)
export type DateKind = "order" | "production" | "ship";

export const DATE_KIND_LABEL: Record<DateKind, string> = {
  order: "발주",
  production: "생산",
  ship: "발송",
};

export const DATE_KIND_COLOR: Record<DateKind, string> = {
  order: "#999999",
  production: "#0a66c2",
  ship: "#F15A30",
};

// "200kg" / "1.5 톤" / " 50 " 같은 문자열에서 첫 숫자를 추출
export function parseNumber(s: string): number {
  if (!s) return 0;
  const m = String(s).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

export interface ProductGroup {
  product: string;
  spec: string;
  totalWeight: number;
  totalQuantity: number;
  clients: string[]; // 중복 제거된 거래처
  orders: Order[];
  // 카드에 표시할 "다음" 일정: 발송일이 비면 생산일, 그것도 비면 발주일
  nextDate: string;
}

export function groupByProduct(orders: Order[]): ProductGroup[] {
  const map = new Map<string, ProductGroup>();
  for (const o of orders) {
    const key = `${o.product}__${o.spec}`;
    let g = map.get(key);
    if (!g) {
      g = {
        product: o.product || "(품목 미정)",
        spec: o.spec,
        totalWeight: 0,
        totalQuantity: 0,
        clients: [],
        orders: [],
        nextDate: "",
      };
      map.set(key, g);
    }
    g.totalWeight += parseNumber(o.weight);
    g.totalQuantity += parseNumber(o.quantity);
    if (o.client && !g.clients.includes(o.client)) g.clients.push(o.client);
    g.orders.push(o);
    const candidate = o.shipDate || o.productionDate || o.orderDate || "";
    if (candidate && (!g.nextDate || candidate < g.nextDate)) g.nextDate = candidate;
  }
  // 다음 일정이 빠른 순으로 정렬, 일정 비어 있으면 뒤로
  return Array.from(map.values()).sort((a, b) => {
    const ka = a.nextDate || "9999";
    const kb = b.nextDate || "9999";
    return ka.localeCompare(kb);
  });
}

// 합산된 숫자를 표시 (정수면 정수, 아니면 소수 첫 자리)
export function formatNumber(n: number): string {
  if (!n) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
