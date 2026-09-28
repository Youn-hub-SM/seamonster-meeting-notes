import type { SupabaseClient } from "@supabase/supabase-js";

// '입고 예정'(입고 예정) — 열린 제조사 생산 요청서(상태 요청·진행중, 용도 '재고 보충')의 품목별 잔여
//  (요청수량 − 입고 누계). 권장 수식이 '창고에 있는 것'만 보고 시켜 둔 물량을 또 시키던 문제의
//  차감 항(2026-09-17 대표 확정 1단계). 규칙(대표 확정):
//  · 마감이 지난 요청서도 '결국 전량 생산된다'고 보고 잔여를 그대로 둔다(자동 제외 없음) — 다음 주 입고분.
//    정말 안 올 물량은 사람이 요청서를 강제 완료·취소해야 입고 예정에서 빠진다.
//  · 원장 '대기' 입고는 운영에서 쓰지 않으므로 보지 않는다.
//  · 도매 납품·프로모션·도매 대량 요청서는 제조사 생산이 아니라 소매→그 칸 이동의 관리 — 제외.
//  · 069 미적용(테이블 없음)이면 빈 결과. 그 밖의 조회 오류·행 한도 초과는 null — 호출부가 '집계 실패'를
//    표시한다(조용히 0 으로 두면 권장이 과대해도 아무도 모른다).
//  · 조회는 range 페이징 — 서버 Max Rows(기본 1000)가 .limit 보다 우선해 조용히 잘리는 함정
//    (overview·briefing 과 같은 관례). 품목이 잘리면 입고 예정 과소→권장 과대(이중 발주), 입고 누계가 잘리면
//    입고 예정 과대→권장 과소(발주 부족)라 둘 다 전량 읽어야 한다.

