export const ORDER_STATUSES = [
  "발주확인/생산대기",
  "생산요청/생산중",
  "생산완료/발송대기",
  "발송완료",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// 옛 상태값 → 새 상태값 매핑 (시트에 남아 있는 과거 데이터 호환)
const STATUS_MIGRATION: Record<string, OrderStatus> = {
  "대기": "발주확인/생산대기",
  "생산중": "생산요청/생산중",
  "생산완료": "생산완료/발송대기",
  "발송완료": "발송완료",
  "취소": "발주확인/생산대기", // 취소는 더 이상 없음 → 기본값으로 마이그레이션
};

export function migrateStatus(raw: string | number | undefined | null): OrderStatus {
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  if ((ORDER_STATUSES as readonly string[]).includes(s)) return s as OrderStatus;
  if (STATUS_MIGRATION[s]) return STATUS_MIGRATION[s];
  return "발주확인/생산대기";
}

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
  note: string;            // 비고
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
  status: "발주확인/생산대기",
  note: "",
};

// ─────────────────────────────────────────────
// 발주 긴급도
// ─────────────────────────────────────────────
export type Urgency = "overdue" | "urgent" | "normal";

export const URGENCY_LABEL: Record<Exclude<Urgency, "normal">, string> = {
  overdue: "지연",
  urgent: "임박",
};

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 오늘 기준으로 발주의 긴급도를 계산.
// - overdue: 일정이 지났는데 다음 단계로 못 넘어간 상태
//   · 발송일이 지났는데 미발송
//   · 생산일이 지났는데 아직 생산대기/생산중
// - urgent: 발송일이 오늘 또는 내일인데 아직 발송 안 됨
export function getUrgency(o: Order, todayIso: string): Urgency {
  if (o.status === "발송완료") return "normal";

  if (o.shipDate && o.shipDate < todayIso) return "overdue";
  if (
    o.productionDate &&
    o.productionDate < todayIso &&
    (o.status === "발주확인/생산대기" || o.status === "생산요청/생산중")
  ) {
    return "overdue";
  }

  const tomorrow = addDaysISO(todayIso, 1);
  if (o.shipDate && o.shipDate <= tomorrow) {
    return "urgent";
  }

  return "normal";
}

export const STATUS_COLORS: Record<OrderStatus, { bg: string; fg: string }> = {
  "발주확인/생산대기": { bg: "#fff8e1", fg: "#b08800" },
  "생산요청/생산중":   { bg: "#e3f2fd", fg: "#0a66c2" },
  "생산완료/발송대기": { bg: "#e6ffed", fg: "#22863a" },
  "발송완료":          { bg: "#ede7f6", fg: "#5e35b1" },
};

// 표/pill 등 좁은 공간에서 사용할 짧은 라벨
export const STATUS_SHORT: Record<OrderStatus, string> = {
  "발주확인/생산대기": "생산대기",
  "생산요청/생산중":   "생산중",
  "생산완료/발송대기": "발송대기",
  "발송완료":          "발송완료",
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
  status?: OrderStatus; // includeStatus=true 일 때만 채워짐
}

export interface GroupByProductOptions {
  includeStatus?: boolean; // 키에 상태 포함 → 같은 품목+규격이라도 상태 다르면 별도 묶음
}

export function groupByProduct(
  orders: Order[],
  opts: GroupByProductOptions = {}
): ProductGroup[] {
  const map = new Map<string, ProductGroup>();
  for (const o of orders) {
    const key = opts.includeStatus
      ? `${o.product}__${o.spec}__${o.status}`
      : `${o.product}__${o.spec}`;
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
        status: opts.includeStatus ? o.status : undefined,
      };
      map.set(key, g);
    }
    // weight 는 "1개당 중량(kg)" → 총 중량 = weight × quantity (quantity 누락 시 1로 간주)
    const q = parseNumber(o.quantity);
    g.totalWeight += parseNumber(o.weight) * (q > 0 ? q : 1);
    g.totalQuantity += q;
    if (o.client && !g.clients.includes(o.client)) g.clients.push(o.client);
    g.orders.push(o);
    const candidate = o.shipDate || o.productionDate || o.orderDate || "";
    if (candidate && (!g.nextDate || candidate < g.nextDate)) g.nextDate = candidate;
  }
  // 품목 → 규격 → 상태 순으로 정렬. 시트에서 숫자로 들어올 수 있으니 string으로 강제 변환.
  return Array.from(map.values()).sort((a, b) => {
    const p = String(a.product ?? "").localeCompare(String(b.product ?? ""), "ko");
    if (p !== 0) return p;
    const s = String(a.spec ?? "").localeCompare(String(b.spec ?? ""), "ko");
    if (s !== 0) return s;
    return String(a.status ?? "").localeCompare(String(b.status ?? ""));
  });
}

