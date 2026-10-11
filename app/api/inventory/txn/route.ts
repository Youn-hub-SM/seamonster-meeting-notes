import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { INV_TXN_TYPES, MOVE_ONLY_CHANNELS, RESERVED_CHANNELS, signedQty, toInvChannel, toInvChannelParam, type InvTxnType } from "@/app/lib/inventory";
import { allocateReceiptsToRequest, fullRequestsOfTxns, recheckRequestCompletion, type LinkResult } from "@/app/lib/production-allocate";
import { getAllBundles, expandBundleQty, isBundleId } from "@/app/lib/product-bundles";
import { kstTodayIso } from "@/app/lib/production-schedule";
import { getUntracked, dropUntracked } from "@/app/lib/stock-tracked";
import { missingTable } from "@/app/lib/fulfill-db";
import { FULFILL_ONE_CONFIRM, FULFILL_ONE_MSG, fulfillBatchOf, isDupRequestKey, isMissing131, isReservedPartner, loadByRequestKey, LOCK_MSG, lockKindOf, parseRequestKey, reasonFor, REQUEST_KEY_CONFLICT_MSG, RESERVED_PARTNER, sameLedgerRows, strip131, unlinkedOf, type LedgerMark } from "./ledger-write";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 요청서 연결이 품목마다 알림을 기다린다 — 기본 제한에 끊기면 '실패'로 보이고 재시도된다

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 숫자 엄격 판독 — '420개'·빈칸을 0 으로 읽어 전량 0 조정이 되지 않게(S8). 실패는 null.
const strictNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim();
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// POST { product_id, type, qty, unit_amount?, txn_date?, partner?, memo?, reason?, done?, request_key? } — 입고/출고/조정 기록.
//  입고/출고는 qty 양수(수량), 조정은 부호 있는 델타(목표수량-현재수량을 UI 에서 계산해 전달).
//  request_key: 화면이 창마다 만든 제출 키(131) — 재시도·더블클릭에도 한 번만 기록되고, 두 번째는 같은 결과(replay)를 돌려받는다.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const product_id = String(b.product_id || "");
    const type = String(b.type || "") as InvTxnType;
    if (!product_id) return NextResponse.json({ ok: false, error: "품목을 선택하세요." }, { status: 400 });
    if (!INV_TXN_TYPES.includes(type)) return NextResponse.json({ ok: false, error: "유형이 올바르지 않습니다." }, { status: 400 });
    // 조정은 칸을 반드시 명시(S8) — 기본값(소매)으로 떨어지면 다른 칸의 실사가 소매를 덮어쓴다
    if (type === "조정" && !toInvChannelParam(b.channel))
      return NextResponse.json({ ok: false, error: "조정할 칸(소매·도매·프로모션·도매 대량)을 고르세요." }, { status: 400 });
    const writeChannel = toInvChannel(b.channel); // 036·113·115 — 미지정·모르는 값은 소매
    const qtyIn = strictNum(b.qty);
    if (qtyIn === null) return NextResponse.json({ ok: false, error: "수량은 숫자로 입력하세요." }, { status: 400 });
    let qty = signedQty(type, qtyIn);
    // 거래일 미지정이면 KST 오늘을 명시해 넣는다 — DB 기본값 current_date 는 UTC 라 KST 00~09시엔 어제가 된다(S6)
    const kstToday = kstTodayIso();
    const txn_date = DATE_RE.test(String(b.txn_date || "")) ? String(b.txn_date) : kstToday;
    const status: "대기" | "완료" | null = type === "입고" || type === "출고" ? (b.done === false ? "대기" : "완료") : null;
    // 미래 날짜 '완료'는 받지 않는다(S6) — 아직 안 들어온/안 나간 물건이 오늘 재고·요청서 이행에 섞인다. 예정 건은 대기로.
    if (status === "완료" && txn_date > kstToday)
      return NextResponse.json({ ok: false, error: "미래 날짜는 '즉시 처리'를 해제해 대기로 저장하세요 — 실제로 들어오거나 나간 날 처리합니다." }, { status: 400 });
    if (isReservedPartner(b.partner))
      return NextResponse.json({ ok: false, error: `거래처에 '${RESERVED_PARTNER}'은 쓸 수 없습니다 — 칸 이동은 [재고 이동]에서 기록하세요.` }, { status: 400 });
    // 조정(실사 목표): 화면이 계산한 델타는 화면 로드 시점 재고 기준이라, 로드 후 재고가 움직이면
    //  낡은 델타가 그대로 기록된다(감사 확정 TOCTOU). target_qty 가 오면 서버가 기록 시점 현재고로
    //  델타를 재계산한다(엑셀 조정 apply 와 같은 규칙). 구 화면(qty 만 전송)은 기존 동작 유지.
    //  기준 시점 = 조정 날짜(asof=txn_date, 미지정이면 KST 오늘) — 실사 엑셀(asof=오늘)과 같은 기준.
    //  asof null(전 기간)이면 조정일 이후 기록까지 섞여 단건 조정과 엑셀 조정의 델타가 달라진다(감사 #6).
    // 조정은 오늘까지만 — 미래 날짜면 기준 재고에 발송 예정 선점이 섞여 델타가 유령 재고가 된다(감사 #6)
    if (type === "조정" && txn_date > kstToday)
      return NextResponse.json({ ok: false, error: "조정 날짜는 오늘 이후로 할 수 없습니다." }, { status: 400 });
    // target_qty 칸을 보냈으면(실사 수량 모드) 빈값·숫자 아님·음수는 거부한다 — 빈칸을 '안 보냄'으로 보면 화면이 계산한 낡은 델타가 기록된다(S8).
    if (type === "조정" && b.target_qty !== undefined) {
      const targetIn = strictNum(b.target_qty);
      if (targetIn === null || targetIn < 0) return NextResponse.json({ ok: false, error: "실사 수량은 0 이상의 숫자로 입력하세요." }, { status: 400 });
      const target = Math.round(targetIn * 100) / 100;
      const asof = txn_date;
      const { data: stockRow, error: stockErr } = await supabaseAdmin()
        .rpc("inventory_stock", { asof, chan: writeChannel })
        .eq("product_id", String(b.product_id || ""))
        .maybeSingle();
      // RPC 구버전(asof·chan 시그니처 없음, PGRST202)일 때만 화면이 보낸 델타(qty)로 폴백 — 다른 오류는 중단(낡은 델타 기록 방지)
      if (stockErr && stockErr.code !== "PGRST202") throw stockErr;
      if (!stockErr) {
        const current = Number((stockRow as { qty?: number } | null)?.qty) || 0;
        qty = Math.round((target - current) * 100) / 100;
        if (qty === 0) return NextResponse.json({ ok: false, error: `${asof} 기준 ${writeChannel} 현재고(${current.toLocaleString()})와 같습니다 — 변동 없음.` }, { status: 400 });
      }
    }
    if (qty === 0) return NextResponse.json({ ok: false, error: "수량을 입력하세요." }, { status: 400 });
    // 이동 전용 칸 직접 입고 금지 — 도매·프로모션·도매 대량은 소매 입고 후 이동으로만 들어간다(실수로 바로 그 칸에 넣는 사고 방지).
    //  정당한 입고(이동·생산 수령)는 이 라우트를 쓰지 않으므로 여기서 막아도 안전하다. 조정·출고는 네 칸 모두 허용(실사 대상).
    if (type === "입고" && MOVE_ONLY_CHANNELS.includes(writeChannel))
      return NextResponse.json({ ok: false, error: `${writeChannel} 입고는 막혀 있습니다 — 소매로 입고한 뒤 [재고 이동]에서 옮기세요.` }, { status: 400 });

    const sb = supabaseAdmin();
    // 묶음(세트)은 자체 재고가 없다 → 입고/출고는 구성품으로 전개해 기록(다른 경로와 동일 규칙),
    //  조정은 파생값이라 조정 대상이 될 수 없으므로 막는다. 세트 구성 조회 실패는 getAllBundles 가 던진다(S4 — '세트 없음'으로 보지 않음).
    const [bundles, untracked] = await Promise.all([getAllBundles(sb), getUntracked(sb)]);
    const isSet = isBundleId(bundles, product_id);
    if (isSet && type === "조정")
      return NextResponse.json({ ok: false, error: "묶음(세트)은 자체 재고가 없어 조정할 수 없습니다. 구성품의 재고를 조정하세요." }, { status: 400 });

    // 사유(099) — 출고: '판매'는 null(기본), 협찬·폐기·제조사 반품·기타는 대사에서 비판매로 분리.
    //  입고: '고객 반품'(D4b) — 매입이 아니라 돌아온 물건이라 요청서에 연결하지 않고 단가를 받지 않는다.
    const reason = reasonFor(type, b.reason);
    const customerReturn = type === "입고" && reason === "고객 반품";
    const requestKey = parseRequestKey(b.request_key);
    const row: Record<string, unknown> = {
      product_id, type, qty,
      channel: writeChannel, // 036·113·115, 기본 소매
      unit_amount: customerReturn || b.unit_amount === undefined || b.unit_amount === "" || b.unit_amount === null ? null : Math.max(0, Math.round(Number(b.unit_amount) || 0)),
      partner: String(b.partner || "").trim() || null,
      memo: String(b.memo || "").trim() || null,
      created_by: await actor(req),
      txn_date,
      source: "manual", // 131 — 미적용이면 아래 폴백이 뺀다
    };
    if (reason) row.reason = reason;
    // 입고/출고 단건도 주문번호 부여(033 미적용이면 생략). 즉시처리 미체크면 대기.
    if (status) {
      row.status = status;
      try {
        const { data, error } = await sb.rpc("next_inventory_order_no", { p_type: type });
        if (!error && data) { row.group_id = crypto.randomUUID(); row.order_no = String(data); row.source_ref = String(data); }
      } catch { /* 033 미적용 */ }
    }

    // 세트면 구성품 여러 행으로, 아니면 그대로 1행. 같은 group_id/order_no 로 묶여 한 거래로 남는다.
    //  qty 는 이미 유형별 부호가 붙어 있음(출고=음수, 조정 감소=음수) → 부호 그대로 전개.
    //  구성수량 c.qty 는 양수라 세트 전개 시 부호가 구성품에 그대로 전파된다. abs/재-signedQty 금지
    //  (조정 감소가 증가로 뒤집히던 회귀 방지 — 조정은 위에서 세트가 차단돼 항상 비세트 1행).
    //  전개 순서는 결정적(구성 조회가 parent·component 순 정렬) — 재시도에도 같은 순번에 같은 품목이 온다.
    //  전개 뒤 '재고 관리 사용 안함'(121) 구성품은 뺀다 — 다른 입출고 경로와 같은 순서(S5: 전개 → 미관리 제외).
    const per = dropUntracked(expandBundleQty(bundles, product_id, qty), untracked);
    if (!per.size) return NextResponse.json({ ok: false, error: "재고 관리 사용 안함 품목이라 기록하지 않습니다." }, { status: 400 });
    const attempt: Record<string, unknown>[] = [...per.entries()].map(([pid, q], i) => ({
      ...row,
      product_id: pid,
      qty: q,
      ...(requestKey ? { request_key: `${requestKey}:${i}` } : {}),
      ...(isSet ? { unit_amount: null, memo: [row.memo, "세트 분해"].filter(Boolean).join(" ") } : {}),
    }));
    const requestId = !customerReturn && /^[0-9a-f-]{36}$/i.test(String(b.request_id || "")) ? String(b.request_id) : null;

    // 선택 컬럼(status=034, channel=036, reason=099, 131 세 칸) 미적용 환경이면 그 컬럼만 빼고 재시도.
    // 113·115 미적용 환경: 보호 칸 값은 channel 체크 제약에 걸린다. 아래 폴백이 channel 열을 통째로 빼고 재시도하면
    //  그 기록이 조용히 소매 칸에 남아 칸이 섞이므로, 제약 위반일 때만 먼저 잘라낸다(열 자체가 없는 036 폴백은 그대로).
    let res = await sb.from("inventory_txns").insert(attempt).select();
    if (res.error && RESERVED_CHANNELS.includes(writeChannel) && /channel_chk|check constraint/i.test(res.error.message))
      return NextResponse.json({ ok: false, error: `${writeChannel} 칸이 아직 없습니다 — migration ${writeChannel === "프로모션" ? "113" : "115"} 을 먼저 적용하세요.` }, { status: 500 });
    for (let guard = 0; res.error && !isDupRequestKey(res.error) && guard < 4; guard++) {
      if (isMissing131(res.error)) { strip131(attempt); res = await sb.from("inventory_txns").insert(attempt).select(); continue; }
      const miss = (["channel", "status", "reason"] as const).find((c) => c in attempt[0] && new RegExp(c, "i").test(res.error!.message));
      if (!miss) break;
      for (const r of attempt) delete r[miss];
      res = await sb.from("inventory_txns").insert(attempt).select();
    }

    // 같은 제출 키로 이미 기록됨(재시도·더블클릭) — 새로 넣지 않고 그 기록을 돌려준다. 내용이 다르면(입력을 고친 뒤 재전송) 409.
    if (res.error && isDupRequestKey(res.error) && requestKey) {
      const prev = await loadByRequestKey<Record<string, unknown>>(sb, requestKey, "*");
      if (prev.error) return NextResponse.json({ ok: false, error: "이미 저장된 기록을 확인하지 못했습니다 — [입고 및 출고] 목록을 먼저 확인하세요." }, { status: 503 });
      if (!sameLedgerRows(prev.rows, attempt)) return NextResponse.json({ ok: false, code: "request_key_conflict", error: REQUEST_KEY_CONFLICT_MSG }, { status: 409 });
      let link: LinkResult | null = null;
      const done = prev.rows.filter((t) => t.type === "입고" && Number(t.qty) > 0 && (t.status ?? "완료") === "완료");
      if (type === "입고" && requestId && done.length) {
        const open = await unlinkedOf(sb, done.map((t) => String(t.id)));
        if (open === null) link = { ok: false, reason: "요청서 연결 여부를 확인하지 못했습니다 — 생산 요청 화면에서 확인하세요.", lines: [] };
        else if (open.size) {
          try {
            link = await allocateReceiptsToRequest(sb, requestId,
              done.filter((t) => open.has(String(t.id))).map((t) => ({ inv_txn_id: String(t.id), product_id: String(t.product_id), qty: Number(t.qty), receipt_date: (t.txn_date as string) || undefined })),
              row.created_by as string | null);
          } catch (e) { console.warn("[inventory/txn] 재시도 요청서 연결 실패", e); link = { ok: false, reason: "요청서 연결에 실패했습니다 — 생산 요청 화면에서 확인하세요.", lines: [] }; }
        }
      }
      return NextResponse.json({ ok: true, replay: true, txn: prev.rows[0] ?? null, txns: prev.rows, link });
    }
    if (res.error) throw res.error;

    // 입고(완료)에 요청서를 지정했으면 그 요청서에 연결(지정 매칭). 실패해도 입고는 성공 — 결과만 응답에 싣는다.
    let link: LinkResult | null = null;
    if (type === "입고" && status === "완료" && requestId) {
      try {
        link = await allocateReceiptsToRequest(
          sb, requestId,
          (res.data ?? []).filter((t) => Number(t.qty) > 0).map((t) => ({ inv_txn_id: t.id as string, product_id: t.product_id as string, qty: Number(t.qty), receipt_date: (t.txn_date as string) || undefined })),
          row.created_by as string | null,
        );
      } catch (e) { console.warn("[inventory/txn] 생산요청 연결 실패", e); link = { ok: false, reason: "요청서 연결에 실패했습니다 — 생산 요청 화면에서 확인하세요.", lines: [] }; }
    }
    return NextResponse.json({ ok: true, txn: res.data?.[0] ?? null, txns: res.data, link });
  } catch (err) {
    console.error("[inventory/txn POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "기록 실패") }, { status: 500 });
  }
}

