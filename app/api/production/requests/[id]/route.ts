import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { loadRequests, formatRequestDetail } from "@/app/lib/wholesale-production-db";
import { PR_STATUSES, UNREQUESTED_ITEM_MEMO, toPrPurpose, CONFIRMED_PURPOSES, type PrStatus, type PrPurpose } from "@/app/lib/wholesale-production";
import { logProductionRequestStatusChanged, logProductionRequestUpdated, logProductionRequestDeleted } from "@/app/lib/b2b-activity";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { syncWindowReceipts } from "@/app/lib/production-allocate";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET — 요청서 단건(품목·입고 이력 포함)
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const [row] = await loadRequests(supabaseAdmin(), { id });
    if (!row) return NextResponse.json({ ok: false, error: "요청서를 찾을 수 없습니다." }, { status: 404 });
    return NextResponse.json({ ok: true, request: row });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PATCH { status?, title?, requested_by?, request_date?, due_date?, memo?, items? } — 헤더·품목 수정(상태 변경 포함)
//  items: [{ id?, product_id, requested_qty, memo? }] — 전체 교체 방식.
//  단, 입고 기록이 있는 품목은 뺄 수 없다(items FK cascade 가 입고 증거까지 지워 재고 정합이 깨짐).
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const b = (await req.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (b.status !== undefined) {
      const s = String(b.status) as PrStatus;
      if (!PR_STATUSES.includes(s)) return NextResponse.json({ ok: false, error: "상태값이 올바르지 않습니다." }, { status: 400 });
      patch.status = s;
    }
    if (b.title !== undefined) patch.title = String(b.title || "").trim() || null;
    // 용도(082·113·115) — 모르는 값은 재고 보충. 아래 미적용 경고에서 다시 쓰려고 지역 변수로 잡아 둔다.
    const nextPurpose: PrPurpose | null = b.purpose !== undefined ? toPrPurpose(b.purpose) : null;
    if (nextPurpose) patch.purpose = nextPurpose;
    if (b.requested_by !== undefined) patch.requested_by = String(b.requested_by || "").trim() || null;
    if (b.assignee !== undefined) patch.assignee = String(b.assignee || "").trim() || null;
    if (b.memo !== undefined) patch.memo = String(b.memo || "").trim() || null;
    if (b.request_date !== undefined && DATE_RE.test(String(b.request_date))) patch.request_date = String(b.request_date);
    if (b.due_date !== undefined) {
      // 생산종료일(마감)은 필수(일정·보드가 마감일 기준) — 빈값·형식 오류는 거부, 해제 불가.
      if (!DATE_RE.test(String(b.due_date))) return NextResponse.json({ ok: false, error: "생산종료일을 입력하세요." }, { status: 400 });
      patch.due_date = String(b.due_date);
    }
    // 생산시작일(118) — 입고 자동 매칭 창의 시작. 빈값 = 해제(신청일 폴백).
    if (b.prod_start !== undefined) patch.prod_start = DATE_RE.test(String(b.prod_start)) ? String(b.prod_start) : null;

    const sb = supabaseAdmin();

    // 창 키가 하나라도 오면 현재 값을 미리 읽는다 — (1) 시작>종료 역전을 저장 전에 차단(POST 와 동일 가드:
    //  역전 창은 비어 있어 소급 링크만 지워지고 재매칭이 하나도 안 붙는다), (2) windowChanged 를 '키 존재'가
    //  아니라 '실제 값 변경'으로 판정(안 바뀐 저장마다 열린 요청서 전체 재매칭이 돌던 낭비 방지 — 리뷰 확정).
    //  컬럼 미적용(071/082/118) 환경은 에러에 보이는 컬럼만 빼고 재시도.
    type WinCur = { request_date?: string | null; due_date?: string | null; prod_start?: string | null; purpose?: string | null };
    let curWin: WinCur | null = null;
    if (b.request_date !== undefined || b.due_date !== undefined || b.prod_start !== undefined || b.purpose !== undefined) {
      const cols = ["request_date", "due_date", "prod_start", "purpose"];
      for (let guard = 0; guard < 4; guard++) {
        const r = await sb.from("production_requests").select(cols.join(", ")).eq("id", id).maybeSingle();
        if (!r.error) { curWin = (r.data as WinCur) ?? {}; break; }
        const miss = cols.find((c) => new RegExp(c, "i").test(r.error!.message));
        if (!miss || cols.length <= 1) break;
        cols.splice(cols.indexOf(miss), 1);
      }
      const effStart = patch.prod_start !== undefined ? (patch.prod_start as string | null) : (curWin?.prod_start ?? null);
      const effDue = patch.due_date !== undefined ? (patch.due_date as string) : (curWin?.due_date ?? null);
      if (effStart && effDue && String(effStart) > String(effDue))
        return NextResponse.json({ ok: false, error: "생산시작일이 생산종료일보다 뒤입니다 — 기간을 확인하세요." }, { status: 400 });
    }

    // 품목 교체 준비 — 헤더 갱신 전에 검증까지 끝낸다(절반만 반영되는 것 방지).
    type ItemIn = { id?: string; product_id: string; requested_qty: number; memo?: string };
    let itemsIn: ItemIn[] | null = null;
    let toDelete: string[] = [];
    let curItemIds = new Set<string>();
    let autoIds = new Set<string>(); // '[요청서에 없음]' 자동 줄 id
    if (b.items !== undefined) {
      if (!Array.isArray(b.items)) return NextResponse.json({ ok: false, error: "items 형식이 올바르지 않습니다." }, { status: 400 });
      const { data: curItems, error: ciErr } = await sb.from("production_request_items").select("id, requested_qty, memo").eq("request_id", id);
      if (ciErr) throw ciErr;
      curItemIds = new Set((curItems ?? []).map((i) => i.id as string));
      // '[요청서에 없음]' 자동 줄(요청수량 0·memo 표식) = 입고 매칭이 만든 시스템 줄. 수정 저장이 이 줄을 지우거나 훼손하지 않게
      //  ① 클라이언트가 안 보내도(수정 창을 연 뒤 다른 사용자의 입고로 생김) 입고가 있으면 조용히 유지
      //  ② 보내면 수량 0·표식·정렬 고정(클라이언트 memo 무시) ③ 양수 수량을 넣으면 정식 요청 줄로 승격(표식 제거).
      //  입고 있는 '실제' 줄의 0 은 종전대로 거부 — 품목을 빼려면 그 입고를 먼저 취소한다.
      autoIds = new Set((curItems ?? []).filter((i) => (Number(i.requested_qty) || 0) <= 0 && i.memo === UNREQUESTED_ITEM_MEMO).map((i) => i.id as string));
      const withReceipts = new Set<string>();
      if (curItemIds.size) {
        const { data: rc, error: rcErr0 } = await sb.from("production_receipts").select("item_id").in("item_id", [...curItemIds]).limit(5000);
        if (rcErr0) throw rcErr0;
        for (const r of rc ?? []) withReceipts.add(r.item_id as string);
      }
      const rawIn = (b.items as ItemIn[])
        .map((it) => ({ id: it.id ? String(it.id) : undefined, product_id: String(it.product_id || ""), requested_qty: Math.round((Number(it.requested_qty) || 0) * 100) / 100, memo: String(it.memo || "").trim() || undefined })); // 소수 둘째 자리 허용(104)
      if (rawIn.some((it) => it.id && curItemIds.has(it.id) && !autoIds.has(it.id) && withReceipts.has(it.id) && it.requested_qty <= 0)) {
        return NextResponse.json({ ok: false, error: "입고 기록이 있는 품목은 수량을 0으로 할 수 없습니다. 품목을 빼려면 그 입고를 먼저 취소하세요." }, { status: 400 });
      }
      itemsIn = rawIn.filter((it) => it.product_id && (it.requested_qty > 0 || (it.id && autoIds.has(it.id))));
      if (!itemsIn.some((it) => it.requested_qty > 0)) return NextResponse.json({ ok: false, error: "요청 수량이 있는 품목이 최소 1개 필요합니다." }, { status: 400 });
      const keepIds = new Set(itemsIn.filter((it) => it.id && curItemIds.has(it.id)).map((it) => it.id!));
      // 입고가 붙은 자동 줄은 안 보내도 유지(①). 입고 없는 자동 줄은 지운다(빈 줄 정리)
      toDelete = [...curItemIds].filter((iid) => !keepIds.has(iid) && !(autoIds.has(iid) && withReceipts.has(iid)));
      if (toDelete.length > 0) {
        const { data: rc, error: rcErr } = await sb.from("production_receipts").select("item_id").in("item_id", toDelete).limit(1);
        if (rcErr) throw rcErr;
        if ((rc ?? []).length > 0) {
          return NextResponse.json({ ok: false, error: "입고 기록이 있는 품목은 뺄 수 없습니다. 해당 품목의 입고를 먼저 취소하세요." }, { status: 400 });
        }
      }
    }

    // 상태 변경이면 이전 상태·요청번호 확보(변경기록 + 알림용)
    let prevStatus: string | null = null, reqNo = "";
    if (patch.status !== undefined) {
      const { data: cur } = await sb.from("production_requests").select("status, req_no").eq("id", id).single();
      prevStatus = (cur as { status?: string } | null)?.status ?? null;
      reqNo = (cur as { req_no?: string } | null)?.req_no ?? "";
    }
    let { error } = await sb.from("production_requests").update(patch).eq("id", id);
    if (error && nextPurpose && CONFIRMED_PURPOSES.includes(nextPurpose) && /purpose/i.test(error.message))
      return NextResponse.json({ ok: false, error: `${nextPurpose} 용도가 아직 없습니다 — migration ${nextPurpose === "프로모션" ? "113" : "115"} 을 먼저 적용하세요.` }, { status: 500 });
    if (error && "purpose" in patch && /purpose/i.test(error.message)) {
      delete patch.purpose; // 082 미적용 환경 폴백
      ({ error } = await sb.from("production_requests").update(patch).eq("id", id));
    }
    if (error && "due_date" in patch && /due_date/i.test(error.message)) {
      delete patch.due_date; // 071 미적용 환경 폴백
      ({ error } = await sb.from("production_requests").update(patch).eq("id", id));
    }
    if (error && "prod_start" in patch && /prod_start/i.test(error.message)) {
      delete patch.prod_start; // 118 미적용 환경 폴백 — 창 시작은 신청일
      ({ error } = await sb.from("production_requests").update(patch).eq("id", id));
    }
    if (error) throw error;

    // 품목 교체 실행 — 수정 → 추가 → 삭제 순(검증은 위에서 완료)
    if (itemsIn) {
      let sort = 0;
      for (const it of itemsIn) {
        if (it.id && curItemIds.has(it.id)) {
          if (autoIds.has(it.id) && it.requested_qty <= 0) {
            // 자동 줄 유지(②) — 표식·정렬 고정, 정렬 번호는 소비하지 않는다
            const { error: ue0 } = await sb.from("production_request_items").update({ requested_qty: 0, memo: UNREQUESTED_ITEM_MEMO, sort: 9000 }).eq("id", it.id).eq("request_id", id);
            if (ue0) throw ue0;
            continue;
          }
          // 자동 줄에 양수 수량을 넣으면 정식 요청 줄로 승격(③) — 표식은 제조사 엑셀 비고·알림에 찍히지 않게 걷어낸다
          const memo = it.memo ? (it.memo.replace(UNREQUESTED_ITEM_MEMO, "").trim() || null) : null;
          const { error: ue } = await sb.from("production_request_items").update({ requested_qty: it.requested_qty, memo, sort }).eq("id", it.id).eq("request_id", id);
          if (ue) throw ue;
        } else {
          const { error: ie } = await sb.from("production_request_items").insert({ request_id: id, product_id: it.product_id, requested_qty: it.requested_qty, memo: it.memo ?? null, sort });
          if (ie) throw ie;
        }
        sort++;
      }
      if (toDelete.length > 0) {
        const { error: de } = await sb.from("production_request_items").delete().in("id", toDelete);
        if (de) throw de;
      }
    }
    // 변경기록·알림. 작업자(누가 바꿨는지)를 함께 전달. 게시물 본문에 수정 후 전체 구성·이행률 첨부.
    const token = req.cookies.get("b2b_auth")?.value;
    const who = (await verifySession(token)) || resolveUserName(token);
    let detailNow: string | undefined;
    try { const [dr] = await loadRequests(sb, { id }); if (dr) detailNow = formatRequestDetail(dr); } catch { /* 상세 없이 발송 */ }
    if (patch.status !== undefined && prevStatus && prevStatus !== patch.status) {
      await logProductionRequestStatusChanged(reqNo, prevStatus, String(patch.status), who, detailNow);
    }
    // 상태 외의 실질 수정(품목 교체·마감일·수량 등) → 수정 알림(설정 체크리스트로 제어)
    const contentKeys = Object.keys(patch).filter((k) => k !== "updated_at" && k !== "status");
    if (itemsIn !== null || contentKeys.length > 0) {
      await logProductionRequestUpdated(reqNo, who, detailNow);
    }
    // 창(생산시작일·생산종료일·신청일)이나 용도가 바뀌면 기존 소급 링크부터 지우고 새 기준으로 다시 매칭한다 —
    //  안 지우면 창 밖 입고나 '도매 납품'으로 정정한 요청의 소매 입고 링크가 잔존해 이중 이행이 된다.
    //  지우는 건 링크(증거)뿐 — 원장은 건드리지 않는다. 이벤트 매칭 링크(memo '입고/출고 연동')는 유지.
    //  구 메모(신청일~마감일)도 함께 지운다 — 규칙 변경 전에 만들어진 링크를 새 창 기준으로 재판정.
    //  '키 존재'가 아니라 curWin(수정 전 값)과의 실제 비교 — 안 바뀐 저장마다 전체 재매칭이 돌지 않게.
    //  폴백으로 patch 에서 빠진 컬럼(미적용)은 비교 대상에서도 자연히 빠진다. curWin 조회 실패 시 종전(존재 기반) 판정.
    const dnorm = (v: unknown) => (v == null || v === "" ? null : String(v).slice(0, 10));
    const windowChanged = curWin
      ? (("request_date" in patch && dnorm(patch.request_date) !== dnorm(curWin.request_date))
        || ("due_date" in patch && dnorm(patch.due_date) !== dnorm(curWin.due_date))
        || ("prod_start" in patch && dnorm(patch.prod_start) !== dnorm(curWin.prod_start ?? null))
        || ("purpose" in patch && patch.purpose !== toPrPurpose(curWin.purpose)))
      : (patch.request_date !== undefined || patch.due_date !== undefined || patch.prod_start !== undefined || patch.purpose !== undefined);
    if (windowChanged) {
      try {
        await sb.from("production_receipts").delete().eq("request_id", id)
          .in("memo", ["기간 자동 매칭(신청일~마감일)", "기간 자동 매칭(생산기간)"]);
      } catch { /* 실패해도 아래 sync 가 미연결분만 붙이므로 이중 배분은 없다 */ }
    }
    // 신청일·마감일·품목이 바뀌었을 수 있다 — 새 창 기준으로 소급 매칭 후 반환.
    //  창·용도가 바뀌었으면 풀린 입고가 다른 열린 요청서(그 주간 요청서)로 가야 하므로 열린 재고 보충 요청서 전체를 재매칭한다.
    await (windowChanged ? syncWindowReceipts(sb) : syncWindowReceipts(sb, { requestId: id }));
    const [row] = await loadRequests(sb, { id });
    return NextResponse.json({ ok: true, request: row });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "수정 실패") }, { status: 500 });
  }
}

