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
