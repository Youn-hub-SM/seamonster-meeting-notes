import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { matchKoQuery } from "@/app/lib/hangul";
import { allocateReceiptsToRequest, fullRequestsOfTxns, recheckRequestCompletion, type LinkResult } from "@/app/lib/production-allocate";
import { chunks, missingColumn, missingRpc, missingTable } from "@/app/lib/fulfill-db";
import { kstTodayIso } from "@/app/lib/production-schedule";
import { isMoveRow } from "@/app/lib/production-velocity";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { fulfillBatchOf, LOCK_MSG, lockKindOf, unlinkedOf } from "../txn/ledger-write";
import { DELETE as deleteOneTxn } from "../txn/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 입고처리에서 요청서를 고르면 연결·재판정을 기다린다
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// 상태 변경·취소 대상 행(select *) — 035·131 미적용에도 안전한 칸만 읽는다
type TxnRow = {
  id: string; product_id?: string; type?: string; qty?: unknown; txn_date?: string | null; status?: string | null; reason?: string | null;
  partner?: string | null; order_no?: string | null; group_id?: string | null; shipment_id?: string | null; created_by?: string | null;
  source?: string | null; source_ref?: string | null; created_at?: string | null;
};

// ── [재고 차감 기록] 묶음(온라인발주 미반영분 출고) 취소 — S9·S7 ──
//  기록할 때 fulfill/unmatched 가 그 코드를 미반영 목록(fulfill_dispatch.unmatched, 135)에서 빼거나 목록을 닫는다.
//  그래서 이 묶음 행만 지우면 재고도 안 빠지고 그 코드는 어느 목록에도 안 남는다. 목록을 '정확히' 되살릴 수 있을 때만 다시 열고,
//  아니면 확인(confirm=1)을 받은 뒤에만 지운다.
//  정확히 되살릴 수 있는 경우 = 목록이 닫혀 있고 닫힌 시각 ≤ 이 묶음 기록 시각. 목록을 닫는 쓰기는 기록의 선점과 [확인 완료]뿐이고,
//  선점 중에는 [확인 완료]·다른 기록이 못 끼어든다 — 그러니 이 묶음의 선점이 마지막으로 닫았고, 목록은 그때 그대로(기록한 코드
//  + 그때 미등록이라 남은 코드, 남은 코드를 다시 열지 못한 경우)다. 일부만 기록돼 목록이 열려 있거나 그 뒤에 닫혔으면
//  이 묶음의 원래 코드(세트 코드 포함)는 어디에도 남아 있지 않다 — 품목 코드로 지어 넣으면 매핑을 고치려고 취소한 경우 같은 품목이 또 빠진다.
type LateCode = { sku: string; qty: number };
type LateReopen = { id: string; doneAt: string; codes: LateCode[] };
const lateCodesOf = (v: unknown): LateCode[] =>
  Array.isArray(v) ? (v as { sku?: unknown; qty?: unknown }[]).filter((c) => c && typeof c.sku === "string" && Number(c.qty) > 0).map((c) => ({ sku: String(c.sku), qty: Number(c.qty) })) : [];
const tsMs = (v: unknown): number | null => {
  const t = Date.parse(String(v ?? "").replace(/(\.\d{3})\d+/, "$1")); // PostgREST 는 마이크로초까지 준다
  return Number.isFinite(t) ? t : null;
};
// 다시 열 출고 이력. null = 정확히 되살릴 수 없음(확인 필요), 'error' = 조회 실패(멈춘다, S4)
async function lateReopenPlan(sb: ReturnType<typeof supabaseAdmin>, late: TxnRow[]): Promise<LateReopen | null | "error"> {
  const refs = [...new Set(late.map((r) => String(r.source_ref ?? "")))];
  if (refs.length !== 1 || !/^[0-9a-f-]{36}$/i.test(refs[0])) return null;
  const { data, error } = await sb.from("fulfill_dispatch").select("id, dispatch_date, unmatched, unmatched_done_at").eq("id", refs[0]).maybeSingle();
  if (error) return missingTable(error) || missingColumn(error, /unmatched/i) ? null : "error";
  const row = data as { id: string; dispatch_date?: string | null; unmatched?: unknown; unmatched_done_at?: string | null } | null;
  if (!row?.unmatched_done_at) return null; // 출고 이력 없음(연결 끊김) 또는 열린 목록(일부만 기록)
  const doneMs = tsMs(row.unmatched_done_at);
  const firstMs = Math.min(...late.map((r) => tsMs(r.created_at) ?? Number.NaN));
  if (doneMs === null || !Number.isFinite(firstMs) || doneMs > firstMs) return null; // 이 묶음 뒤에 닫힘(다른 기록·[확인 완료])
  // [재고 차감 기록] 목록은 최근 60일 출고만 보여 준다(fulfill/unmatched GET 과 같은 기준) — 그보다 오래되면 다시 열어도 안 보인다
  const since = new Date(Date.now() + 9 * 3600e3 - 60 * 86400e3).toISOString().slice(0, 10);
  if (String(row.dispatch_date ?? "").slice(0, 10) < since) return null;
  const codes = lateCodesOf(row.unmatched);
  return codes.length ? { id: row.id, doneAt: row.unmatched_done_at, codes } : null;
}
const LATE_GROUP_MSG = "온라인발주 미반영분 출고([재고 차감 기록]) 묶음입니다 — 취소하면 이 코드들은 [재고 차감 기록] 목록에 다시 나오지 않습니다(일부만 기록됐거나 오래된 출고라 목록을 되살릴 수 없습니다). 고친 뒤 다시 빼려면 [입고 및 출고]의 [+ 입고/출고 기록]으로 직접 출고하세요.";
const LATE_GROUP_CONFIRM = "온라인발주 미반영분 출고 묶음입니다. 취소하면 재고는 원복되지만 이 코드들은 [재고 차감 기록] 목록에 다시 나오지 않습니다(일부만 기록됐거나 오래된 출고라 목록을 되살릴 수 없습니다). 고친 뒤 다시 빼려면 [입고 및 출고]의 [+ 입고/출고 기록]으로 직접 출고하세요.\n\n그래도 취소할까요?";
// 한 묶음(group_id)의 행 전량 — 서버 Max Rows(1000)에 잘리면 처리·취소 준비가 일부 행만 보고 결정한다(S4). 오류는 error.
async function groupRows(sb: ReturnType<typeof supabaseAdmin>, groupId: string): Promise<{ rows: TxnRow[]; error: string | null }> {
  const rows: TxnRow[] = [];
  for (let off = 0; off < 100000; off += 1000) {
    const { data, error } = await sb.from("inventory_txns").select("*").eq("group_id", groupId).order("id", { ascending: true }).range(off, off + 999);
    if (error) return { rows, error: error.message };
    rows.push(...((data ?? []) as TxnRow[]));
    if ((data ?? []).length < 1000) break;
  }
  return { rows, error: null };
}

