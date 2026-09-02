import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { matchKoQuery } from "@/app/lib/hangul";
import { allocateReceiptsToOpenRequests } from "@/app/lib/production-allocate";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const dynamic = "force-dynamic";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Raw = {
  id: string; product_id: string; type: string; qty: number; unit_amount: number | null;
  txn_date: string; partner: string | null; memo: string | null; created_by: string | null; created_at: string;
  order_no?: string | null; group_id?: string | null; status?: string | null;
  products?: { name?: string; sku?: string | null } | null;
};

const FULL_COLS = (withGroup: boolean) =>
  `id, product_id, type, qty, unit_amount, txn_date, partner, memo, created_by, created_at${withGroup ? ", order_no, group_id, status" : ""}, products(name, sku)`;

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
      const sel = (withGroup: boolean) =>
        applyF(sb.from("inventory_txns").select(FULL_COLS(withGroup)).in("type", ["입고", "출고"]))
          .order("created_at", { ascending: false })
          .order("id", { ascending: true });
      // range 페이징 — 서버 Max Rows(기본 1000, 더 낮추지 말 것)가 limit 보다 작아도 전량 확보
      let wg = true;
      try {
        raws = await fetchPaged<Raw>(() => sel(true), limit);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/order_no|group_id|status/i.test(msg)) { wg = false; raws = await fetchPaged<Raw>(() => sel(false), limit); } // 033 미적용 폴백
        else throw e;
      }
      capped = raws.length >= limit;
      if (capped && raws.length) {
        // 경계 timestamp 블록을 끝까지 마저 읽는다 — 한 insert 문으로 들어온 주문(들)의 행이
        //  캡 중간에서 잘려 품목 수·총액이 틀어지지 않게. 같은 timestamp 에 주문이 여럿(혼합 엑셀)일
        //  수도 있으므로 블록 전체를 이 페이지가 소화하고, 다음 페이지는 lt 커서로 그보다 과거만 본다.
        const last = raws[raws.length - 1];
        boundaryTs = last.created_at;
        const tail = () =>
          applyF(sb.from("inventory_txns").select(FULL_COLS(wg)).in("type", ["입고", "출고"]))
            .eq("created_at", last.created_at).gt("id", last.id)
            .order("id", { ascending: true });
        raws.push(...await fetchPaged<Raw>(() => tail(), 30000));
      }
    }

    // group_id 로 묶기(없으면 id 단건)
    const map = new Map<string, ReturnType<typeof emptyOrder>>();
    function emptyOrder(r: Raw) {
      return {
        key: r.group_id || r.id, order_no: r.order_no || null, type: r.type, status: r.status || "완료",
        txn_date: r.txn_date, created_at: r.created_at, partner: r.partner, memo: r.memo, created_by: r.created_by,
        item_count: 0, total_qty: 0, total_amount: 0,
        items: [] as { id: string; product_name: string; sku: string | null; qty: number; unit_amount: number | null; amount: number }[],
      };
    }
    for (const r of raws) {
      const k = r.group_id || r.id;
      const o = map.get(k) || emptyOrder(r);
      const absQty = Math.abs(Number(r.qty) || 0);
      const amount = (Number(r.unit_amount) || 0) * absQty;
      o.items.push({ id: r.id, product_name: r.products?.name || "(삭제됨)", sku: r.products?.sku ?? null, qty: absQty, unit_amount: r.unit_amount, amount });
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
  let wg = cols !== "id";
  const loadChunk = async (col: "group_id" | "id", vals: string[]) => {
    const mk = (withGroup: boolean) =>
      applyFilters(sb.from("inventory_txns").select(FULL_COLS(withGroup)).in(col, vals))
        .order("created_at", { ascending: false }).order("id", { ascending: true });
    try {
      push(await fetchPaged<Raw>(() => mk(wg)));
    } catch (e) {
      // 033은 있는데 034(status) 만 없는 환경 — 그룹 키는 유효하니 select 만 줄여 재시도
      const msg = e instanceof Error ? e.message : String(e);
      if (wg && /order_no|group_id|status/i.test(msg)) { wg = false; push(await fetchPaged<Raw>(() => mk(false))); }
      else throw e;
    }
  };
  const gk = [...groupKeys].slice(0, 2000); // 검색 결과 상한 — 이 규모면 검색어가 무의미한 수준
  for (let i = 0; i < gk.length; i += 100) await loadChunk("group_id", gk.slice(i, i + 100));
  const si = [...soloIds].slice(0, 2000);
  for (let i = 0; i < si.length; i += 100) await loadChunk("id", si.slice(i, i + 100));
  return raws;
}

// PATCH { group_id?|id?, status } — 입고처리/출고처리(대기→완료) 등 상태 전환.
export async function PATCH(req: NextRequest) {
  try {
    const b = (await req.json()) as { group_id?: string; id?: string; status?: string };
    const status = b.status === "대기" ? "대기" : "완료";
    const sb = supabaseAdmin();
    // 실제로 상태가 바뀌는 행만 갱신·반환 — 아래 생산요청 매칭이 같은 행을 두 번 연결하지 않게
    let q = sb.from("inventory_txns").update({ status }).neq("status", status);
    if (b.group_id) q = q.eq("group_id", b.group_id);
    else if (b.id) q = q.eq("id", b.id);
    else return NextResponse.json({ ok: false, error: "group_id 또는 id 가 필요합니다." }, { status: 400 });
    const { data: flipped, error } = await q.select("id, product_id, qty, type, txn_date, partner");
    if (error) throw error;

    // 대기 → 완료된 '입고'는 이 시점이 실제 입고 — 열린 생산요청(재고 보충)에 이벤트 매칭.
    //  (기록 시점 매칭은 대기 건을 건너뛰므로 여기서 이어받는다. 실패해도 처리 자체는 성공.)
    //  채널이동(내부 이동) 입고는 제조사 생산이 아니므로 제외 — 창 매칭과 같은 규칙.
    if (status === "완료") {
      const receipts = (flipped ?? []).filter((t) => t.type === "입고" && Number(t.qty) > 0 && t.partner !== "채널이동");
      if (receipts.length) {
        try {
          const token = req.cookies.get("b2b_auth")?.value;
          const who = (await verifySession(token)) || resolveUserName(token);
          await allocateReceiptsToOpenRequests(
            sb,
            receipts.map((t) => ({ inv_txn_id: t.id as string, product_id: t.product_id as string, qty: Number(t.qty), receipt_date: (t.txn_date as string) || undefined })),
            who,
            { purpose: "재고 보충" },
          );
        } catch (e) { console.warn("[inventory/orders PATCH] 생산요청 매칭 실패", e); }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/orders PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}

// DELETE ?group_id= | ?id= — 주문(묶음) 전체 취소, 또는 단건.
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
    if (groupId) {
      const { error } = await sb.from("inventory_txns").delete().eq("group_id", groupId);
      if (error) { const f = friendly(error); if (f) return f; throw error; }
    } else if (id) {
      const { error } = await sb.from("inventory_txns").delete().eq("id", id);
      if (error) { const f = friendly(error); if (f) return f; throw error; }
    } else {
      return NextResponse.json({ ok: false, error: "group_id 또는 id 가 필요합니다." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/orders DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
