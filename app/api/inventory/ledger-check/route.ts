import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getUntracked } from "@/app/lib/stock-tracked";
import { reconcileB2BSales, SALES_MISMATCH_LABEL, type SalesMismatchKind } from "@/app/lib/b2b-sales-sync";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/inventory/ledger-check?kinds=b2b_overdue,move_unpaired
//  원장 점검(대표 결정 D4d · docs/ledger-standard.md S12) — 장부 이상을 종류별로 모아 보여 준다. 읽기 전용, 아무것도 고치지 않는다.
//  판정은 inventory_ledger_check RPC(132) 한 곳. 여기선 rn 순으로 끝까지 읽고(S4) 종류별로 묶기만 한다.
//  예외 하나 — B2B 매출 원장 대조(b2b_sales_ledger)는 금액 규칙이 앱(buildOrderSalesRows, S10)에 있어 reconcileB2BSales 를 부른다.
//  kinds 를 주면 그 종류만 계산한다(예: 실사 화면이 발송일 지난 발송대기만 확인할 때 ?kinds=b2b_overdue).
//  응답 groups[] = { kind, count, items, unavailable?, error? } — unavailable/error 가 있으면 count 는 확인 못 한 값이다(0 으로 보지 않는다).
//  [무시](145 ledger_check_ignores) — 사람이 문제없다고 본 행은 count·items 에서 빼고 ignored[] 로 따로 준다(원장은 그대로).
//  POST { action: "ignore" | "restore", kind, key, summary? } — 무시·되살리기.
//  미사용(active=false) 품목은 재고 0으로 본다(2026-10-21 대표 결정) — 잔량 항목(마이너스 재고)에서 빼고,
//  함수가 주는 'inactive_balance'(미사용 품목에 남은 재고)는 받지 않는다(SQL_KINDS 에서 뺌 — 화면이 모르는 종류로 버려진다).

const SQL_KINDS = [
  "b2b_cancelled", "b2b_no_deduct", "b2b_stock_off", "b2b_qty_mismatch", "b2b_date_mismatch", "b2b_overdue",
  "b2b_unlinked_line", "b2b_over_alloc", "b2b_dup_shipment", "b2b_kept_orphan",
  "fulfill_interrupted", "fulfill_late_orphan", "fulfill_unmatched", "fulfill_not_dispatched",
  "move_unpaired", "bundle_row", "old_pending", "future_done",
  "promo_stranded", "promo_unreleased", "negative_balance", "untracked_balance",
  "receipt_unlinked", "return_no_out", "return_after_count",
  "shipped_no_sales", "sales_not_shipped", "sales_future",
] as const;
const TS_KINDS = ["b2b_sales_ledger"] as const;
const KINDS = [...SQL_KINDS, ...TS_KINDS] as const;
type Kind = (typeof KINDS)[number];
// 10-11 2차에 새로 넣은 항목 — 옛 132 함수(표시 행 '_meta' 없음)는 이 항목을 계산하지 않는다
const V2_KINDS = new Set<string>([
  "b2b_unlinked_line", "b2b_over_alloc", "b2b_dup_shipment", "b2b_kept_orphan",
  "fulfill_interrupted", "fulfill_late_orphan", "fulfill_unmatched", "fulfill_not_dispatched",
  "promo_unreleased", "receipt_unlinked", "return_no_out", "return_after_count", "sales_future",
]);
// 함수 판(132 '_meta' 행 ref_id) — 3 = 처리 안내 표식 정정('covered' · 'multi' 증거 · 'dup'),
//  4 = 중단된 출고 'old'(7일 지남) 표식 폐지(④가 출고일과 무관하게 이어서 차감 — 옛 판은 '7일 지남'을 내용에 붙인다),
//  5 = 중단된 출고 'finished'(대기 키 없음 + 그 배치 처리완료 키 있음 = 출고 완료 뒤 재고만 취소 — 다시 올려도 이어받지 못한다).
//  옛 판도 항목은 모두 계산하지만 표식·내용이 달라 안내가 틀릴 수 있다 — 화면이 '132 다시 적용'을 알린다.
const FN_VERSION = 6; // 6 = 155(차수별 선점 규칙 — b2b_qty_mismatch 기대치·b2b_date_mismatch 재정의)
const SALES_LEDGER_DAYS = 90; // B2B 매출 원장 대조 기간(최근 N일 발송분) — 더 앞은 [매출 집계]의 원장 대조로 본다
const SALES_LEDGER_KINDS: SalesMismatchKind[] = ["differs", "backfill_dup", "backfill_only", "stale_date"]; // missing·not_completed 는 SQL 항목(전 기간)이 본다

