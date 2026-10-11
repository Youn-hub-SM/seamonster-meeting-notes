import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { MOVE_ONLY_CHANNELS, RESERVED_CHANNELS, signedQty, toInvChannel } from "@/app/lib/inventory";
import { getAllBundles, expandBundleQty, isBundleId } from "@/app/lib/product-bundles";
import { getUntracked } from "@/app/lib/stock-tracked";
import { allocateReceiptsToRequest, type LinkResult } from "@/app/lib/production-allocate";
import { kstTodayIso } from "@/app/lib/production-schedule";
import {
  isDupRequestKey, isMissing131, isReservedPartner, loadByRequestKey, parseRequestKey, reasonFor,
  REQUEST_KEY_CONFLICT_MSG, RESERVED_PARTNER, sameLedgerRows, strip131, unlinkedOf,
} from "../../../txn/ledger-write";
import type { ImportTxn } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/inventory/txns/import/apply { rows: ImportTxn[], done?, channel?, request_id?, request_key? }
//  미리보기에서 확인한 입출고(엑셀) 또는 '구매 및 판매' 폼을 일괄 기록.
//  request_key: 화면이 미리보기·폼마다 만든 제출 키(131). 재시도·더블클릭에도 한 번만 기록되고 두 번째는 같은 결과(replay)를 받는다.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { rows?: ImportTxn[]; done?: boolean; channel?: string; request_id?: string | null; request_key?: string | null };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const status = body.done === false ? "대기" : "완료"; // 즉시처리 미체크면 대기
    const channel = toInvChannel(body.channel); // 036·113·115, 기본 소매
    if (!rows.length) return NextResponse.json({ ok: false, error: "반영할 행이 없습니다." }, { status: 400 });
    const cookie = req.cookies.get("b2b_auth")?.value;
    const actor = (await verifySession(cookie)) || resolveUserName(cookie);
    const requestKey = parseRequestKey(body.request_key);
    const kstToday = kstTodayIso();

    const sb = supabaseAdmin();
    const valid = rows.filter((r) => r && r.product_id && (r.type === "입고" || r.type === "출고") && Number.isFinite(Number(r.qty)) && Number(r.qty) !== 0);
    if (!valid.length) return NextResponse.json({ ok: false, error: "유효한 행이 없습니다." }, { status: 400 });
    // 이동 전용 칸 입고 금지 — 화면에서 이미 막지만, 유형 열이 섞인 엑셀(입고+출고 혼재)이 그 칸으로 오는 경우까지 여기서 잡는다.
    if (MOVE_ONLY_CHANNELS.includes(channel) && valid.some((r) => r.type === "입고"))
      return NextResponse.json({ ok: false, error: `${channel} 입고는 막혀 있습니다 — 소매로 입고한 뒤 [재고 이동]에서 옮기세요. (파일에 입고 행이 있습니다)` }, { status: 400 });
    // 사람이 적은 거래처가 '채널이동'이면 그 행이 이동으로 오인된다(판매·매입에서 빠짐, S11)
    if (valid.some((r) => isReservedPartner(r.partner)))
      return NextResponse.json({ ok: false, error: `거래처에 '${RESERVED_PARTNER}'은 쓸 수 없습니다 — 칸 이동은 [재고 이동]에서 기록하세요.` }, { status: 400 });
    // 거래일 — 형식이 틀리면 KST 오늘(DB 기본값 current_date 는 UTC 라 KST 00~09시엔 어제가 된다, S6).
    //  미래 날짜 '완료'는 받지 않는다 — 아직 안 들어온/안 나간 물건이 오늘 재고·요청서 이행에 섞인다. 예정 건은 대기로.
    const dateOf = (r: ImportTxn) => (DATE_RE.test(String(r.txn_date)) ? String(r.txn_date) : kstToday);
    if (status === "완료") {
      const future = valid.filter((r) => dateOf(r) > kstToday).length;
      if (future) return NextResponse.json({ ok: false, error: `미래 날짜 행이 ${future}건 있습니다 — '즉시 처리'를 해제해 대기로 저장하거나 날짜를 고치세요.` }, { status: 400 });
    }

    // 묶음(세트)은 자체 재고가 없다 → 반드시 구성품 원장으로 남긴다. 세트 id 로 기록하면
    //  현재고가 구성품에서 파생되므로 그 원장은 무시되고 아무 재고도 줄지 않는다.
    //  엑셀 업로드는 미리보기에서 이미 전개돼 오지만 수동 '구매 및 판매' 폼은 세트 그대로 온다 →
    //  쓰기 직전인 여기서 전개해 두 경로를 한 규칙으로 통일(구성품은 재전개해도 그대로라 이중 전개 없음).
    //  세트 구성 조회 실패는 getAllBundles 가 던진다(S4) — 세트 id 로 원장을 남기지 않는다.
    const [bundles, untracked] = await Promise.all([getAllBundles(sb), getUntracked(sb)]);
    const expanded: ImportTxn[] = [];
    for (const r of valid) {
      if (!isBundleId(bundles, r.product_id)) { if (!untracked.ids.has(r.product_id)) expanded.push(r); continue; } // 재고 관리 사용 안함(121) 품목은 기록 안 함
      const per = expandBundleQty(bundles, r.product_id, Math.abs(Math.round(Number(r.qty) * 100) / 100));
      for (const [pid, q] of per) {
        if (untracked.ids.has(pid)) continue; // 세트 안의 재고 관리 안 함 구성품만 빼고 나머지는 기록
        expanded.push({
          ...r, product_id: pid, qty: signedQty(r.type, q),
          unit_amount: null, // 세트 단가는 구성품에 나눌 수 없음 → 비움(메모로 출처 보존)
          memo: r.memo ? `${r.memo} (세트 분해: ${r.product_name})` : `세트 분해: ${r.product_name}`,
        });
      }
    }

    if (!expanded.length) return NextResponse.json({ ok: false, error: "재고 관리 사용 안함 품목만 있어 기록할 행이 없습니다." }, { status: 400 });

    // 유형별로 주문번호(IN-/OUT-) + group_id 부여. migration 033 미적용이면 묶음 없이 진행(폴백).
    const orderByType = new Map<string, { group_id: string; order_no: string }>();
    for (const t of new Set(expanded.map((r) => r.type))) {
      try {
        const { data, error } = await sb.rpc("next_inventory_order_no", { p_type: t });
        if (error || !data) throw error || new Error("no order_no");
        orderByType.set(t, { group_id: crypto.randomUUID(), order_no: String(data) });
      } catch { /* 033 미적용 — 묶음 생략 */ }
    }

    // 사유(099) — 출고: 판매(null)·협찬·폐기·제조사 반품·기타 / 입고: 일반(null)·고객 반품(D4b)
    //  고객 반품은 매입이 아니다 — 단가를 비우고 요청서에 연결하지 않는다.
    const insert: Record<string, unknown>[] = expanded.map((r, i) => {
      const grp = orderByType.get(r.type);
      const reason = reasonFor(r.type, r.reason);
      return {
        product_id: r.product_id,
        type: r.type,
        channel,
        qty: Math.round(Number(r.qty) * 100) / 100,
        unit_amount: reason === "고객 반품" || r.unit_amount == null ? null : Math.max(0, Math.round(Number(r.unit_amount))),
        txn_date: dateOf(r),
        partner: r.partner ? String(r.partner).slice(0, 200) : null,
        memo: r.memo ? String(r.memo).slice(0, 500) : null,
        created_by: actor,
        status,
        source: "import", // 131 — 미적용이면 아래 폴백이 뺀다
        ...(grp ? { group_id: grp.group_id, order_no: grp.order_no, source_ref: grp.order_no } : {}),
        ...(requestKey ? { request_key: `${requestKey}:${i}` } : {}),
        ...(reason ? { reason } : {}),
      };
    });
    const hasCustomerReturn = insert.some((r) => r.reason === "고객 반품");
    const requestId = !hasCustomerReturn && /^[0-9a-f-]{36}$/i.test(String(body.request_id || "")) ? String(body.request_id) : null;

    // 선택 컬럼(status=034, channel=036, reason=099, 131 세 칸) 미적용 환경이면 그 컬럼만 빼고 재시도. group/order 는 rpc 성공 시에만 추가돼 안전.
    const SEL = "id, product_id, qty, type, txn_date";
    let ins = await sb.from("inventory_txns").insert(insert).select(SEL);
    // 113·115 미적용: 보호 칸은 channel 체크 제약에 걸린다. 아래 폴백이 열을 빼고 재시도하면 엑셀 한 장이 통째로
    //  소매 칸에 남으므로 제약 위반일 때만 먼저 잘라낸다(열이 없는 036 폴백은 그대로).
    if (ins.error && RESERVED_CHANNELS.includes(channel) && /channel_chk|check constraint/i.test(ins.error.message))
      return NextResponse.json({ ok: false, error: `${channel} 칸이 아직 없습니다 — migration ${channel === "프로모션" ? "113" : "115"} 을 먼저 적용하세요.` }, { status: 500 });
    for (let guard = 0; ins.error && !isDupRequestKey(ins.error) && guard < 4; guard++) {
      if (isMissing131(ins.error)) { strip131(insert); ins = await sb.from("inventory_txns").insert(insert).select(SEL); continue; }
      const miss = (["channel", "status", "reason"] as const).find((c) => new RegExp(c, "i").test(ins.error!.message));
      if (!miss) break;
      for (const row of insert) delete row[miss];
      ins = await sb.from("inventory_txns").insert(insert).select(SEL);
    }

    // 같은 제출 키로 이미 반영됨(재시도·더블클릭) — 아무 행도 안 들어갔다. 기존 기록을 돌려주고, 끊겼던 요청서 연결만 마저 채운다.
    //  내용이 다르면(입력을 고친 뒤 재전송) 409 — 화면은 키를 새로 만들어 다음 누름은 새 기록이 된다.
    if (ins.error && isDupRequestKey(ins.error) && requestKey) {
      const prev = await loadByRequestKey<Record<string, unknown>>(sb, requestKey, "*"); // * = 비교 칸(사유·단가 등) 전부 — 099 미적용에도 안전
      if (prev.error) return NextResponse.json({ ok: false, error: "이미 저장된 기록을 확인하지 못했습니다 — [입고 및 출고] 목록을 먼저 확인하세요." }, { status: 503 });
      if (!sameLedgerRows(prev.rows, insert)) return NextResponse.json({ ok: false, code: "request_key_conflict", error: REQUEST_KEY_CONFLICT_MSG }, { status: 409 });
      let link: LinkResult | null = null;
      const inDone = prev.rows.filter((r) => r.type === "입고" && Number(r.qty) > 0 && (r.status ?? "완료") === "완료");
      if (status === "완료" && requestId && inDone.length) {
        const open = await unlinkedOf(sb, inDone.map((r) => String(r.id)));
        if (open === null) link = { ok: false, reason: "요청서 연결 여부를 확인하지 못했습니다 — 생산 요청 화면에서 확인하세요.", lines: [] };
        else if (open.size) {
          try {
            link = await allocateReceiptsToRequest(sb, requestId,
              inDone.filter((r) => open.has(String(r.id))).map((r) => ({ inv_txn_id: String(r.id), product_id: String(r.product_id), qty: Number(r.qty), receipt_date: (r.txn_date as string) || undefined })),
              actor);
          } catch (e) { console.warn("[inventory/txns import apply] 재시도 요청서 연결 실패", e); link = { ok: false, reason: "요청서 연결에 실패했습니다 — 생산 요청 화면에서 확인하세요.", lines: [] }; }
        }
      }
      const orders = [...new Set(prev.rows.map((r) => r.order_no).filter(Boolean).map(String))];
      return NextResponse.json({ ok: true, replay: true, applied: prev.rows.length, status, orders, link });
    }
    if (ins.error) throw ins.error;

    // 입고(즉시 처리)에 요청서를 지정했으면 그 요청서에 연결(지정 매칭). 실패해도 입고는 성공 — 결과만 응답에.
    let link: LinkResult | null = null;
    if (status === "완료" && requestId) {
      try {
        const inRows = (ins.data ?? []).filter((r) => r.type === "입고" && Number(r.qty) > 0);
        if (inRows.length) link = await allocateReceiptsToRequest(
          sb, requestId,
          inRows.map((r) => ({ inv_txn_id: r.id as string, product_id: r.product_id as string, qty: Number(r.qty), receipt_date: (r.txn_date as string) || undefined })),
          actor,
        );
      } catch (e) { console.warn("[inventory/txns import apply] 생산요청 연결 실패", e); link = { ok: false, reason: "요청서 연결에 실패했습니다 — 생산 요청 화면에서 확인하세요.", lines: [] }; }
    }
    return NextResponse.json({ ok: true, applied: insert.length, status, orders: [...orderByType.values()].map((o) => o.order_no), link });
  } catch (err) {
    console.error("[inventory/txns import apply]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "적용 실패") }, { status: 500 });
  }
}