export type InboundReq = { req_no: string | null; qty: number; due: string | null; status: string };
export type InboundRow = {
  qty: number;                 // 잔여 합(소수 둘째 자리) — 담은 행사·대량 몫(folded)을 뺀 소매 몫
  earliest_due: string | null; // 잔여가 있는 요청서 중 가장 이른 생산마감일(마감 없는 옛 요청서는 제외)
  overdue_qty: number;         // 그중 마감이 지난 잔여(자동 제외 없음 — 표시용)
  reqs: InboundReq[];          // 요청서별 내역(마감 오름차순, 마감 없음은 뒤) — 담은 몫 포함 잔여
  folded: number;              // 뺀 몫 = min(요청서에 담은 확정형 몫 중 아직 안 온 양, 아직 옮기지 않은 확정형 잔여)
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const PAGE = 1000;
const MAX_ROWS = 20000; // 이 이상은 '집계 불확실'(null) — 열린 요청서가 이만큼 쌓이는 건 정리 대상

type Resp = { data: unknown; error: { message: string } | null };
// range 페이징으로 전량 읽기 — 오류·한도 초과면 null
async function pagedAll<T>(q: (from: number, to: number) => PromiseLike<Resp>): Promise<T[] | null> {
  const out: T[] = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await q(off, off + PAGE - 1);
    if (error) return null;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  return null;
}

// "column production_requests.purpose does not exist"(082 미적용)도 'does not exist' 라 — 컬럼 오류는 테이블 없음으로 보지 않는다.
//  'schema cache' 는 넣지 않는다 — PostgREST 재연결 중 일시 오류(PGRST002 "…for the schema cache. Retrying.")를 미적용으로 오판한다.
const missingTable = (m: string) => !/column/i.test(m) && /does not exist|could not find/i.test(m);

export async function getOpenInboundByProduct(sb: SupabaseClient, today: string): Promise<Map<string, InboundRow> | null> {
  try {
    type Head = { id: string; req_no: string | null; status: string; request_date: string; due_date?: string | null; purpose?: string | null };
    // 1) 열린 요청서 — 오류 메시지에 보이는 컬럼만 빼고 재시도(082 purpose·071 due_date 미적용 폴백).
    //    그 밖의 오류는 lite 로 흘리지 않는다(도매 납품·프로모션까지 합산되는 오판 방지) — null.
    let withDue = true, withPurpose = true;
    let heads: Head[] | null = null;
    for (let guard = 0; guard < 3 && heads === null; guard++) {
      const sel = `id, req_no, status, request_date${withDue ? ", due_date" : ""}${withPurpose ? ", purpose" : ""}`;
      const acc: Head[] = [];
      let failed: string | null = null;
      let truncated = false;
      for (let off = 0; off < MAX_ROWS; off += PAGE) {
        const { data, error } = await sb.from("production_requests").select(sel)
          .in("status", ["요청", "진행중"]).order("id", { ascending: true }).range(off, off + PAGE - 1);
        if (error) { failed = error.message; break; }
        const rows = (data ?? []) as unknown as Head[];
        acc.push(...rows);
        if (rows.length < PAGE) break;
        if (off + PAGE >= MAX_ROWS) truncated = true;
      }
      if (!failed) { if (truncated) return null; heads = acc; break; }
      if (withPurpose && /purpose/i.test(failed)) { withPurpose = false; continue; } // 082 미적용 — 전부 재고 보충
      if (withDue && /due_date/i.test(failed)) { withDue = false; continue; }         // 071 미적용 — 마감 없음
      if (missingTable(failed)) return new Map();                                       // 069 미적용
      return null;
    }
    if (heads === null) return null;
    // 확정형(프로모션·도매 대량) 열린 요청서 — 제조사 요청서에 '담은 몫'을 입고 예정에서 뺄 한도(아직 옮기지 않은 잔여)
    const confirmedIds = heads.filter((h) => h.purpose === "프로모션" || h.purpose === "도매 대량").map((h) => h.id);
    heads = heads.filter((h) => (h.purpose ?? "재고 보충") === "재고 보충");
    const out = new Map<string, InboundRow>();
    if (!heads.length) return out;
    const headById = new Map(heads.map((h) => [h.id, h]));

    // 2) 요청 품목 — 요청서 100건씩(URL 길이) 청크, 청크 안은 페이징 전량
    type Item = { id: string; request_id: string; product_id: string; requested_qty: number; reserved_qty?: number | null };
    const items: Item[] = [];
    const ids = heads.map((h) => h.id);
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      // * = reserved_qty(119) 미적용이어도 안전(없으면 담은 몫 0)
      const rows = await pagedAll<Item>((a, b) => sb.from("production_request_items")
        .select("*").in("request_id", part).order("id", { ascending: true }).range(a, b));
      if (rows === null) return null;
      items.push(...rows);
    }
    if (!items.length) return out;

    // 3) 입고 누계(receipts 합) — 품목 100건씩 청크, 청크 안은 페이징 전량
    const received = new Map<string, number>();
    for (let i = 0; i < items.length; i += 100) {
      const part = items.slice(i, i + 100).map((x) => x.id);
      const rows = await pagedAll<{ item_id: string; qty: number }>((a, b) => sb.from("production_receipts")
        .select("item_id, qty").in("item_id", part).order("id", { ascending: true }).range(a, b));
      if (rows === null) return null;
      for (const rc of rows) received.set(rc.item_id, (received.get(rc.item_id) || 0) + (Number(rc.qty) || 0));
    }

    // 담은 몫 중 아직 안 온 양(줄마다 min(담은 몫, 잔여) — 담은 몫이 마지막에 온다고 보는 보수적 가정)
    const foldedPending = new Map<string, number>();
    for (const it of items) {
      const rem = Math.max(0, (Number(it.requested_qty) || 0) - (received.get(it.id) || 0));
      const f = Math.min(Math.max(0, Number(it.reserved_qty) || 0), rem);
      if (f > 0) foldedPending.set(it.product_id, (foldedPending.get(it.product_id) || 0) + f);
    }
    // 확정형 잔여(아직 소매에서 옮기지 않은 양) — 담은 몫을 뺄 상한. 물건이 와서 옮겨지면 잔여가 줄어 보정도 풀린다.
    const confirmedRem = new Map<string, number>();
    if (foldedPending.size && confirmedIds.length) {
      const cItems: Item[] = [];
      for (let i = 0; i < confirmedIds.length; i += 100) {
        const rows = await pagedAll<Item>((a, b) => sb.from("production_request_items")
          .select("id, request_id, product_id, requested_qty").in("request_id", confirmedIds.slice(i, i + 100)).order("id", { ascending: true }).range(a, b));
        if (rows === null) return null;
        cItems.push(...rows.filter((x) => foldedPending.has(x.product_id)));
      }
      const cRecv = new Map<string, number>();
      for (let i = 0; i < cItems.length; i += 100) {
        const rows = await pagedAll<{ item_id: string; qty: number }>((a, b) => sb.from("production_receipts")
          .select("item_id, qty").in("item_id", cItems.slice(i, i + 100).map((x) => x.id)).order("id", { ascending: true }).range(a, b));
        if (rows === null) return null;
        for (const rc of rows) cRecv.set(rc.item_id, (cRecv.get(rc.item_id) || 0) + (Number(rc.qty) || 0));
      }
      for (const it of cItems) {
        const rem = Math.max(0, (Number(it.requested_qty) || 0) - (cRecv.get(it.id) || 0));
        if (rem > 0) confirmedRem.set(it.product_id, (confirmedRem.get(it.product_id) || 0) + rem);
      }
    }

    for (const it of items) {
      const rem = r2(Math.max(0, (Number(it.requested_qty) || 0) - (received.get(it.id) || 0)));
      if (rem <= 0) continue;
      const h = headById.get(it.request_id);
      if (!h) continue;
      const due = h.due_date ?? null; // 마감 없는 옛 요청서는 날짜 판정에서 제외(요청일을 마감으로 오인하지 않는다)
      const row = out.get(it.product_id) ?? { qty: 0, earliest_due: null, overdue_qty: 0, reqs: [], folded: 0 };
      row.qty = r2(row.qty + rem);
      if (due && (!row.earliest_due || due < row.earliest_due)) row.earliest_due = due;
      if (due && due < today) row.overdue_qty = r2(row.overdue_qty + rem);
      row.reqs.push({ req_no: h.req_no ?? null, qty: rem, due, status: h.status });
      out.set(it.product_id, row);
    }
    for (const [pid, row] of out) {
      row.reqs.sort((a, b) => String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));
      const f = r2(Math.min(foldedPending.get(pid) || 0, confirmedRem.get(pid) || 0, row.qty));
      if (f > 0) { row.folded = f; row.qty = r2(row.qty - f); }
    }
    return out;
  } catch {
    return null;
  }
}

// 툴팁·설명용 — "PR-000123 300 (마감 09-25 지남)" 형태를 줄바꿈으로 잇는다
export function formatInbound(row: InboundRow | undefined, today: string): string {
  if (!row || !row.reqs.length) return "";
  const lines = row.reqs
    .map((r) => `${r.req_no ?? "요청서"} ${r.qty.toLocaleString()}${r.due ? ` (마감 ${r.due.slice(5)}${r.due < today ? " 지남" : ""})` : " (마감 없음)"}`);
  if (row.folded > 0) lines.push(`행사·대량 몫 −${row.folded.toLocaleString()} (도착 후 프로모션·도매 대량으로 옮길 양)`);
  return lines.join("\n");
}