type Raw = {
  id: string; product_id: string; type: string; qty: number; unit_amount: number | null;
  txn_date: string; partner: string | null; memo: string | null; created_by: string | null; created_at: string;
  order_no?: string | null; group_id?: string | null; status?: string | null; channel?: string | null;
  reason?: string | null; source?: string | null;
  products?: { name?: string; sku?: string | null } | null;
};

// 선택 칸 — group = 033·034·036(order_no·group_id·status·channel, 한 칸이라도 없으면 넷 다 뺀다. channel 은 이동 방향 표시용),
//  reason = 099(대기 입고처리의 고객 반품 판정), source = 131(출처 — 이동 판정 isMoveRow·온라인발주 배치 구분).
//  '칸 없음' 오류일 때만 그 칸을 빼고 다시 읽는다 — 일시 오류로 group 을 빼면 묶음이 단건으로 보여 취소가 id= 로 나가 한 줄만 지워진다(S4).
type ColSet = { group: boolean; reason: boolean; source: boolean };
const FULL_COLS = (c: ColSet) =>
  `id, product_id, type, qty, unit_amount, txn_date, partner, memo, created_by, created_at${c.group ? ", order_no, group_id, status, channel" : ""}${c.reason ? ", reason" : ""}${c.source ? ", source" : ""}, products(name, sku)`;
const GROUP_COL_RE = /order_no|group_id|status|channel/i;
const COL_MISSING_RE = /does not exist|could not find/i;
// 오류가 선택 칸 없음이면 그 칸을 끄고 true(다시 읽기). 아니면 false — 호출부는 그대로 던진다.
function degradeCols(c: ColSet, e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (!COL_MISSING_RE.test(msg)) return false;
  if (c.source && /\bsource\b/i.test(msg)) { c.source = false; return true; }
  if (c.reason && /\breason\b/i.test(msg)) { c.reason = false; return true; }
  if (c.group && GROUP_COL_RE.test(msg)) { c.group = false; return true; }
  return false;
}
// FULL_COLS 로 페이지 끝까지 읽기 — 칸 없음이면 c 를 줄여(호출부와 공유) 다시 읽는다
async function fetchFull(c: ColSet, build: (cols: string) => PagedQuery, maxRows?: number): Promise<Raw[]> {
  for (let i = 0; ; i++) {
    try { return await fetchPaged<Raw>(() => build(FULL_COLS(c)), maxRows); }
    catch (e) { if (i >= 3 || !degradeCols(c, e)) throw e; }
  }
}

