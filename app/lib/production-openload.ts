import type { SupabaseClient } from "@supabase/supabase-js";

// 열린 생산 요청서의 '부하'를 품목별로 한 번에 계산한다 — 예약 · 그중 나감 · 잔여 · 오는 중.
//  (docs/demand-streams-plan.md 5·7·8절. 2026-09-18 대표 확정, 1단계는 표시 전용이라
//   어떤 권장 수식도 이 값을 쓰지 않는다 — 화면에 보여주기만 한다.)
//
//  용어
//   · 표시 예약 = 열린 '도매 납품' 요청서에 배정된 누계, 요청수량 상한. 임자가 정해진 몫.
//   · 그중 나감(소진) = 그 예약분 중 이미 도매 발송으로 나간 양. B2B 발송은 발송예정일에
//     도매 재고를 미리 빼므로, 이걸 안 빼면 보유가 이중으로 깎인다.
//   · 유효 예약 = 표시 예약 − 소진. 3단계부터 도매 보유에서 뺄 값.
//   · 잔여 = max(0, 요청수량 − 배정 누계). 앞으로 만들 확정형 물량.
//   · 오는 중 = 시한 내 '재고 보충'(제조사) 요청서 잔여 합. 2단계에서 권장 수식이 쓴다.
//
//  규칙(문서와 1:1)
//   · 소진은 **출고 행을 한 번만 배분**한다. 요청서마다 따로 합을 구하면 같은 발송이
//     여러 요청서에서 중복 소진돼 예약이 과소해진다. 불변식: Σ소진 ≤ Σ도매 발송 출고.
//   · 거래처 매칭은 **uuid 조인**(출고 → 발송 → 발주 → 거래처)으로 한다. 거래처명 문자열은
//     이름을 바꾸면 이전 출고가 통째로 빠지고 동명 거래처가 있으면 남의 발송이 예약을 먹는다.
//   · 시한 — 도매 예약은 납품예정일 + 유예일 경과 시 제외. 오는 중은 3단(A 마감 미도래 포함 /
//     B 마감+유효일 내는 그 품목에 A가 없을 때만 / C 초과는 무조건 제외).
//   · 컬럼 미적용(082 purpose · 071 due_date · 115 company_id)은 있는 것만으로 진행한다.
//     조회 오류·행 한도 초과는 null — 호출부가 '집계 실패'를 표시한다(조용한 0 금지).

export type OpenLoadReq = {
  id: string;
  req_no: string | null;
  purpose: "재고 보충" | "도매 납품" | "프로모션";
  status: string;
  request_date: string;
  due_date: string | null;
  company_id: string | null;
  requested: number;   // 이 품목 줄의 요청수량
  allocated: number;   // 배정 누계
  remain: number;      // max(0, 요청 − 배정)
  reserved: number;    // 표시 예약 = max(0, min(배정, 요청))  (확정형만)
  consumed: number;    // 그중 나감 (도매 납품만)
  stale: boolean;      // 시한이 지나 계산에서 빠짐 — '정리 대기'
};

export type OpenLoadRow = {
  reservedShown: number;      // 도매 표시 예약
  reservedConsumed: number;   // 그중 나감
  reservedEffective: number;  // 유효 예약 = 표시 − 소진 (3단계부터 도매 보유에서 뺀다)
  wholesaleRemain: number;    // 도매 대량 잔여(시한 내)
  promoReserved: number;      // 프로모션 표시 예약(풀 잔량 상한은 호출부에서)
  promoRemain: number;        // 행사 잔여(시한 내)
  inbound: number;            // 오는 중(시한 내)
  inboundDue: string | null;  // 잔여가 있는 제조사 요청서 중 가장 이른 마감
  staleInbound: number;       // 시한이 지나 오는 중에서 빠진 제조사 잔여
  staleCommitted: number;     // 시한이 지나 ③④에서 빠질 확정형 잔여
  reqs: OpenLoadReq[];        // 근거 요청서(마감 오름차순)
};

