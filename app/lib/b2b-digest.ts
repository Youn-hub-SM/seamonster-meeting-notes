import { supabaseAdmin } from "./supabase";
import { getAppBaseUrl } from "./b2b-settings";

// B2B '향후 7일 미완료 업무' 다이제스트 — 매일 아침 Flow 챗봇 발송용.
//  ① 발송 예정(shipments ship_date ≤ 7일, 발송대기/중) ② 발송일정 미등록(발송대기 & 스케줄 없음)
//  ③ 계산서 미발행(발송완료 & 미발행) ④ 입금 대기(발송완료 & 입금전/일부)

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const kst = () => new Date(Date.now() + 9 * 3600e3);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const won = (n: unknown) => Math.round(Number(n) || 0).toLocaleString();
function weekday(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

type OrderRow = { id: string; order_no: string; company_id: string; status: string; tax_invoice_status: string; payment_status: string; total: number };
type ShipRow = { ship_date: string; status: string; box_count: number; order_id: string };

export type B2BDigest = { text: string; counts: { ship: number; unscheduled: number; invoice: number; payment: number }; hasTasks: boolean };

export async function buildB2BDigest(): Promise<B2BDigest> {
  const sb = supabaseAdmin();
  const now = kst();
  const today = ymd(now);
  const in7 = ymd(new Date(now.getTime() + 7 * 864e5));

  const [shipsRes, ordersRes, compsRes, schedRes] = await Promise.all([
    sb.from("shipments").select("ship_date, status, box_count, order_id").gte("ship_date", today).lte("ship_date", in7).in("status", ["발송대기", "발송중"]).order("ship_date"),
    sb.from("orders").select("id, order_no, company_id, status, tax_invoice_status, payment_status, total").neq("status", "취소"),
    sb.from("companies").select("id, name"),
    sb.from("shipments").select("order_id").not("ship_date", "is", null),
  ]);
  const ships = (shipsRes.data || []) as ShipRow[];
  const orders = (ordersRes.data || []) as OrderRow[];
  const compName = new Map((compsRes.data || []).map((c: { id: string; name: string }) => [c.id, c.name]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const scheduled = new Set((schedRes.data || []).map((s: { order_id: string }) => s.order_id));
  const nameOf = (o?: OrderRow) => (o ? compName.get(o.company_id) || o.order_no : "(?)");

  // ① 발송 예정 (날짜별)
  const byDate = new Map<string, { name: string; box: number }[]>();
  for (const s of ships) {
    const arr = byDate.get(s.ship_date) || [];
    arr.push({ name: nameOf(orderById.get(s.order_id)), box: Number(s.box_count) || 0 });
    byDate.set(s.ship_date, arr);
  }
  const unscheduled = orders.filter((o) => o.status === "발송대기" && !scheduled.has(o.id));
  const needInvoice = orders.filter((o) => o.status === "발송완료" && o.tax_invoice_status === "미발행");
  const needPay = orders.filter((o) => o.status === "발송완료" && (o.payment_status === "입금전" || o.payment_status === "일부입금"));

  const counts = { ship: ships.length, unscheduled: unscheduled.length, invoice: needInvoice.length, payment: needPay.length };
  const hasTasks = counts.ship + counts.unscheduled + counts.invoice + counts.payment > 0;

  const cut = (arr: string[], n: number) => (arr.length > n ? `${arr.slice(0, n).join(", ")} 외 ${arr.length - n}건` : arr.join(", "));
  const L: string[] = [`☀️ 씨몬스터 B2B 오늘의 할 일 — ${today.slice(5)}(${weekday(today)}) 기준 · 향후 7일`];

  if (!hasTasks) {
    L.push("", "처리할 미완료 업무가 없습니다. 좋은 하루 되세요 🎉");
  } else {
    if (byDate.size) {
      L.push("", `📦 발송 예정 (${counts.ship}건)`);
      [...byDate.keys()].sort().forEach((d) => {
        const items = byDate.get(d)!;
        const head = items.slice(0, 6).map((i) => `${i.name}${i.box ? ` ${i.box}박스` : ""}`);
        L.push(` · ${d.slice(5)}(${weekday(d)}): ${items.length > 6 ? `${head.join(", ")} 외 ${items.length - 6}건` : head.join(", ")}`);
      });
    }
    if (unscheduled.length) {
      L.push("", `🗓 발송일정 미등록 (${unscheduled.length}건) — 일정 잡아야 함`, ` · ${cut(unscheduled.map((o) => nameOf(o)), 8)}`);
    }
    if (needInvoice.length) {
      L.push("", `🧾 계산서 미발행 (${needInvoice.length}건)`, ` · ${cut(needInvoice.map((o) => `${nameOf(o)} ${won(o.total)}원`), 8)}`);
    }
    if (needPay.length) {
      L.push("", `💰 입금 대기 (${needPay.length}건)`, ` · ${cut(needPay.map((o) => `${nameOf(o)} ${won(o.total)}원`), 8)}`);
    }
  }
  const base = await getAppBaseUrl();
  if (base) L.push("", `→ ${base}/b2b/orders`);
  return { text: L.join("\n"), counts, hasTasks };
}