// GET /api/inventory/orders?type=&from=&to=&limit=&q= — 입고/출고를 '주문(묶음)' 단위로 그룹핑.
//  group_id 로 묶고, 없으면 단건(자기 자신)으로. migration 033 미적용이면 order_no/group_id 없이 단건.
//  q(검색어)가 있으면 행 캡과 무관하게 전체 기록에서 매칭 주문을 찾는다 — 예전엔 최근 N행만 불러와
//  화면에서 걸렀는데, [전체] 탭은 입고+출고 합산이 캡을 먼저 채워 과거 매칭 건이 조용히 빠졌다.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const type = sp.get("type");
    const from = sp.get("from");
    const to = sp.get("to");
    const qWord = (sp.get("q") || "").trim();
    // before: '이전 내역 더 보기' 커서 — 지난 페이지 경계 timestamp 보다 strictly 과거(lt)만.
    //  경계 timestamp 블록은 지난 페이지가 끝까지 읽어 갔으므로(아래) 여기서 다시 주지 않는다.
    const before = /^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]{6,30}$/.test(sp.get("before") || "") ? sp.get("before")! : null;
    const limit = Math.min(4000, Math.max(1, Number(sp.get("limit")) || 1500));
    const sb = supabaseAdmin();

    let raws: Raw[];
    let capped = false;      // 행 캡 도달 = 더 과거 내역이 있을 수 있다
    let boundaryTs: string | null = null;
    if (qWord) {
      raws = await searchRaws(sb, { type, from, to, qWord });
    } else {
      const applyF = <T extends { eq: (c: string, v: string) => T; gte: (c: string, v: string) => T; lte: (c: string, v: string) => T; lt: (c: string, v: string) => T }>(q: T): T => {
        if (type === "입고" || type === "출고") q = q.eq("type", type);
        if (from && DATE_RE.test(from)) q = q.gte("txn_date", from);
        if (to && DATE_RE.test(to)) q = q.lte("txn_date", to);
        if (before) q = q.lt("created_at", before);
        return q;
      };
      const sel = (cols: string) =>
        applyF(sb.from("inventory_txns").select(cols).in("type", ["입고", "출고"]))
          .order("created_at", { ascending: false })
          .order("id", { ascending: true });
      // range 페이징 — 서버 Max Rows(기본 1000, 더 낮추지 말 것)가 limit 보다 작아도 전량 확보. 칸 없음(033·036·099·131 미적용)은 그 칸만 빼고 다시.
      const cs: ColSet = { group: true, reason: true, source: true };
      raws = await fetchFull(cs, sel, limit);
      capped = raws.length >= limit;
      if (capped && raws.length) {
        // 경계 timestamp 블록을 끝까지 마저 읽는다 — 한 insert 문으로 들어온 주문(들)의 행이
        //  캡 중간에서 잘려 품목 수·총액이 틀어지지 않게. 같은 timestamp 에 주문이 여럿(혼합 엑셀)일
        //  수도 있으므로 블록 전체를 이 페이지가 소화하고, 다음 페이지는 lt 커서로 그보다 과거만 본다.
        const last = raws[raws.length - 1];
        boundaryTs = last.created_at;
        const tail = (cols: string) =>
          applyF(sb.from("inventory_txns").select(cols).in("type", ["입고", "출고"]))
            .eq("created_at", last.created_at).gt("id", last.id)
            .order("id", { ascending: true });
        raws.push(...await fetchFull(cs, tail, 30000));
      }
    }

    // group_id 로 묶기(없으면 id 단건)
    const map = new Map<string, ReturnType<typeof emptyOrder>>();
    function emptyOrder(r: Raw) {
      return {
        // grouped: 화면이 취소·처리 시 group_id= / id= 를 고르는 기준 — 주문번호 유무로 고르면 이동(번호 없음·group 있음)이 id 로 나가 아무것도 안 지워진다.
        key: r.group_id || r.id, grouped: !!r.group_id, order_no: r.order_no || null, type: r.type, status: r.status || "완료",
        txn_date: r.txn_date, created_at: r.created_at, partner: r.partner, memo: r.memo, created_by: r.created_by,
        move_from: null as string | null, move_to: null as string | null, // 이동 행의 출고 칸 → 입고 칸(배지 표시용)
        // is_move: 칸 이동·프로모션 합류 묶음(isMoveRow — 출처 칸 source 우선, 131 이전 행은 주문번호 없는 partner '채널이동').
        //  화면이 partner 글자 대신 이 값으로 이동 묶음을 고른다(S11). source: 묶음의 출처(131 — fulfill·fulfill_unmatched 등, 없으면 null).
        is_move: false, source: null as string | null,
        item_count: 0, total_qty: 0, total_amount: 0,
        // product_id·reason(099)·source(131) — 대기 입고처리의 품목별 요청서 잔여 확인·고객 반품 판정·출처 구분용(칸이 없으면 null)
        items: [] as { id: string; product_id: string; product_name: string; sku: string | null; qty: number; unit_amount: number | null; amount: number; reason: string | null; source: string | null }[],
      };
    }
    for (const r of raws) {
      const k = r.group_id || r.id;
      const o = map.get(k) || emptyOrder(r);
      // 소매↔도매 이동은 출고+입고 두 행이 한 묶음 — 첫 행 유형(무작위)으로 배지가 찍히면
      //  [전체] 탭에서 입고/출고 집계가 어긋나 보인다. 두 유형이 섞이면 '이동'으로 명시.
      if (o.type !== "이동" && r.type !== o.type) o.type = "이동";
      if (r.channel) { if (r.type === "출고") o.move_from = o.move_from ?? r.channel; else if (r.type === "입고") o.move_to = o.move_to ?? r.channel; }
      const absQty = Math.abs(Number(r.qty) || 0);
      const amount = (Number(r.unit_amount) || 0) * absQty;
      o.items.push({ id: r.id, product_id: r.product_id, product_name: r.products?.name || "(삭제됨)", sku: r.products?.sku ?? null, qty: absQty, unit_amount: r.unit_amount, amount,
        reason: r.reason ?? null, source: r.source ?? null });
      if (isMoveRow(r)) o.is_move = true;
      if (!o.source && r.source) o.source = r.source;
      o.item_count += 1; o.total_qty += absQty; o.total_amount += amount;
      if (!o.memo && r.memo) o.memo = r.memo;
      if (!o.partner && r.partner) o.partner = r.partner;
      map.set(k, o);
    }
    const orders = [...map.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    // capped 면 경계 블록보다 과거 내역이 남아 있을 수 있다(없으면 다음 페이지가 빈 목록으로 끝난다).
    const more = !qWord && capped && !!boundaryTs;
    return NextResponse.json({ ok: true, orders, more, next_before: more ? boundaryTs : null });
  } catch (err) {
    console.error("[inventory/orders GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "주문 조회 실패") }, { status: 500 });
  }
}

// range 페이징 — limit/서버 max-rows 캡(기본 1000)이 결과를 조용히 자르는 것을 막는다(이 버그의 원형).
//  정확히 maxRows 행까지 읽는다. 페이징 안정성을 위해 호출부는 order 를 걸어 둔다.
type PagedQuery = { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };
async function fetchPaged<T>(build: () => PagedQuery, maxRows = 30000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < maxRows; i += 1000) {
    const upto = Math.min(i + 999, maxRows - 1);
    const { data, error } = await build().range(i, upto);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < upto - i + 1) break;
  }
  return out;
}