// DELETE — 요청서 삭제. 입고 기록이 있으면 거부(재고 정합성 보호) → '취소'로 기록 보존.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const { count, error: ce } = await sb.from("production_receipts").select("id", { count: "exact", head: true }).eq("request_id", id);
    if (ce) throw ce;
    if ((count ?? 0) > 0) return NextResponse.json({ ok: false, error: "입고 기록이 있어 삭제할 수 없습니다. 입고를 먼저 취소하거나 요청서를 '취소' 처리하세요." }, { status: 400 });
    const { data: head } = await sb.from("production_requests").select("req_no, title").eq("id", id).maybeSingle(); // 삭제 알림용(삭제 전에 확보)
    let deletedDetail: string | undefined; // 무엇이 지워졌는지 게시물 본문에 남긴다(삭제 후엔 복구 불가한 정보)
    try { const [dr] = await loadRequests(sb, { id }); if (dr) deletedDetail = formatRequestDetail(dr); } catch { /* 상세 없이 발송 */ }
    const { error } = await sb.from("production_requests").delete().eq("id", id);
    if (error) throw error;
    const token = _req.cookies.get("b2b_auth")?.value;
    const who = (await verifySession(token)) || resolveUserName(token);
    await logProductionRequestDeleted((head as { req_no?: string } | null)?.req_no || "", (head as { title?: string } | null)?.title || "", who, deletedDetail);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