type RpcRow = {
  rn: number; kind: string; ref_id: string | null; ref_no: string | null; partner: string | null;
  product_id: string | null; product_name: string | null; sku: string | null; channel: string | null;
  qty: number | string | null; txn_date: string | null; detail: string | null;
  tags?: string[] | null; // 화면 처리 안내를 고르는 표식(132 — 먼저 적용한 옛 132 함수에는 없다)
};
type Item = Omit<RpcRow, "rn" | "kind" | "qty" | "tags"> & { qty: number | null; tags: string[]; key: string };
type Group = { kind: string; count: number; items: Item[]; unavailable?: string; error?: string };
type Ignored = { kind: string; key: string; summary: string | null; ignored_by: string | null; created_at: string };

// 점검 행 고유 값 — 수량까지 넣어 값이 바뀐 행(마이너스 재고 등)은 다시 보이게 한다(145). extra = 같은 발주의 다른 판정 구분
type KeyPart = { ref_id: string | null; ref_no: string | null; product_id: string | null; channel: string | null; txn_date: string | null; qty: number | null };
const itemKey = (r: KeyPart, extra = "") =>
  [r.ref_id, r.ref_no, r.product_id, r.channel, r.txn_date, r.qty === null ? "" : String(Math.round(r.qty * 1000) / 1000), extra]
    .map((v) => v ?? "").join("|");
const ignoresMissing = (e: { code?: string; message?: string }) =>
  e.code === "42P01" || e.code === "PGRST205" || /ledger_check_ignores/i.test(e.message || "");

const PAGE = 1000;
const MAX_PAGES = 30;  // 3만 행 — 넘으면 truncated 로 알린다(점검 결과가 그만큼이면 이미 손으로 볼 양이 아니다)
const ITEM_CAP = 200;  // 종류별 화면 표시 행(건수는 전체)
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const daysBefore = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86400_000).toISOString().slice(0, 10);
// 함수 없음(미적용)만 — 권한 오류(42501) 등은 일반 오류로 보인다(다시 적용해도 안 고쳐지는 오류를 '적용하세요'로 가리지 않게)
const fnMissing = (e: { code?: string; message?: string }) =>
  e.code === "PGRST202" || e.code === "42883" ||
  (/inventory_ledger_check/i.test(e.message || "") && /could not find|does not exist/i.test(e.message || ""));
const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