// 검색어로 전체 기록에서 매칭 주문의 행을 모두 찾는다.
//  1) 품목 마스터에서 이름·SKU 매칭(화면 검색과 같은 초성·영문자판 규칙 = matchKoQuery)
//  2) 매칭 품목의 거래 행 + 거래처/주문번호 부분일치 행에서 주문 키(group_id, 없으면 단건 id)를 모으고
//  3) 그 주문의 행을 다시 불러온다 — 행 단위로만 거르면 같은 주문의 다른 품목이 잘려
//     품목 수·총액이 틀어지기 때문. 단 유형·기간 필터는 재적용한다: 소매↔도매 이동은 출고+입고
//     두 행이 한 group_id 를 쓰고, 엑셀 업로드 그룹은 여러 날짜에 걸칠 수 있어, 필터 없이 그룹
//     전체를 실으면 무검색 화면과 품목 수·총액이 달라진다. in-list 는 URL 로 나가므로 100개씩 청크.
async function searchRaws(
  sb: ReturnType<typeof supabaseAdmin>,
  f: { type: string | null; from: string | null; to: string | null; qWord: string },
): Promise<Raw[]> {
  const { type, from, to, qWord } = f;
  const applyFilters = <T extends { eq: (c: string, v: string) => T; gte: (c: string, v: string) => T; lte: (c: string, v: string) => T }>(q: T): T => {
    if (type === "입고" || type === "출고") q = q.eq("type", type);
    if (from && DATE_RE.test(from)) q = q.gte("txn_date", from);
    if (to && DATE_RE.test(to)) q = q.lte("txn_date", to);
    return q;
  };

  // 1) 품목 매칭
  const { data: prods, error: pErr } = await sb.from("products").select("id, name, sku").limit(5000);
  if (pErr) throw pErr;
  const pids = (prods ?? [])
    .filter((p) => matchKoQuery(`${p.name || ""} ${p.sku || ""}`, qWord))
    .map((p) => p.id as string);

  // 2) 주문 키 수집 — 033 미적용이면 group_id 컬럼이 없으므로 id 만으로 폴백.
  //    각 청크는 페이징으로 전량 읽는다(limit 캡이면 어떤 행이 빠질지 비결정적이라 증상이 재발한다).
  let cols = "id, group_id";
  const groupKeys = new Set<string>();
  const soloIds = new Set<string>();
  type KeyRow = { id: string; group_id?: string | null };
  const collect = (rows: KeyRow[]) => {
    for (const r of rows) { if (r.group_id) groupKeys.add(r.group_id); else soloIds.add(r.id); }
  };
  const find = (c: string) =>
    applyFilters(sb.from("inventory_txns").select(c).in("type", ["입고", "출고"]))
      .order("created_at", { ascending: false }).order("id", { ascending: true });
  const collectFrom = async (mk: (c: string) => PagedQuery, fallbackRe: RegExp) => {
    try {
      collect(await fetchPaged<KeyRow>(() => mk(cols), 10000));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (cols !== "id" && fallbackRe.test(msg)) { cols = "id"; collect(await fetchPaged<KeyRow>(() => mk(cols), 10000)); }
      else throw e;
    }
  };

  for (let i = 0; i < pids.length; i += 100) {
    const part = pids.slice(i, i + 100);
    await collectFrom((c) => find(c).in("product_id", part), /group_id/i);
  }

  // 거래처·주문번호 부분일치 — or() 문법을 깨는 문자는 '구분자'로 취급해 토큰을 나눈다.
  //  지워 붙이면 "(주)씨몬스터" 가 "주씨몬스터" 연속 패턴이 돼 실제 값과 어긋난다(회귀 확인).
  //  여러 토큰은 모두 포함(and) — 화면 검색과 같은 AND 의미.
  const tokens = qWord.split(/[\s,()%\\"'*]+/).filter(Boolean);
  if (tokens.length) {
    const andOf = (col: string) =>
      tokens.length === 1 ? `${col}.ilike.*${tokens[0]}*` : `and(${tokens.map((t) => `${col}.ilike.*${t}*`).join(",")})`;
    await collectFrom(
      (c) => find(c).or(c === "id" ? andOf("partner") : `${andOf("partner")},${andOf("order_no")}`),
      /group_id|order_no/i,
    );
  }

  // 3) 주문 행 로드(중복 제거) — 유형·기간 필터를 재적용해 무검색 화면과 같은 기준으로 싣고,
  //    청크마다 페이징 전량 로드(잘리면 품목 수·총액이 틀어진다).
  const raws: Raw[] = [];
  const seen = new Set<string>();
  const push = (rows: Raw[]) => { for (const r of rows) { if (!seen.has(r.id)) { seen.add(r.id); raws.push(r); } } };
  // 033은 있는데 034(status)·036 만 없는 환경 — 그룹 키는 유효하니 select 만 줄여 재시도(099·131 칸도 같은 방식)
  const cs: ColSet = { group: cols !== "id", reason: true, source: true };
  const loadChunk = async (col: "group_id" | "id", vals: string[]) => {
    const mk = (c: string) =>
      applyFilters(sb.from("inventory_txns").select(c).in(col, vals))
        .order("created_at", { ascending: false }).order("id", { ascending: true });
    push(await fetchFull(cs, mk));
  };
  const gk = [...groupKeys].slice(0, 2000); // 검색 결과 상한 — 이 규모면 검색어가 무의미한 수준
  for (let i = 0; i < gk.length; i += 100) await loadChunk("group_id", gk.slice(i, i + 100));
  const si = [...soloIds].slice(0, 2000);
  for (let i = 0; i < si.length; i += 100) await loadChunk("id", si.slice(i, i + 100));
  return raws;
}

// PATCH { group_id?|id?, status, date?, request_id? } — 입고처리/출고처리(대기→완료) 등 상태 전환.
//  완료로 바꿀 때 거래일 = 실제 처리일(date, 기본 오늘 KST, 미래 거절) — 대기로 만든 날짜로 완료가 반영되면
//  과거 날짜 실사·as-of 재고가 실제와 어긋나고, 미래 날짜 대기를 그대로 완료하면 미래 '완료'가 오늘 재고에 섞인다(S6).
//  이동 짝 한 줄·B2B 연동 행은 여기서 바꾸지 않는다. 대기로 되돌리기는 사람이 쓴 입출고만(연동·연결 행은 취소 후 다시 기록).
//  request_id: 입고를 완료로 바꿀 때 연결할 제조사 요청서(지정 매칭 — 즉시 처리 입고와 같은 함수). 없으면 연결 안내를 싣는다.
export async function PATCH(req: NextRequest) {
  try {
    const b = (await req.json()) as { group_id?: string; id?: string; status?: string; date?: string; request_id?: string };
    const status = b.status === "대기" ? "대기" : "완료";
    const today = kstTodayIso();
    let date = today;
    if (status === "완료" && b.date) {
      if (!DATE_RE.test(b.date)) return NextResponse.json({ ok: false, error: "처리일 형식이 올바르지 않습니다." }, { status: 400 });
      if (b.date > today) return NextResponse.json({ ok: false, error: "처리일은 오늘 이후로 할 수 없습니다." }, { status: 400 });
      date = b.date;
    }
    if (!b.group_id && !b.id) return NextResponse.json({ ok: false, error: "group_id 또는 id 가 필요합니다." }, { status: 400 });
    const requestId = status === "완료" && /^[0-9a-f-]{36}$/i.test(String(b.request_id || "")) ? String(b.request_id) : null;
    const sb = supabaseAdmin();
    // 대상 행 확인 — * = 035·131 미적용에도 안전. 묶음은 페이지 끝까지(서버 Max Rows 1000 에 잘리면 일부 행만 처리된다, S4).
    let list: TxnRow[];
    if (b.group_id) {
      const g = await groupRows(sb, b.group_id);
      if (g.error) throw new Error(g.error);
      list = g.rows;
    } else {
      const { data, error: ce } = await sb.from("inventory_txns").select("*").eq("id", b.id!);
      if (ce) throw ce;
      list = (data ?? []) as TxnRow[];
    }
    if (!list.length) return NextResponse.json({ ok: false, error: "처리할 기록을 찾지 못했습니다 — 새로고침 후 다시 시도하세요." }, { status: 404 });
    const locks = list.map((r) => lockKindOf(r));
    const b2bLock = locks.find((k) => k === "b2b_ship" || k === "b2b_kept");
    if (b2bLock) return NextResponse.json({ ok: false, code: `locked_${b2bLock}`, error: LOCK_MSG[b2bLock] }, { status: 409 });
    if (!b.group_id && locks.includes("move"))
      return NextResponse.json({ ok: false, error: "재고 이동 기록은 한 줄만 바꿀 수 없습니다 — 묶음으로 처리하세요." }, { status: 409 });
    const targets = list.filter((r) => (r.status || "완료") !== status);
    // 이미 그 상태 — 요청서를 골랐으면 아래에서 연결만 마저 한다(첫 요청이 처리 뒤 연결 전에 끊긴 재시도). 연결은 원장 건별로 한 번만 붙는다.
    if (!targets.length && !requestId) return NextResponse.json({ ok: true, changed: 0 });
    if (status === "대기") {
      // 완료 → 대기는 재고에서 조용히 빠지는 변경이라 사람이 쓴 입출고만 받는다.
      //  이동·합류(짝 칸이 함께 움직였다)·온라인발주 출고(처리완료 주문은 남는다)·요청서에 연결된 입고(이행이 대기 물건을 센다)는 막는다.
      if (locks.includes("move"))
        return NextResponse.json({ ok: false, error: "재고 이동 기록은 대기로 되돌릴 수 없습니다 — 취소 후 다시 기록하세요." }, { status: 409 });
      let fulfill = targets.some((r) => String(r.source ?? "").startsWith("fulfill"));
      if (!fulfill) {
        const batch = await fulfillBatchOf(sb, targets[0]); // 묶음은 한 group_id — 131 전 배치 행은 출고 이력으로 확인
        if (batch === "error") return NextResponse.json({ ok: false, error: "처리 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
        fulfill = !!batch;
      }
      if (fulfill)
        return NextResponse.json({ ok: false, error: "온라인발주 출고는 대기로 되돌릴 수 없습니다 — [입고 및 출고]에서 묶음으로 취소하세요." }, { status: 409 });
      const inIds = targets.filter((r) => r.type === "입고").map((r) => r.id);
      const open = await unlinkedOf(sb, inIds);
      if (open === null) return NextResponse.json({ ok: false, error: "처리 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
      if (open.size < inIds.length)
        return NextResponse.json({ ok: false, error: "요청서에 연결된 입고가 있어 대기로 되돌릴 수 없습니다 — 생산 요청에서 [연결 해제] 후 다시 시도하세요." }, { status: 409 });
    }
    // 실제로 상태가 바뀌는 행만 갱신 — 생산요청 매칭이 같은 행을 두 번 연결하지 않게
    const patch = status === "완료" ? { status, txn_date: date } : { status };
    const changedRows: TxnRow[] = [];
    const ids = targets.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("inventory_txns").update(patch).in("id", ids.slice(i, i + 100)).neq("status", status).select("*");
      if (error) throw error;
      changedRows.push(...((data ?? []) as TxnRow[]));
    }
    // 대기 → 완료가 된 입고 — 요청서를 골랐으면 그 요청서에 연결(즉시 처리 입고와 같은 지정 매칭), 아니면 연결 안내.
    //  고객 반품(D4b)·이동은 매입이 아니라 연결 대상이 아니다. 연결이 실패해도 처리(재고)는 유지 — 결과만 싣는다.
    let link: LinkResult | null = null;
    let notice: string | null = null;
    //  이번에 바뀐 행이 없으면(재시도) 이미 완료된 이 묶음의 입고를 대상으로 한다 — allocateReceiptsToRequest 가 원장 건별 남은 양만 붙인다(S2).
    const pool = changedRows.length ? changedRows : list.filter((r) => (r.status || "완료") === "완료");
    const received = status === "완료"
      ? pool.filter((r) => r.type === "입고" && Number(r.qty) > 0 && r.reason !== "고객 반품" && r.source !== "customer_return" && !lockKindOf(r)) // 요청서 link 라우트와 같은 고객 반품 판정
      : [];
    if (received.length) {
      if (requestId) {
        try {
          link = await allocateReceiptsToRequest(sb, requestId,
            received.map((r) => ({ inv_txn_id: r.id, product_id: String(r.product_id), qty: Number(r.qty), receipt_date: r.txn_date || date })),
            await actor(req));
        } catch (e) {
          console.warn("[inventory/orders PATCH] 요청서 연결 실패", e);
          link = { ok: false, reason: "요청서 연결에 실패했습니다 — 생산 요청에서 그 요청서의 [입고 연결]로 다시 연결하세요(재고는 반영됐습니다).", lines: [] };
        }
      } else {
        notice = "요청서에 연결되지 않았습니다 — 생산 입고면 생산 요청에서 그 요청서의 [입고 연결]로 연결하세요.";
      }
    }
    return NextResponse.json({ ok: true, changed: changedRows.length, txn_date: status === "완료" ? date : undefined, link, notice });
  } catch (err) {
    console.error("[inventory/orders PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}

// 135 미적용 취소 폴백용 — 같은 서명(배치 서명에 주문 키 집합이 섞여 있어 같은 서명 = 같은 주문)을 출고한 다른 배치.
//  출고 이력 행이 있는 배치를 먼저, 없으면 이력 행 없이 재고 행만 있는 배치(같은 날 다시 출고, 131 source_ref = 서명). 'error' = 조회 실패.
async function sameSigHeir(sb: ReturnType<typeof supabaseAdmin>, sig: string, groupId: string): Promise<{ orderNo: string | null } | null | "error"> {
  if (!sig) return null;
  const d = await sb.from("fulfill_dispatch").select("group_id, order_no").eq("sig", sig).neq("group_id", groupId).order("created_at", { ascending: false }).limit(1);
  if (d.error) return "error";
  if (d.data?.length) return { orderNo: (d.data[0] as { order_no?: string | null }).order_no || null };
  const t = await sb.from("inventory_txns").select("group_id, order_no").eq("source", "fulfill").eq("source_ref", sig).neq("group_id", groupId).order("created_at", { ascending: false }).limit(1);
  if (t.error) return missingColumn(t.error, /source/i) ? null : "error";
  return t.data?.length ? { orderNo: (t.data[0] as { order_no?: string | null }).order_no || null } : null;
}

// DELETE ?group_id= | ?id= [&confirm=1] — 주문(묶음) 전체 취소, 또는 단건. 온라인발주 출고 배치는 처리완료 주문 기록도 함께 지운다.
//  [재고 차감 기록] 묶음은 미반영 목록을 되살리거나(성공 응답 notice), 되살릴 수 없으면 409 code 'confirm_required'(error·confirm 문구).
export async function DELETE(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const groupId = sp.get("group_id");
    const id = sp.get("id");
    const sb = supabaseAdmin();
    // 083(cascade) 이후: 생산요청과 연결된 입고 취소 시 요청 쪽 기록도 함께 원복. 미적용(restrict)이면 안내.
    const friendly = (e: { message: string }) =>
      /production_receipts/i.test(e.message)
        ? NextResponse.json({ ok: false, error: "생산 요청과 연결된 입고가 포함돼 있습니다 — migration 083 적용 후에는 여기서 취소하면 요청 기록도 함께 원복됩니다. (지금은 생산 요청 화면의 입고 이력에서 취소하세요)" }, { status: 409 })
        : null;
    // 삭제 전에 '지금 100% 완료'인 연결 요청서를 잡아 두고, 삭제 뒤 100% 아래로 내려갔으면 자동 재개(마감 원복).
    const prepFail = () => NextResponse.json({ ok: false, error: "취소 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
    // 이동(채널이동 짝)·B2B 연동 행(선점·발송 후 취소 미반품)은 여기서 지우지 않는다 — 이동은 [재고 이동] 취소(음수 가드·재개 판정),
    //  선점은 발송일정에서(cascade 원복), 미반품 출고는 발주 복구로 정리. txn DELETE 와 같은 판정(lockKindOf, 131 출처 칸 우선).
    //  화면은 이동을 move DELETE 로 보내지만, 직접 호출·구 화면을 위해 서버에서도 막는다.
    const locked = (rows: TxnRow[]) => {
      const k = rows.map((r) => lockKindOf(r)).find(Boolean);
      return k ? NextResponse.json({ ok: false, code: `locked_${k}`, error: LOCK_MSG[k] }, { status: 409 }) : null;
    };
    // 0행 삭제는 실패로 — 예전엔 ok:true 라 화면이 '취소됨'으로 믿고 다시 옮겨 이중 이동이 났다.
    const notFound = () => NextResponse.json({ ok: false, error: "취소할 기록을 찾지 못했습니다 — 새로고침 후 다시 시도하세요." }, { status: 404 });
    let fullBefore: string[] | null = [];
    let notice: string | null = null; // 성공 안내(예: [재고 차감 기록] 목록에 다시 올림)
    if (groupId) {
      const g = await groupRows(sb, groupId); // 페이지 끝까지 — 잘리면 재개할 요청서를 빠뜨린다(S4)
      if (g.error) return prepFail();
      const ids = g.rows;
      if (!ids.length) return notFound();
      const lk = locked(ids);
      if (lk) return lk;
      fullBefore = await fullRequestsOfTxns(sb, ids.map((r) => String(r.id)));
      if (fullBefore === null) return prepFail();
      // 온라인발주 출고 배치(fulfill_dispatch) — 재고 행만 지우면 '처리완료 주문' 키·출고 이력이 남아, 고친 파일을
      //  다시 올릴 때 그 주문이 '이미 처리된 주문'으로 빠진다(S7). 셋을 한 트랜잭션으로 지운다(135 RPC).
      const fd = await sb.from("fulfill_dispatch").select("id, order_no, sig").eq("group_id", groupId).limit(20);
      if (fd.error && !missingTable(fd.error)) return prepFail();
      // 출고 이력 행이 없는 온라인발주 출고 배치(131 source 'fulfill') — 같은 날 같은 배치를 다시 출고(force)하면 이력 유니크(sig, 날짜)에
      //  막혀 행이 없다. 재고 행만 지우지 않고 같은 RPC 로 취소한다 — 이 배치가 등록한 처리완료 키가 있으면 같은 서명의 다른 배치로
      //  넘기거나(그 배치가 같은 주문을 출고) 지운다(S7). 135 미적용이면 키에 배치 칸이 없어 가려낼 키가 없다 — 재고 행만 지운다.
      //  135 를 10-11 2차 수정 전 판으로만 적용했으면(fulfill_dispatch.keys 칸 없음) 함수가 키를 넘기지 않고 지운다 — 그때도 재고 행만.
      let newRpc = false;
      if (!fd.data?.length && ids.some((r) => r.source === "fulfill")) {
        const probe = await sb.from("fulfill_dispatch").select("keys").limit(1);
        if (probe.error && !missingColumn(probe.error, /\bkeys\b/i) && !missingTable(probe.error)) return prepFail();
        newRpc = !probe.error;
      }
      if (newRpc) {
        const rpc = await sb.rpc("cancel_fulfill_dispatch", { p_group: groupId });
        if (!rpc.error) {
          if (!Number(rpc.data)) return notFound();
        } else if (missingRpc(rpc.error)) {
          const { data: del, error } = await sb.from("inventory_txns").delete().eq("group_id", groupId).select("id");
          if (error) { const f = friendly(error); if (f) return f; throw error; }
          if (!del?.length) return notFound();
        } else { const f = friendly(rpc.error); if (f) return f; throw rpc.error; }
      } else if (fd.data?.length) {
        // 이 배치의 늦은 출고([재고 차감 기록] — source 'fulfill_unmatched', source_ref = 출고 이력 id, 131). 남기면 고친 파일을
        //  다시 출고할 때 그 코드가 또 차감된다(S3·S7). 135 RPC 가 함께 지우지만, 고치기 전 함수가 적용돼 있어도 남지 않게
        //  미리 잡아 두고 뒤에서 한 번 더 지운다. 131 미적용이면 칸이 없다 — 그때는 늦은 출고가 기록되지 않는다(unmatched 라우트가 막음).
        let lateIds: string[] = [];
        const lr = await sb.from("inventory_txns").select("id").eq("source", "fulfill_unmatched").in("source_ref", fd.data.map((d) => String(d.id))).limit(5000);
        if (lr.error) { if (!missingColumn(lr.error, /source/i)) return prepFail(); }
        else lateIds = (lr.data ?? []).map((r) => String(r.id));
        const lateOrderNo = (fd.data[0] as { order_no?: string | null }).order_no || "";
        const dropLate = async () => {
          for (const part of chunks(lateIds, 100)) {
            const { error } = await sb.from("inventory_txns").delete().in("id", part);
            if (error) return NextResponse.json({ ok: false, error: `재고는 원복됐지만 이 배치의 미반영분 출고${lateOrderNo ? `(출고번호 ${lateOrderNo})` : ""}를 취소하지 못했습니다 — 목록에서 그 묶음도 취소하세요.` }, { status: 500 });
          }
          return null;
        };
        // 이 배치가 등록한 처리완료 키 — 취소 뒤에도 남은 것은 다른 배치도 같은 주문을 출고해 그 배치로 넘어간 것(135 RPC).
        //  사람이 알 수 있게 안내만 한다(읽기 실패면 안내만 생략 — 취소 판단에 쓰지 않는다).
        const ownKeys: string[] = [];
        for (let off = 0; off < 100000; off += 1000) {
          const { data, error } = await sb.from("fulfill_order_keys").select("key").eq("group_id", groupId).order("key", { ascending: true }).range(off, off + 999);
          if (error) { ownKeys.length = 0; break; }
          ownKeys.push(...(data ?? []).map((r) => String(r.key)));
          if ((data ?? []).length < 1000) break;
        }
        const rpc = await sb.rpc("cancel_fulfill_dispatch", { p_group: groupId });
        if (!rpc.error) {
          if (!Number(rpc.data)) return notFound();
          let kept = 0;
          for (const part of chunks(ownKeys, 150)) {
            const { count, error } = await sb.from("fulfill_order_keys").select("key", { count: "exact", head: true }).in("key", part);
            if (error) { kept = 0; break; }
            kept += count ?? 0;
          }
          if (kept) notice = "이 배치 주문 중 다른 배치로도 출고된 주문은 처리완료로 남겼습니다 — 같은 파일을 다시 올려도 그 주문은 자동 제외됩니다.";
        } else if (missingRpc(rpc.error)) {
          // 135 미적용 — 재고 행 → 키 → 이력 순으로. 뒤 둘이 실패하면 그대로 알린다(재고는 이미 원복).
          const { data: del, error } = await sb.from("inventory_txns").delete().eq("group_id", groupId).select("id");
          if (error) { const f = friendly(error); if (f) return f; throw error; }
          if (!del?.length) return notFound();
          const head = fd.data[0] as { order_no?: string | null; sig?: string | null };
          const orderNo = head.order_no;
          // 같은 서명(= 같은 주문)을 출고한 다른 배치가 있으면 키를 지우지 않고 그 배치 출고번호로 넘긴다 — 지우면 그 배치가 출고한
          //  주문이 다음 누적 파일에 다시 실린다(135 RPC ①과 같은 판정). 그 배치에 출고번호가 없으면 키를 그대로 둔다.
          let kd: { error: { message: string; code?: string } | null } = { error: null };
          if (orderNo) {
            const heir = await sameSigHeir(sb, String(head.sig || ""), groupId);
            if (heir === "error") kd = { error: { message: "같은 배치 확인 실패" } };
            else if (!heir) kd = await sb.from("fulfill_order_keys").delete().eq("order_no", orderNo);
            else if (heir.orderNo) kd = await sb.from("fulfill_order_keys").update({ order_no: heir.orderNo }).eq("order_no", orderNo);
          }
          const dd = await sb.from("fulfill_dispatch").delete().eq("group_id", groupId);
          if ((kd.error && !missingTable(kd.error)) || dd.error)
            return NextResponse.json({ ok: false, error: "재고는 원복됐지만 이 배치의 '처리완료 주문' 기록을 지우지 못했습니다 — 같은 주문을 다시 올리면 자동 제외됩니다. migration 135 적용 후 관리자에게 알려 주세요." }, { status: 500 });
        } else { const f = friendly(rpc.error); if (f) return f; throw rpc.error; }
        const lateFail = await dropLate();
        if (lateFail) return lateFail;
      } else {
        // [재고 차감 기록] 묶음 — 미반영 목록을 정확히 되살릴 수 있으면 지운 뒤 다시 열고, 아니면 확인 후에만 지운다(위 lateReopenPlan).
        const late = ids.filter((r) => r.source === "fulfill_unmatched");
        let reopen: LateReopen | null = null;
        if (late.length) {
          const plan = await lateReopenPlan(sb, late);
          if (plan === "error") return prepFail();
          reopen = plan;
          if (!reopen && sp.get("confirm") !== "1")
            return NextResponse.json({ ok: false, code: "confirm_required", error: LATE_GROUP_MSG, confirm: LATE_GROUP_CONFIRM }, { status: 409 });
        }
        const { data: del, error } = await sb.from("inventory_txns").delete().eq("group_id", groupId).select("id");
        if (error) { const f = friendly(error); if (f) return f; throw error; }
        if (!del?.length) return notFound();
        if (reopen) {
          // 재고 행을 먼저 지운 뒤 연다 — 거꾸로 하면 지우기가 실패했을 때 목록에도 있고 재고도 빠진 채라 다시 기록하면 두 번 빠진다.
          //  닫힌 시각이 그대로일 때만(그 사이 다른 기록이 목록을 바꾸지 않았을 때) 연다. 못 열면 코드를 알린다(S9).
          const { data: up, error: ue } = await sb.from("fulfill_dispatch").update({ unmatched_done_at: null })
            .eq("id", reopen.id).eq("unmatched_done_at", reopen.doneAt).select("id");
          if (ue || !up?.length)
            return NextResponse.json({ ok: false, error: `재고는 원복됐지만 이 코드들을 [재고 차감 기록] 목록에 다시 올리지 못했습니다 — 적어 두고 고친 뒤 [입고 및 출고]에서 직접 출고하세요: ${reopen.codes.map((c) => `${c.sku} ${c.qty.toLocaleString()}개`).join(", ")}` }, { status: 500 });
          notice = `코드 ${reopen.codes.length}개를 온라인발주 화면의 [재고 차감 기록] 목록에 다시 올렸습니다.`;
        }
      }
    } else if (id) {
      // 단건 — txn DELETE(?id=&confirm=, 같은 파라미터)와 한 판정·한 경로로 처리한다(S1): 잠금(lockKindOf), 온라인발주 배치 한 줄 확인,
      //  배치의 마지막 줄이면 출고 이력에 '재고 행 없음' 표식(다시 올린 파일이 '중단된 출고'로 또 차감되지 않게), 요청서 재개.
      return deleteOneTxn(req);
    } else {
      return NextResponse.json({ ok: false, error: "group_id 또는 id 가 필요합니다." }, { status: 400 });
    }
    if (fullBefore.length) { try { await recheckRequestCompletion(sb, fullBefore, "입고 취소", "reopen"); } catch { /* 재개 실패는 취소를 막지 않는다 */ } }
    return NextResponse.json({ ok: true, ...(notice ? { notice } : {}) });
  } catch (err) {
    console.error("[inventory/orders DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