// PATCH { id, unit_amount } — 이미 기록된 입고/출고의 단가만 수정. 재고에 영향 주는 값(수량·품목·날짜)은
//  취소 후 재기록이 원칙이라 여기서 받지 않는다. 결산의 단가 미입력(*) 건을 나중에 채우는 용도. 빈값 = 단가 지움.
export async function PATCH(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const id = String(b.id || "");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const unit_amount = b.unit_amount === undefined || b.unit_amount === "" || b.unit_amount === null
      ? null : Math.max(0, Math.round(Number(b.unit_amount) || 0));
    const sb = supabaseAdmin();
    const { data: cur, error: findErr } = await sb.from("inventory_txns").select("id, type").eq("id", id).maybeSingle();
    if (findErr) throw findErr;
    if (!cur) return NextResponse.json({ ok: false, error: "내역을 찾을 수 없습니다 — 새로고침 후 다시 시도하세요." }, { status: 404 });
    if (cur.type === "조정") return NextResponse.json({ ok: false, error: "조정 건에는 단가가 없습니다." }, { status: 400 });
    const { error } = await sb.from("inventory_txns").update({ unit_amount }).eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/txn PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "단가 수정 실패") }, { status: 500 });
  }
}

// ── 온라인발주 출고 배치의 마지막 재고 행을 한 줄 취소할 때(S2·S12) ──
//  한 줄 취소는 '그 배치의 주문은 처리완료로 남는' 수량 정정이다. 그런데 배치의 마지막 재고 행까지 지우면 재고 행이 0 이 되어
//  출고 이력(fulfill_dispatch)이 '중단된 출고'(이력·키를 쓴 뒤 재고 기록 전에 끊김)와 똑같아진다 — 7일 안에 같은 발주엑셀을
//  다시 올리면 발주엑셀 분석이 그 주문을 되살리고 ④ [출고 완료]가 '이어서 차감'으로 한 번 더 뺀다(이중 차감).
//  그래서 그 이력의 품목 수(sku_count)를 0 으로 둔다 = '재고 행 없이 처리완료된 배치'(재고 관리 안 함·미등록 코드뿐인 배치와 같은 상태).
//  중단 판정(fulfill-db maybeInterrupted · 132 fulfill_interrupted)은 sku_count > 0 인 이력만 본다 → 다시 올리면 '이미 출고됨'으로
//  막히고 재출고는 확인 뒤에만 된다. 재고 행이 하나라도 기록된 배치는 다시 '중단'일 수 없으므로 0 으로 두는 쪽이 늘 안전하다.
//  표식은 지우기 '전'에 단다(표식을 못 쓰면 지우지 않는다). 동시 취소로 마지막이 된 경우는 지운 뒤 한 번 더 보고 단다.
type Sb = ReturnType<typeof supabaseAdmin>;
type DispatchHead = { id: string; sku_count: number };
// 이 묶음의 출고 이력 중 품목 수가 남은 것. 065 미적용 = 빈 목록, 그 밖의 오류 = 'error'(멈춘다, S4)
async function dispatchHeads(sb: Sb, groupId: string): Promise<DispatchHead[] | "error"> {
  const { data, error } = await sb.from("fulfill_dispatch").select("id, sku_count").eq("group_id", groupId).gt("sku_count", 0).limit(50);
  if (error) return missingTable(error) ? [] : "error";
  return ((data ?? []) as { id: string; sku_count: number | null }[]).map((d) => ({ id: String(d.id), sku_count: Number(d.sku_count) || 0 }));
}
// 이 묶음에 남은 재고 행 수(exceptId 제외). 오류·모름 = 'error'
async function rowsLeft(sb: Sb, groupId: string, exceptId: string): Promise<number | "error"> {
  const { count, error } = await sb.from("inventory_txns").select("id", { count: "exact", head: true }).eq("group_id", groupId).neq("id", exceptId);
  return error || count == null ? "error" : count;
}
async function markEmptied(sb: Sb, heads: DispatchHead[]): Promise<boolean> {
  const { error } = await sb.from("fulfill_dispatch").update({ sku_count: 0 }).in("id", heads.map((h) => h.id));
  return !error;
}
async function unmarkEmptied(sb: Sb, heads: DispatchHead[]): Promise<void> {
  for (const h of heads) { try { await sb.from("fulfill_dispatch").update({ sku_count: h.sku_count }).eq("id", h.id).eq("sku_count", 0); } catch { /* 최선 노력 — 재고 행이 남은 배치는 0 이어도 '출고됨'이다 */ } }
}
const FULFILL_LAST_MSG = "온라인발주 출고 배치의 마지막 줄입니다 — 취소하면 이 배치의 재고가 모두 원복되고 주문은 처리완료로 남습니다(같은 발주엑셀을 다시 올리면 '이미 출고됨'으로 막힙니다). 다시 출고하려면 [입고 및 출고]에서 그 묶음을 취소하세요.";
const FULFILL_LAST_CONFIRM = "온라인발주 출고 배치의 마지막 줄입니다. 취소하면 이 배치의 재고가 모두 원복되고 주문은 처리완료로 남습니다(같은 발주엑셀을 다시 올리면 '이미 출고됨'으로 막힙니다). 다시 출고하려면 [취소]를 누르고 [입고 및 출고]에서 그 묶음을 취소하세요.\n\n이 줄만 취소할까요?";
const FULFILL_MARK_FAIL = "재고는 원복됐지만 이 배치의 출고 이력에 '재고 행 없음'을 남기지 못했습니다 — 같은 발주엑셀을 다시 올려 '중단된 출고'로 물으면 [취소]를 누르세요(이미 출고된 배치입니다).";