export async function GET(req: NextRequest) {
  try {
    const asked = (req.nextUrl.searchParams.get("kinds") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const kinds = asked.filter((k): k is Kind => (KINDS as readonly string[]).includes(k));
    if (asked.length && !kinds.length) return NextResponse.json({ ok: false, error: "점검 종류가 올바르지 않습니다." }, { status: 400 });
    const want = (k: string) => !kinds.length || (kinds as string[]).includes(k);
    const sqlKinds = kinds.filter((k) => (SQL_KINDS as readonly string[]).includes(k));

    const sb = supabaseAdmin();
    const today = kstToday();
    const groups = new Map<string, Group>();
    for (const k of kinds.length ? kinds : KINDS) groups.set(k, { kind: k, count: 0, items: [] });
    // [무시] 목록 — 145 미적용이면 무시 없이 전부 보인다(ignoreUnavailable). 그 밖의 조회 실패는 멈춘다(S4)
    let ignoreUnavailable = false;
    const ignoreMap = new Map<string, Ignored>();
    {
      const { data, error } = await sb.from("ledger_check_ignores").select("kind, item_key, summary, ignored_by, created_at").limit(5000);
      if (error) {
        if (!ignoresMissing(error)) return NextResponse.json({ ok: false, error: `무시 목록 조회 실패: ${error.message}` }, { status: 500 });
        ignoreUnavailable = true;
      }
      for (const r of (data ?? []) as { kind: string; item_key: string; summary: string | null; ignored_by: string | null; created_at: string }[])
        ignoreMap.set(`${r.kind} ${r.item_key}`, { kind: r.kind, key: r.item_key, summary: r.summary, ignored_by: r.ignored_by, created_at: r.created_at });
    }
    // 지금도 점검에 걸리는데 무시한 행만 돌려준다(이미 사라진 문제의 무시 기록은 보이지 않는다)
    const ignored: Ignored[] = [];
    const isIgnored = (kind: string, key: string) => {
      const hit = ignoreMap.get(`${kind} ${key}`);
      if (hit) ignored.push(hit);
      return !!hit;
    };
    // B2B 매출 원장 대조는 RPC 와 함께 돌린다(읽기만 — 실패는 아래에서 그 항목의 '확인 못 함'으로)
    const salesP = want("b2b_sales_ledger")
      ? reconcileB2BSales(daysBefore(today, SALES_LEDGER_DAYS), today).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }))
      : null;

    let truncated = false;
    let fnStale = false; // 옛 판(v2) 함수 — 처리 안내 표식이 이 화면과 다르다
    if (!kinds.length || sqlKinds.length) {
      // 재고 관리 안 함(121) 품목 — 조회 실패면 던진다(빈 목록으로 보면 그 품목 재고가 '이상 없음'으로 숨는다, S4)
      const untracked = await getUntracked(sb);
      // 미사용 품목 — 조회 실패면 던진다(빈 목록으로 보면 미사용 품목 잔량이 다시 섞인다)
      const inactive = new Set<string>();
      {
        const { data, error } = await sb.from("products").select("id").eq("active", false).limit(10000);
        if (error) throw error;
        for (const r of (data ?? []) as { id: string }[]) inactive.add(r.id);
      }
      const BALANCE_KINDS = new Set(["negative_balance", "untracked_balance"]);
      const args = { p_today: today, p_kinds: sqlKinds.length ? sqlKinds : null, p_untracked: [...untracked.ids] };
      const rows: RpcRow[] = [];
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) { truncated = true; break; }
        const { data, error } = await sb
          .rpc("inventory_ledger_check", args)
          .order("rn", { ascending: true })
          .range(page * PAGE, page * PAGE + PAGE - 1);
        if (error) {
          if (fnMissing(error))
            return NextResponse.json({ ok: false, error: "원장 점검 함수가 없습니다 — supabase/migrations/132_reconcile_fix_ledger_check.sql 을 먼저 적용하세요." }, { status: 501 });
          return NextResponse.json({ ok: false, error: `원장 점검 조회 실패: ${error.message}` }, { status: 500 });
        }
        const part = (data ?? []) as RpcRow[];
        rows.push(...part);
        if (part.length < PAGE) break;
      }

      let v2 = false;
      let ver = 0;
      for (const r of rows) {
        if (r.kind === "_meta") { v2 = true; ver = Math.max(ver, Number(String(r.ref_id || "").replace(/^v/i, "")) || 2); continue; }
        if (r.kind === "_unavailable") { // 칸이 없어(마이그레이션 미적용) 확인 못 한 항목
          const g = r.ref_id ? groups.get(r.ref_id) : undefined;
          if (g) g.unavailable = `DB 업데이트 ${r.detail || "(새 마이그레이션)"} 적용 후 확인됩니다`;
          continue;
        }
        const g = groups.get(r.kind);
        if (!g) continue; // 화면이 모르는 새 종류 — 함수만 먼저 바뀐 경우
        if (BALANCE_KINDS.has(r.kind) && r.product_id && inactive.has(r.product_id)) continue; // 미사용 품목 재고 = 0
        const { rn: _rn, kind: _k, qty, tags, ...rest } = r;
        const q = qty === null || qty === undefined ? null : Number(qty);
        const key = itemKey({ ...rest, qty: q });
        if (isIgnored(r.kind, key)) continue;
        g.count++;
        if (g.items.length < ITEM_CAP) g.items.push({ ...rest, qty: q, tags: Array.isArray(tags) ? tags : [], key });
      }
      // 옛 132 함수 — 새 항목은 계산되지 않았다(0건이 아니다). 잘려서 표시 행을 못 봤으면 판단하지 않는다.
      if (!v2 && !truncated) {
        for (const g of groups.values()) if (V2_KINDS.has(g.kind)) { g.count = 0; g.items = []; g.unavailable = "132 를 다시 적용하면 확인됩니다"; }
      }
      // 옛 판(표시 행 없음 = 1차 판, ref_id 가 낮음 = 2차 판) — 잘려서 표시 행을 못 읽었으면 판단하지 않는다
      if (v2 ? ver < FN_VERSION : !truncated) fnStale = true;
    }

    // B2B 매출 원장 대조 — 최근 N일 발송완료 발주의 기대 매출(명세표 규칙)과 매출 원장(sales_orders 도매) 비교. 실패면 '확인 못 함'(S4)
    if (salesP) {
      const g = groups.get("b2b_sales_ledger")!;
      const res = await salesP;
      if (res.ok) {
        const list = res.r.mismatches.filter((m) => SALES_LEDGER_KINDS.includes(m.kind)).map((m) => {
          const base = {
            ref_id: m.status === "삭제됨" ? null : m.order_id, ref_no: m.order_no || null, partner: null,
            product_id: null, product_name: null, sku: null, channel: null,
            qty: null, txn_date: m.date,
          };
          return {
            ...base, key: itemKey(base, `${m.kind}:${m.order_id}:${m.ledger}`),
            detail: `${m.note || SALES_MISMATCH_LABEL[m.kind]} · ${m.status} · 기대 ${won(m.expected)} · 원장 ${won(m.ledger)}`,
            tags: [m.kind === "backfill_dup" || m.kind === "backfill_only" ? "backfill" : m.kind],
          };
        }).filter((it) => !isIgnored("b2b_sales_ledger", it.key));
        g.count = list.length;
        g.items = list.slice(0, ITEM_CAP);
      } else {
        g.error = extractErrorMsg(res.e, "매출 원장 대조 실패");
      }
    }

    return NextResponse.json({ ok: true, today, truncated, fnStale, itemCap: ITEM_CAP, salesLedgerDays: SALES_LEDGER_DAYS, groups: [...groups.values()], ignored, ignoreUnavailable });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "원장 점검 실패") }, { status: 500 });
  }
}

