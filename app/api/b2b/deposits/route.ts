import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getKv } from "@/app/lib/b2b-settings";
import { currentActor } from "@/app/lib/b2b-activity";
import {
  BankDeposit,
  UnpaidOrderLite,
  applyMatch,
  candidateOrders,
  getIgnoreRules,
  isMissingDepositsTable,
  loadUnpaidOrders,
  matchesIgnoreRule,
  setIgnoreRules,
} from "@/app/lib/b2b-deposits";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────
// GET /api/b2b/deposits — 은행 입금 피드 (입금 확인 화면 상단)
//  확인필요 전체 + 최근 처리분(limit) / 확인필요 건별 매칭 후보 / 수동 선택용 미수금 발주 목록
// ─────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const limit = Math.min(100, Math.max(1, Number(sp.get("limit")) || 30));
    const sb = supabaseAdmin();

    const [{ data: reviewRows, error: rErr }, { data: recentRows, error: cErr }] = await Promise.all([
      sb.from("bank_deposits").select("*").eq("status", "확인필요").order("trdt", { ascending: false }),
      sb.from("bank_deposits").select("*").neq("status", "확인필요").order("trdt", { ascending: false }).limit(limit),
    ]);
    if (rErr) throw rErr;
    if (cErr) throw cErr;

    const review = (reviewRows ?? []) as BankDeposit[];
    const recent = (recentRows ?? []) as BankDeposit[];

    // 확인필요 건이 있을 때만 후보 계산 (미수금 목록은 수동 선택 드롭다운에도 쓰므로 항상 로드)
    const unpaid = await loadUnpaidOrders();
    const suggestions: Record<string, { order: UnpaidOrderLite; nameHit: boolean; amountHit: boolean }[]> = {};
    for (const dep of review) {
      suggestions[dep.id] = candidateOrders(dep, unpaid).slice(0, 3);
    }

    let lastSync: unknown = null;
    try {
      const raw = await getKv("deposits_last_sync");
      lastSync = raw ? JSON.parse(raw) : null;
    } catch {
      lastSync = null;
    }

    const rules = await getIgnoreRules();
    return NextResponse.json({ ok: true, review, recent, suggestions, unpaid, lastSync, rules });
  } catch (err) {
    if (isMissingDepositsTable(err)) {
      return NextResponse.json({ ok: true, notReady: true, review: [], recent: [], suggestions: {}, unpaid: [], lastSync: null });
    }
    console.error("[b2b/deposits GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// ─────────────────────────────────────────────
// PATCH /api/b2b/deposits — { action, deposit_id?, order_id?, always?, rules? }
//  match: 원클릭 수동 매칭 (payments 기록 + 발주 상태 변경)
//  ignore: 무시 (always:true 면 입금자명을 자동무시 규칙에 추가 + 같은 이름 대기 건 일괄 무시)
//  restore: 무시 → 확인필요 복귀. rules: 자동무시 규칙 목록 저장(칩 삭제용).
// ─────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: string;
      deposit_id?: string;
      order_id?: string;
      always?: boolean;
      rules?: string[];
    };
    const { action, deposit_id: depositId, order_id: orderId } = body;

    if (action === "rules") {
      if (!Array.isArray(body.rules)) {
        return NextResponse.json({ ok: false, error: "rules 배열 필수" }, { status: 400 });
      }
      await setIgnoreRules(body.rules);
      return NextResponse.json({ ok: true, rules: await getIgnoreRules() });
    }

    if (!depositId || !action) {
      return NextResponse.json({ ok: false, error: "action·deposit_id 필수" }, { status: 400 });
    }
    const sb = supabaseAdmin();
    const { data: dep, error: dErr } = await sb.from("bank_deposits").select("*").eq("id", depositId).single();
    if (dErr) throw dErr;
    const deposit = dep as BankDeposit;

    if (action === "ignore") {
      if (deposit.status !== "확인필요") {
        return NextResponse.json({ ok: false, error: "확인필요 상태만 무시할 수 있습니다." }, { status: 400 });
      }
      const { error } = await sb.from("bank_deposits").update({ status: "무시" }).eq("id", depositId);
      if (error) throw error;

      // 항상 무시: 입금자명을 규칙에 추가 + 같은 이름으로 대기 중인 건 일괄 무시
      let alwaysIgnored = 0;
      if (body.always && deposit.remark) {
        const rules = await getIgnoreRules();
        await setIgnoreRules([...rules, deposit.remark]);
        const newRules = await getIgnoreRules();
        const { data: pendingRows } = await sb.from("bank_deposits").select("id, remark").eq("status", "확인필요");
        for (const p of (pendingRows ?? []) as { id: string; remark: string | null }[]) {
          if (matchesIgnoreRule(p.remark, newRules)) {
            const { error: e } = await sb
              .from("bank_deposits")
              .update({ status: "무시", matched_by: "자동규칙" })
              .eq("id", p.id);
            if (!e) alwaysIgnored++;
          }
        }
      }
      return NextResponse.json({ ok: true, alwaysIgnored });
    }

    if (action === "restore") {
      if (deposit.status !== "무시") {
        return NextResponse.json({ ok: false, error: "무시 상태만 되돌릴 수 있습니다." }, { status: 400 });
      }
      const { error } = await sb.from("bank_deposits").update({ status: "확인필요" }).eq("id", depositId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (action === "match") {
      if (!orderId) return NextResponse.json({ ok: false, error: "order_id 필수" }, { status: 400 });
      if (deposit.status === "자동매칭" || deposit.status === "수동매칭") {
        return NextResponse.json({ ok: false, error: "이미 매칭된 입금입니다." }, { status: 400 });
      }
      const unpaid = await loadUnpaidOrders();
      const order = unpaid.find((o) => o.id === orderId);
      if (!order) {
        return NextResponse.json(
          { ok: false, error: "미수금 발주(입금전·일부입금)에서 찾을 수 없습니다. 목록을 새로고침하세요." },
          { status: 400 }
        );
      }
      const actor = await currentActor();
      await applyMatch(deposit, order, "수동", actor);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: `알 수 없는 action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error("[b2b/deposits PATCH]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "처리 실패") }, { status: 500 });
  }
}