export type OpenLoadOpts = {
  leadDays?: number;          // 마감일 없는 옛 요청서의 대체 마감 = 요청일 + 리드타임
  reserveGraceDays?: number;  // 도매 예약: 납품예정일 + N일까지 유효 (기본 7)
  inboundStaleDays?: number;  // 오는 중 3단의 B 구간 길이 (기본 7)
  committedStaleDays?: number;// 확정형 잔여 시한 (기본 14)
};

const PAGE = 1000;
const MAX_ROWS = 20000; // 이 이상이면 '집계 불확실'(null) — 열린 요청서가 이만큼 쌓이면 정리 대상
const r2 = (n: number) => Math.round(n * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

// 컬럼 오류(082/071/115 미적용)와 '테이블 자체가 없음'을 가른다 — 컬럼 오류 메시지에도 does not exist 가 들어간다
const missingTable = (m: string) => !/column/i.test(m) && /does not exist|schema cache|could not find/i.test(m);

type Resp = { data: unknown; error: { message: string } | null };
// range 페이징 전량 읽기 — 서버 Max Rows(기본 1000)가 .limit 보다 우선해 조용히 잘리는 함정 대응
async function pagedAll<T>(q: (from: number, to: number) => PromiseLike<Resp>): Promise<T[] | null> {
  const out: T[] = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await q(off, off + PAGE - 1);
    if (error) return null;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  return null; // 한도 초과 — 조용히 자르지 않고 집계 실패로 올린다
}

type Head = { id: string; req_no: string | null; status: string; request_date: string; due_date?: string | null; purpose?: string | null; company_id?: string | null };
type Item = { id: string; request_id: string; product_id: string; requested_qty: number };
type Txn = { id: string; product_id: string; qty: number; txn_date: string; shipment_id: string | null };

export async function getOpenLoad(
  sb: SupabaseClient, today: string, opts?: OpenLoadOpts,
): Promise<Map<string, OpenLoadRow> | null> {
  try {
    const leadDays = Math.max(1, Math.round(opts?.leadDays ?? 7));
    const reserveGrace = Math.max(0, Math.round(opts?.reserveGraceDays ?? 7));
    const inboundStale = Math.max(0, Math.round(opts?.inboundStaleDays ?? 7));
    const committedStale = Math.max(0, Math.round(opts?.committedStaleDays ?? 14));

    // 1) 열린 요청서 — 오류 메시지에 보이는 컬럼만 빼고 재시도한다. 그 밖의 오류는 null(조용한 0 금지).
    let withDue = true, withPurpose = true, withCompany = true;
    let heads: Head[] | null = null;
    for (let guard = 0; guard < 4 && heads === null; guard++) {
      const sel = `id, req_no, status, request_date${withDue ? ", due_date" : ""}${withPurpose ? ", purpose" : ""}${withCompany ? ", company_id" : ""}`;
      const rows = await pagedAll<Head>((a, b) => sb.from("production_requests").select(sel)
        .in("status", ["요청", "진행중"]).order("id", { ascending: true }).range(a, b));
      if (rows !== null) { heads = rows; break; }
      // pagedAll 은 오류 원문을 안 돌려주므로 단건 조회로 메시지를 확인한다
      const probe = await sb.from("production_requests").select(sel).limit(1);
      const msg = probe.error?.message ?? "";
      if (!probe.error) return null;                                  // 컬럼은 멀쩡한데 페이징 실패 = 한도 초과 등
      if (withCompany && /company_id/i.test(msg)) { withCompany = false; continue; } // 115 미적용
      if (withPurpose && /purpose/i.test(msg)) { withPurpose = false; continue; }    // 082 미적용
      if (withDue && /due_date/i.test(msg)) { withDue = false; continue; }           // 071 미적용
      if (missingTable(msg)) return new Map();                                       // 069 미적용
      return null;
    }
    if (heads === null) return null;
    const out = new Map<string, OpenLoadRow>();
    if (!heads.length) return out;
    const headById = new Map(heads.map((h) => [h.id, h]));
    const purposeOf = (h: Head): OpenLoadReq["purpose"] =>
      h.purpose === "도매 납품" ? "도매 납품" : h.purpose === "프로모션" ? "프로모션" : "재고 보충";
    // 마감일이 없는 옛 요청서는 요청일 + 리드타임을 마감으로 본다(문서 7절 경계 상황)
    const dueOf = (h: Head): string =>
      h.due_date && DATE_RE.test(h.due_date) ? h.due_date
        : DATE_RE.test(h.request_date) ? addDays(h.request_date, leadDays) : today;

    // 2) 요청 품목 — 요청서 100건씩(URL 길이) 청크, 청크 안은 페이징 전량
    const items: Item[] = [];
    const ids = heads.map((h) => h.id);
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const rows = await pagedAll<Item>((a, b) => sb.from("production_request_items")
        .select("id, request_id, product_id, requested_qty").in("request_id", part).order("id", { ascending: true }).range(a, b));
      if (rows === null) return null;
      items.push(...rows);
    }
    if (!items.length) return out;

    // 3) 배정 누계(receipts 합) — 품목 100건씩
    const allocated = new Map<string, number>();
    for (let i = 0; i < items.length; i += 100) {
      const part = items.slice(i, i + 100).map((x) => x.id);
      const rows = await pagedAll<{ item_id: string; qty: number }>((a, b) => sb.from("production_receipts")
        .select("item_id, qty").in("item_id", part).order("id", { ascending: true }).range(a, b));
      if (rows === null) return null;
      for (const rc of rows) allocated.set(rc.item_id, r2((allocated.get(rc.item_id) || 0) + (Number(rc.qty) || 0)));
    }

    // 4) 도매 대량 예약 후보를 품목별로 모은다(시한 = 납품예정일 + 유예일)
    type Cand = { item: Item; head: Head; cap: number; consumed: number };
    const candByProduct = new Map<string, Cand[]>();
    for (const it of items) {
      const h = headById.get(it.request_id);
      if (!h || purposeOf(h) !== "도매 납품") continue;
      const req = Number(it.requested_qty) || 0;
      const cap = r2(Math.max(0, Math.min(allocated.get(it.id) || 0, req)));
      if (cap <= 0) continue;
      if (today > addDays(dueOf(h), reserveGrace)) continue; // 3층 — 시한 지난 예약은 계산에서 제외
      const arr = candByProduct.get(it.product_id) ?? [];
      arr.push({ item: it, head: h, cap, consumed: 0 });
      candByProduct.set(it.product_id, arr);
    }

    // 5) 소진 — 도매 발송 출고를 '한 줄씩 한 번만' 배분한다. 불변식: Σ소진 ≤ Σ도매 발송 출고.
    if (candByProduct.size) {
      const pids = [...candByProduct.keys()];
      const txns: Txn[] = [];
      let withChannel = true;
      for (let i = 0; i < pids.length; i += 100) {
        const part = pids.slice(i, i + 100);
        const rows = await pagedAll<Txn>((a, b) => {
          let q = sb.from("inventory_txns").select("id, product_id, qty, txn_date, shipment_id")
            .eq("type", "출고").in("product_id", part)
            .not("shipment_id", "is", null)           // 도매 발송분만 — 수동 출고·엑셀·채널이동 제외
            .lte("txn_date", today);                  // 미래 컷(발송예정일이 미래인 선점 출고)
          if (withChannel) q = q.eq("channel", "도매");
          return q.order("txn_date", { ascending: true }).order("id", { ascending: true }).range(a, b);
        });
        if (rows === null) {
          if (!withChannel) return null;
          const probe = await sb.from("inventory_txns").select("channel").limit(1);
          if (probe.error && /channel/i.test(probe.error.message)) { withChannel = false; i -= 100; continue; } // 036 미적용
          return null;
        }
        txns.push(...rows);
      }

      // 출고 → 발송 → 발주 → 거래처 uuid (거래처명 문자열은 쓰지 않는다)
      const companyByTxn = new Map<string, string | null>();
      const shipIds = [...new Set(txns.map((t) => t.shipment_id).filter((v): v is string => !!v))];
      if (shipIds.length) {
        const orderByShip = new Map<string, string>();
        for (let i = 0; i < shipIds.length; i += 100) {
          const { data, error } = await sb.from("shipments").select("id, order_id").in("id", shipIds.slice(i, i + 100)).limit(5000);
          if (error) return null;
          for (const s of data ?? []) orderByShip.set(s.id as string, s.order_id as string);
        }
        const orderIds = [...new Set([...orderByShip.values()])];
        const companyByOrder = new Map<string, string | null>();
        for (let i = 0; i < orderIds.length; i += 100) {
          const { data, error } = await sb.from("orders").select("id, company_id").in("id", orderIds.slice(i, i + 100)).limit(5000);
          if (error) return null;
          for (const o of data ?? []) companyByOrder.set(o.id as string, (o.company_id as string) ?? null);
        }
        for (const t of txns) {
          const oid = t.shipment_id ? orderByShip.get(t.shipment_id) : undefined;
          companyByTxn.set(t.id, oid ? (companyByOrder.get(oid) ?? null) : null);
        }
      }

      for (const t of txns) {
        const cands = candByProduct.get(t.product_id);
        if (!cands?.length) continue;
        let left = r2(Math.abs(Number(t.qty) || 0)); // 출고는 음수로 저장된다(signedQty)
        if (left <= 0) continue;
        const txnCompany = companyByTxn.get(t.id) ?? null;
        // 후보: 요청일 이후의 출고만. 거래처가 지정된 요청서는 그 거래처 출고만 먹는다.
        //  정렬 = 거래처 일치 우선 → 납품예정일 이른 순 → 요청번호
        const pool = cands
          .filter((c) => t.txn_date >= c.head.request_date && (!c.head.company_id || c.head.company_id === txnCompany))
          .sort((a, b) =>
            Number(!!b.head.company_id && b.head.company_id === txnCompany) - Number(!!a.head.company_id && a.head.company_id === txnCompany) ||
            dueOf(a.head).localeCompare(dueOf(b.head)) ||
            String(a.head.req_no ?? "").localeCompare(String(b.head.req_no ?? "")));
        for (const c of pool) {
          if (left <= 0) break;
          const take = r2(Math.min(left, c.cap - c.consumed));
          if (take <= 0) continue;
          c.consumed = r2(c.consumed + take);
          left = r2(left - take);
        }
        // 남는 양은 버린다 — 도매 일반 출고로 본다(도매 속도가 이미 그 몫을 센다)
      }
    }

    // 6) 품목별 집계
    const consumedByItem = new Map<string, number>();
    for (const arr of candByProduct.values()) for (const c of arr) consumedByItem.set(c.item.id, c.consumed);
    const reserveLive = new Set<string>(); // 시한 내 도매 예약 후보 item_id
    for (const arr of candByProduct.values()) for (const c of arr) reserveLive.add(c.item.id);

    // 오는 중 3단의 A(마감 미도래 제조사 요청서가 있는 품목) 집합을 먼저 만든다
    const hasFresh = new Set<string>();
    for (const it of items) {
      const h = headById.get(it.request_id);
      if (!h || purposeOf(h) !== "재고 보충") continue;
      const remain = r2(Math.max(0, (Number(it.requested_qty) || 0) - (allocated.get(it.id) || 0)));
      if (remain > 0 && dueOf(h) >= today) hasFresh.add(it.product_id);
    }

    const rowOf = (pid: string): OpenLoadRow => {
      const cur = out.get(pid);
      if (cur) return cur;
      const fresh: OpenLoadRow = {
        reservedShown: 0, reservedConsumed: 0, reservedEffective: 0, wholesaleRemain: 0,
        promoReserved: 0, promoRemain: 0, inbound: 0, inboundDue: null,
        staleInbound: 0, staleCommitted: 0, reqs: [],
      };
      out.set(pid, fresh);
      return fresh;
    };

    for (const it of items) {
      const h = headById.get(it.request_id);
      if (!h) continue;
      const purpose = purposeOf(h);
      const requested = Number(it.requested_qty) || 0;
      const alloc = allocated.get(it.id) || 0;
      const remain = r2(Math.max(0, requested - alloc));
      const due = dueOf(h);
      const row = rowOf(it.product_id);
      let stale = false;

      if (purpose === "도매 납품" || purpose === "프로모션") {
        const reservedRaw = r2(Math.max(0, Math.min(alloc, requested)));
        const consumed = consumedByItem.get(it.id) ?? 0;
        stale = today > addDays(due, committedStale); // 확정형 잔여 시한
        // 예약은 잔여보다 이른 시한(납품예정일 + 유예일)을 쓴다. 시한이 지난 예약은 품목 합계에서 빠지므로
        //  요청서 배지에도 0 으로 보고하고 '시한 지남'을 켠다 — 안 그러면 툴팁 합과 셀 숫자가 어긋난다.
        const resLive = purpose === "도매 납품" ? reserveLive.has(it.id) : true;
        const reserved = resLive ? reservedRaw : 0;
        if (reservedRaw > 0 && !resLive) stale = true;
        if (purpose === "도매 납품") {
          row.reservedShown = r2(row.reservedShown + reserved);
          row.reservedConsumed = r2(row.reservedConsumed + (resLive ? consumed : 0));
          if (stale) row.staleCommitted = r2(row.staleCommitted + remain);
          else row.wholesaleRemain = r2(row.wholesaleRemain + remain);
        } else {
          row.promoReserved = r2(row.promoReserved + reserved);
          if (stale) row.staleCommitted = r2(row.staleCommitted + remain);
          else row.promoRemain = r2(row.promoRemain + remain);
        }
        if (reserved > 0 || remain > 0) {
          row.reqs.push({ id: h.id, req_no: h.req_no ?? null, purpose, status: h.status, request_date: h.request_date,
            due_date: h.due_date ?? null, company_id: h.company_id ?? null, requested, allocated: alloc, remain, reserved, consumed: resLive ? consumed : 0, stale });
        }
        continue;
      }

      // 제조사(재고 보충) — 오는 중 3단
      if (remain <= 0) continue;
      const overdueBy = today > due;
      if (!overdueBy) {                                        // A. 마감 미도래
        row.inbound = r2(row.inbound + remain);
        if (!row.inboundDue || due < row.inboundDue) row.inboundDue = due;
      } else if (today <= addDays(due, inboundStale) && !hasFresh.has(it.product_id)) {
        row.inbound = r2(row.inbound + remain);                 // B. 유효일 내 + 그 품목에 A 없음
        if (!row.inboundDue || due < row.inboundDue) row.inboundDue = due;
      } else {
        row.staleInbound = r2(row.staleInbound + remain);       // C. 무조건 제외
        stale = true;
      }
      row.reqs.push({ id: h.id, req_no: h.req_no ?? null, purpose, status: h.status, request_date: h.request_date,
        due_date: h.due_date ?? null, company_id: h.company_id ?? null, requested, allocated: alloc, remain, reserved: 0, consumed: 0, stale });
    }

    for (const row of out.values()) {
      row.reservedEffective = r2(Math.max(0, row.reservedShown - row.reservedConsumed));
      row.reqs.sort((a, b) => String(a.due_date ?? "9999").localeCompare(String(b.due_date ?? "9999")));
    }
    return out;
  } catch {
    return null;
  }
}

// 툴팁용 — "PR-000123 예약 420 · 그중 나감 200 (납품 10-07)" 를 줄바꿈으로 잇는다
export function formatOpenLoad(row: OpenLoadRow | undefined, purpose: OpenLoadReq["purpose"]): string {
  if (!row) return "";
  return row.reqs
    .filter((r) => r.purpose === purpose)
    .map((r) => {
      const head = `${r.req_no ?? "요청서"}`;
      const body = purpose === "재고 보충"
        ? `잔여 ${r.remain.toLocaleString()}`
        : `예약 ${r.reserved.toLocaleString()}${r.consumed > 0 ? ` · 그중 나감 ${r.consumed.toLocaleString()}` : ""}${r.remain > 0 ? ` · 잔여 ${r.remain.toLocaleString()}` : ""}`;
      const due = r.due_date ? ` (${purpose === "재고 보충" ? "마감" : "납품"} ${r.due_date.slice(5)})` : "";
      return `${head} ${body}${due}${r.stale ? " — 시한 지남" : ""}`;
    })
    .join("\n");
}
