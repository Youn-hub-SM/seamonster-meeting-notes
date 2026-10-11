import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { SHIPMENT_STATUSES } from "@/app/lib/b2b-orders";
import {
  applyOrderShipments,
  isShippedSchedule,
  shippedKey,
  kstToday,
  salesSyncFields,
  ShipChangeError,
  type SaveShipmentsOpts,
} from "@/app/lib/b2b-shipments";
import { logShipmentStatusChanged } from "@/app/lib/b2b-activity";

export const runtime = "nodejs"; // sales-sync 가 crypto(sales-normalize) 사용
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/b2b/shipments/[id] — 발송 차수(하위) 상태/송장번호/박스 수 변경
//   body: { status?, tracking_no?, box_count?, shipped_date?, returned? }
//   발송완료로 바꾸려면 송장번호 필수 + 실제 발송일(shipped_date, 기본 오늘·미래 불가 — D2).
//   상태가 바뀌면(취소·복구·발송완료·되돌림) applyOrderShipments 로 선점 재고·헤더·매출을 다시 맞춘다(S7) —
//   예전엔 상태만 바꿔 2차를 취소해도 발주 전량 선점이 그대로 남았다(감사 9번).
//   발송된 차수를 취소하면 returned(돌아옴/안 돌아옴)가 필요하다(D3).
//   박스 수·송장만 고치는 요청은 재고·매출과 무관해 그 칸만 고친다.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = (await req.json()) as {
      status?: string; tracking_no?: string; box_count?: number; shipped_date?: string | null; returned?: boolean;
    };

    const sb = supabaseAdmin();
    const { data: ship, error: getErr } = await sb
      .from("shipments")
      .select("id, order_id, seq, status, tracking_no, box_count, ship_date, shipped_at")
      .eq("id", id)
      .maybeSingle();
    if (getErr) throw getErr;
    if (!ship) {
      // 다른 저장(발송일 창·상태 변경)이 차수를 새로 만들면 id 가 바뀐다
      return NextResponse.json({ ok: false, error: "발송 일정이 바뀌었습니다 — 새로고침한 뒤 다시 시도하세요." }, { status: 404 });
    }
    if (body.status !== undefined && !(SHIPMENT_STATUSES as readonly string[]).includes(body.status)) {
      return NextResponse.json({ ok: false, error: "알 수 없는 발송 상태입니다." }, { status: 400 });
    }

    const newStatus = body.status ?? (ship.status as string);
    const trackingNo =
      body.tracking_no !== undefined
        ? (body.tracking_no || "").trim()
        : (ship.tracking_no ?? "").toString().trim();

    // 박스 수만큼 송장번호 필요 (콤마 구분, 박스당 1개)
    //  '직접배송' 마커면 송장번호 검증 생략 (택배 아닌 직접 전달)
    //  이미 발송완료인 차수에 박스 수만 저장하는 요청까지 막으면 안 된다 — 상태·송장을 실제로
    //  건드리는 요청에서만 검증한다(발주 단위로 발송완료 처리하면 송장이 orders 에만 남아
    //  차수의 tracking_no 가 비어 있을 수 있고, 그러면 양식 다운로드가 영구히 막힌다).
    const touchesShipping = body.status !== undefined || body.tracking_no !== undefined;
    if (touchesShipping && newStatus === "발송완료" && trackingNo.trim() !== "직접배송") {
      const boxCount = Math.max(1, Number(body.box_count ?? ship.box_count) || 1);
      const parts = trackingNo.split(",").map((s: string) => s.trim()).filter(Boolean);
      if (parts.length === 0) {
        return NextResponse.json(
          { ok: false, error: "발송완료로 변경하려면 송장번호가 필요합니다." },
          { status: 400 }
        );
      }
      if (parts.length < boxCount) {
        return NextResponse.json(
          { ok: false, error: `${boxCount}박스 — 박스별 송장번호 ${boxCount}개가 필요합니다 (${parts.length}개 입력됨).` },
          { status: 400 }
        );
      }
    }

    const statusChange = body.status !== undefined && body.status !== ship.status;

    // ── 상태 변경: 공용 재계산 경로 ──
    if (statusChange) {
      const from = ship.status as string;
      const to = body.status as string;
      const today = kstToday();
      let shippedDate = today;
      if (to === "발송완료") {
        shippedDate = String(body.shipped_date || today);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(shippedDate)) {
          return NextResponse.json({ ok: false, error: "실제 발송일 형식이 올바르지 않습니다." }, { status: 400 });
        }
        if (shippedDate > today) {
          return NextResponse.json({ ok: false, error: "실제 발송일은 오늘보다 뒤일 수 없습니다." }, { status: 400 });
        }
      }
      const shipped = isShippedSchedule({ status: from, shipped_at: ship.shipped_at as string | null });
      if (to === "취소" && shipped && typeof body.returned !== "boolean") {
        return NextResponse.json(
          { ok: false, need_return: true, error: "발송된 차수입니다 — 반품으로 실제 돌아왔는지 골라 주세요." },
          { status: 409 }
        );
      }
      const boxPatch = body.box_count !== undefined ? Math.max(1, Math.floor(Number(body.box_count) || 1)) : null;
      let dateNotice: string | null = null; // 발송된 적 있는 차수를 되살리며 발송일이 옮겨졌을 때

      const r = await applyOrderShipments(ship.order_id as string, {
        mutate: (schedules) => {
          const i = schedules.findIndex((s) => s.id === ship.id);
          if (i < 0) throw new ShipChangeError("발송 일정이 바뀌었습니다 — 새로고침한 뒤 다시 시도하세요.", 409);
          const s = schedules[i];
          const opts: SaveShipmentsOpts = {};
          if (body.tracking_no !== undefined) s.tracking_no = (body.tracking_no || "").trim();
          if (boxPatch !== null) s.box_count = boxPatch;
          s.cancelled_with_order = false; // 차수 단위로 바꾼 차수는 발주 복구 대상이 아니다
          if (to === "취소") {
            // 돌아옴 → 발송 시각을 지워 '안 나간 차수'와 같게(재고 복구) / 안 돌아옴 → 시각 보존 + 출고 유지 행
            opts.cancelled = [i];
            if (shipped) {
              if (body.returned) s.shipped_at = null;
              else { s.shipped_at = s.shipped_at ?? new Date().toISOString(); opts.keep = [i]; }
            }
          } else {
            // 취소에서 되살리거나 발송완료↔발송대기 — 출고 유지 행이 있었으면 지우고 일반 선점으로 돌아간다
            if (from === "취소") {
              const k = shippedKey(s.shipped_at);
              if (k !== null) opts.releaseKeys = [k];
            }
            if (to === "발송완료") {
              // 실제 발송일 — 첫 발송일이면 선점일·매출 인식일이 함께 옮겨진다(D2).
              //  발송 뒤 취소(안 돌아옴)한 차수를 되살리면 저장된 발송일이 실제 발송일이다 — 날짜를 안 보냈으면 그대로,
              //  다른 날짜를 보냈으면 그 날로 옮기고(명시한 날짜 우선) 알린다.
              const orig = from === "취소" && s.shipped_at && s.ship_date ? s.ship_date : null;
              const date = !body.shipped_date && orig && orig <= today ? orig : shippedDate;
              if (orig && orig !== date) {
                dateNotice = `${Number(ship.seq) || 1}차 발송일을 ${orig} → ${date}로 옮겼습니다 — 가장 이른 차수면 재고 차감일·매출 인식일도 함께 바뀝니다.`;
              }
              s.ship_date = date;
              s.shipped_at = s.shipped_at ?? new Date().toISOString();
            } else {
              s.shipped_at = null;
            }
          }
          s.status = to as typeof s.status;
          return opts;
        },
        headerShipDate: null, // 차수가 있으니 자동 차수를 만들지 않는다
        statusFromSingle: true,
      });

      // 알림은 재고·헤더·매출을 다 맞춘 뒤(applyOrderShipments 안에서 끝난다)에 보낸다
      await logShipmentStatusChanged(ship.order_id as string, Number(ship.seq) || 1, from, to);
      return NextResponse.json({
        ok: true, order_status: r.headerStatus,
        channel_notice: [dateNotice, r.channelNotice].filter(Boolean).join("\n") || null,
        ...salesSyncFields(r),
      });
    }

    // ── 송장·박스 수만 — 재고·매출과 무관해 그 칸만 고친다 ──
    const patch: Record<string, unknown> = {};
    if (body.tracking_no !== undefined) patch.tracking_no = (body.tracking_no || "").trim() || null;
    // 실제 포장 박스 수 확정(발송요청 양식에서 입력) — 송장 출력 행 수·송장 입력칸 수·이익률 배송비가 이 값을 따른다.
    if (body.box_count !== undefined) patch.box_count = Math.max(1, Math.floor(Number(body.box_count) || 1));
    if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true });

    const { error: upErr } = await sb.from("shipments").update(patch).eq("id", id);
    if (upErr) throw upErr;

    // 박스 수가 바뀌면 발주 헤더(orders.box_count)도 차수 합으로 다시 맞춘다 — 이익률·발주 단위 송장칸이 이걸 읽는다.
    //  취소 차수는 빼고 센다 — 안 보낸 박스까지 세면 부분 취소 발주의 배송비가 과대 계산된다.
    //  송장만 바꿔도 발주를 '바뀜'으로 표시한다(수정 화면이 열 때 읽은 값으로 덮지 않게 — updated_at 검사).
    const headerPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.box_count !== undefined) {
      const { data: all, error: allErr } = await sb.from("shipments").select("box_count, status").eq("order_id", ship.order_id);
      if (allErr) throw allErr;
      const total = (all ?? [])
        .filter((s) => (s as { status: string | null }).status !== "취소")
        .reduce((a, s) => a + Math.max(1, Number((s as { box_count: number | null }).box_count) || 1), 0);
      if (total > 0) headerPatch.box_count = total;
    }
    const { error: hErr } = await sb.from("orders").update(headerPatch).eq("id", ship.order_id);
    if (hErr) throw hErr;

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ShipChangeError) {
      return NextResponse.json({ ok: false, error: err.message, ...(err.extra || {}) }, { status: err.status });
    }
    console.error("[b2b/shipments PATCH]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "변경 실패") },
      { status: 500 }
    );
  }
}
