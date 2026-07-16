import { NextRequest, NextResponse } from "next/server";
import { getCampaign, setCampaignDailyBudget, isCBO } from "@/app/lib/meta-ad";
import { getMetaThresholds } from "@/app/lib/meta-settings";
import { getScaleLog, recordScale, scaleBlockedReason } from "@/app/lib/meta-scale";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { id, expectFrom } — 본 캠페인(CBO)의 일 예산을 설정의 증액률만큼 올린다.
//
//  실제 광고비가 걸린 되돌릴 수 없는 변경이라, 클라이언트를 신뢰하지 않는 지점이 셋 있다:
//   ① 금액을 받지 않는다 — 서버가 메타에서 현재 예산을 다시 읽어 직접 계산한다.
//   ② 증액률은 설정에서만 온다 — 요청 본문으로 못 바꾼다.
//   ③ expectFrom(화면에 보이던 예산)이 실제와 다르면 막는다 — 보드는 최대 90초 캐시라
//      그 사이 메타 광고관리자에서 누가 바꿨을 수 있고, 그때 곱하기를 하면 엉뚱한 금액이 된다.
//  단계 판정(연속 N일)은 화면 규칙이라 여기서 다시 보지 않는다. 여기서 막는 건 '돌이킬 수 없는 것'뿐.
export async function POST(req: NextRequest) {
  try {
    const { id, expectFrom } = (await req.json()) as { id?: string; expectFrom?: number };
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });

    const [th, log] = await Promise.all([getMetaThresholds(), getScaleLog()]);

    const blocked = scaleBlockedReason(log[id]);
    if (blocked) return NextResponse.json({ ok: false, error: blocked }, { status: 409 });

    const c = await getCampaign(id);
    if (!isCBO(c)) {
      return NextResponse.json({ ok: false, error: "본 캠페인(CBO)만 증액할 수 있습니다 — 이 캠페인은 예산이 광고세트에 있습니다." }, { status: 400 });
    }
    const from = Number(c.daily_budget) || 0;
    if (!from) {
      return NextResponse.json({ ok: false, error: "일 예산 캠페인만 증액할 수 있습니다 — 총 예산(lifetime) 캠페인은 메타에서 직접 조정하세요." }, { status: 400 });
    }
    if (typeof expectFrom === "number" && Math.round(expectFrom) !== Math.round(from)) {
      return NextResponse.json({
        ok: false,
        error: `화면의 예산(${Math.round(expectFrom).toLocaleString()}원)과 메타의 실제 예산(${Math.round(from).toLocaleString()}원)이 다릅니다. 새로고침 후 다시 시도하세요.`,
      }, { status: 409 });
    }

    const pct = Number(th.scalePct) || 0;
    if (pct <= 0) return NextResponse.json({ ok: false, error: "설정의 증액 비율이 0입니다 — 성과 기준 설정에서 값을 넣으세요." }, { status: 400 });
    const to = Math.round(from * (1 + pct / 100));
    if (to <= from) return NextResponse.json({ ok: false, error: "증액 결과가 현재 예산보다 크지 않습니다." }, { status: 400 });

    await setCampaignDailyBudget(id, to);
    // 메타 반영에 성공한 뒤에만 기록한다. 먼저 기록하면 메타 호출이 실패했을 때
    // 올리지도 못한 채 7일 쿨다운에 걸린다(반대 순서의 손해가 더 크다).
    await recordScale(id, from, to);

    return NextResponse.json({ ok: true, id, name: c.name, from, to, pct });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "예산 변경 실패" }, { status: 500 });
  }
}