// 합산된 숫자를 표시 (정수면 정수, 아니면 소수 첫 자리)
export function formatNumber(n: number): string {
  if (!n) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// 단위 표시 — 빈 값은 빈 문자열, 값 있으면 단위 부착
export function formatSpec(v: string | number): string {
  const s = v === null || v === undefined ? "" : String(v).trim();
  if (!s) return "";
  // 이미 단위가 붙어 있으면 그대로 표시
  return /[a-zA-Zㄱ-힣]/.test(s) ? s : `${s}g`;
}

export function formatWeight(v: string | number): string {
  const s = v === null || v === undefined ? "" : String(v).trim();
  if (!s) return "";
  return /[a-zA-Zㄱ-힣]/.test(s) ? s : `${s}kg`;
}

// ─────────────────────────────────────────────
// 주간 그룹화 (월요일 시작 기준)
// ─────────────────────────────────────────────
export interface WeekGroup {
  weekStart: string;  // YYYY-MM-DD (월요일)
  weekEnd: string;    // YYYY-MM-DD (일요일)
  label: string;      // "5월 11일(월) ~ 5월 17일(일)"
  totalWeight: number;
  totalQuantity: number;
  clients: string[];
  productGroups: ProductGroup[];
  orders: Order[];
}

function getMondayOf(dateStr: string): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const day = d.getDay(); // 0=일, 1=월, ..., 6=토
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatKoreanRange(monday: Date, sunday: Date): string {
  const m1 = monday.getMonth() + 1;
  const d1 = monday.getDate();
  const m2 = sunday.getMonth() + 1;
  const d2 = sunday.getDate();
  return `${m1}월 ${d1}일(월) ~ ${m2}월 ${d2}일(일)`;
}

export interface GroupByWeekOptions {
  dateKey?: "shipDate" | "productionDate"; // 기본: shipDate
  productOpts?: GroupByProductOptions;
}

// 주차별로 그룹. 기준일이 비어 있으면 "<기준>일 미정" 그룹(weekStart="").
export function groupByWeek(
  orders: Order[],
  opts: GroupByWeekOptions = {}
): WeekGroup[] {
  const dateKey = opts.dateKey || "shipDate";
  const unscheduledLabel = dateKey === "productionDate" ? "생산일 미정" : "발송일 미정";

  const buckets = new Map<string, Order[]>();
  for (const o of orders) {
    const monday = getMondayOf(o[dateKey]);
    const key = monday ? toISODate(monday) : "";
    const arr = buckets.get(key) || [];
    arr.push(o);
    buckets.set(key, arr);
  }

  const result: WeekGroup[] = [];
  for (const [key, list] of buckets.entries()) {
    let label: string;
    let weekEnd: string;
    if (key === "") {
      label = unscheduledLabel;
      weekEnd = "";
    } else {
      const monday = new Date(key + "T00:00:00");
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      label = formatKoreanRange(monday, sunday);
      weekEnd = toISODate(sunday);
    }

    let totalWeight = 0;
    let totalQuantity = 0;
    const clientsSet = new Set<string>();
    for (const o of list) {
      const q = parseNumber(o.quantity);
      totalWeight += parseNumber(o.weight) * (q > 0 ? q : 1);
      totalQuantity += q;
      if (o.client) clientsSet.add(o.client);
    }

    result.push({
      weekStart: key,
      weekEnd,
      label,
      totalWeight,
      totalQuantity,
      clients: Array.from(clientsSet),
      productGroups: groupByProduct(list, opts.productOpts),
      orders: list,
    });
  }

  result.sort((a, b) => {
    if (a.weekStart === "" && b.weekStart === "") return 0;
    if (a.weekStart === "") return 1;
    if (b.weekStart === "") return -1;
    return a.weekStart.localeCompare(b.weekStart);
  });

  return result;
}