// POST { action: "ignore" | "restore", kind, key, summary? } — 점검 행 [무시]·[되살리기](145). 원장은 건드리지 않는다.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; kind?: string; key?: string; summary?: string };
    const kind = String(body.kind || "");
    const key = String(body.key || "");
    if (!(KINDS as readonly string[]).includes(kind) || !key || key.length > 500)
      return NextResponse.json({ ok: false, error: "무시할 점검 행이 올바르지 않습니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const token = req.cookies.get("b2b_auth")?.value;
    const user = (await verifySession(token)) || resolveUserName(token);
    let error: { code?: string; message?: string } | null = null;
    if (body.action === "ignore") {
      ({ error } = await sb.from("ledger_check_ignores").upsert(
        { kind, item_key: key, summary: String(body.summary || "").slice(0, 300) || null, ignored_by: user || null },
        { onConflict: "kind,item_key" }));
    } else if (body.action === "restore") {
      ({ error } = await sb.from("ledger_check_ignores").delete().eq("kind", kind).eq("item_key", key));
    } else {
      return NextResponse.json({ ok: false, error: "action 은 ignore 또는 restore 입니다." }, { status: 400 });
    }
    if (error) {
      if (ignoresMissing(error))
        return NextResponse.json({ ok: false, error: "DB 업데이트 145(supabase/migrations/145_ledger_check_ignores.sql)를 먼저 적용하세요." }, { status: 501 });
      return NextResponse.json({ ok: false, error: `저장 실패: ${error.message}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "무시 저장 실패") }, { status: 500 });
  }
}