// DELETE ?id=&confirm= — 거래 취소(원장에서 삭제 = 현재고 원복). orders DELETE ?id= 도 이 함수를 그대로 쓴다(같은 판정, S1).
//  온라인발주 출고 배치의 한 줄은 confirm=1 이 있어야 지운다(409 code 'confirm_required' + confirm 문구 — 화면이 확인창 뒤 다시 보낸다).
//  배치의 마지막 줄이면 확인 문구가 다르고, 지우기 전에 출고 이력에 '재고 행 없음' 표식을 단다(위).
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    const confirmed = req.nextUrl.searchParams.get("confirm") === "1";
    const sb = supabaseAdmin();
    const prepFail = () => NextResponse.json({ ok: false, error: "취소 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
    // 쌍·연동 행은 여기서 단건 삭제 금지 — 이동(마감 합류 포함)은 [재고 이동] 내역에서 묶음 단위로(음수 가드·재개 판정 포함),
    //  B2B 선점 출고는 발주의 발송일정에서(재저장·삭제 시 cascade 로 원복), 발송 후 취소 미반품 출고는 발주 복구로 정리한다(S7).
    //  한쪽만 지우면 짝 없는 칸 재고가 남거나, 발주를 복구할 때 같은 수량이 한 번 더 빠진다.
    const { data: cur, error: curErr } = await sb.from("inventory_txns").select("*").eq("id", id).maybeSingle(); // * = 035·131 미적용에도 안전
    if (curErr) throw curErr;
    if (!cur) return NextResponse.json({ ok: false, error: "내역을 찾을 수 없습니다 — 새로고침 후 다시 시도하세요." }, { status: 404 });
    const lock = lockKindOf(cur as LedgerMark); // 출처 칸(131) 우선, 그 전 기록은 종전 표식 — orders DELETE/PATCH 와 같은 판정
    if (lock) return NextResponse.json({ ok: false, code: `locked_${lock}`, error: LOCK_MSG[lock] }, { status: 409 });
    // 온라인발주 출고 배치의 한 줄 — 지우면 그 줄의 재고만 원복되고 배치의 '처리완료 주문'은 남는다(수량 정정용). 확인 후에만(S7).
    //  배치 여부를 모르면 지우지 않는다(S4).
    const batch = await fulfillBatchOf(sb, cur as { source?: unknown; group_id?: unknown });
    if (batch === "error") return prepFail();
    // 배치 본 출고의 마지막 재고 행인가 — 출고 이력(품목 수 남음)이 있고 이 행 말고 남은 행이 없다. 모르면 멈춘다(S4).
    const groupId = batch === "dispatch" && (cur as { group_id?: unknown }).group_id ? String((cur as { group_id?: unknown }).group_id) : null;
    let heads: DispatchHead[] = [];
    let last = false;
    if (groupId) {
      const h = await dispatchHeads(sb, groupId);
      if (h === "error") return prepFail();
      heads = h;
      if (heads.length) {
        const left = await rowsLeft(sb, groupId, id);
        if (left === "error") return prepFail();
        last = left === 0;
      }
    }
    if (batch && !confirmed) {
      return last
        ? NextResponse.json({ ok: false, code: "confirm_required", error: FULFILL_LAST_MSG, confirm: FULFILL_LAST_CONFIRM }, { status: 409 })
        : NextResponse.json({ ok: false, code: "confirm_required", error: FULFILL_ONE_MSG[batch], confirm: FULFILL_ONE_CONFIRM[batch] }, { status: 409 });
    }
    // 083(cascade) 이후: 생산요청과 연결된 입고를 여기서 취소하면 요청 쪽 입고 기록도 함께 원복된다.
    //  083 미적용(restrict)이면 FK 오류 → 안내 문구로 변환.
    //  삭제 전에 '지금 100% 완료'인 연결 요청서를 잡아 두고, 삭제 뒤 100% 아래로 내려갔으면 자동 재개(마감 원복).
    const fullBefore = await fullRequestsOfTxns(sb, [id]);
    if (fullBefore === null) return prepFail();
    // 마지막 줄 — 표식을 먼저(못 쓰면 지우지 않는다)
    if (last && !(await markEmptied(sb, heads))) return prepFail();
    const { data: del, error } = await sb.from("inventory_txns").delete().eq("id", id).select("id");
    if (error) {
      if (last) await unmarkEmptied(sb, heads);
      if (/production_receipts/i.test(error.message))
        return NextResponse.json({ ok: false, error: "생산 요청과 연결된 입고입니다 — migration 083 적용 후에는 여기서 취소하면 요청 기록도 함께 원복됩니다. (지금은 생산 요청 화면의 입고 이력에서 취소하세요)" }, { status: 409 });
      throw error;
    }
    // 0행 = 그 사이 다른 창이 먼저 취소했다 — '취소됨'으로 믿고 다시 기록하지 않게 실패로 알린다(orders DELETE 와 같다).
    //  마지막 줄 표식은 그대로 둔다 — 이 행이 없으니 그 배치는 이미 재고 행 0 이다.
    if (!del?.length) return NextResponse.json({ ok: false, error: "이미 취소된 기록입니다 — 새로고침하세요." }, { status: 404 });
    // 동시 취소로 이 행이 마지막이 됐을 수 있다 — 지운 뒤 다시 세어 0(또는 모름)이면 표식을 단다(재고 행이 남아도 0 은 안전, 위)
    if (heads.length && !last && groupId) {
      const left = await rowsLeft(sb, groupId, id);
      if ((left === "error" || left === 0) && !(await markEmptied(sb, heads)))
        return NextResponse.json({ ok: false, error: FULFILL_MARK_FAIL }, { status: 500 });
    }
    if (fullBefore.length) { try { await recheckRequestCompletion(sb, fullBefore, "입고 취소", "reopen"); } catch { /* 재개 실패는 취소를 막지 않는다 */ } }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[inventory/txn DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "취소 실패") }, { status: 500 });
  }
}
