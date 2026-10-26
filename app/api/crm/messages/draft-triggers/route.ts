import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { adminOnly } from "@/app/lib/admin-req";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST — 트리거·D+n 이 비어 있는 메시지에 초안을 채운다(docs/crm-message-map-plan.md §3 매핑, 제목으로 맞춤). 관리자만.
//  이미 값이 있는 메시지는 건드리지 않는다. 결과: 채운 건수·못 맞춘 제목.
type Draft = { trigger: string; offset_days: number | null; offset_note?: string };
const RULES: { re: RegExp; d: Draft }[] = [
  { re: /체험단 안내/, d: { trigger: "event", offset_days: 0, offset_note: "선정 시" } },
  { re: /SNS 광고|블로그.*SEO|가이드 SEO/, d: { trigger: "always", offset_days: null } },
  { re: /웰컴 쿠폰|첫 방문/, d: { trigger: "signup", offset_days: 0 } },
  { re: /주문 완료 알림|입금 확인/, d: { trigger: "first_order", offset_days: 0 } },
  { re: /첫 구매 환영/, d: { trigger: "first_order", offset_days: 0, offset_note: "결제 후 1시간" } },
  { re: /카카오채널 추가/, d: { trigger: "first_order", offset_days: 1 } },
  { re: /발송 알림|리플렛/, d: { trigger: "shipped", offset_days: 0 } },
  { re: /배송 완료 알림|해동|조리법/, d: { trigger: "delivered", offset_days: 0 } },
  { re: /식단일기/, d: { trigger: "first_order", offset_days: 0, offset_note: "주문 건당 1회" } },
  { re: /리뷰 작성/, d: { trigger: "delivered", offset_days: 5 } },
  { re: /만족도|NPS/, d: { trigger: "delivered", offset_days: 7 } },
  { re: /크로스셀/, d: { trigger: "first_order", offset_days: 14 } },
  { re: /재구매 리마인더/, d: { trigger: "reorder", offset_days: 0, offset_note: "재구매 주기 도래" } },
  { re: /정기배송 전환/, d: { trigger: "reorder", offset_days: 0, offset_note: "2회 구매 시점" } },
  { re: /정기배송 알림톡/, d: { trigger: "subscription", offset_days: -3 } },
  { re: /결제 완료 안내|회차 혜택|해지 방지/, d: { trigger: "subscription", offset_days: 0 } },
  { re: /장바구니/, d: { trigger: "cart", offset_days: 0 } },
  { re: /60일/, d: { trigger: "inactive", offset_days: 60 } },
  { re: /90일/, d: { trigger: "inactive", offset_days: 90 } },
  { re: /180일|윈백/, d: { trigger: "inactive", offset_days: 180 } },
  { re: /체험단 3회|VIP|장기 고객|신제품/, d: { trigger: "event", offset_days: 0 } },
];

export async function POST(req: NextRequest) {
  const deny = await adminOnly(req); if (deny) return deny;
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("crm_messages").select("id,title,timing,trigger,offset_days,offset_note");
    if (error) throw error;
    let filled = 0; const unmatched: string[] = [];
    for (const m of (data || []) as { id: string; title: string; timing: string; trigger: string; offset_days: number | null; offset_note: string }[]) {
      if (m.trigger) continue;
      const hit = RULES.find((r) => r.re.test(m.title || ""));
      if (!hit) { unmatched.push(m.title || "(제목 없음)"); continue; }
      const { error: ue } = await sb.from("crm_messages").update({ trigger: hit.d.trigger, offset_days: hit.d.offset_days, offset_note: hit.d.offset_note || m.offset_note || "", updated_at: new Date().toISOString() }).eq("id", m.id);
      if (ue) throw ue;
      filled++;
    }
    return NextResponse.json({ ok: true, filled, unmatched });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "초안 채우기 실패") }, { status: 500 });
  }
}
