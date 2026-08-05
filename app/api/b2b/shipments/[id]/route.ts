import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { deriveParentStatus } from "@/app/lib/b2b-shipments";
import { logShipmentStatusChanged } from "@/app/lib/b2b-activity";
import { syncOrderSalesSafe } from "@/app/lib/b2b-sales-sync";

export const runtime = "nodejs"; // sales-sync 가 crypto(sales-normalize) 사용
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/b2b/shipments/[id] — 발송 차수(하위) 상태/송장번호 변경
//   body: { status?, tracking_no? }
//   발송완료로 바꾸려면 송장번호 필수. 변경 후 상위발주 상태를 하위 차수들로부터 재도출.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { status?: string; tracking_no?: string; box_count?: number };

    const sb = supabaseAdmin();
    const { data: ship, error: getErr } = await sb
      .from("shipments")
      .select("id, order_id, seq, status, tracking_no, box_count")
      .eq("id", id)
      .single();
    if (getErr || !ship) {
      return NextResponse.json({ ok: false, error: "발송 일정을 찾을 수 없습니다." }, { status: 404 });
    }

    const newStatus = body.status ?? ship.status;
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
      const boxCount = Math.max(1, Number(ship.box_count) || 1);
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

    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.tracking_no !== undefined) patch.tracking_no = (body.tracking_no || "").trim() || null;
    // 실제 포장 박스 수 확정(발송요청 양식에서 입력) — 송장 출력 행 수·송장 입력칸 수·이익률 배송비가 이 값을 따른다.
    if (body.box_count !== undefined) patch.box_count = Math.max(1, Math.floor(Number(body.box_count) || 1));
    // 발송 시각은 상태를 실제로 건드릴 때만 손댄다 — 박스 수만 저장하는 요청이 이미 찍힌 발송 시각을
    //  현재 시각으로 밀거나(재다운로드 때마다) 지워 버리면 안 된다.
    if (touchesShipping) patch.shipped_at = newStatus === "발송완료" ? new Date().toISOString() : null;

    const { error: upErr } = await sb.from("shipments").update(patch).eq("id", id);
    if (upErr) throw upErr;

    // 박스 수가 바뀌면 발주 헤더(orders.box_count)도 차수 합으로 다시 맞춘다 — 이익률·발주 단위 송장칸이 이걸 읽는다.
    //  취소 차수는 빼고 센다 — 안 보낸 박스까지 세면 부분 취소 발주의 배송비가 과대 계산된다.
    //  상태 변경(취소↔복구)도 합계를 바꾸므로 같이 재동기화한다. 안 그러면 취소한 박스가 계속 배송비로 남는다.
    if (body.box_count !== undefined || newStatus !== ship.status) {
      const { data: all } = await sb.from("shipments").select("box_count, status").eq("order_id", ship.order_id);
      const total = (all ?? [])
        .filter((s) => (s as { status: string | null }).status !== "취소")
        .reduce((a, s) => a + Math.max(1, Number((s as { box_count: number | null }).box_count) || 1), 0);
      if (total > 0) await sb.from("orders").update({ box_count: total }).eq("id", ship.order_id);
    }

    // 차수 상태 변경 이력 기록 (히스토리)
    if (body.status !== undefined && newStatus !== ship.status) {
      await logShipmentStatusChanged(ship.order_id as string, Number(ship.seq) || 1, ship.status as string, newStatus);
    }

    // 상위발주 상태 재도출 (복수 발송이면)
    const { data: ships } = await sb.from("shipments").select("status").eq("order_id", ship.order_id);
    const derived = deriveParentStatus((ships ?? []).map((s) => s.status as string));
    if (derived) {
      await sb.from("orders").update({ status: derived }).eq("id", ship.order_id);
      // 발주 상태가 재도출되면 매출원장 동기화. 발송완료면 반영, 취소(전 차수 취소)면 옛 매출행 정리.
      await syncOrderSalesSafe(ship.order_id as string);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[b2b/shipments PATCH]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "변경 실패") },
      { status: 500 }
    );
  }
}
